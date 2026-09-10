// Turning the raw Spotify playlist list into the rotation: filter to tagged playlists
// the user owns, parse the tag, assign any missing order, cache the result.
//
// Cache-first is a hard requirement, not an optimisation: issue #4 makes every
// transition a full page reload, so the return trip must paint from localStorage
// instantly and revalidate behind it. Never block first paint on the network.

import { parseTag, setOrder } from './tag.js';
import { assignOrders, applyAssignments, sortForGrid } from './order.js';
import { getAllPlaylists, getMe, updatePlaylistDetails } from './api.js';
import { read, write, remove } from './storage.js';

const CACHE_KEY = 'playlists';
const CACHE_VERSION = 1;

/** Read the cached rotation. Synchronous, cheap, safe to call before anything else. */
export function readCache() {
  const cached = read(CACHE_KEY, null);
  if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.items)) return [];
  return cached.items;
}

export function writeCache(items) {
  write(CACHE_KEY, { version: CACHE_VERSION, updatedAt: Date.now(), items });
}

export function clearCache() {
  remove(CACHE_KEY);
}

/** The cached shape, deliberately small — exactly what the grid and the handoff need. */
export function toCacheEntry(playlist, tag) {
  return {
    id: playlist.id,
    uri: playlist.uri,
    name: playlist.name,
    image: playlist.images?.[0]?.url ?? null,
    trackTotal: playlist.tracks?.total ?? 0,
    order: tag.order,
    nofadein: tag.nofadein,
    // Kept so a later order write can splice into the exact text Spotify gave us.
    description: playlist.description ?? '',
    rewritable: tag.rewritable,
  };
}

export function selectTagged(playlists, userId) {
  const out = [];
  for (const p of playlists) {
    if (!p?.id) continue;
    if (userId && p.owner?.id !== userId) continue; // only playlists you own are writable
    const tag = parseTag(p.description);
    if (!tag.hasTag) continue;
    out.push(toCacheEntry(p, tag));
  }
  return out;
}

/**
 * Full refresh against the API.
 *
 * @param {object} opts
 * @param {(items: Array) => void} opts.onUpdate called whenever there is a better list
 *        to paint — once after filtering, and again after any orders are written back.
 * @param {(msg: string) => void} opts.onWarn non-fatal problems (e.g. a failed write).
 */
export async function refreshPlaylists({ onUpdate = () => {}, onWarn = () => {} } = {}) {
  const me = await getMe();
  const raw = await getAllPlaylists();
  let tagged = selectTagged(raw, me?.id);

  onUpdate(sortForGrid(tagged));

  // Fill in what's missing, never overwrite what's already there.
  const assignments = assignOrders(tagged);
  const written = [];
  for (const a of assignments) {
    const entry = tagged.find((p) => p.id === a.id);
    if (!entry?.rewritable) {
      onWarn(`"${a.name}": tag could not be located safely in the description, order not written`);
      continue;
    }
    const nextDescription = setOrder(entry.description, a.order);
    if (nextDescription === entry.description) {
      onWarn(`"${a.name}": description rewrite produced no change, order not written`);
      continue;
    }
    try {
      await updatePlaylistDetails(a.id, { name: entry.name, description: nextDescription });
      entry.description = nextDescription;
      written.push(a);
    } catch (e) {
      onWarn(`"${a.name}": could not write order:${a.order} — ${e.message}`);
    }
  }

  if (written.length) {
    tagged = applyAssignments(tagged, written);
  }

  const sorted = sortForGrid(tagged);
  writeCache(sorted);
  onUpdate(sorted);
  return sorted;
}
