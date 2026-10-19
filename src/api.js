// Spotify Web API calls: playlist metadata, and — since #13 — playback.
//
// This file used to say READ ONLY, because the iOS shortcut owned the whole transition
// (#4). It doesn't any more. The fade, the playlist switch and the shuffle flag are all
// done from here now, through `PUT /me/player/*`, which is what retired the shortcut.
// See transition.js for why that became possible, and the README's "Why it's shaped
// this way".
//
// Still true: the app never writes anything to the user's LIBRARY. The rotation lives in
// localStorage (#9) and no playlist is ever edited. The writes below are all playback
// control — volume, shuffle, what's playing — not data.

import { API_BASE } from './config.js';
import { getAccessTokenSync, refreshTokens, logout } from './auth.js';

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', body, retryOn401 = true, rateLimitRetries = 2 } = {}) {
  const token = getAccessTokenSync();
  if (!token) throw new ApiError(401, 'not logged in');

  const res = await fetch(path.startsWith('http') ? path : API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retryOn401) {
    // The background timer should normally have prevented this. Recover once anyway.
    let refreshed = null;
    try {
      refreshed = await refreshTokens();
    } catch {
      refreshed = null;
    }
    if (!refreshed) {
      // Nothing to refresh with, or the refresh was rejected — the session is dead.
      logout();
      throw new ApiError(401, 'session expired — log in again');
    }
    return request(path, { method, body, retryOn401: false, rateLimitRetries });
  }

  if (res.status === 429 && rateLimitRetries > 0) {
    const waitS = Number(res.headers.get('Retry-After')) || 1;
    await sleep(Math.min(waitS, 10) * 1000);
    return request(path, { method, body, retryOn401, rateLimitRetries: rateLimitRetries - 1 });
  }

  if (res.status === 204) return null;

  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.message || `${method} ${path} failed (${res.status})`, json);
  }
  return json;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Page through every playlist the user has, owned or merely followed. All of them: since
 * #9 this is the candidate list the rotation is picked from (and #8's setup page renders),
 * so stopping early is not an option. Playlists that are followed but not owned are the
 * entire reason membership moved out of descriptions.
 */
export async function getAllPlaylists({ limit = 50, maxPages = 100 } = {}) {
  const items = [];
  let url = `/me/playlists?limit=${limit}&offset=0`;
  for (let page = 0; page < maxPages && url; page++) {
    const data = await request(url);
    if (!data) break;
    items.push(...(data.items ?? []).filter(Boolean));
    url = data.next || null;
  }
  return items;
}

// ---------------------------------------------------------------------------------
// Playback (#13)
// ---------------------------------------------------------------------------------
// All four go through `request()` above, so they inherit its 401-refresh and its 429
// backoff. That matters more here than it did for playlist reads: a transition is
// roughly 24 requests, and a fast series of taps is the one thing in this app that can
// plausibly reach Spotify's rate limit.

/**
 * The current playback state, or `null` when nothing is active (Spotify answers 204).
 *
 * Read for two things, both about the DEVICE rather than the track:
 *  - `device.volume_percent` — the level to fade from and restore to. The ramp is simply
 *    wrong without it: fading through absolute fractions assumes the device is at 100%,
 *    and from 60% the first "fade out" step would jump the volume UP.
 *  - `device.supports_volume` — whether this device accepts remote volume at all. A
 *    Spotify Connect device (the Mac) does; the iPhone app driving a Bluetooth speaker
 *    does not, because there Spotify sees the phone as the device and the speaker is
 *    only an output, so "volume" is iOS system volume. That case switches playlist at
 *    full volume instead (transition.js).
 */
export async function getPlayerState() {
  return request('/me/player');
}

/** `volume_percent` is an integer 0–100; anything else is a 400. */
export async function setVolume(percent) {
  const v = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
  return request(`/me/player/volume?volume_percent=${v}`, { method: 'PUT' });
}

/**
 * Shuffle on or off. Sent as the literal string `true`/`false` in the query — this is
 * the one Spotify rejects as `400 Bad format for parameter state` if it arrives as
 * anything else (found on device in #10, when a dictionary boolean reached it as 1/0).
 */
export async function setShuffle(state) {
  return request(`/me/player/shuffle?state=${state === true ? 'true' : 'false'}`, { method: 'PUT' });
}

/**
 * Start a context at a track position.
 *
 * Called BEFORE setShuffle, never after — see transition.js. Spotify does not guarantee
 * the order two Player writes are applied in, and shuffle-first lost the race on device.
 */
export async function startPlayback({ contextUri, position = 0 }) {
  return request('/me/player/play', {
    method: 'PUT',
    body: { context_uri: contextUri, offset: { position } },
  });
}
