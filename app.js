import { openCache, createMemoryCache } from './cache.js';
import { computeScores, DAY_MS } from './score.js';
import { createApi, ApiError } from './api.js';
import { planRefresh, runRefresh, readMeta } from './sync.js';
import * as auth from './auth.js';

const PERIODS = [3, 7, 14, 30];
const debug = new URLSearchParams(location.search).has('debug'); // ?debug shows the score inputs on each card
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const FLAG = 'cureyt.signedIn';
const PERIOD_KEY = 'cureyt.period';

const state = {
  cache: null,
  view: 'landing', // landing | loading | list
  signedIn: false,
  period: PERIODS.includes(+store.get(PERIOD_KEY)) ? +store.get(PERIOD_KEY) : 7,
  items: [], // scored, eligible videos with display data, sorted by score
  hasData: false,
  lastUpdated: null,
  refreshing: false,
  notice: null, // { text, action?, run? }
};

// ---------- tiny DOM helper (text is always set as text, never as HTML) ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// ---------- formatting ----------
const fmtViews = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const fmtRatio = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function timeAgo(ms, now = Date.now()) {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  return `il y a ${Math.round(hrs / 24)} j`;
}

function fmtDuration(sec) {
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const safeImg = (u) => (/^(https:\/\/|data:image\/)/.test(u || '') ? u : '');

// ---------- data ----------
async function loadFromCache() {
  const [channels, videos, meta] = await Promise.all([
    state.cache.getAll('channels'), state.cache.getAll('videos'), readMeta(state.cache),
  ]);
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const scores = computeScores({ channels, videos, now: Date.now() });
  state.items = scores
    .map((s) => ({ ...s, video: videoById.get(s.id), channel: channelById.get(s.channelId) }))
    .sort((a, b) => b.score - a.score);
  state.hasData = videos.length > 0;
  state.lastUpdated = Math.max(meta.lastFull || 0, meta.lastLight || 0) || null;
}

// ---------- rendering ----------
function renderNotice() {
  const el = $('notice');
  el.replaceChildren();
  el.hidden = !state.notice;
  if (!state.notice) return;
  el.append(h('span', {}, state.notice.text));
  if (state.notice.action) el.append(h('button', { type: 'button', class: 'btn small', onclick: state.notice.run }, state.notice.action));
}

function renderPeriods() {
  $('periods').replaceChildren(...PERIODS.map((d) => h('button', {
    type: 'button', class: 'period', 'aria-pressed': String(d === state.period),
    onclick: () => { state.period = d; store.set(PERIOD_KEY, d); renderPeriods(); renderList(); },
  }, `${d} j`)));
}

function renderUpdated() {
  const parts = [];
  if (state.refreshing) parts.push('Mise à jour…');
  else if (state.lastUpdated) parts.push(`mis à jour ${timeAgo(state.lastUpdated)}`);
  $('updated').textContent = parts.join(' · ');
  $('refresh').disabled = state.refreshing;
}

function card(item) {
  const { video, channel, rho, confidence, ageDays, vproj, M, R, n, score } = item;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  const hot = rho >= 2;
  return h('li', { class: 'card' },
    h('a', { class: 'thumb', href: url, target: '_blank', rel: 'noopener noreferrer', tabindex: '-1', 'aria-hidden': 'true' },
      h('img', { src: safeImg(video.thumb), alt: '', loading: 'lazy', width: '320', height: '180' }),
      h('span', { class: 'dur' }, fmtDuration(video.duration))),
    h('div', { class: 'body' },
      h('a', { class: 'title', href: url, target: '_blank', rel: 'noopener noreferrer' }, video.title),
      h('div', { class: 'meta' }, `${channel.title} · ${timeAgo(Date.parse(video.publishedAt))}`),
      h('div', { class: 'stats' },
        h('span', { class: 'views' }, `${fmtViews.format(video.views)} vues`),
        h('span', { class: `badge${hot ? ' hot' : ''}`, title: 'Vues projetées par rapport à la référence de la chaîne' }, `×${fmtRatio.format(rho)}`),
        confidence === 'low' ? h('span', { class: 'badge low', title: 'Peu de vidéos de référence pour cette chaîne' }, 'peu de données') : null),
      debug ? h('div', { class: 'debug' },
        `ρ ${rho.toFixed(2)} · Vproj ${Math.round(vproj)} · M ${M == null ? '-' : Math.round(M)} · R ${Math.round(R)} · n ${n} · S ${score.toFixed(2)} · ${ageDays.toFixed(1)} j`) : null));
}

function renderList() {
  const shown = state.items.filter((i) => i.ageDays <= state.period);
  $('cards').replaceChildren(...shown.map(card));
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  empty.replaceChildren();
  if (!shown.length) {
    const longer = PERIODS.find((d) => d > state.period);
    empty.append(`Aucune vidéo sur les ${state.period} derniers jours. `);
    if (longer) {
      empty.append(h('button', { type: 'button', class: 'btn small', onclick: () => {
        state.period = longer; store.set(PERIOD_KEY, longer); renderPeriods(); renderList();
      } }, `Essayer ${longer} jours`));
    }
  }
}

const G_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function renderLanding() {
  const signin = h('button', { type: 'button', class: 'gsi', id: 'signin', onclick: signIn });
  signin.insertAdjacentHTML('afterbegin', G_LOGO); // constant markup, no user data
  signin.append(h('span', {}, 'Se connecter avec Google'));
  // replaceChildren turns null into the text "null", so absent nodes are filtered out
  $('landing').replaceChildren(...[
    h('div', { class: 'hero' }, h('h1', {}, 'Cure', h('span', {}, 'Yt'))),
    h('p', { class: 'tagline' }, 'Curate your YouTube channels'),
    signin,
    auth.isConfigured() ? null : h('p', { class: 'warn' },
      "La connexion Google n'est pas encore configurée (identifiant client OAuth manquant dans config.js)."),
  ].filter(Boolean));
}

function render() {
  document.body.dataset.view = state.view;
  const showList = state.view === 'list';
  $('landing').hidden = state.view !== 'landing';
  $('loading').hidden = state.view !== 'loading';
  $('listview').hidden = !showList;
  $('controls').hidden = !showList;
  if (state.view === 'landing') renderLanding();
  if (showList) { renderPeriods(); renderList(); }
  renderUpdated();
  renderNotice();
}

function setView() {
  state.view = state.signedIn && state.hasData ? 'list' : 'landing';
}

// ---------- refresh ----------
function onProgress(p) {
  if (state.view === 'loading') {
    $('loading-text').textContent = p.phase === 'channels'
      ? `${p.done} / ${p.total} chaînes traitées`
      : `Mise à jour : ${p.done} / ${p.total} chaînes`;
    const bar = $('loading-bar');
    bar.max = Math.max(1, p.total);
    bar.value = p.done;
  } else {
    $('updated').textContent = `Mise à jour… ${p.done} / ${p.total}`;
  }
}

function describeError(e, manual) {
  const retry = () => startRefresh({ manual: true, force: true });
  if (e instanceof ApiError) {
    if (e.isQuota) return { text: 'Quota du jour atteint, réessayez demain. La liste affichée vient du cache.' };
    if (e.isAuth) {
      return manual
        ? { text: 'Connexion Google impossible ou refusée.', action: 'Réessayer', run: retry }
        : { text: 'Données à actualiser : reconnectez-vous pour lancer la mise à jour.', action: 'Rafraîchir', run: retry };
    }
    if (e.isNetwork) return { text: 'Erreur réseau, la liste affichée vient du cache.', action: 'Réessayer', run: retry };
    return { text: `Erreur YouTube (${e.status}${e.reason ? ' ' + e.reason : ''}).`, action: 'Réessayer', run: retry };
  }
  return { text: `Erreur inattendue : ${e.message}`, action: 'Réessayer', run: retry };
}

async function startRefresh({ manual = false, force = false, forceSubs = false } = {}) {
  if (state.refreshing) return;
  const plan = planRefresh(await readMeta(state.cache), Date.now(), { force, forceSubs });
  if (plan.mode === 'none' && !plan.subs) return;

  state.refreshing = true;
  state.notice = null;
  if (!state.hasData) state.view = 'loading';
  render();
  try {
    if (!state.hasData) $('loading-text').textContent = 'Connexion à YouTube…';
    await auth.requestToken();
    const api = createApi({ getToken: auth.getToken, refreshToken: auth.refreshToken });
    await runRefresh({ api, cache: state.cache, ...plan, onProgress });
  } catch (e) {
    state.notice = describeError(e, manual);
  } finally {
    state.refreshing = false;
    await loadFromCache();
    setView();
    render();
  }
}

// ---------- actions ----------
async function signIn() {
  if (!auth.isConfigured()) {
    state.notice = { text: "La connexion Google n'est pas configurée (voir README.md)." };
    return renderNotice();
  }
  state.notice = null;
  try {
    await auth.requestToken();
  } catch {
    state.notice = { text: 'Connexion Google annulée ou refusée.' };
    return renderNotice();
  }
  store.set(FLAG, '1');
  state.signedIn = true;
  startRefresh({ manual: true, force: true, forceSubs: true }); // also prunes channels of a previous account
}

function signOut() {
  $('menu').open = false;
  auth.forgetToken();
  store.set(FLAG, null);
  state.signedIn = false;
  state.notice = null;
  state.view = 'landing';
  render();
}

async function erase() {
  $('menu').open = false;
  if (!confirm('Effacer toutes les données locales et révoquer l\'accès Google ?')) return;
  auth.revoke();
  await state.cache.clearAll();
  store.set(FLAG, null);
  state.signedIn = false;
  state.hasData = false;
  state.items = [];
  state.lastUpdated = null;
  state.notice = null;
  state.view = 'landing';
  render();
}

// ---------- boot ----------
async function init() {
  $('refresh').addEventListener('click', () => startRefresh({ manual: true, force: true }));
  $('signout').addEventListener('click', signOut);
  $('erase').addEventListener('click', erase);
  document.addEventListener('click', (e) => { if (!$('menu').contains(e.target)) $('menu').open = false; });
  setInterval(renderUpdated, 60000);

  try {
    state.cache = await openCache();
  } catch {
    state.cache = createMemoryCache(); // IndexedDB unavailable (private mode...): works, but nothing persists
  }
  state.signedIn = store.get(FLAG) === '1';
  await loadFromCache();
  setView();
  render();
  if (auth.isConfigured()) auth.loadGis().catch(() => {});
  if (state.signedIn && state.hasData) startRefresh(); // automatic: only does something when the data is stale
}

init();
