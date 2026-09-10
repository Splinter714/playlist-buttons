import { describe, it, expect } from 'vitest';
import { parseScopes, sessionScopesStale } from '../src/scopes.js';
import { SCOPES, REMOVED_SCOPES } from '../src/config.js';

const session = (scope) => ({ access_token: 'tok', scope });
const CURRENT = SCOPES.join(' ');
const OLD = [...SCOPES, ...REMOVED_SCOPES].join(' ');

describe('the scope set itself', () => {
  it('no longer asks for write access', () => {
    expect(SCOPES).not.toContain('playlist-modify-private');
    expect(SCOPES).not.toContain('playlist-modify-public');
  });

  it('still asks for what the app actually uses', () => {
    expect(SCOPES).toEqual([
      'playlist-read-private',
      'user-read-playback-state',
      'user-modify-playback-state',
    ]);
  });

  it('does not ask for playlist-read-collaborative — Jackson kept the consent screen minimal', () => {
    expect(SCOPES).not.toContain('playlist-read-collaborative');
  });

  it('does not ask for streaming — the app never plays audio', () => {
    expect(SCOPES).not.toContain('streaming');
  });
});

describe('parseScopes', () => {
  it('splits the space-separated string Spotify returns', () => {
    expect(parseScopes('a b  c')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('handles an array, and null', () => {
    expect(parseScopes(['a', 'b'])).toEqual(new Set(['a', 'b']));
    expect(parseScopes(null)).toEqual(new Set());
  });
});

describe('sessionScopesStale — the #9 re-consent', () => {
  it('sends a pre-#9 session back through login', () => {
    expect(sessionScopesStale(session(OLD))).toBe(true);
  });

  it('leaves a current session alone', () => {
    expect(sessionScopesStale(session(CURRENT))).toBe(false);
  });

  it('does not fire when there is no session at all', () => {
    expect(sessionScopesStale(null)).toBe(false);
    expect(sessionScopesStale({})).toBe(false);
  });

  it('fires on a session that never recorded its scopes', () => {
    expect(sessionScopesStale(session(null))).toBe(true);
  });

  it('fires when a scope the app needs is missing', () => {
    expect(sessionScopesStale(session('playlist-read-private'))).toBe(true);
  });

  it('fires on either write scope on its own', () => {
    for (const removed of REMOVED_SCOPES) {
      expect(sessionScopesStale(session(`${CURRENT} ${removed}`))).toBe(true);
    }
  });

  it('does not care about scope order', () => {
    expect(sessionScopesStale(session(SCOPES.slice().reverse().join(' ')))).toBe(false);
  });

  it('tolerates an unknown extra scope rather than looping the user through login', () => {
    // The check names what it removed instead of demanding an exact match, so a scope
    // Spotify hands back that we did not predict cannot cause an endless re-login.
    expect(sessionScopesStale(session(`${CURRENT} some-future-scope`))).toBe(false);
  });
});
