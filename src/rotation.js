// The rotation: which playlists are buttons, in what order, and which skip the fade-in.
//
// This is the SINGLE SOURCE OF TRUTH for membership (#9). It used to live in the Spotify
// playlist description as a `[game ...]` tag; that cannot work, because you cannot edit
// the description of a playlist you do not own, and the rotation has to include playlists
// that are followed rather than owned. So membership, order and `nofadein` are all local,
// and the app never writes to Spotify at all.
//
// Include-list polarity: nothing is in the rotation until it is added.
//
// Stored shape: an ORDERED array of `{id, nofadein}`. The array order IS the button
// order — there is no `order:N` any more, so there is nothing to collide, renumber or
// write back. Reordering is moving an array element (#3).

import { read, write, remove } from './storage.js';

// Versioned key on purpose. The pre-#9 storage carried tag-parsed order/nofadein, so a
// new key means anything of the old shape is ignored rather than misread.
export const ROTATION_KEY = 'rotation.v1';

/** Coerce whatever is in storage into a clean ordered list. First mention of an id wins. */
function normalize(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, nofadein: entry?.nofadein === true });
  }
  return out;
}

/** @returns {Array<{id: string, nofadein: boolean}>} in button order. */
export function readRotation() {
  return normalize(read(ROTATION_KEY, null));
}

/** Replace the whole rotation. Returns what was actually stored, after normalising. */
export function writeRotation(entries) {
  const clean = normalize(entries);
  write(ROTATION_KEY, clean);
  return clean;
}

export function clearRotation() {
  remove(ROTATION_KEY);
}

export function isInRotation(id, entries = readRotation()) {
  return entries.some((e) => e.id === id);
}

/** Append to the end. Adding something already in the rotation is a no-op. */
export function addToRotation(id, { nofadein = false } = {}) {
  const entries = readRotation();
  if (typeof id !== 'string' || !id || isInRotation(id, entries)) return entries;
  return writeRotation([...entries, { id, nofadein: nofadein === true }]);
}

export function removeFromRotation(id) {
  return writeRotation(readRotation().filter((e) => e.id !== id));
}

/**
 * Reorder to match an explicit sequence of ids — what a drag hands back (#3).
 *
 * Ids that are not in the rotation are ignored, and anything the sequence forgot keeps
 * its relative order at the end. A partial or stale list can therefore never drop a
 * playlist out of the rotation.
 */
export function reorderRotation(ids) {
  const entries = readRotation();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const ordered = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const entry = byId.get(id);
    if (!entry || ordered.includes(entry)) continue;
    ordered.push(entry);
  }
  for (const entry of entries) {
    if (!ordered.includes(entry)) ordered.push(entry);
  }
  return writeRotation(ordered);
}

/** Per-playlist fade-in override (#6). No-op for a playlist not in the rotation. */
export function setNofadein(id, nofadein) {
  const entries = readRotation();
  if (!isInRotation(id, entries)) return entries;
  return writeRotation(entries.map((e) => (e.id === id ? { ...e, nofadein: nofadein === true } : e)));
}

export function toggleNofadein(id) {
  const entry = readRotation().find((e) => e.id === id);
  return entry ? setNofadein(id, !entry.nofadein) : readRotation();
}

/**
 * Join the rotation against cached playlist metadata — this is what the grid renders.
 *
 * Rotation order wins; `nofadein` comes from the rotation, everything else (name, art,
 * uri, track count) from the cached `/me/playlists` result. A rotation entry with no
 * metadata is dropped rather than drawn as a nameless tile: it means the playlist was
 * deleted or unfollowed, or the cache has not landed yet on a first load.
 *
 * @param {Array<{id: string, nofadein: boolean}>} entries
 * @param {Array<{id: string}>} playlists
 */
export function joinRotation(entries, playlists) {
  const meta = new Map((Array.isArray(playlists) ? playlists : []).filter((p) => p?.id).map((p) => [p.id, p]));
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const p = meta.get(entry?.id);
    if (!p) continue;
    out.push({ ...p, nofadein: entry.nofadein === true });
  }
  return out;
}
