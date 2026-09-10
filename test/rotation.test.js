import { describe, it, expect, beforeEach, vi } from 'vitest';

// A real-enough localStorage: the rotation's entire job is being the thing that survives
// the reload every transition forces (#4), so the tests go through storage, not memory.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const {
  readRotation, writeRotation, clearRotation, isInRotation,
  addToRotation, removeFromRotation, reorderRotation,
  setNofadein, toggleNofadein, joinRotation, buildCandidates, ROTATION_KEY,
} = await import('../src/rotation.js');

const ids = (list = readRotation()) => list.map((e) => e.id);

beforeEach(() => store.clear());

describe('an empty rotation — include-list polarity', () => {
  it('starts empty: nothing is in the rotation until it is added', () => {
    expect(readRotation()).toEqual([]);
  });

  it('reports nothing as a member', () => {
    expect(isInRotation('tavern')).toBe(false);
  });

  it('survives junk in storage', () => {
    localStorage.setItem(`pb.${ROTATION_KEY}`, 'not json at all');
    expect(readRotation()).toEqual([]);
  });

  it('ignores a stored value of the wrong shape', () => {
    localStorage.setItem(`pb.${ROTATION_KEY}`, JSON.stringify({ tavern: true }));
    expect(readRotation()).toEqual([]);
  });
});

describe('add', () => {
  it('adds a playlist with fade-in on by default', () => {
    addToRotation('tavern');
    expect(readRotation()).toEqual([{ id: 'tavern', nofadein: false }]);
  });

  it('adds with nofadein set', () => {
    addToRotation('battle', { nofadein: true });
    expect(readRotation()).toEqual([{ id: 'battle', nofadein: true }]);
  });

  it('appends to the end, so the order is the order things were added', () => {
    addToRotation('tavern');
    addToRotation('battle');
    addToRotation('travel');
    expect(ids()).toEqual(['tavern', 'battle', 'travel']);
  });

  it('is a no-op for something already in the rotation', () => {
    addToRotation('tavern', { nofadein: true });
    addToRotation('tavern');
    expect(readRotation()).toEqual([{ id: 'tavern', nofadein: true }]);
  });

  it('refuses an empty or non-string id', () => {
    addToRotation('');
    addToRotation(null);
    addToRotation(7);
    expect(readRotation()).toEqual([]);
  });
});

