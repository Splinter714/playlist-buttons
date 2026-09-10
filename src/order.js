// Order assignment and grid ordering. Pure — no DOM, no network, no storage.
//
// Governing rule (issue #1, Jackson's words): fill in what's missing, never overwrite
// what's already there. So: a tagged playlist with no `order:` gets the next free
// integer; a playlist that already has one is never renumbered here, not even when two
// of them collide. Collisions are broken for display only, leaving both descriptions
// alone until something is actually dragged (issue #3).

const FIRST_ORDER = 1;

/**
 * Deterministic name comparison. Deliberately avoids `localeCompare` without an
 * explicit locale, which can order differently between environments — the grid must
 * come out identical on the phone and on the laptop.
 */
export function compareNames(a, b) {
  const an = String(a?.name ?? '');
  const bn = String(b?.name ?? '');
  const al = an.toLowerCase();
  const bl = bn.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (an !== bn) return an < bn ? -1 : 1;
  const ai = String(a?.id ?? '');
  const bi = String(b?.id ?? '');
  if (ai !== bi) return ai < bi ? -1 : 1;
  return 0;
}

/**
 * Work out which playlists need an `order:` written into their description.
 *
 * @param {Array<{id: string, name: string, order: number|null}>} playlists
 * @returns {Array<{id: string, name: string, order: number}>} only the newly assigned
 *          ones, in the order they were assigned (name order).
 */
export function assignOrders(playlists) {
  const taken = new Set();
  for (const p of playlists) {
    if (Number.isSafeInteger(p?.order)) taken.add(p.order);
  }

  const unassigned = playlists
    .filter((p) => !Number.isSafeInteger(p?.order))
    .slice()
    .sort(compareNames);

  const assignments = [];
  let next = FIRST_ORDER;
  for (const p of unassigned) {
    while (taken.has(next)) next++;
    taken.add(next);
    assignments.push({ ...p, order: next });
    next++;
  }
  return assignments;
}

/**
 * Apply the result of `assignOrders` back onto the list, without mutating the input.
 */
export function applyAssignments(playlists, assignments) {
  const byId = new Map(assignments.map((a) => [a.id, a.order]));
  return playlists.map((p) => (byId.has(p.id) ? { ...p, order: byId.get(p.id) } : p));
}

/**
 * Final grid ordering. Ties on the same `order:N` fall back to name, then id, so the
 * grid is stable across reloads even while two playlists disagree about their slot.
 * Anything still without an order sorts to the end (a description write that failed).
 */
export function sortForGrid(playlists) {
  return playlists.slice().sort((a, b) => {
    const ao = Number.isSafeInteger(a?.order) ? a.order : Number.MAX_SAFE_INTEGER;
    const bo = Number.isSafeInteger(b?.order) ? b.order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return compareNames(a, b);
  });
}
