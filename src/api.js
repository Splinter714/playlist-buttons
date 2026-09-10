// Spotify Web API calls. Read/write of playlist metadata only — this app never touches
// playback from the browser (the shortcut does that, see README and issue #4).

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

export function getMe() {
  return request('/me');
}

/**
 * Page through every playlist the user has. All of them — a tagged playlist can sit
 * anywhere in the list, so stopping early is not an option.
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

/**
 * Write a playlist's description back. `name` is sent unchanged alongside it: Spotify's
 * PUT for playlist details is happier with both fields present, and re-sending the
 * existing name is a no-op.
 */
export function updatePlaylistDetails(id, { name, description }) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = description;
  return request(`/playlists/${id}`, { method: 'PUT', body });
}
