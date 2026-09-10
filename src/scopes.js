// Whether a stored session's granted scopes still match what the app asks for.
//
// #9 removed the two write scopes, because the app no longer writes anything to Spotify.
// A session created before that is still sitting in localStorage carrying the old set,
// and its token can still modify playlists — which is exactly what shrinking the scopes
// was for. Changing the requested scopes also means the consent screen has to be shown
// again, so the honest move is to detect the old shape on load and send the user back
// through login, rather than quietly running on an over-privileged token.
//
// Pure — no storage, no network.

import { SCOPES, REMOVED_SCOPES } from './config.js';

export function parseScopes(scope) {
  if (Array.isArray(scope)) return new Set(scope.filter(Boolean));
  return new Set(String(scope ?? '').split(/\s+/).filter(Boolean));
}

/**
 * True when the stored session must be thrown away and re-consented.
 *
 * Deliberately NOT "granted !== requested": that would loop the user through login
 * forever if Spotify ever handed back a scope string we did not predict. The two checks
 * are both things we know the answer to — a scope we need that is missing, and a scope we
 * have deliberately stopped asking for that is still there.
 */
export function sessionScopesStale(auth, { required = SCOPES, removed = REMOVED_SCOPES } = {}) {
  if (!auth?.access_token) return false; // nothing stored — nothing to migrate
  const granted = parseScopes(auth.scope);
  if (required.some((s) => !granted.has(s))) return true;
  return removed.some((s) => granted.has(s));
}
