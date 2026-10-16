import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '../cache.js';
import { ApiError } from '../api.js';
import { planRefresh, runRefresh, syncSubscriptions, HOUR_MS } from '../sync.js';
import { DAY_MS } from '../score.js';

const NOW = Date.UTC(2026, 9, 16, 12);

function fakeApi({ channels = 200, perChannel = 50, stepDays = 4, failAfterUnits = Infinity, missing = new Set() } = {}) {
  let ids = Array.from({ length: channels }, (_, i) => `c${i}`);
  const api = {
    units: 0,
    setChannels(list) { ids = list; },
    bill(n = 1) {
      if (api.units + n > failAfterUnits) throw new ApiError(403, 'quotaExceeded');
      api.units += n;
    },
    async listSubscriptions() {
      api.bill(Math.ceil(ids.length / 50));
      return ids.map((id) => ({ id, title: id, thumb: '' }));
    },
    async fetchChannels(list) {
      api.bill();
      return list.map((id) => ({ id, subscriberCount: 10000, hiddenSubscriberCount: false, uploads: 'UU' + id }));
    },
    async listUploads(pl) {
      api.bill();
      if (pl === 'UUc-empty') return [];
      const ch = pl.slice(2);
      return Array.from({ length: perChannel }, (_, i) => ({
        videoId: `${ch}:${i}`, publishedAt: new Date(NOW - (i * stepDays + 0.5) * DAY_MS).toISOString(),
      }));
    },
    async fetchVideos(list) {
      api.bill();
      return list.filter((id) => !missing.has(id)).map((id) => {
        const [ch, i] = id.split(':');
        return {
          id, channelId: ch, title: id, thumb: '', views: 1000,
          publishedAt: new Date(NOW - (i * stepDays + 0.5) * DAY_MS).toISOString(),
          duration: i === '1' ? 59 : 600, live: i === '2',
        };
      });
    },
  };
  return api;
}

test('planRefresh follows the spec thresholds', () => {
  assert.deepEqual(planRefresh({}, NOW), { mode: 'full', subs: true });
  const fresh = { lastFull: NOW - HOUR_MS, lastLight: NOW - HOUR_MS, lastSubs: NOW - HOUR_MS };
  assert.deepEqual(planRefresh(fresh, NOW), { mode: 'none', subs: false });
  assert.equal(planRefresh({ ...fresh, lastLight: NOW - 4 * HOUR_MS, lastFull: NOW - 4 * HOUR_MS }, NOW).mode, 'light');
  assert.equal(planRefresh({ ...fresh, lastFull: NOW - 8 * DAY_MS }, NOW).mode, 'full');
  assert.equal(planRefresh({ ...fresh, lastSubs: NOW - 25 * HOUR_MS }, NOW).subs, true);
  assert.equal(planRefresh(fresh, NOW, { force: true }).mode, 'light');
  assert.equal(planRefresh(fresh, NOW, { forceSubs: true }).subs, true);
});

test('full load for 200 subscriptions costs at most 450 units', async () => {
  const api = fakeApi(); const cache = createMemoryCache();
  const progress = [];
  const { units } = await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW, onProgress: (p) => progress.push(p) });
  assert.ok(units <= 450, `units ${units}`);
  assert.equal((await cache.getAll('channels')).length, 200);
  assert.equal((await cache.getAll('videos')).length, 200 * 50);
  assert.equal(await cache.getMeta('lastFull'), NOW);
  assert.deepEqual(progress.at(-1), { phase: 'channels', done: 200, total: 200 });
});

test('shorts and lives are stored with their exclusion reason', async () => {
  const api = fakeApi({ channels: 1 }); const cache = createMemoryCache();
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  const byId = Object.fromEntries((await cache.getAll('videos')).map((v) => [v.id, v]));
  assert.equal(byId['c0:1'].excluded, 'short');
  assert.equal(byId['c0:2'].excluded, 'live');
  assert.equal(byId['c0:0'].excluded, null);
});

test('light refresh costs about 240 units for 200 subscriptions', async () => {
  const api = fakeApi(); const cache = createMemoryCache();
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  const later = NOW + 4 * HOUR_MS;
  const { units } = await runRefresh({ api, cache, mode: 'light', subs: false, now: later });
  assert.ok(units >= 200 && units <= 260, `units ${units}`);
  assert.equal(await cache.getMeta('lastLight'), later);
  assert.equal(await cache.getMeta('lastFull'), NOW);
});

test('light refresh drops recent videos that were deleted', async () => {
  const api = fakeApi({ channels: 2 }); const cache = createMemoryCache();
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  api.fetchVideos = (orig => async (ids) => orig(ids.filter((id) => id !== 'c0:3')))(api.fetchVideos);
  await runRefresh({ api, cache, mode: 'light', subs: false, now: NOW + 4 * HOUR_MS });
  assert.equal((await cache.getAll('videos')).some((v) => v.id === 'c0:3'), false);
});

test('a video missing from videos.list (deleted) is skipped without failing the sync', async () => {
  const api = fakeApi({ channels: 1, missing: new Set(['c0:5']) }); const cache = createMemoryCache();
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  const ids = (await cache.getAll('videos')).map((v) => v.id);
  assert.equal(ids.length, 49);
});

test('a channel without uploads (empty playlist) does not abort the sync', async () => {
  const api = fakeApi({ channels: 3 }); const cache = createMemoryCache();
  api.setChannels(['c-empty', 'c1', 'c2']);
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  assert.equal((await cache.getAll('videos')).filter((v) => v.channelId === 'c-empty').length, 0);
  assert.equal((await cache.getAll('videos')).length, 100);
});

test('subscription sync prunes unsubscribed channels and loads new ones', async () => {
  const api = fakeApi({ channels: 3 }); const cache = createMemoryCache();
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  api.setChannels(['c1', 'c2', 'c9']);
  await runRefresh({ api, cache, mode: 'none', subs: true, now: NOW + HOUR_MS });
  const chans = (await cache.getAll('channels')).map((c) => c.id).sort();
  assert.deepEqual(chans, ['c1', 'c2', 'c9']);
  const videos = await cache.getAll('videos');
  assert.equal(videos.some((v) => v.channelId === 'c0'), false);
  assert.equal(videos.filter((v) => v.channelId === 'c9').length, 50);
});

test('quota error mid-load keeps what was written and the next run resumes', async () => {
  const cache = createMemoryCache();
  const api1 = fakeApi({ channels: 20, failAfterUnits: 20 });
  await assert.rejects(runRefresh({ api: api1, cache, mode: 'full', subs: true, now: NOW }), (e) => e.isQuota);
  assert.equal(await cache.getMeta('lastFull'), null);
  const loaded = (await cache.getAll('channels')).filter((c) => c.loadedAt).length;
  assert.ok(loaded > 0 && loaded < 20, `loaded ${loaded}`);

  const api2 = fakeApi({ channels: 20 });
  await runRefresh({ api: api2, cache, mode: 'full', subs: true, now: NOW + 60000 });
  assert.equal(await cache.getMeta('lastFull'), NOW + 60000);
  assert.equal((await cache.getAll('videos')).length, 20 * 50);
  // resumed run did not reload the channels loaded by the first one
  assert.ok(api2.units < 4 + 4 + 40, `units ${api2.units}`);
});

test('syncSubscriptions keeps loadedAt of known channels', async () => {
  const api = fakeApi({ channels: 2 }); const cache = createMemoryCache();
  await runRefresh({ api, cache, mode: 'full', subs: true, now: NOW });
  await syncSubscriptions({ api, cache });
  assert.ok((await cache.getAll('channels')).every((c) => c.loadedAt === NOW));
});
