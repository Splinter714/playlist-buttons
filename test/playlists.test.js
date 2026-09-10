import { describe, it, expect, beforeEach } from 'vitest';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { selectPlaylists, toCacheEntry, readCache, hasCache, writeCache, clearCache, purgeLegacyStorage } =
  await import('../src/playlists.js');

const raw = (over = {}) => ({
  id: 'p1',
  uri: 'spotify:playlist:p1',
  name: 'Tavern',
  description: 'Cosy inn music.',
  images: [{ url: 'https://img/1.jpg' }],
  tracks: { total: 47 },
  owner: { id: 'jackson' },
  ...over,
});

beforeEach(() => store.clear());

describe('selectPlaylists — the candidate list, not the rotation (#9)', () => {
  it('flattens a playlist to the cache shape', () => {
    const [p] = selectPlaylists([raw()]);
    expect(p).toEqual({
      id: 'p1',
      uri: 'spotify:playlist:p1',
      name: 'Tavern',
      image: 'https://img/1.jpg',
      trackTotal: 47,
    });
  });

  it('keeps a playlist owned by someone else — the entire point of the change', () => {
    const [p] = selectPlaylists([raw({ owner: { id: 'someone-else' } })]);
    expect(p.id).toBe('p1');
  });

  it('keeps a playlist with no description at all', () => {
    expect(selectPlaylists([raw({ description: undefined })])).toHaveLength(1);
  });

  it('does not carry the description, an order or a nofadein into the cache', () => {
    const [p] = selectPlaylists([raw({ description: 'Cosy. [game order:2 nofadein]' })]);
    expect(p.description).toBeUndefined();
    expect(p.order).toBeUndefined();
    expect(p.nofadein).toBeUndefined();
  });

  it('keeps every playlist it is given, in the order Spotify returned them', () => {
    const out = selectPlaylists([raw({ id: 'a' }), raw({ id: 'b' }), raw({ id: 'c' })]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('survives missing images and tracks', () => {
    const [p] = selectPlaylists([raw({ images: undefined, tracks: undefined })]);
    expect(p).toMatchObject({ image: null, trackTotal: 0 });
  });

  it('skips null entries in the page (Spotify has been known to return them)', () => {
    expect(selectPlaylists([null, undefined, raw()])).toHaveLength(1);
  });

  it('skips an entry with no id', () => {
    expect(selectPlaylists([raw({ id: undefined })])).toEqual([]);
  });

  it('survives being handed nothing', () => {
    expect(selectPlaylists(undefined)).toEqual([]);
  });
});

describe('the cache', () => {
  it('round-trips', () => {
    writeCache([toCacheEntry(raw())]);
    expect(readCache()).toEqual([{
      id: 'p1', uri: 'spotify:playlist:p1', name: 'Tavern', image: 'https://img/1.jpg', trackTotal: 47,
    }]);
  });

  it('discards a cache written by the pre-#9 build rather than misreading it', () => {
    // The old build wrote version 1 under `pb.playlists`, holding tag-parsed entries.
    store.set('pb.playlists', JSON.stringify({
      version: 1,
      items: [{ id: 'p1', name: 'Tavern', order: 2, nofadein: true, description: '[game order:2 nofadein]' }],
    }));
    expect(hasCache()).toBe(false);
    expect(readCache()).toEqual([]);
  });

  it('clears the old key out so it cannot be mistaken for data later', () => {
    store.set('pb.playlists', JSON.stringify({ version: 1, items: [] }));
    purgeLegacyStorage();
    expect(store.has('pb.playlists')).toBe(false);
  });

  it('leaves the current cache alone when purging the old one', () => {
    writeCache([toCacheEntry(raw())]);
    purgeLegacyStorage();
    expect(readCache()).toHaveLength(1);
  });

  it('ignores a cache entry of the wrong shape', () => {
    store.set('pb.playlists.v2', JSON.stringify({ version: 2, items: 'nope' }));
    expect(hasCache()).toBe(false);
  });

  it('clears', () => {
    writeCache([toCacheEntry(raw())]);
    clearCache();
    expect(hasCache()).toBe(false);
  });
});
