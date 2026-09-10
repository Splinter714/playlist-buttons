import { describe, it, expect, beforeEach } from 'vitest';

// Minimal localStorage, because the marker's whole point is surviving the reload that
// every transition forces (#4) — reading it back from storage is the behaviour.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { readNowPlaying, recordNowPlaying, clearNowPlaying, resolveNowPlaying } =
  await import('../src/nowplaying.js');
const { hasCache, writeCache, clearCache, readCache } = await import('../src/playlists.js');

const p = (id, name = id) => ({ id, name });

beforeEach(() => store.clear());

describe('now-playing marker', () => {
  it('is empty before anything has been triggered', () => {
    expect(readNowPlaying()).toBe(null);
  });

  it('survives a reload — recorded once, read straight back out of storage', () => {
    recordNowPlaying('tavern', 1000);
    expect(readNowPlaying()).toEqual({ id: 'tavern', at: 1000 });
  });

  it('replaces the previous trigger rather than accumulating', () => {
    recordNowPlaying('tavern', 1000);
    recordNowPlaying('battle', 2000);
    expect(readNowPlaying()).toEqual({ id: 'battle', at: 2000 });
  });

  it('ignores an empty id', () => {
    recordNowPlaying('');
    expect(readNowPlaying()).toBe(null);
  });

  it('clears', () => {
    recordNowPlaying('tavern');
    clearNowPlaying();
    expect(readNowPlaying()).toBe(null);
  });
});

describe('resolveNowPlaying — the marker against the list actually rendered', () => {
  const items = [p('tavern'), p('battle'), p('travel')];

  it('marks the playlist that was last triggered', () => {
    expect(resolveNowPlaying(items, { id: 'battle' })).toBe('battle');
  });

  it('marks nothing when nothing has been triggered', () => {
    expect(resolveNowPlaying(items, null)).toBe(null);
  });

  it('marks nothing when the remembered playlist has left the rotation', () => {
    expect(resolveNowPlaying(items, { id: 'deleted' })).toBe(null);
  });

  it('marks nothing on an empty grid', () => {
    expect(resolveNowPlaying([], { id: 'battle' })).toBe(null);
  });

  it('round-trips against what was recorded', () => {
    recordNowPlaying('travel');
    expect(resolveNowPlaying(items, readNowPlaying())).toBe('travel');
  });
});

describe('hasCache — a genuine first load versus an empty rotation', () => {
  it('is false when nothing has ever been cached', () => {
    expect(hasCache()).toBe(false);
  });

  it('is true after caching an empty rotation — that is an answer, not a first load', () => {
    writeCache([]);
    expect(hasCache()).toBe(true);
    expect(readCache()).toEqual([]);
  });

  it('is true after caching playlists', () => {
    writeCache([p('tavern')]);
    expect(hasCache()).toBe(true);
  });

  it('is false again after the cache is cleared', () => {
    writeCache([p('tavern')]);
    clearCache();
    expect(hasCache()).toBe(false);
  });
});
