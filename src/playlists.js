// The playlist metadata cache: everything `GET /me/playlists` returns, flattened to the
// few fields the grid and the handoff need.
//
// Since #9 this is NOT the rotation. It is the candidate list — every playlist the user
// has, owned or followed — and the rotation (rotation.js) picks ids out of it. Nothing
// here filters, parses a tag, assigns an order or writes anything back.
//
// Cache-first is a hard requirement, not an optimisation: issue #4 makes every transition
// a full page reload, so the return trip must paint from localStorage instantly and
// revalidate behind it. Never block first paint on the network.

import { getAllPlaylists } from './api.js';
import { read, write, remove } from './storage.js';

// Versioned KEY, not just a version field: the pre-#9 cache held tag-parsed `order`,
// `nofadein`, `description` and `rewritable`, and only playlists the user owned. A new key
// means that shape is dropped on sight instead of being read as a rotation.
const CACHE_KEY = 'playlists.v2';
const CACHE_VERSION = 2;

// Storage left behind by the tag-based build. Cleared once so it does not sit there
// forever looking like data.
const LEGACY_KEYS = ['playlists'];

/** Read the cached playlist list. Synchronous, cheap, safe to call before anything else. */
export function readCache() {
  const cached = read(CACHE_KEY, null);
  if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.items)) return [];
  return cached.items;
}

/**
 * Whether a cache entry exists at all — distinct from it being empty.
 *
 * The grid needs the difference: no cache means a genuine first load and earns the
 * skeleton tiles, while a cache that has landed is a real answer and must paint the grid
 * (or the empty-rotation message) immediately instead (#2).
 */
export function hasCache() {
  const cached = read(CACHE_KEY, null);
  return Boolean(cached && cached.version === CACHE_VERSION && Array.isArray(cached.items));
}

export function writeCache(items) {
  write(CACHE_KEY, { version: CACHE_VERSION, updatedAt: Date.now(), items });
}

export function clearCache() {
  remove(CACHE_KEY);
}

/** Drop storage from before #9 so a stale shape cannot be misread later. */
export function purgeLegacyStorage() {
  for (const key of LEGACY_KEYS) remove(key);
}

/** The cached shape, deliberately small — exactly what the grid and the handoff need. */
export function toCacheEntry(playlist) {
  return {
    id: playlist.id,
    uri: playlist.uri,
    name: playlist.name,
    image: playlist.images?.[0]?.url ?? null,
    trackTotal: playlist.tracks?.total ?? 0,
  };
}

/**
 * Flatten a raw API page set. No filtering by owner and no tag parsing: a playlist the
 * user follows but does not own is a legitimate rotation candidate, which is the whole
 * point of #9.
 */
export function selectPlaylists(playlists) {
  const out = [];
  for (const p of Array.isArray(playlists) ? playlists : []) {
    if (!p?.id) continue;
    out.push(toCacheEntry(p));
  }
  return out;
}

/**
 * Full refresh against the API: fetch every playlist, cache it, hand it back. One request
 * path, no writes, nothing that can half-succeed.
 */
export async function refreshPlaylists() {
  const items = selectPlaylists(await getAllPlaylists());
  writeCache(items);
  return items;
}
