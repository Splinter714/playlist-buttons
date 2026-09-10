// Which of the main view's states to render. Pure — no DOM, no storage, no network.
//
// The interesting rule is the skeleton one. Nine grey tiles exist so that a genuine
// first load does not jump when the data lands; every later load paints from cache
// instantly and must NEVER show them (#2). "No cache at all" is therefore different
// from "a cache that says there is nothing tagged" — the second is a real answer and
// gets the real answer's screen.

export const SKELETON_COUNT = 9;

/**
 * @param {object} state
 * @param {boolean} state.loggedIn
 * @param {boolean} state.cachePresent  a cache entry exists (even an empty one)
 * @param {boolean} state.settled       a refresh has finished, successfully or not
 * @param {Array}   state.items         what we have to show right now
 * @returns {'signedout'|'grid'|'skeleton'|'empty'}
 */
export function resolveView({ loggedIn = false, cachePresent = false, settled = false, items = [] } = {}) {
  if (!loggedIn) return 'signedout';
  if (items.length) return 'grid';
  // Nothing to show. Skeleton only while a first-ever load is still in flight.
  if (!cachePresent && !settled) return 'skeleton';
  return 'empty';
}
