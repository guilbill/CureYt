// Google Identity Services "token client": short-lived access token, kept in memory only.
import { CLIENT_ID } from './config.js';
import { ApiError } from './api.js';

export const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

let token = null;
let expiresAt = 0;
let client = null;
let inflight = null;
let pending = null;
let gisPromise = null;

export const isConfigured = () => !!CLIENT_ID && !CLIENT_ID.startsWith('YOUR_');
export const hasValidToken = () => !!token && Date.now() < expiresAt - 60000;

export function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new ApiError(0, 'gis_load', 'Google script not loaded')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

function ensureClient() {
  if (client) return client;
  client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      const p = pending;
      pending = null;
      if (!p) return;
      if (resp.error) return p.reject(new ApiError(401, resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) return p.reject(new ApiError(401, 'scope_not_granted'));
      token = resp.access_token;
      expiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
      p.resolve(token);
    },
    error_callback: (err) => {
      const p = pending;
      pending = null;
      if (p) p.reject(new ApiError(401, err?.type || 'token_error'));
    },
  });
  return client;
}

// Resolves with a token, from memory or from Google. Concurrent callers share one request.
export function requestToken() {
  if (hasValidToken()) return Promise.resolve(token);
  if (!isConfigured()) return Promise.reject(new ApiError(401, 'not_configured'));
  if (!inflight) {
    inflight = loadGis()
      .then(() => new Promise((resolve, reject) => {
        pending = { resolve, reject };
        ensureClient().requestAccessToken({ prompt: '' });
      }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export const getToken = () => requestToken();

export function refreshToken() {
  token = null;
  return requestToken();
}

export function forgetToken() {
  token = null;
  expiresAt = 0;
}

export function revoke() {
  const t = token;
  forgetToken();
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
}
