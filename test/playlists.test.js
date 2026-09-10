import { describe, it, expect } from 'vitest';
import { selectTagged } from '../src/playlists.js';

const raw = (over = {}) => ({
  id: 'p1',
  uri: 'spotify:playlist:p1',
  name: 'Tavern',
  description: 'Cosy inn music. [game order:2 nofadein]',
  images: [{ url: 'https://img/1.jpg' }],
  tracks: { total: 47 },
  owner: { id: 'jackson' },
  ...over,
});

describe('selectTagged', () => {
  it('keeps a tagged playlist and flattens it to the cache shape', () => {
    const [p] = selectTagged([raw()], 'jackson');
    expect(p).toMatchObject({
      id: 'p1',
      uri: 'spotify:playlist:p1',
      name: 'Tavern',
      image: 'https://img/1.jpg',
      trackTotal: 47,
      order: 2,
      nofadein: true,
    });
  });

  it('keeps the raw description so a later order write can splice into it', () => {
    const [p] = selectTagged([raw()], 'jackson');
    expect(p.description).toBe('Cosy inn music. [game order:2 nofadein]');
  });

  it('drops untagged playlists', () => {
    expect(selectTagged([raw({ description: 'just music' })], 'jackson')).toEqual([]);
  });

  it('drops playlists owned by someone else', () => {
    expect(selectTagged([raw({ owner: { id: 'someone-else' } })], 'jackson')).toEqual([]);
  });

  it('keeps an escaped tag from another user? no — ownership wins over the tag', () => {
    const p = raw({ owner: { id: 'other' }, description: '&#91;game order:1&#93;' });
    expect(selectTagged([p], 'jackson')).toEqual([]);
  });

  it('handles an escaped description', () => {
    const [p] = selectTagged([raw({ description: 'Rock &amp; roll &#91;game order:5&#93;' })], 'jackson');
    expect(p).toMatchObject({ order: 5, nofadein: false });
  });

  it('survives missing images, tracks and description', () => {
    const p = raw({ images: undefined, tracks: undefined, description: '[game]' });
    const [out] = selectTagged([p], 'jackson');
    expect(out).toMatchObject({ image: null, trackTotal: 0, order: null });
  });

  it('skips null entries in the page (Spotify has been known to return them)', () => {
    expect(selectTagged([null, undefined, raw()], 'jackson')).toHaveLength(1);
  });
});
