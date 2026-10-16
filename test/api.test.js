import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, pool, chunk } from '../api.js';

const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
const quotaBody = { error: { errors: [{ reason: 'quotaExceeded' }] } };

function make(fetchImpl, extra = {}) {
  let token = 't1';
  return createApi({
    getToken: async () => token,
    refreshToken: async () => { token = 't2'; },
    fetchImpl, retryDelayMs: 0, ...extra,
  });
}

test('retries network failures twice, then throws a network ApiError', async () => {
  let calls = 0;
  const api = make(async () => { calls++; throw new TypeError('offline'); });
  await assert.rejects(api.fetchChannels(['a']), (e) => e instanceof ApiError && e.isNetwork);
  assert.equal(calls, 3);
});

test('a network failure followed by success is transparent', async () => {
  let calls = 0;
  const api = make(async () => { if (calls++ === 0) throw new TypeError('x'); return json(200, { items: [] }); });
  assert.deepEqual(await api.fetchChannels(['a']), []);
});

test('401 refreshes the token once and retries with the new one', async () => {
  const seen = [];
  const api = make(async (url, opts) => {
    seen.push(opts.headers.Authorization);
    return seen.length === 1 ? json(401, {}) : json(200, { items: [] });
  });
  await api.fetchChannels(['a']);
  assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
});

test('a second 401 is reported as an auth error', async () => {
  const api = make(async () => json(401, {}));
  await assert.rejects(api.fetchChannels(['a']), (e) => e.isAuth);
});

test('403 quotaExceeded is recognised', async () => {
  const api = make(async () => json(403, quotaBody));
  await assert.rejects(api.fetchVideos(['a']), (e) => e.isQuota);
});

test('a missing uploads playlist (404) yields no videos', async () => {
  const api = make(async () => json(404, { error: { errors: [{ reason: 'playlistNotFound' }] } }));
  assert.deepEqual(await api.listUploads('PL'), []);
});

test('listSubscriptions follows pagination and counts one unit per page', async () => {
  const pages = [
    { items: [{ snippet: { title: 'A', resourceId: { channelId: 'a' }, thumbnails: {} } }], nextPageToken: 'p2' },
    { items: [{ snippet: { title: 'B', resourceId: { channelId: 'b' }, thumbnails: {} } }] },
  ];
  let i = 0;
  const api = make(async () => json(200, pages[i++]));
  const subs = await api.listSubscriptions();
  assert.deepEqual(subs.map((s) => s.id), ['a', 'b']);
  assert.equal(api.units, 2);
});

test('fetchVideos maps live, duration and missing views', async () => {
  const api = make(async () => json(200, {
    items: [
      { id: '1', snippet: { channelId: 'c', title: 't', publishedAt: 'x', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT10M' }, statistics: { viewCount: '42' } },
      { id: '2', snippet: { channelId: 'c', title: 't', publishedAt: 'x', liveBroadcastContent: 'upcoming' }, contentDetails: { duration: 'PT1H' }, statistics: {} },
      { id: '3', snippet: { channelId: 'c', title: 't', publishedAt: 'x', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT5M' }, statistics: {}, liveStreamingDetails: {} },
    ],
  }));
  const [a, b, c] = await api.fetchVideos(['1', '2', '3']);
  assert.deepEqual([a.views, a.duration, a.live], [42, 600, false]);
  assert.deepEqual([b.views, b.live], [null, true]);
  assert.equal(c.live, true);
});

test('pool never exceeds the concurrency limit and stops after a failure', async () => {
  let active = 0, peak = 0, started = 0;
  await pool(Array.from({ length: 30 }, (_, i) => i), 6, async () => {
    started++; active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
  });
  assert.ok(peak <= 6 && peak > 1, `peak ${peak}`);

  started = 0;
  await assert.rejects(pool(Array.from({ length: 100 }, (_, i) => i), 6, async (i) => {
    started++;
    if (i === 3) throw new Error('boom');
    await new Promise((r) => setTimeout(r, 2));
  }), /boom/);
  assert.ok(started < 100);
});

test('chunk', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
