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
//  3. The random offset is re-rolled every time an href is built, and deliberately not
//     rolled once at startup. This used to be all the re-randomising there was, because
//     every transition ended in a page load: `x-success` navigated back here when the
//     run finished. It does not any more — the shortcut returns to the app itself,
//     mid-run, and a backgrounded app cannot switch apps, so `x-success` sits queued
//     until Shortcuts is next opened by hand. Confirmed on device. main.js now repaints
//     on `visibilitychange` instead, which is what re-rolls the offsets and what picks
//     up a token refreshed while the app was away.
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
export function buildHandoffPayload(playlist, { token, fadeMs, random, returnUrl } = {}) {
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
    // A STRING, not a boolean. The shortcut interpolates this straight into
    // `PUT /me/player/shuffle?state=`, and Shortcuts renders a JSON boolean from a
    // dictionary as 1/0 — which Spotify rejects with
    // `400 Bad format for parameter state`. Sending "true"/"false" as text means what
    // reaches the URL is already what Spotify expects.
    shuffle: inorder ? 'false' : 'true',
    downMs,
    upMs,
    // Where the shortcut sends the phone back to, mid-run, as soon as the new playlist
    // is playing — so the fade-in happens while the app is back on screen instead of
    // while Shortcuts is. It is in the PAYLOAD as well as in `x-success` because the two
    // are different mechanisms: `x-success` is Shortcuts' own, and only fires when the
    // run finishes, which is the thing we are trying not to wait for. The shortcut opens
    // this one itself, from an Open URLs action placed right after the play call.
    //
    // Sent from here rather than baked into the shortcut so one installed shortcut serves
    // both the dev server and the Pages build.
    return_url: returnUrl,
  };
}

/**
 * Assemble the x-callback-url. Every value is percent-encoded by URLSearchParams.
 *
 * `x-success` sends the phone back to this app's https URL, which lands in Safari. That
 * is the ceiling, not an oversight — tested on device 2026-09-09:
 *
 * - No callback at all: the shortcut finishes and you are left in Shortcuts. iOS does
 *   not return to a Home Screen web app on its own.
 * - Shortcuts' "Open App" action: does not list installed web apps.
 * - iOS 26's `webapp://` scheme: iOS recognises it (prompts "open in Web?") and then
 *   rejects the address, on every format tried — `webapp://host/path/`, the same with
 *   no trailing slash, the full https URL percent-encoded, and `webapp:https://…`.
 *   Matches a report that it stopped working after the iOS 26 beta.
 *
 * So the app is used from a Safari tab, and x-success returns to that tab — which the
 * #4 spike showed works cleanly. The reload that causes is what re-rolls each tile's
 * random offset.
 *
 * `x-success` is KEPT even though the shortcut now returns to the app by itself, partway
 * through its run — but NOT as the backstop it was first assumed to be. On device it does
 * not fire when the run ends: a backgrounded app cannot switch apps, so once the
 * shortcut's own Open App action has put Safari in front, the callback waits for
 * Shortcuts to be foregrounded by hand.
 *
 * What it is still worth: it is the ONLY return if the early action does not switch apps
 * at all on some iOS version, which is the case it now covers. Nothing else may depend on
 * it — the offset re-roll that used to ride on its reload is a `visibilitychange` repaint
 * in main.js now, and `?err=1` from `x-error` reports on the same delay, so a failed
 * transition is effectively silent until Shortcuts is opened.
 */
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

  const back = returnUrl ?? appReturnUrl();
  const payload = buildHandoffPayload(playlist, { token: accessToken, fadeMs, random, returnUrl: back });
  return { mode: 'handoff', href: buildHandoffUrl(payload, back), payload };
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
