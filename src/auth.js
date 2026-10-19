// Spotify Authorization Code flow with PKCE, entirely in the browser. No server, no
// client secret — see the note in config.js about why the client ID is public.
//
// Two things here were load-bearing for issue #4, and are now just sensible:
//   1. Tokens live in localStorage. That was because every transition reloaded the page;
//      it is now simply how a session survives a reload at all.
//   2. Refresh happens on load and on a timer rather than lazily at the moment of use.
//      The hard reason is gone — an `await` in the tap path used to risk losing gesture
//      attribution and bringing iOS's "Open in Shortcuts?" prompt back (#13 retired that
//      path) — but a background refresh still means a tap never waits on one, and
//      `api.js` recovers from a 401 anyway.

import {
  CLIENT_ID, SCOPES, AUTH_ENDPOINT, TOKEN_ENDPOINT,
  REFRESH_MARGIN_MS, REFRESH_CHECK_INTERVAL_MS, resolveRedirectUri,
} from './config.js';
import { read, write, remove } from './storage.js';

const AUTH_KEY = 'auth';
const VERIFIER_KEY = 'pkce_verifier';
const STATE_KEY = 'pkce_state';

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => UNRESERVED[b % UNRESERVED.length]).join('');
}

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

export function getAuth() {
  return read(AUTH_KEY, null);
}

export function isLoggedIn() {
  const a = getAuth();
  return Boolean(a && a.access_token);
}

/**
 * Synchronous token read. Deliberately does NOT check expiry or refresh — that is the
 * timer's job, and `request()` in api.js retries a 401 once.
 *
 * It existed for the tap path, which was forbidden to await (#4). That is no longer why
 * it is here: `request()` uses it per call, and the grid uses it to decide whether a tile
 * can do anything at all.
 */
export function getAccessTokenSync() {
  return getAuth()?.access_token ?? null;
}

export function logout() {
  remove(AUTH_KEY);
  remove(VERIFIER_KEY);
  remove(STATE_KEY);
}

function storeTokens(payload, previous = getAuth()) {
  const auth = {
    access_token: payload.access_token,
    // Spotify rotates refresh tokens; if this response did not carry one, keep the old.
    refresh_token: payload.refresh_token ?? previous?.refresh_token ?? null,
    expires_at: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    scope: payload.scope ?? previous?.scope ?? null,
  };
  write(AUTH_KEY, auth);
  return auth;
}

export async function beginLogin() {
  const verifier = randomString(64);
  const state = randomString(16);
  write(VERIFIER_KEY, verifier);
  write(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: resolveRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    state,
    scope: SCOPES.join(' '),
    // Always show Spotify's account/approval screen, even when the browser already has
    // a live Spotify session. Without this, logging in silently adopts whoever happens
    // to be signed in — which is wrong on a shared or previously-used device, and gives
    // no way to pick a different account.
    show_dialog: 'true',
  });
  location.assign(`${AUTH_ENDPOINT}?${params}`);
}

/**
 * Consume `?code=` / `?error=` on load and clean the URL up afterwards.
 * @returns {Promise<{handled: boolean, error?: string}>}
 */
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return { handled: false };

  const cleanUrl = () => history.replaceState({}, '', location.pathname);

  if (error) {
    cleanUrl();
    return { handled: true, error };
  }

  const expectedState = read(STATE_KEY, null);
  if (expectedState && params.get('state') !== expectedState) {
    cleanUrl();
    return { handled: true, error: 'state_mismatch' };
  }

  const verifier = read(VERIFIER_KEY, null);
  if (!verifier) {
    cleanUrl();
    return { handled: true, error: 'missing_verifier' };
  }

  try {
    const payload = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: resolveRedirectUri(),
      code_verifier: verifier,
    });
    storeTokens(payload);
    remove(VERIFIER_KEY);
    remove(STATE_KEY);
    cleanUrl();
    return { handled: true };
  } catch (e) {
    cleanUrl();
    return { handled: true, error: e.message };
  }
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `token request failed (${res.status})`);
  }
  return json;
}

let refreshInFlight = null;

export async function refreshTokens() {
  const auth = getAuth();
  if (!auth?.refresh_token) return null;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const payload = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: auth.refresh_token,
      });
      return storeTokens(payload, auth);
    } catch (e) {
      // A rejected refresh token is unrecoverable — force a fresh login rather than
      // sitting on a dead session.
      if (/invalid_grant/i.test(e.message)) logout();
      throw e;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function needsRefresh(auth = getAuth(), now = Date.now()) {
  if (!auth?.refresh_token) return false;
  return !auth.expires_at || auth.expires_at - now < REFRESH_MARGIN_MS;
}

export async function refreshIfNeeded() {
  if (!needsRefresh()) return getAuth();
  return refreshTokens();
}

/**
 * Background freshness. Runs once immediately and then on an interval, so a token is
 * always already fresh by the time a button is tapped.
 */
export function startRefreshTimer(onError = () => {}, onRefreshed = () => {}) {
  const tick = () => {
    const before = getAuth()?.access_token;
    refreshIfNeeded()
      .then((auth) => {
        // Only when the token actually changed. Every tile's href embeds the token at
        // render time, so a silent refresh leaves the grid holding a dead one and the
        // next tap 401s — invisible until the page has sat open for an hour.
        if (auth?.access_token && auth.access_token !== before) onRefreshed(auth);
      })
      .catch(onError);
  };
  tick();
  const id = setInterval(tick, REFRESH_CHECK_INTERVAL_MS);
  // A tab restored from the background may have sat there long enough for the token to
  // age out, and its interval was throttled while it was away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
  return () => clearInterval(id);
}
