// Pure scoring logic: no DOM, no network. Runs in the browser and in node --test.

export const DAY_MS = 86400000;

export const DEFAULTS = {
  tau: 3, // days, view accumulation rhythm
  fmin: 0.15, // floor of the projection (about 12 h)
  m: 5, // weight of the default estimate (views and like rate)
  minRefAgeDays: 7,
  sampleSize: 30,
  r0: 0.05, // fallback views/subscribers ratio
  alpha: 0.15, // weight of absolute volume
  lambda: 0.02, // decay per day of age
  shortMaxSeconds: 180,
  minVideoAgeHours: 6, // a video enters the ranking only after this age
  likeK: 100, // views needed before a video's own like rate is trusted
  noteBalance: 1 / 3, // 0 = views only, 1 = likes only; 1/3 means views x1 + likes x0.5
  scoreScale: 1.5, // keeps the default balance on the scale of the original formula
};

export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return +d * 86400 + +h * 3600 + +min * 60 + +s;
}

// video: { duration (seconds), views, live (bool) } -> null | 'short' | 'live' | 'nodata'
export function exclusionReason(video, params = DEFAULTS) {
  if (video.live) return 'live';
  if (video.duration <= params.shortMaxSeconds) return 'short';
  if (video.views == null) return 'nodata';
  return null;
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function confidenceFor(n) {
  if (n >= 15) return 'high';
  if (n >= 5) return 'medium';
  return 'low';
}

// Raw reference of a channel from its sampleSize most recent mature videos, optionally leaving
// one video out (the one being evaluated): median views (M, n videos) and median like rate (E, nL).
function rawReference(matureSorted, excludeId, params) {
  const views = [];
  const rates = [];
  let taken = 0;
  for (const v of matureSorted) {
    if (v.id === excludeId) continue;
    views.push(v.views);
    if (v.likes != null && v.views > 0) rates.push(v.likes / v.views);
    if (++taken === params.sampleSize) break;
  }
  return { M: median(views), n: views.length, E: median(rates), nL: rates.length };
}

/**
 * Final score from the two components. balance: 0 = only views, 1 = only likes.
 * The age decay is independent of the balance.
 */
export function combineScore({ sViews, sNote, ageDays }, balance = DEFAULTS.noteBalance, params = {}) {
  const p = { ...DEFAULTS, ...params };
  return p.scoreScale * ((1 - balance) * sViews + balance * sNote) - p.lambda * ageDays;
}

/**
 * channels: [{ id, subscriberCount, hiddenSubscriberCount }]
 * videos:   [{ id, channelId, views, likes (null when hidden), publishedAt (ISO), excluded }]
 * Returns one entry per eligible video of a known channel that is at least minVideoAgeHours old.
 * sViews: views component, sNote: like-rate component (0 when unknown), score: both combined.
 * M is the raw reference median (null when n = 0), R the smoothed reference actually used.
 */
export function computeScores({ channels, videos, now = Date.now(), params = {} }) {
  const p = { ...DEFAULTS, ...params };
  const channelById = new Map(channels.map((c) => [c.id, c]));

  const matureByChannel = new Map();
  const eligible = [];
  for (const v of videos) {
    if (v.excluded || !channelById.has(v.channelId)) continue;
    const t = Date.parse(v.publishedAt);
    const item = { ...v, t };
    eligible.push(item);
    if ((now - t) / DAY_MS >= p.minRefAgeDays) {
      if (!matureByChannel.has(v.channelId)) matureByChannel.set(v.channelId, []);
      matureByChannel.get(v.channelId).push(item);
    }
  }
  for (const list of matureByChannel.values()) list.sort((a, b) => b.t - a.t);

  const rawByChannel = new Map();
  for (const c of channels) {
    rawByChannel.set(c.id, rawReference(matureByChannel.get(c.id) || [], null, p));
  }

  const usable = (c) => !c.hiddenSubscriberCount && c.subscriberCount > 0;
  const ratios = channels
    .filter((c) => usable(c) && rawByChannel.get(c.id).n >= 10)
    .map((c) => rawByChannel.get(c.id).M / c.subscriberCount);
  const r = ratios.length ? median(ratios) : p.r0;
  const raws = channels.map((c) => rawByChannel.get(c.id));
  const globalM = median(raws.filter((x) => x.n > 0).map((x) => x.M));
  const globalE = median(raws.filter((x) => x.nL > 0).map((x) => x.E));

  const out = [];
  for (const v of eligible) {
    const c = channelById.get(v.channelId);
    const ageDays = Math.max(0, (now - v.t) / DAY_MS);
    if (ageDays * 24 < p.minVideoAgeHours) continue;
    const { M, n, E, nL } = rawReference(matureByChannel.get(v.channelId) || [], v.id, p);

    // views component
    const P = usable(c) ? r * c.subscriberCount : globalM;
    let R;
    if (n === 0) R = P;
    else if (P == null) R = M;
    else R = (n * M + p.m * P) / (n + p.m);

    const f = 1 - Math.exp(-ageDays / p.tau);
    const vproj = v.views / Math.max(f, p.fmin);
    const vprojSafe = Math.max(vproj, 1);
    if (!(R > 0)) R = vprojSafe; // nothing to compare with: neutral ratio
    const rho = vprojSafe / R;
    const sViews = Math.log(rho) + p.alpha * Math.log10(vprojSafe);

    // like-rate component: the video's rate (smoothed toward the channel's) over the channel's rate
    let Es;
    if (nL === 0) Es = globalE;
    else if (globalE == null) Es = E;
    else Es = (nL * E + p.m * globalE) / (nL + p.m);
    let sNote = 0;
    if (v.likes != null && v.views > 0 && Es > 0) {
      const rate = (v.likes + p.likeK * Es) / (v.views + p.likeK);
      sNote = Math.log(rate / Es);
    }

    out.push({
      id: v.id, channelId: v.channelId, rho, vproj, M, R, n, ageDays, sViews, sNote,
      score: combineScore({ sViews, sNote, ageDays }, p.noteBalance, p),
      confidence: confidenceFor(n),
    });
  }
  return out;
}
