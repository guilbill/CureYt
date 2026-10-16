// Local cache: IndexedDB in the browser, an in-memory twin with the same interface for tests/demo.
const STORES = ['channels', 'videos', 'meta'];

export function createMemoryCache() {
  const data = { channels: new Map(), videos: new Map(), meta: new Map() };
  return {
    async getAll(store) { return [...data[store].values()]; },
    async putMany(store, items) {
      for (const it of items) data[store].set(store === 'meta' ? it.key : it.id, structuredClone(it));
    },
    async replaceChannelVideos(channelId, videos) {
      for (const [id, v] of data.videos) if (v.channelId === channelId) data.videos.delete(id);
      for (const v of videos) data.videos.set(v.id, structuredClone(v));
    },
    async deleteVideos(ids) { for (const id of ids) data.videos.delete(id); },
    async deleteChannels(ids) {
      const set = new Set(ids);
      for (const id of ids) data.channels.delete(id);
      for (const [id, v] of data.videos) if (set.has(v.channelId)) data.videos.delete(id);
    },
    async getMeta(key) { return data.meta.get(key)?.value ?? null; },
    async setMeta(key, value) { data.meta.set(key, { key, value }); },
    async clearAll() { for (const s of STORES) data[s].clear(); },
  };
}

export async function openCache(name = 'cureyt') {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('channels', { keyPath: 'id' });
      d.createObjectStore('videos', { keyPath: 'id' }).createIndex('channelId', 'channelId');
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const result = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return {
    getAll: (store) => result(db.transaction(store).objectStore(store).getAll()),
    async putMany(store, items) {
      const tx = db.transaction(store, 'readwrite');
      for (const it of items) tx.objectStore(store).put(it);
      await done(tx);
    },
    async replaceChannelVideos(channelId, videos) {
      const tx = db.transaction('videos', 'readwrite');
      const os = tx.objectStore('videos');
      const keys = await result(os.index('channelId').getAllKeys(channelId));
      for (const k of keys) os.delete(k);
      for (const v of videos) os.put(v);
      await done(tx);
    },
    async deleteVideos(ids) {
      const tx = db.transaction('videos', 'readwrite');
      for (const id of ids) tx.objectStore('videos').delete(id);
      await done(tx);
    },
    async deleteChannels(ids) {
      const tx = db.transaction(['channels', 'videos'], 'readwrite');
      const videos = tx.objectStore('videos');
      for (const id of ids) {
        tx.objectStore('channels').delete(id);
        const keys = await result(videos.index('channelId').getAllKeys(id));
        for (const k of keys) videos.delete(k);
      }
      await done(tx);
    },
    async getMeta(key) {
      const row = await result(db.transaction('meta').objectStore('meta').get(key));
      return row ? row.value : null;
    },
    async setMeta(key, value) {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
      await done(tx);
    },
    async clearAll() {
      const tx = db.transaction(STORES, 'readwrite');
      for (const s of STORES) tx.objectStore(s).clear();
      await done(tx);
    },
  };
}
