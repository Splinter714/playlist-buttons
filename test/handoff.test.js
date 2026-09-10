import { describe, it, expect, beforeEach } from 'vitest';

// Same real-enough localStorage as the other suites: the token and the fade setting both
// come out of storage, and the whole point of storage here is surviving the reload that
// every transition forces (#4).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const {
  buildTileHref, resolveTileLink, buildHandoffPayload, buildHandoffUrl,
  pickOffset, appReturnUrl, consumeHandoffError,
  SHORTCUT_NAME, HANDOFF_ENDPOINT, ERROR_PARAM,
} = await import('../src/handoff.js');
const { SETTINGS_KEY } = await import('../src/settings.js');

const TOKEN = 'BQC-fake+token/with=padding';
const RETURN = 'https://splinter714.github.io/playlist-buttons/';

const tavern = {
  id: '4kQrPlaylistId',
  uri: 'spotify:playlist:4kQrPlaylistId',
  name: 'Tavern',
  trackTotal: 120,
  nofadein: false,
};

/** The query of a `shortcuts://` URL — sliced rather than parsed, since the scheme is odd. */
const query = (href) => new URLSearchParams(href.slice(href.indexOf('?') + 1));
const payloadOf = (href) => JSON.parse(query(href).get('text'));

const href = (playlist = tavern, options = {}) =>
  buildTileHref(playlist, { token: TOKEN, returnUrl: RETURN, ...options });

beforeEach(() => store.clear());

describe('the handoff URL (#4) — what a tile actually points at', () => {
  it('runs the PlaylistButtons shortcut with text input', () => {
    const q = query(href());
    expect(href().startsWith(`${HANDOFF_ENDPOINT}?`)).toBe(true);
    expect(q.get('name')).toBe(SHORTCUT_NAME);
    expect(q.get('input')).toBe('text');
  });

  it('carries exactly the six contract fields the shortcut unpacks (#10 added shuffle)', () => {
    const payload = payloadOf(href());
    expect(Object.keys(payload).sort()).toEqual(
      ['context_uri', 'downMs', 'offset', 'shuffle', 'token', 'upMs'],
    );
  });

  it('carries the same six fields for an in-order playlist — one contract, not two', () => {
    const payload = payloadOf(href({ ...tavern, inorder: true }));
    expect(Object.keys(payload).sort()).toEqual(
      ['context_uri', 'downMs', 'offset', 'shuffle', 'token', 'upMs'],
    );
  });

  it('passes the playlist URI and the token through untouched', () => {
    const payload = payloadOf(href());
    expect(payload.context_uri).toBe('spotify:playlist:4kQrPlaylistId');
    expect(payload.token).toBe(TOKEN);
  });

  it('percent-encodes the payload rather than dropping raw JSON into the query', () => {
    const raw = href();
    // A `+` or `/` from a token, or a `"` from the JSON, would end the value or be
    // silently reinterpreted if it went in unencoded.
    expect(raw).not.toContain('"');
    expect(raw).not.toContain('{');
    expect(raw).toContain('%22'); // the JSON's quotes
    expect(raw).toContain('%2B'); // the token's `+`
  });

  it('returns to the app on success and to the app with ?err=1 on failure', () => {
    const q = query(href());
    expect(q.get('x-success')).toBe(RETURN);
    expect(q.get('x-error')).toBe(`${RETURN}?${ERROR_PARAM}=1`);
    // Encoded in the URL itself — an unencoded `:` or `&` here would break the callback.
    expect(href()).toContain(encodeURIComponent(RETURN));
  });

  it('defaults the return URL to the app itself, with no query and no hash', () => {
    expect(appReturnUrl({
      origin: 'https://splinter714.github.io',
      pathname: '/playlist-buttons/',
      search: '?err=1',
      hash: '#settings',
    })).toBe(RETURN);
  });
});

describe('fade values come from settings and the playlist (#5/#6)', () => {
  it('uses the stored fade for both directions by default', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: 4500 }));
    const payload = payloadOf(href());
    expect(payload.downMs).toBe(4500);
    expect(payload.upMs).toBe(4500);
  });

  it('falls back to the 3s default when nothing is stored', () => {
    const payload = payloadOf(href());
    expect(payload.downMs).toBe(3000);
    expect(payload.upMs).toBe(3000);
  });

  it('sends upMs: 0 for a playlist marked nofadein — still fading OUT', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: 2000 }));
    const payload = payloadOf(href({ ...tavern, nofadein: true }));
    expect(payload.downMs).toBe(2000);
    expect(payload.upMs).toBe(0);
  });
});

describe('shuffle and the start offset (#10)', () => {
  it('shuffles from a random offset by default — nothing about this changed', () => {
    const payload = payloadOf(href(tavern, { random: () => 0.5 }));
    expect(payload.shuffle).toBe(true);
    expect(payload.offset).toBe(60);
  });

  it('sends offset 0 and shuffle false for an in-order playlist', () => {
    const payload = payloadOf(href({ ...tavern, inorder: true }, { random: () => 0.5 }));
    expect(payload.offset).toBe(0);
    expect(payload.shuffle).toBe(false);
  });

  it('starts at track 1 however the random source rolls — the roll is not used at all', () => {
    for (const r of [0, 0.5, 0.999]) {
      expect(payloadOf(href({ ...tavern, inorder: true }, { random: () => r })).offset).toBe(0);
    }
  });

  it('treats a missing or junk inorder as the default, so an old entry shuffles', () => {
    for (const inorder of [undefined, null, false, 'yes', 0, 1]) {
      const payload = payloadOf(href({ ...tavern, inorder }, { random: () => 0.5 }));
      expect(payload.shuffle).toBe(true);
      expect(payload.offset).toBe(60);
    }
  });

  it('is independent of nofadein — in order can still fade in, and vice versa', () => {
    const both = payloadOf(href({ ...tavern, inorder: true, nofadein: true }));
    expect(both).toMatchObject({ offset: 0, shuffle: false, upMs: 0 });

    const inOrderOnly = payloadOf(href({ ...tavern, inorder: true, nofadein: false }));
    expect(inOrderOnly).toMatchObject({ offset: 0, shuffle: false, upMs: 3000 });

    const loudOnly = payloadOf(href({ ...tavern, inorder: false, nofadein: true }));
    expect(loudOnly).toMatchObject({ shuffle: true, upMs: 0 });
  });
});

