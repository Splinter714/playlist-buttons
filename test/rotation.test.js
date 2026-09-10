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
  setNofadein, toggleNofadein, joinRotation, ROTATION_KEY,
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
