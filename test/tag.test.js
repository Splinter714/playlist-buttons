import { describe, it, expect } from 'vitest';
import { parseTag, hasGameTag, setOrder, decodeHtmlEntities } from '../src/tag.js';

describe('parseTag — canonical forms', () => {
  it('parses order and nofadein', () => {
    const t = parseTag('[game order:3 nofadein]');
    expect(t.hasTag).toBe(true);
    expect(t.order).toBe(3);
    expect(t.nofadein).toBe(true);
  });

  it('parses order alone', () => {
    const t = parseTag('[game order:3]');
    expect(t).toMatchObject({ hasTag: true, order: 3, nofadein: false });
  });

  it('parses a bare tag', () => {
    const t = parseTag('[game]');
    expect(t).toMatchObject({ hasTag: true, order: null, nofadein: false });
  });

  it('parses nofadein without an order', () => {
    const t = parseTag('[game nofadein]');
    expect(t).toMatchObject({ hasTag: true, order: null, nofadein: true });
  });

  it('does not care about field order', () => {
    const t = parseTag('[game nofadein order:12]');
    expect(t).toMatchObject({ hasTag: true, order: 12, nofadein: true });
  });

  it('is case insensitive', () => {
    expect(parseTag('[GAME ORDER:4 NOFADEIN]')).toMatchObject({ order: 4, nofadein: true });
  });

  it('tolerates extra whitespace', () => {
    expect(parseTag('[ game   order: 7   nofadein ]')).toMatchObject({ order: 7, nofadein: true });
  });

  it('handles multi-digit and zero orders', () => {
    expect(parseTag('[game order:0]').order).toBe(0);
    expect(parseTag('[game order:104]').order).toBe(104);
  });
});

describe('parseTag — text around the tag', () => {
  it('finds a tag at the end of a real description', () => {
    const t = parseTag('Late night driving stuff. [game order:3 nofadein]');
    expect(t).toMatchObject({ hasTag: true, order: 3, nofadein: true });
  });

  it('finds a tag at the start', () => {
    expect(parseTag('[game order:2] moody instrumental')).toMatchObject({ order: 2 });
  });

  it('finds a tag in the middle', () => {
    expect(parseTag('before [game order:9] after')).toMatchObject({ order: 9 });
  });

  it('ignores order-looking text outside the tag', () => {
    const t = parseTag('sorted in order:99 by vibe. [game order:1]');
    expect(t.order).toBe(1);
  });

  it('ignores a stray nofadein outside the tag', () => {
    expect(parseTag('nofadein please [game order:1]').nofadein).toBe(false);
  });
});

describe('parseTag — malformed and non-tags', () => {
  it.each([
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['just a normal description', 'no brackets'],
    ['[gaming session]', 'game must be a whole word'],
    ['[games]', 'plural is not the tag'],
    ['[gameorder:3]', 'no separator after game'],
    ['[not a game]', 'game is not the first word'],
    ['game order:3', 'no brackets at all'],
    ['[game order:3', 'unclosed bracket'],
  ])('rejects %j (%s)', (input) => {
    expect(hasGameTag(input)).toBe(false);
  });

  it.each([
    '[game order:]',
    '[game order:abc]',
    '[game order:-2]',
    '[game order]',
  ])('treats %s as tagged but unordered', (input) => {
    const t = parseTag(input);
    expect(t.hasTag).toBe(true);
    expect(t.order).toBe(null);
  });

  it('takes the first tag when there are two', () => {
    expect(parseTag('[game order:1] [game order:2]').order).toBe(1);
  });
});

