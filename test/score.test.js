import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, exclusionReason, sizeOf, median, computeScores, combineScore, DEFAULTS } from '../score.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 16, 12);
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const vid = (id, channelId, views, daysAgo, extra = {}) => ({
  id, channelId, views, publishedAt: iso(daysAgo), duration: 600, excluded: null, ...extra,
});
// 10 mature videos at exactly `views` views make M = views, n = 10
const refVideos = (channelId, views, count = 10) =>
  Array.from({ length: count }, (_, i) => vid(`${channelId}-ref${i}`, channelId, views, 20 + i));

test('parseDuration handles h/m/s and edge cases', () => {
  assert.equal(parseDuration('PT3M'), 180);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('P1DT1H'), 90000);
  assert.equal(parseDuration(undefined), 0);
});

test('sizeOf buckets by duration', () => {
  assert.equal(sizeOf(181), 'short');
  assert.equal(sizeOf(599), 'short');
  assert.equal(sizeOf(600), 'medium');
  assert.equal(sizeOf(1800), 'medium');
  assert.equal(sizeOf(1801), 'long');
});

test('exclusionReason: shorts, lives, premieres, missing views', () => {
  const base = { duration: 600, views: 100, live: false };
  assert.equal(exclusionReason(base), null);
  assert.equal(exclusionReason({ ...base, duration: 180 }), 'short');
  assert.equal(exclusionReason({ ...base, duration: 181 }), null);
  assert.equal(exclusionReason({ ...base, live: true }), 'live');
  assert.equal(exclusionReason({ ...base, views: null }), 'nodata');
  assert.equal(exclusionReason({ ...base, views: undefined }), 'nodata');
  assert.equal(exclusionReason({ ...base, views: 0 }), null);
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 9, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('spec example 1: 50k views at 3 days, channel reference 10k', () => {
  const channels = [{ id: 'a', subscriberCount: 100000, hiddenSubscriberCount: false }];
  const videos = [...refVideos('a', 10000), vid('v', 'a', 50000, 3)];
  const r = computeScores({ channels, videos, now: NOW }).find((s) => s.id === 'v');
  assert.ok(Math.abs(r.vproj - 79100) < 300, `vproj ${r.vproj}`);
  assert.ok(Math.abs(r.rho - 7.9) < 0.1, `rho ${r.rho}`);
  assert.ok(Math.abs(r.score - 2.7) < 0.1, `score ${r.score}`);
  assert.equal(r.confidence, 'medium'); // n = 10
  assert.equal(r.M, 10000);
  assert.ok(Math.abs(r.R - 10000) < 1e-6);
});

test('spec example 2: 2.5M views on a 2M channel is behind the small one', () => {
  const channels = [
    { id: 'a', subscriberCount: 100000, hiddenSubscriberCount: false },
    { id: 'b', subscriberCount: 20000000, hiddenSubscriberCount: false },
  ];
  const videos = [
    ...refVideos('a', 10000), vid('small', 'a', 50000, 3),
    ...refVideos('b', 2000000), vid('big', 'b', 2500000, 3),
  ];
  const out = computeScores({ channels, videos, now: NOW });
  const big = out.find((s) => s.id === 'big');
  const small = out.find((s) => s.id === 'small');
  assert.ok(Math.abs(big.rho - 2.0) < 0.1, `rho ${big.rho}`);
  assert.ok(Math.abs(big.score - 1.6) < 0.1, `score ${big.score}`);
  assert.ok(small.score > big.score);
});

test('the evaluated video is excluded from its own reference', () => {
  const channels = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];
  // 10 old videos: nine at 1000, one at 1,000,000. Without self-exclusion the median stays 1000
  // but n would be 10; excluding the big one gives n = 9 -> low/medium boundary check on n.
  const videos = [...refVideos('a', 1000, 9), vid('big', 'a', 1000000, 10)];
  const r = computeScores({ channels, videos, now: NOW }).find((s) => s.id === 'big');
  assert.equal(r.n, 9);
});

test('confidence tiers use the n actually used', () => {
  const channels = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];
  const mk = (count) => computeScores({
    channels, now: NOW, videos: [...refVideos('a', 1000, count), vid('v', 'a', 1000, 1)],
  }).find((s) => s.id === 'v').confidence;
  assert.equal(mk(4), 'low');
  assert.equal(mk(5), 'medium');
  assert.equal(mk(14), 'medium');
  assert.equal(mk(15), 'high');
});

