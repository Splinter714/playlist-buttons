// Which playlist is playing, as far as this app knows.
//
// Deliberately local-only: the marker records what THIS app last triggered, written at
// tap time. That is what makes it instant — it moves to the tapped tile while the
// fade-out is still running (#13), seconds before the music actually changes. Asking
// Spotify would be more truthful but would arrive after the grid is already on screen,
// and during a fade it would still be reporting the OLD playlist.
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
 * Record a trigger. Called first thing in the tile's click handler, before the transition
 * is started, so the marker moves immediately.
 *
 * This used to carry a rule — never await, never preventDefault — that existed only to
 * protect the handoff into Shortcuts (#4). That handoff is gone (#13) and so is the rule.
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