describe('parseTag — HTML-escaped variants', () => {
  // Spotify has been observed handing descriptions back HTML-escaped. It is NOT yet
  // confirmed whether brackets survive a live write/read round trip — until that is
  // checked against a real account, the parser accepts both shapes.
  it.each([
    ['&#91;game order:3 nofadein&#93;', 'decimal numeric entities'],
    ['&#x5B;game order:3 nofadein&#x5D;', 'hex numeric entities'],
    ['&#x5b;game order:3 nofadein&#x5d;', 'lowercase hex entities'],
    ['&lsqb;game order:3 nofadein&rsqb;', 'named lsqb/rsqb'],
    ['&lbrack;game order:3 nofadein&rbrack;', 'named lbrack/rbrack'],
    ['&#091;game order:3 nofadein&#093;', 'zero-padded decimal'],
  ])('parses %s (%s)', (input) => {
    expect(parseTag(input)).toMatchObject({ hasTag: true, order: 3, nofadein: true, rewritable: true });
  });

  it('parses a mixed escaped/literal bracket pair', () => {
    expect(parseTag('&#91;game order:5]')).toMatchObject({ hasTag: true, order: 5 });
  });

  it('parses an escaped tag with escaped text around it', () => {
    const t = parseTag('Rock &amp; roll, loud. &#91;game order:8&#93;');
    expect(t).toMatchObject({ hasTag: true, order: 8, nofadein: false });
  });

  it('reads a double-escaped tag but marks it unsafe to rewrite', () => {
    const t = parseTag('&amp;#91;game order:6 nofadein&amp;#93;');
    expect(t).toMatchObject({ hasTag: true, order: 6, nofadein: true, rewritable: false });
  });

  it('escaped and unescaped forms agree', () => {
    const plain = parseTag('Vibes. [game order:3 nofadein]');
    const escaped = parseTag('Vibes. &#91;game order:3 nofadein&#93;');
    expect(escaped.order).toBe(plain.order);
    expect(escaped.nofadein).toBe(plain.nofadein);
    expect(escaped.hasTag).toBe(plain.hasTag);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeHtmlEntities('a &amp; b &#91;c&#x5D;')).toBe('a & b [c]');
  });

  it('leaves unknown entities alone', () => {
    expect(decodeHtmlEntities('&notarealentity; stays')).toBe('&notarealentity; stays');
  });

  it('unwinds double escaping', () => {
    expect(decodeHtmlEntities('&amp;#91;')).toBe('[');
  });

  it('is a no-op on plain text', () => {
    expect(decodeHtmlEntities('nothing to do here')).toBe('nothing to do here');
  });
});

describe('setOrder — surrounding text must survive exactly', () => {
  it('inserts an order into a bare tag', () => {
    expect(setOrder('[game]', 4)).toBe('[game order:4]');
  });

  it('inserts before an existing nofadein', () => {
    expect(setOrder('[game nofadein]', 2)).toBe('[game order:2 nofadein]');
  });

  it('preserves text before and after the tag byte for byte', () => {
    const before = 'Late night driving stuff. [game nofadein] — updated 2024. ';
    expect(setOrder(before, 3)).toBe('Late night driving stuff. [game order:3 nofadein] — updated 2024. ');
  });

  it('preserves escaped surrounding text and escaped brackets', () => {
    const before = 'Rock &amp; roll &#91;game nofadein&#93; &lt;loud&gt;';
    expect(setOrder(before, 7)).toBe('Rock &amp; roll &#91;game order:7 nofadein&#93; &lt;loud&gt;');
  });

  it('preserves unicode and emoji around the tag', () => {
    const before = 'café 🎧 vibes [game] — naïve';
    expect(setOrder(before, 1)).toBe('café 🎧 vibes [game order:1] — naïve');
  });

  it('replaces an existing order without disturbing anything else', () => {
    const before = 'stuff [game order:3 nofadein] more stuff';
    expect(setOrder(before, 11)).toBe('stuff [game order:11 nofadein] more stuff');
  });

  it('leaves an untagged description completely untouched', () => {
    const before = 'no tag in here at all';
    expect(setOrder(before, 5)).toBe(before);
  });

  it('refuses to rewrite a tag it can only read through decoding', () => {
    const before = '&amp;#91;game&amp;#93;';
    expect(setOrder(before, 5)).toBe(before);
  });

  it('ignores invalid order values', () => {
    expect(setOrder('[game]', -1)).toBe('[game]');
    expect(setOrder('[game]', 1.5)).toBe('[game]');
    expect(setOrder('[game]', null)).toBe('[game]');
  });

  it('handles a null description without throwing', () => {
    expect(setOrder(null, 3)).toBe('');
  });

  it('round-trips: what it writes, it can read back', () => {
    const written = setOrder('Chill stuff. [game nofadein]', 9);
    expect(parseTag(written)).toMatchObject({ order: 9, nofadein: true });
  });

  it('is idempotent', () => {
    const once = setOrder('desc [game] tail', 6);
    expect(setOrder(once, 6)).toBe(once);
  });
});
