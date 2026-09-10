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
// Stored shape: an ORDERED array of `{id, nofadein, inorder}`. The array order IS the
// button order — there is no `order:N` any more, so there is nothing to collide, renumber
// or write back. Reordering is moving an array element (#3).
//
// The two per-playlist flags are INDEPENDENT of each other, not one three-way setting:
//   nofadein (#6)  — start at full volume instead of ramping in.
//   inorder  (#10) — start at track 1 with shuffle off, instead of a random offset with
//                    shuffle on. Always track 1; deliberately not "resume where it left
//                    off", so a playlist opens the same way every time.
// Both default to false, and an entry stored before a flag existed simply reads as false —
// `normalize` decides that, so an old rotation never has to be migrated.

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
    out.push({ id, nofadein: entry?.nofadein === true, inorder: entry?.inorder === true });
  }
  return out;
}

/** @returns {Array<{id: string, nofadein: boolean, inorder: boolean}>} in button order. */
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
export function addToRotation(id, { nofadein = false, inorder = false } = {}) {
  const entries = readRotation();
  if (typeof id !== 'string' || !id || isInRotation(id, entries)) return entries;
  return writeRotation([...entries, { id, nofadein: nofadein === true, inorder: inorder === true }]);
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
 * Per-playlist "play in order" override (#10). No-op for a playlist not in the rotation.
 *
 * Independent of `nofadein`: setting one never touches the other.
 */
export function setInorder(id, inorder) {
  const entries = readRotation();
  if (!isInRotation(id, entries)) return entries;
  return writeRotation(entries.map((e) => (e.id === id ? { ...e, inorder: inorder === true } : e)));
}

export function toggleInorder(id) {
  const entry = readRotation().find((e) => e.id === id);
  return entry ? setInorder(id, !entry.inorder) : readRotation();
}

/**
 * Join the rotation against cached playlist metadata — this is what the grid renders.
 *
 * Rotation order wins; `nofadein` and `inorder` come from the rotation, everything else
 * (name, art, uri, track count) from the cached `/me/playlists` result. A rotation entry with no
 * metadata is dropped rather than drawn as a nameless tile: it means the playlist was
 * deleted or unfollowed, or the cache has not landed yet on a first load.
 *
 * @param {Array<{id: string, nofadein: boolean, inorder: boolean}>} entries
 * @param {Array<{id: string}>} playlists
 */
/**
 * The settings screen's list (#8): every playlist on the account, each marked with whether
 * it is already in the rotation, where it sits, and its `nofadein` / `inorder` flags.
 *
 * The opposite direction to joinRotation. That one starts from the rotation and drops
 * anything without metadata; this one starts from the candidate list and keeps everything,
 * because the whole point of the screen is showing what you could still add.
 *
 * @param {Array<{id: string}>} playlists the cached `/me/playlists` result
 * @param {Array<{id: string, nofadein: boolean, inorder: boolean}>} entries
 */
export function buildCandidates(playlists, entries = readRotation()) {
  const byId = new Map();
  (Array.isArray(entries) ? entries : []).forEach((e, i) => {
    if (e?.id) byId.set(e.id, { position: i + 1, nofadein: e.nofadein === true, inorder: e.inorder === true });
  });
  const out = [];
  for (const p of Array.isArray(playlists) ? playlists : []) {
    if (!p?.id) continue;
    const member = byId.get(p.id);
    out.push({
      ...p,
      inRotation: Boolean(member),
      position: member ? member.position : null,
      nofadein: member ? member.nofadein : false,
      inorder: member ? member.inorder : false,
    });
  }
  return out;
}

export function joinRotation(entries, playlists) {
  const meta = new Map((Array.isArray(playlists) ? playlists : []).filter((p) => p?.id).map((p) => [p.id, p]));
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const p = meta.get(entry?.id);
    if (!p) continue;
    out.push({ ...p, nofadein: entry.nofadein === true, inorder: entry.inorder === true });
  }
  return out;
}