test('small channels are smoothed toward r * subscribers (n < 10 channels do not set r)', () => {
  const channels = [
    { id: 'big', subscriberCount: 100000, hiddenSubscriberCount: false },
    { id: 'tiny', subscriberCount: 10000, hiddenSubscriberCount: false },
  ];
  // big: M = 5000, n = 10 -> r = 0.05, so P(tiny) = 500. tiny has n = 2 videos at 50000.
  const videos = [
    ...refVideos('big', 5000),
    ...refVideos('tiny', 50000, 2), vid('t', 'tiny', 1000, 1),
  ];
  const r = computeScores({ channels, videos, now: NOW }).find((s) => s.id === 't');
  // R = (2*50000 + 5*500) / 7 = 14642.86
  const expectedR = (2 * 50000 + 5 * 500) / 7;
  const f = 1 - Math.exp(-1 / DEFAULTS.tau);
  const vproj = 1000 / f;
  assert.ok(Math.abs(r.rho - vproj / expectedR) < 0.01, `rho ${r.rho}`);
  assert.equal(r.confidence, 'low');
});

test('r0 fallback when no channel has n >= 10', () => {
  const channels = [{ id: 'a', subscriberCount: 100000, hiddenSubscriberCount: false }];
  const videos = [...refVideos('a', 5000, 3), vid('v', 'a', 5000, 1)];
  const r = computeScores({ channels, videos, now: NOW }).find((s) => s.id === 'v');
  const P = DEFAULTS.r0 * 100000; // 5000
  const R = (3 * 5000 + 5 * P) / 8;
  const vproj = 5000 / (1 - Math.exp(-1 / DEFAULTS.tau));
  assert.ok(Math.abs(r.rho - vproj / R) < 0.01);
});

test('hidden subscribers: P is the median of all channels M', () => {
  const channels = [
    { id: 'a', subscriberCount: 0, hiddenSubscriberCount: true },
    { id: 'b', subscriberCount: 1000, hiddenSubscriberCount: false },
    { id: 'c', subscriberCount: 1000, hiddenSubscriberCount: false },
  ];
  const videos = [
    ...refVideos('b', 2000), ...refVideos('c', 4000), // medians: 2000, 4000 -> median of M = 3000
    vid('v', 'a', 1000, 1), // channel a has n = 0
  ];
  const r = computeScores({ channels, videos, now: NOW }).find((s) => s.id === 'v');
  assert.equal(r.n, 0);
  assert.ok(Number.isFinite(r.score));
  const vproj = 1000 / (1 - Math.exp(-1 / DEFAULTS.tau));
  // n = 0 -> R = P = 3000
  assert.ok(Math.abs(r.rho - vproj / 3000) < 0.01, `rho ${r.rho}`);
});

test('no reference anywhere: finite score, low confidence', () => {
  const channels = [{ id: 'a', subscriberCount: 0, hiddenSubscriberCount: true }];
  const r = computeScores({ channels, videos: [vid('v', 'a', 500, 1)], now: NOW })[0];
  assert.ok(Number.isFinite(r.score));
  assert.ok(Number.isFinite(r.rho));
  assert.equal(r.confidence, 'low');
});

test('zero views and very fresh video stay finite', () => {
  const channels = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];
  const videos = [...refVideos('a', 1000), vid('zero', 'a', 0, 2), vid('fresh', 'a', 100, 0.3)];
  const out = computeScores({ channels, videos, now: NOW });
  for (const id of ['zero', 'fresh']) {
    const r = out.find((s) => s.id === id);
    assert.ok(Number.isFinite(r.score), id);
    assert.ok(Number.isFinite(r.rho), id);
  }
  const fresh = out.find((s) => s.id === 'fresh');
  assert.ok(Math.abs(fresh.vproj - 100 / DEFAULTS.fmin) < 1e-6); // floored
});

test('excluded videos are neither scored nor used as reference', () => {
  const channels = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];
  const videos = [
    ...refVideos('a', 1000, 6),
    vid('short', 'a', 9e9, 12, { excluded: 'short' }),
    vid('v', 'a', 1000, 1),
  ];
  const out = computeScores({ channels, videos, now: NOW });
  assert.equal(out.find((s) => s.id === 'short'), undefined);
  assert.equal(out.find((s) => s.id === 'v').n, 6);
});

