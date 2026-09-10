// Which playlist is playing, as far as this app knows.
//
// Deliberately local-only: the marker records what THIS app last triggered, written at
// tap time, so it is correct on the very first paint after the reload that issue #4's
// handoff forces. Asking Spotify would be more truthful but would arrive after the
// grid is already on screen, which is the one thing the marker must not do.
//
// Known tradeoff, accepted by Jackson (#2): change playlist from the Spotify app
// directly and this marker is wrong until the next tap here.

import { read, write, remove } from './storage.js';

const KEY = 'nowplaying';

/** @returns {{id: string, at: number}|null} */
export function readNowPlaying() {
  const v = read(KEY, null);
  if (!v || typeof v.id !== 'string') return null;
  return { id: v.id, at: Number(v.at) || 0 };
}

/**
 * Record a trigger. Called synchronously from the tile's click handler — it must never
 * await or preventDefault, because the navigation that follows is the link tap itself
 * and losing gesture attribution is what brings iOS's confirmation prompt back (#4).
 */
export function recordNowPlaying(id, now = Date.now()) {
  if (!id) return;
  write(KEY, { id, at: now });
}

export function clearNowPlaying() {
  remove(KEY);
}

/**
 * Resolve the stored record against the list actually being rendered.
 *
 * Returns the id only if that playlist is still in the rotation; a playlist that has
 * since been removed from the rotation, deleted or unfollowed leaves the grid with no
 * marker rather than a marker pointing at nothing.
 *
 * @param {Array<{id: string}>} items
 * @param {{id: string}|null} record
 * @returns {string|null}
 */
export function resolveNowPlaying(items, record) {
  const id = record?.id;
  if (!id || !Array.isArray(items)) return null;
  return items.some((p) => p?.id === id) ? id : null;
}
