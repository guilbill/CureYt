// Refresh orchestration: decides what to fetch and keeps the cache up to date.
// Takes the api and the cache as arguments so it can be tested without a browser.
import { chunk, pool } from './api.js';
import { exclusionReason, DAY_MS } from './score.js';

export const HOUR_MS = 3600000;
export const LIGHT_AFTER_MS = 3 * HOUR_MS;
export const FULL_AFTER_MS = 7 * DAY_MS;
export const SUBS_AFTER_MS = 24 * HOUR_MS;
export const RECENT_DAYS = 30;
// Bump when the shape of cached videos changes: forces one full reload (v2 added `likes`).
export const SCHEMA = 2;
const CONCURRENCY = 6;

// meta: { lastFull, lastLight, lastSubs, schema } (epoch ms or null) -> { mode: 'full'|'light'|'none', subs }
export function planRefresh(meta, now, { force = false, forceSubs = false } = {}) {
  let mode = 'none';
  if (!meta.lastFull || meta.schema !== SCHEMA || now - meta.lastFull > FULL_AFTER_MS) mode = 'full';
  else if (force || now - Math.max(meta.lastFull, meta.lastLight || 0) > LIGHT_AFTER_MS) mode = 'light';
  const subs = forceSubs || !meta.lastSubs || now - meta.lastSubs > SUBS_AFTER_MS;
  return { mode, subs };
}

export async function readMeta(cache) {
  const [lastFull, lastLight, lastSubs, schema] = await Promise.all(
    ['lastFull', 'lastLight', 'lastSubs', 'schema'].map((k) => cache.getMeta(k)),
  );
  return { lastFull, lastLight, lastSubs, schema };
}

const toRecord = (v, fetchedAt) => ({
  id: v.id,
  channelId: v.channelId,
  title: v.title,
  publishedAt: v.publishedAt,
  thumb: v.thumb,
  duration: v.duration,
  views: v.views,
  likes: v.likes ?? null,
  fetchedAt,
  excluded: exclusionReason(v),
});

export async function syncSubscriptions({ api, cache, refreshStats = false }) {
  const subs = await api.listSubscriptions();
  const subIds = new Set(subs.map((s) => s.id));
  const existing = new Map((await cache.getAll('channels')).map((c) => [c.id, c]));

  const removed = [...existing.keys()].filter((id) => !subIds.has(id));
  if (removed.length) await cache.deleteChannels(removed);

  const needStats = subs.filter((s) => refreshStats || !existing.has(s.id)).map((s) => s.id);
  const statLists = await pool(chunk(needStats, 50), CONCURRENCY, (ids) => api.fetchChannels(ids));
  const stats = new Map(statLists.flat().map((c) => [c.id, c]));

  const records = subs.map((s) => {
    const prev = existing.get(s.id);
    const st = stats.get(s.id);
    return {
      subscriberCount: 0, hiddenSubscriberCount: true, uploads: null, loadedAt: null,
      ...prev,
      title: s.title,
      thumb: s.thumb,
      ...(st ? { subscriberCount: st.subscriberCount, hiddenSubscriberCount: st.hiddenSubscriberCount, uploads: st.uploads } : {}),
      id: s.id,
    };
  });
  await cache.putMany('channels', records);
  return { added: subs.filter((s) => !existing.has(s.id)).map((s) => s.id), removed };
}

async function loadChannels({ api, cache, channels, now, onProgress }) {
  let done = 0;
  onProgress({ phase: 'channels', done, total: channels.length });
  await pool(channels, CONCURRENCY, async (c) => {
    const uploads = c.uploads ? await api.listUploads(c.uploads) : [];
    const ids = uploads.map((u) => u.videoId).slice(0, 50);
    const fetched = ids.length ? await api.fetchVideos(ids) : [];
    await cache.replaceChannelVideos(c.id, fetched.map((v) => toRecord(v, now)));
    await cache.putMany('channels', [{ ...c, loadedAt: now, schema: SCHEMA }]);
    onProgress({ phase: 'channels', done: ++done, total: channels.length });
  });
}

async function lightRefresh({ api, cache, channels, now, onProgress }) {
  const cutoff = now - RECENT_DAYS * DAY_MS;
  const cachedRecent = (await cache.getAll('videos')).filter((v) => Date.parse(v.publishedAt) >= cutoff);
  const ids = new Set(cachedRecent.map((v) => v.id));

  let done = 0;
  onProgress({ phase: 'light', done, total: channels.length });
  await pool(channels, CONCURRENCY, async (c) => {
    const uploads = c.uploads ? await api.listUploads(c.uploads) : [];
    for (const u of uploads) if (u.publishedAt && Date.parse(u.publishedAt) >= cutoff) ids.add(u.videoId);
    onProgress({ phase: 'light', done: ++done, total: channels.length });
  });

  const fetched = (await pool(chunk([...ids], 50), CONCURRENCY, (batch) => api.fetchVideos(batch))).flat();
  const got = new Set(fetched.map((v) => v.id));
  const gone = cachedRecent.filter((v) => !got.has(v.id)).map((v) => v.id);
  await cache.putMany('videos', fetched.map((v) => toRecord(v, now)));
  if (gone.length) await cache.deleteVideos(gone);
}

/**
 * mode: 'full' | 'light' | 'none'; subs: also re-read the subscriptions.
 * Throws ApiError (quota, auth, network); data already written stays in the cache and the
 * meta dates are only moved forward after a complete run. Returns { units }.
 */
export async function runRefresh({ api, cache, mode, subs, now = Date.now(), onProgress = () => {} }) {
  const startUnits = api.units;
  if (subs || mode === 'full') {
    onProgress({ phase: 'subs', done: 0, total: 0 });
    await syncSubscriptions({ api, cache, refreshStats: mode === 'full' });
  }
  const channels = await cache.getAll('channels');
  const fresh = channels.filter((c) => !c.loadedAt);

  if (mode === 'full') {
    // Resumable: a channel loaded during the last day (an interrupted run) is not fetched again,
    // unless its videos come from an older cache schema.
    const targets = channels.filter((c) => !c.loadedAt || c.schema !== SCHEMA || now - c.loadedAt > DAY_MS);
    await loadChannels({ api, cache, channels: targets, now, onProgress });
  } else {
    await loadChannels({ api, cache, channels: fresh, now, onProgress });
    if (mode === 'light') {
      await lightRefresh({ api, cache, channels: channels.filter((c) => c.loadedAt), now, onProgress });
    }
  }

  if (mode === 'full') {
    await cache.setMeta('lastFull', now);
    await cache.setMeta('schema', SCHEMA);
  }
  if (mode !== 'none') await cache.setMeta('lastLight', now);
  if (subs || mode === 'full') await cache.setMeta('lastSubs', now);
  return { units: api.units - startUnits };
}