describe('the random start offset', () => {
  it('stays inside [0, tracks.total) for every roll', () => {
    for (const r of [0, 0.001, 0.5, 0.999, 0.9999999]) {
      const payload = payloadOf(href(tavern, { random: () => r }));
      expect(payload.offset).toBeGreaterThanOrEqual(0);
      expect(payload.offset).toBeLessThan(tavern.trackTotal);
      expect(Number.isInteger(payload.offset)).toBe(true);
    }
  });

  it('never runs off the end, even if the random source returns exactly 1', () => {
    expect(pickOffset(120, () => 1)).toBe(119);
  });

  it('is 0 for a playlist with no known track count, rather than refusing to build', () => {
    expect(pickOffset(0)).toBe(0);
    expect(payloadOf(href({ ...tavern, trackTotal: undefined }))).toMatchObject({ offset: 0 });
  });

  it('reads a raw API shape too, not just the cache field', () => {
    const payload = payloadOf(href({ ...tavern, trackTotal: undefined, tracks: { total: 10 } }, {
      random: () => 0.5,
    }));
    expect(payload.offset).toBe(5);
  });

  it('re-rolls on every build — a page load is what re-randomises (#4)', () => {
    const rolls = [0.1, 0.8];
    let i = 0;
    const random = () => rolls[i++];
    expect(payloadOf(href(tavern, { random })).offset).toBe(12);
    expect(payloadOf(href(tavern, { random })).offset).toBe(96);
  });
});

describe('no usable token at render time', () => {
  it('does not emit a handoff URL that is guaranteed to fail', () => {
    const link = resolveTileLink(tavern, { token: null, returnUrl: RETURN });
    expect(link.mode).toBe('fallback');
    expect(link.reason).toBe('no-token');
    expect(link.href).toBe('https://open.spotify.com/playlist/4kQrPlaylistId');
    expect(link.href).not.toContain('shortcuts://');
  });

  it('falls back the same way when the cached playlist has no URI', () => {
    const link = resolveTileLink({ ...tavern, uri: undefined }, { token: TOKEN });
    expect(link.mode).toBe('fallback');
    expect(link.reason).toBe('no-uri');
  });

  it('has no href at all for a playlist with no id either', () => {
    expect(buildTileHref({}, { token: null })).toBe(null);
  });

  it('reads the token straight out of storage when none is passed in', () => {
    store.set('pb.auth', JSON.stringify({ access_token: 'stored-token', expires_at: Date.now() + 1e6 }));
    expect(payloadOf(buildTileHref(tavern, { returnUrl: RETURN })).token).toBe('stored-token');
  });

  it('falls back when storage holds no session', () => {
    expect(resolveTileLink(tavern, { returnUrl: RETURN }).mode).toBe('fallback');
  });
});

describe('coming back from a failed run (?err=1)', () => {
  const fakeLocation = (search, hash = '') => ({ pathname: '/playlist-buttons/', search, hash });

  it('reports the failure and clears the param so a reload does not repeat it', () => {
    let replacedWith = null;
    const hist = { replaceState: (_s, _t, url) => { replacedWith = url; } };
    expect(consumeHandoffError(fakeLocation('?err=1'), hist)).toBe(true);
    expect(replacedWith).toBe('/playlist-buttons/');
  });

  it('keeps any other query params and the hash', () => {
    let replacedWith = null;
    const hist = { replaceState: (_s, _t, url) => { replacedWith = url; } };
    consumeHandoffError(fakeLocation('?err=1&keep=yes', '#settings'), hist);
    expect(replacedWith).toBe('/playlist-buttons/?keep=yes#settings');
  });

  it('is false, and touches nothing, on an ordinary load', () => {
    let called = false;
    const hist = { replaceState: () => { called = true; } };
    expect(consumeHandoffError(fakeLocation(''), hist)).toBe(false);
    expect(consumeHandoffError(fakeLocation('?code=abc'), hist)).toBe(false);
    expect(called).toBe(false);
  });
});

describe('buildHandoffUrl / buildHandoffPayload directly', () => {
  it('round-trips a hand-built payload', () => {
    const payload = {
      token: 't', context_uri: 'spotify:playlist:x', offset: 3, shuffle: true,
      downMs: 3000, upMs: 0,
    };
    expect(payloadOf(buildHandoffUrl(payload, RETURN))).toEqual(payload);
  });

  it('builds the payload without needing a URL', () => {
    expect(buildHandoffPayload(tavern, { token: 't', fadeMs: 1000, random: () => 0 })).toEqual({
      token: 't',
      context_uri: 'spotify:playlist:4kQrPlaylistId',
      offset: 0,
      shuffle: true,
      downMs: 1000,
      upMs: 1000,
    });
  });

  it('builds the in-order payload the same way, with shuffle off', () => {
    expect(buildHandoffPayload({ ...tavern, inorder: true }, {
      token: 't', fadeMs: 1000, random: () => 0.9,
    })).toEqual({
      token: 't',
      context_uri: 'spotify:playlist:4kQrPlaylistId',
      offset: 0,
      shuffle: false,
      downMs: 1000,
      upMs: 1000,
    });
  });
});