describe('remove', () => {
  beforeEach(() => {
    writeRotation([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('removes one and leaves the rest in order', () => {
    removeFromRotation('b');
    expect(ids()).toEqual(['a', 'c']);
  });

  it('does nothing for an id that is not in the rotation', () => {
    removeFromRotation('nope');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('can empty the rotation completely', () => {
    for (const id of ['a', 'b', 'c']) removeFromRotation(id);
    expect(readRotation()).toEqual([]);
  });

  it('leaves nothing behind that a re-add would inherit', () => {
    setNofadein('b', true);
    removeFromRotation('b');
    addToRotation('b');
    expect(readRotation().find((e) => e.id === 'b')).toEqual({ id: 'b', nofadein: false });
  });
});

describe('reorder', () => {
  beforeEach(() => {
    writeRotation([{ id: 'a' }, { id: 'b', nofadein: true }, { id: 'c' }]);
  });

  it('reorders to match the ids it is given', () => {
    reorderRotation(['c', 'a', 'b']);
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('carries each playlist nofadein along with it', () => {
    reorderRotation(['b', 'c', 'a']);
    expect(readRotation()[0]).toEqual({ id: 'b', nofadein: true });
  });

  it('appends anything the list forgot rather than dropping it', () => {
    reorderRotation(['c']);
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('ignores ids that are not in the rotation', () => {
    reorderRotation(['ghost', 'b', 'a', 'c']);
    expect(ids()).toEqual(['b', 'a', 'c']);
  });

  it('ignores a repeated id', () => {
    reorderRotation(['b', 'b', 'a']);
    expect(ids()).toEqual(['b', 'a', 'c']);
  });

  it('survives being handed nothing', () => {
    reorderRotation(undefined);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });
});

describe('nofadein', () => {
  beforeEach(() => {
    writeRotation([{ id: 'a' }, { id: 'b' }]);
  });

  it('sets the flag on one playlist only', () => {
    setNofadein('a', true);
    expect(readRotation()).toEqual([{ id: 'a', nofadein: true }, { id: 'b', nofadein: false }]);
  });

  it('clears it again', () => {
    setNofadein('a', true);
    setNofadein('a', false);
    expect(readRotation()[0].nofadein).toBe(false);
  });

  it('toggles', () => {
    toggleNofadein('b');
    expect(readRotation()[1].nofadein).toBe(true);
    toggleNofadein('b');
    expect(readRotation()[1].nofadein).toBe(false);
  });

  it('does not change the order', () => {
    setNofadein('b', true);
    expect(ids()).toEqual(['a', 'b']);
  });

  it('does nothing for a playlist that is not in the rotation', () => {
    setNofadein('ghost', true);
    expect(readRotation()).toEqual([{ id: 'a', nofadein: false }, { id: 'b', nofadein: false }]);
  });
});

describe('across a reload — the whole reason this is in localStorage (#4)', () => {
  it('keeps membership, order and nofadein when the module is loaded fresh', async () => {
    addToRotation('tavern');
    addToRotation('battle');
    addToRotation('travel');
    reorderRotation(['travel', 'tavern', 'battle']);
    setNofadein('tavern', true);

    // A fresh module instance reading the same storage is what a page reload is: the
    // rotation holds nothing in memory, so everything has to come back off the disk.
    vi.resetModules();
    const reloaded = await import('../src/rotation.js');
    expect(reloaded.readRotation()).toEqual([
      { id: 'travel', nofadein: false },
      { id: 'tavern', nofadein: true },
      { id: 'battle', nofadein: false },
    ]);
  });

  it('clears completely when asked', () => {
    addToRotation('tavern');
    clearRotation();
    expect(readRotation()).toEqual([]);
  });
});

describe('joinRotation — rotation order over cached metadata', () => {
  const meta = [
    { id: 'battle', name: 'Battle', image: 'b.jpg', trackTotal: 12 },
    { id: 'tavern', name: 'Tavern', image: 't.jpg', trackTotal: 47 },
    { id: 'travel', name: 'Travel', image: null, trackTotal: 3 },
  ];

  it('returns the playlists in rotation order, not API order', () => {
    const out = joinRotation([{ id: 'travel' }, { id: 'battle' }], meta);
    expect(out.map((p) => p.id)).toEqual(['travel', 'battle']);
  });

  it('takes name and art from the cache and nofadein from the rotation', () => {
    const [p] = joinRotation([{ id: 'tavern', nofadein: true }], meta);
    expect(p).toEqual({ id: 'tavern', name: 'Tavern', image: 't.jpg', trackTotal: 47, nofadein: true });
  });

  it('drops a rotation entry with no metadata — deleted, unfollowed, or cache not landed', () => {
    expect(joinRotation([{ id: 'ghost' }, { id: 'battle' }], meta).map((p) => p.id)).toEqual(['battle']);
  });

  it('returns nothing on an empty rotation, however many playlists exist', () => {
    expect(joinRotation([], meta)).toEqual([]);
  });

  it('returns nothing when the metadata cache is empty — that is the first-load case', () => {
    expect(joinRotation([{ id: 'battle' }], [])).toEqual([]);
  });

  it('does not include playlists that are merely on the account', () => {
    const out = joinRotation([{ id: 'battle' }], meta);
    expect(out).toHaveLength(1);
  });

  it('survives missing arguments', () => {
    expect(joinRotation(null, null)).toEqual([]);
  });

  it('joins what was actually stored', () => {
    addToRotation('travel');
    addToRotation('tavern', { nofadein: true });
    expect(joinRotation(readRotation(), meta).map((p) => [p.name, p.nofadein]))
      .toEqual([['Travel', false], ['Tavern', true]]);
  });
});

describe('buildCandidates — the settings screen list (#8)', () => {
  const meta = [
    { id: 'battle', name: 'Battle', image: 'b.jpg', trackTotal: 12 },
    { id: 'tavern', name: 'Tavern', image: 't.jpg', trackTotal: 47 },
    { id: 'travel', name: 'Travel', image: null, trackTotal: 3 },
  ];

  it('lists EVERY playlist on the account, not just the rotation', () => {
    writeRotation([{ id: 'tavern' }]);
    expect(buildCandidates(meta).map((c) => c.id)).toEqual(['battle', 'tavern', 'travel']);
  });

  it('keeps the account order, so the list does not reshuffle as things are added', () => {
    writeRotation([{ id: 'travel' }, { id: 'battle' }]);
    expect(buildCandidates(meta).map((c) => c.id)).toEqual(['battle', 'tavern', 'travel']);
  });

  it('marks which ones are already in the rotation', () => {
    writeRotation([{ id: 'travel' }, { id: 'battle' }]);
    const inRotation = Object.fromEntries(buildCandidates(meta).map((c) => [c.id, c.inRotation]));
    expect(inRotation).toEqual({ battle: true, tavern: false, travel: true });
  });

  it('numbers members by their place in the rotation, not their place in the list', () => {
    writeRotation([{ id: 'travel' }, { id: 'battle' }]);
    const position = Object.fromEntries(buildCandidates(meta).map((c) => [c.id, c.position]));
    expect(position).toEqual({ battle: 2, tavern: null, travel: 1 });
  });

  it('carries each member nofadein flag through', () => {
    writeRotation([{ id: 'battle', nofadein: true }, { id: 'tavern' }]);
    const flags = Object.fromEntries(buildCandidates(meta).map((c) => [c.id, c.nofadein]));
    expect(flags).toEqual({ battle: true, tavern: false, travel: false });
  });

  it('carries the metadata the rows draw with', () => {
    writeRotation([]);
    const [battle] = buildCandidates(meta);
    expect(battle.name).toBe('Battle');
    expect(battle.image).toBe('b.jpg');
    expect(battle.trackTotal).toBe(12);
  });

  it('reads the stored rotation when none is passed', () => {
    addToRotation('tavern');
    expect(buildCandidates(meta).find((c) => c.id === 'tavern').inRotation).toBe(true);
  });

  it('says nothing is in the rotation when the rotation is empty', () => {
    expect(buildCandidates(meta, []).every((c) => !c.inRotation && c.position === null)).toBe(true);
  });

  it('ignores a rotation entry with no matching playlist', () => {
    expect(buildCandidates(meta, [{ id: 'ghost' }, { id: 'battle' }])
      .find((c) => c.id === 'battle').position).toBe(2);
  });

  it('survives missing arguments', () => {
    expect(buildCandidates(null, null)).toEqual([]);
  });
});

describe('what the settings screen actually does to the rotation', () => {
  const meta = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), trackTotal: 1 }));
  const positions = () => Object.fromEntries(buildCandidates(meta).map((c) => [c.id, c.position]));

  it('a tap on a playlist that is not in the rotation appends it to the end', () => {
    addToRotation('c');
    addToRotation('a');
    expect(positions()).toEqual({ a: 2, b: null, c: 1, d: null });
    addToRotation('d');
    expect(positions().d).toBe(3);
  });

  it('a tap on a member removes it, from any position, and renumbers the rest', () => {
    for (const id of ['a', 'b', 'c', 'd']) addToRotation(id);
    removeFromRotation('a'); // first
    expect(positions()).toEqual({ a: null, b: 1, c: 2, d: 3 });
    removeFromRotation('c'); // middle
    expect(positions()).toEqual({ a: null, b: 1, c: null, d: 2 });
    removeFromRotation('d'); // last
    expect(positions()).toEqual({ a: null, b: 1, c: null, d: null });
  });

  it('re-adding after a removal puts it back on the end, not where it was', () => {
    for (const id of ['a', 'b', 'c']) addToRotation(id);
    removeFromRotation('a');
    addToRotation('a');
    expect(ids()).toEqual(['b', 'c', 'a']);
  });

  it('the full-volume toggle round-trips through storage', () => {
    addToRotation('b');
    expect(buildCandidates(meta).find((c) => c.id === 'b').nofadein).toBe(false);
    toggleNofadein('b');
    expect(buildCandidates(meta).find((c) => c.id === 'b').nofadein).toBe(true);
    // Re-read from storage, exactly as the next page load does.
    expect(readRotation()).toEqual([{ id: 'b', nofadein: true }]);
    toggleNofadein('b');
    expect(readRotation()).toEqual([{ id: 'b', nofadein: false }]);
  });

  it('the full-volume toggle does nothing for a playlist that is not a member', () => {
    toggleNofadein('b');
    expect(readRotation()).toEqual([]);
  });

  it('toggling one member leaves the others alone', () => {
    for (const id of ['a', 'b', 'c']) addToRotation(id);
    toggleNofadein('b');
    expect(readRotation()).toEqual([
      { id: 'a', nofadein: false },
      { id: 'b', nofadein: true },
      { id: 'c', nofadein: false },
    ]);
  });
});
