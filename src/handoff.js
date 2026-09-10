// The href a tile carries: the handoff into the iOS shortcut (#4).
//
//   shortcuts://x-callback-url/run-shortcut
//     ?name=PlaylistButtons
//     &input=text
//     &text=<urlencoded {token, context_uri, offset, shuffle, downMs, upMs}>
//     &x-success=<urlencoded app URL>
//     &x-error=<urlencoded app URL + ?err=1>
//
// Three things here are findings from #4's on-device spike, not style preferences:
//
//  1. The href is FULLY BUILT and sitting on the anchor before the tap. A tapped link
//     reaches Shortcuts with no iOS confirmation prompt; the same URL constructed inside
//     a click handler and navigated to programmatically risks one. So this module is
//     called at render time, and the tap path does nothing but let the link navigate.
//  2. NOTHING here awaits. The token comes from `getAccessTokenSync()`, which exists for
//     exactly this reason — an await between the tap and the navigation can lose user
//     gesture attribution, which is what puts the prompt back. Expiry is the background
//     refresh timer's problem (auth.js), never this path's.
//  3. The random offset is re-rolled every time an href is built. Every transition
//     reloads the page — `x-success` returns to a fresh context — so building hrefs at
//     render is all the re-randomising this needs. No extra machinery, and deliberately
//     not rolled once at startup.
//
// The payload carries a `shuffle` boolean (#10). It used to be absent, because the
// shortcut hardcoded `?state=true`; a playlist marked `inorder` needs shuffle explicitly
// OFF and `offset: 0`, so the two travel together and the shortcut reads both from input.
// Default behaviour is unchanged: random offset, shuffle on.

import { getAccessTokenSync } from './auth.js';
import { resolveFade } from './settings.js';

/** Must match the shortcut's name on the phone, byte for byte. */
export const SHORTCUT_NAME = 'PlaylistButtons';
export const HANDOFF_ENDPOINT = 'shortcuts://x-callback-url/run-shortcut';

/** What `x-error` puts on the return URL, so the grid can say the transition failed. */
export const ERROR_PARAM = 'err';

/**
 * Where `x-success` / `x-error` send the phone back to: this app, with no query and no
 * hash. Dropping the hash matters — the return trip should land on the grid, not on
 * whatever screen happened to be open — and dropping the query stops `?err=1` from
 * accumulating across transitions.
 */
export function appReturnUrl(loc = globalThis.location) {
  return `${loc?.origin ?? ''}${loc?.pathname ?? '/'}`;
}

/** Track count as the cache stores it (`trackTotal`), tolerating a raw API object. */
function trackTotal(playlist) {
  const n = Number(playlist?.trackTotal ?? playlist?.tracks?.total);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * A random start position in `[0, total)`. A playlist with no known track count gets 0,
 * which is a valid position for any non-empty playlist — better than refusing to build
 * an href because the cache is thin.
 */
export function pickOffset(total, random = Math.random) {
  const n = Math.floor(Number(total));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor(random() * n)));
}

/**
 * The JSON the shortcut receives. Key order is the contract's order, so the encoded
 * string is stable and readable when debugging on the phone.
 *
 * @param {{uri: string, trackTotal?: number, nofadein?: boolean, inorder?: boolean}} playlist
 * @param {{token: string, fadeMs?: number, random?: () => number}} options
 */
export function buildHandoffPayload(playlist, { token, fadeMs, random } = {}) {
  // `nofadein` is the one per-playlist fade setting (#6); resolveFade turns it into
  // `upMs: 0`, meaning restore to the captured volume instead of ramping.
  const { downMs, upMs } = resolveFade(playlist?.nofadein === true, fadeMs);
  // `inorder` (#10) is the other, independent per-playlist flag. Track 1 with shuffle off
  // is one decision expressed as two fields, so they are computed together: a random
  // offset with shuffle off would play the rest of the playlist from a random point, and
  // `offset: 0` with shuffle on would not start on track 1 at all.
  const inorder = playlist?.inorder === true;
  return {
    token,
    context_uri: playlist?.uri,
    offset: inorder ? 0 : pickOffset(trackTotal(playlist), random),
    shuffle: !inorder,
    downMs,
    upMs,
  };
}

/** Assemble the x-callback-url. Every value is percent-encoded by URLSearchParams. */
export function buildHandoffUrl(payload, returnUrl = appReturnUrl()) {
  const params = new URLSearchParams({
    name: SHORTCUT_NAME,
    input: 'text',
    text: JSON.stringify(payload),
    'x-success': returnUrl,
    'x-error': `${returnUrl}?${ERROR_PARAM}=1`,
  });
  return `${HANDOFF_ENDPOINT}?${params}`;
}

/**
 * What a tile's anchor gets, and which of the two kinds of link it is.
 *
 *  - `handoff` — the real thing.
 *  - `fallback` — there is no usable token, or the cached playlist has no `uri`. Emitting
 *    a handoff URL anyway would hand the shortcut a request that cannot succeed, and the
 *    failure would surface as a volume ramp down onto silence. The tile opens the playlist
 *    on Spotify instead, and the grid says why (grid.js) rather than looking normal and
 *    failing on tap.
 *
 * `token` is read synchronously here rather than passed down from main, so a render is
 * always built against whatever the background refresh most recently stored.
 *
 * @returns {{mode: 'handoff'|'fallback', href: string|null, reason?: string, payload?: object}}
 */
export function resolveTileLink(playlist, { token, returnUrl, fadeMs, random } = {}) {
  const id = playlist?.id;
  const uri = typeof playlist?.uri === 'string' && playlist.uri ? playlist.uri : null;
  const accessToken = token === undefined ? getAccessTokenSync() : token;

  if (!accessToken || !uri) {
    return {
      mode: 'fallback',
      reason: !accessToken ? 'no-token' : 'no-uri',
      href: id ? `https://open.spotify.com/playlist/${encodeURIComponent(id)}` : null,
    };
  }

  const payload = buildHandoffPayload(playlist, { token: accessToken, fadeMs, random });
  return { mode: 'handoff', href: buildHandoffUrl(payload, returnUrl ?? appReturnUrl()), payload };
}

/** Just the href — what most callers want. */
export function buildTileHref(playlist, options) {
  return resolveTileLink(playlist, options).href;
}

/**
 * Read and clear the `?err=1` the shortcut's `x-error` sends back.
 *
 * Clearing it matters: the return URL is the app's own URL, so a later reload of that
 * same address would otherwise re-announce a failure that already happened. Any other
 * query params are left alone, and the hash is kept.
 *
 * @returns {boolean} whether this load came back from a failed shortcut run
 */
export function consumeHandoffError(loc = globalThis.location, hist = globalThis.history) {
  const params = new URLSearchParams(loc?.search ?? '');
  if (params.get(ERROR_PARAM) !== '1') return false;
  params.delete(ERROR_PARAM);
  const query = params.toString();
  hist?.replaceState?.({}, '', `${loc.pathname}${query ? `?${query}` : ''}${loc.hash ?? ''}`);
  return true;
}