test('reference only counts videos >= 7 days old and at most the 30 most recent', () => {
  const channels = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];
  const recent = Array.from({ length: 3 }, (_, i) => vid(`r${i}`, 'a', 9e6, 1 + i)); // too young
  const mature = Array.from({ length: 40 }, (_, i) => vid(`m${i}`, 'a', 1000, 8 + i));
  const out = computeScores({ channels, videos: [...recent, ...mature], now: NOW });
  assert.equal(out.find((s) => s.id === 'r0').n, 30);
});

test('videos from an unknown channel are skipped', () => {
  assert.deepEqual(computeScores({ channels: [], videos: [vid('v', 'ghost', 1, 1)], now: NOW }), []);
});

test('a video younger than 6 hours is not ranked yet, an older one is', () => {
  const channels = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];
  const videos = [...refVideos('a', 1000), vid('young', 'a', 500, 5 / 24), vid('ok', 'a', 500, 7 / 24)];
  const out = computeScores({ channels, videos, now: NOW });
  assert.equal(out.find((s) => s.id === 'young'), undefined);
  assert.ok(out.find((s) => s.id === 'ok'));
  const custom = computeScores({ channels, videos, now: NOW, params: { minVideoAgeHours: 0 } });
  assert.ok(custom.find((s) => s.id === 'young'));
});

// --- like rate ("note") ---
const liked = (channelId, views, likes, count = 10) =>
  Array.from({ length: count }, (_, i) => vid(`${channelId}-L${i}`, channelId, views, 20 + i, { likes }));
const chA = [{ id: 'a', subscriberCount: 1000, hiddenSubscriberCount: false }];

test('a better like rate than the channel norm raises the note component', () => {
  const videos = [
    ...liked('a', 1000, 50), // norm: 5 %
    vid('good', 'a', 1000, 2, { likes: 100 }),
    vid('bad', 'a', 1000, 2, { likes: 10 }),
  ];
  const out = computeScores({ channels: chA, videos, now: NOW });
  const good = out.find((s) => s.id === 'good');
  const bad = out.find((s) => s.id === 'bad');
  assert.ok(good.sNote > 0 && bad.sNote < 0);
  assert.equal(good.sViews, bad.sViews); // same views, same age
  assert.ok(good.score > bad.score);
});

test('hidden likes give a neutral note component', () => {
  const videos = [...liked('a', 1000, 50), vid('h', 'a', 1000, 2, { likes: null }), vid('u', 'a', 1000, 2)];
  const out = computeScores({ channels: chA, videos, now: NOW });
  assert.equal(out.find((s) => s.id === 'h').sNote, 0);
  assert.equal(out.find((s) => s.id === 'u').sNote, 0);
});

test('the like rate of a barely viewed video is pulled toward the channel norm', () => {
  const videos = [...liked('a', 1000, 50), vid('tiny', 'a', 10, 2, { likes: 3 })]; // 30 % on 10 views
  const r = computeScores({ channels: chA, videos, now: NOW }).find((s) => s.id === 'tiny');
  assert.ok(r.sNote > 0 && r.sNote < 0.5, `sNote ${r.sNote}`); // unsmoothed it would be ln(6) = 1.79
});

test('no like data anywhere: note component is 0 and finite', () => {
  const r = computeScores({ channels: chA, videos: [...refVideos('a', 1000), vid('v', 'a', 500, 2, { likes: 5 })], now: NOW })
    .find((s) => s.id === 'v');
  assert.equal(r.sNote, 0);
});

test('combineScore: balance moves weight between views and likes, default keeps views x1 + likes x0.5', () => {
  const parts = { sViews: 2, sNote: -1, ageDays: 0 };
  assert.ok(Math.abs(combineScore(parts, 0) - 3) < 1e-9);
  assert.ok(Math.abs(combineScore(parts, 1) - -1.5) < 1e-9);
  assert.ok(Math.abs(combineScore(parts) - (2 + 0.5 * -1)) < 1e-9);
  assert.ok(Math.abs(combineScore({ ...parts, ageDays: 10 }, 0.5) - (combineScore(parts, 0.5) - DEFAULTS.lambda * 10)) < 1e-9);
});
