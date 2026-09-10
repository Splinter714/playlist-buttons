import { describe, it, expect } from 'vitest';
import { resolveView, SKELETON_COUNT } from '../src/view.js';

const p = (id) => ({ id, name: id });

describe('resolveView — which state the main view shows', () => {
  it('shows the sign-in prompt when logged out, whatever the cache says', () => {
    expect(resolveView({ loggedIn: false })).toBe('signedout');
    expect(resolveView({ loggedIn: false, cachePresent: true, items: [p('a')] })).toBe('signedout');
  });

  it('shows skeleton tiles on a genuine first load — no cache, nothing back yet', () => {
    expect(resolveView({ loggedIn: true, cachePresent: false, settled: false, items: [] })).toBe('skeleton');
  });

  it('nine skeleton tiles, so the 3-wide grid does not jump when data lands', () => {
    expect(SKELETON_COUNT).toBe(9);
  });

  it('never shows skeletons once a cache exists, even an empty one', () => {
    expect(resolveView({ loggedIn: true, cachePresent: true, settled: false, items: [] })).toBe('empty');
  });

  it('paints the grid straight from a populated cache, before any refresh', () => {
    expect(resolveView({ loggedIn: true, cachePresent: true, settled: false, items: [p('a')] })).toBe('grid');
  });

  it('drops the skeleton for the empty message once a first refresh comes back with nothing', () => {
    expect(resolveView({ loggedIn: true, cachePresent: false, settled: true, items: [] })).toBe('empty');
  });

  it('shows the grid once a first refresh comes back with playlists', () => {
    expect(resolveView({ loggedIn: true, cachePresent: false, settled: true, items: [p('a')] })).toBe('grid');
  });

  it('defaults to the sign-in prompt on an empty state object', () => {
    expect(resolveView()).toBe('signedout');
  });
});
