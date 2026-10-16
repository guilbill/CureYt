// YouTube Data API v3 client. Never calls search.list.
import { parseDuration } from './score.js';

const BASE = 'https://www.googleapis.com/youtube/v3/';

export class ApiError extends Error {
  constructor(status, reason, message) {
    super(message || `${status} ${reason}`);
    this.name = 'ApiError';
    this.status = status; // 0 = network
    this.reason = reason;
  }
  get isQuota() { return this.status === 403 && this.reason === 'quotaExceeded'; }
  get isAuth() { return this.status === 401; }
  get isNetwork() { return this.status === 0; }
}

// Runs fn(item, index) with at most `limit` in flight. Stops taking new items after the first
// failure, lets running ones finish, then rethrows that first failure.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failure = failure || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}

export const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const thumbOf = (t) => (t && (t.medium || t.high || t.default || {}).url) || '';

export function createApi({ getToken, refreshToken, fetchImpl = (...a) => fetch(...a), retryDelayMs = 600 }) {
  const api = { units: 0 };

  async function request(path, params) {
    const url = BASE + path + '?' + new URLSearchParams(params);
    let networkTries = 0;
    let refreshed = false;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
      } catch (e) {
        if (networkTries++ < 2) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        throw new ApiError(0, 'network', 'Network error');
      }
      api.units += 1;
      if (res.ok) return res.json();
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await refreshToken();
        continue;
      }
      if (res.status >= 500 && networkTries++ < 2) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      let reason = '';
      try {
        reason = (await res.json()).error.errors[0].reason;
      } catch { /* body is not the usual error shape */ }
      throw new ApiError(res.status, reason);
    }
  }

  // -> [{ id, title, thumb }]
  api.listSubscriptions = async () => {
    const out = [];
    let pageToken;
    do {
      const params = { part: 'snippet', mine: 'true', maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;
      const data = await request('subscriptions', params);
      for (const it of data.items || []) {
        out.push({
          id: it.snippet.resourceId.channelId,
          title: it.snippet.title,
          thumb: thumbOf(it.snippet.thumbnails),
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  };

  // ids: at most 50 -> [{ id, subscriberCount, hiddenSubscriberCount, uploads }]
  api.fetchChannels = async (ids) => {
    const data = await request('channels', {
      part: 'statistics,contentDetails', id: ids.join(','), maxResults: '50',
    });
    return (data.items || []).map((c) => ({
      id: c.id,
      subscriberCount: Number(c.statistics?.subscriberCount || 0),
      hiddenSubscriberCount: !!c.statistics?.hiddenSubscriberCount,
      uploads: c.contentDetails?.relatedPlaylists?.uploads || null,
    }));
  };

  // -> [{ videoId, publishedAt }], newest first. Empty for a missing playlist.
  api.listUploads = async (playlistId) => {
    try {
      const data = await request('playlistItems', {
        part: 'contentDetails', playlistId, maxResults: '50',
      });
      return (data.items || []).map((it) => ({
        videoId: it.contentDetails.videoId,
        publishedAt: it.contentDetails.videoPublishedAt || null,
      }));
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  };

  // ids: at most 50. Videos deleted in between are simply absent from the result.
  api.fetchVideos = async (ids) => {
    const data = await request('videos', {
      part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(','), maxResults: '50',
    });
    return (data.items || []).map((v) => ({
      id: v.id,
      channelId: v.snippet.channelId,
      title: v.snippet.title,
      publishedAt: v.snippet.publishedAt,
      thumb: thumbOf(v.snippet.thumbnails),
      duration: parseDuration(v.contentDetails?.duration),
      views: v.statistics?.viewCount == null ? null : Number(v.statistics.viewCount),
      live: !!v.liveStreamingDetails || (v.snippet.liveBroadcastContent || 'none') !== 'none',
    }));
  };

  return api;
}
