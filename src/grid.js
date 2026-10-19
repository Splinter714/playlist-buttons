// The button grid: cover art tiles, three per row, name over the bottom of the art.
//
// ---------------------------------------------------------------------------------
// Every tile is a BUTTON, and the handler is async — on purpose (#13)
// ---------------------------------------------------------------------------------
// Until #13 every tile was a real `<a>` whose href — the handoff into the iOS shortcut —
// was fully built before the tap, and the click listener was forbidden from awaiting or
// calling `preventDefault`. That was not fussiness: an await between the tap and the
// navigation, or a synthesised navigation, can lose user gesture attribution, and that is
// what brought iOS's "Open in Shortcuts?" prompt back (#4).
//
// Every bit of that existed to protect the handoff into Shortcuts. The fade now happens
// in this app over the Spotify Web API (transition.js), there is no `shortcuts://` URL to
// navigate to, and so THERE IS NOTHING LEFT TO PROTECT. Tiles are ordinary buttons, the
// handler awaits a transition that takes seconds, and the start offset is rolled at tap
// time rather than at render time.
//
// Please don't reinstate the anchor-and-no-await rule out of habit if you find yourself
// here: it would buy nothing and would make the transition impossible to run.
//
// ---------------------------------------------------------------------------------
// There is no edit mode here, and that is still the point
// ---------------------------------------------------------------------------------
// Reordering used to live on this screen behind a mode that turned tap-to-play off (#3).
// It now lives on the settings screen, where the rotation is already decided, dragged by
// a handle on each member's row. That leaves this file with ONE kind of tile and no mode
// to get stuck in.

import { SKELETON_COUNT } from './view.js';
import { resolveTile } from './transition.js';
import { recordNowPlaying } from './nowplaying.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(root) {
  root.replaceChildren();
}

function buildTile(playlist, isNowPlaying, linkOptions) {
  const tile = resolveTile(playlist, linkOptions);
  const node = el('button', 'tile');
  node.type = 'button';
  node.dataset.id = playlist.id ?? '';
  // Which kind of tile this ended up being, so renderGrid can say so once at the top
  // instead of a tile silently looking normal and doing something else on tap.
  node.dataset.mode = tile.mode;
  if (tile.reason) node.dataset.reason = tile.reason;
  // A fallback tile has nothing to transition into, so it opens the playlist on Spotify.
  // The URL rides on the element rather than being rebuilt in the handler.
  if (tile.href) node.dataset.href = tile.href;
  const label = tile.mode === 'fallback' ? `${playlist.name} (opens in Spotify)` : playlist.name;
  node.setAttribute('aria-label', isNowPlaying ? `${playlist.name} (playing)` : label);
  if (tile.mode === 'fallback') node.classList.add('tile--fallback');
  if (isNowPlaying) {
    node.classList.add('is-playing');
    node.setAttribute('aria-current', 'true');
  }

  if (playlist.image) {
    const img = el('img', 'tile-art');
    img.src = playlist.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // A dead cover URL should leave the tile looking deliberate, not broken.
    img.addEventListener('error', () => img.remove(), { once: true });
    node.append(img);
  }

  // The name carries its own solid pill (see grid.css), so nothing else is needed to
  // keep it readable over arbitrary covers — light ones included.
  node.append(el('span', 'tile-name', playlist.name ?? ''));

  if (isNowPlaying) {
    const dot = el('span', 'tile-dot');
    dot.setAttribute('aria-hidden', 'true');
    node.append(dot);
  }

  return node;
}

/** A transition that threw somewhere in the middle. The volume has been put back. */
export const TRANSITION_FAILED_TEXT =
  'That did not play — Spotify refused the switch. Volume is back where it was; tap again to retry.';

/**
 * The device cannot be faded (#13). Both of these describe the very next tap, not the
 * last one, which is why they sit above the art like the warnings below.
 *
 * The first is the known case: the phone's own Spotify app, where Spotify sees the phone
 * as the device and a Bluetooth speaker is only an output, so there is no remote volume
 * to ramp. Playing on a Spotify Connect device instead — the Mac — makes the fade work.
 */
export const NO_VOLUME_TEXT =
  'This device can’t be faded from here, so the playlist just switches. Play on a Spotify Connect device for the fade.';
export const NO_PLAYER_TEXT =
  'Nothing was playing, so there was nothing to fade — the playlist just starts.';

/** Shown when a tile could not be given a real transition — two reasons, two lines. */
export const NO_TOKEN_TEXT =
  'Not connected to Spotify right now, so these tiles just open the playlist — no fade.';
export const NO_URI_TEXT =
  'Some playlists are missing their Spotify link — those tiles open the playlist instead of fading into it.';

function renderNotice(text, kind) {
  const p = el('p', `grid-notice grid-notice--${kind}`, text);
  p.setAttribute('role', 'status');
  return p;
}

/** A bare string stays an error, which is what every caller of the old shape meant. */
function normaliseNotice(notice) {
  if (!notice) return null;
  if (typeof notice === 'string') return { text: notice, kind: 'error' };
  return notice.text ? { text: notice.text, kind: notice.kind || 'error' } : null;
}

/**
 * @param {HTMLElement} root
 * @param {object} state
 * @param {Array} state.items
 * @param {string|null} state.nowPlayingId
 * @param {string|{text: string, kind?: string}|null} state.notice  last transition's news
 * @param {object} [state.linkOptions]   passed through to transition.js (tests seed it)
 */
export function renderGrid(root, {
  items,
  nowPlayingId = null,
  notice = null,
  linkOptions,
} = {}) {
  clear(root);
  const grid = el('div', 'grid');
  const reasons = new Set();
  for (const p of items) {
    const tile = buildTile(p, p.id === nowPlayingId, linkOptions);
    if (tile.dataset.mode === 'fallback') reasons.add(tile.dataset.reason);
    grid.append(tile);
  }
  const shown = normaliseNotice(notice);
  if (shown) root.append(renderNotice(shown.text, shown.kind));
  // A missing token is about the whole grid; a missing URI is about particular tiles.
  // Saying "not connected" for the second would send Jackson to the wrong place.
  if (reasons.has('no-token')) root.append(renderNotice(NO_TOKEN_TEXT, 'warn'));
  else if (reasons.size) root.append(renderNotice(NO_URI_TEXT, 'warn'));
  root.append(grid);
}

/** Nine grey placeholders in the same 3-wide grid, so the layout does not jump. */
export function renderSkeleton(root) {
  clear(root);
  const grid = el('div', 'grid');
  grid.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < SKELETON_COUNT; i++) {
    grid.append(el('div', 'tile tile--skeleton'));
  }
  root.append(grid);
}

/**
 * Empty rotation — the first thing anyone sees, since #9 made the rotation a local
 * include-list that starts empty. It used to say the setup page did not exist yet; #8
 * built it, so this now points straight at it rather than dead-ending.
 */
export function renderEmpty(root, { settingsHref = '#settings' } = {}) {
  clear(root);
  const box = el('div', 'notice');
  box.append(el('p', null, 'Nothing in the rotation yet.'));
  box.append(el('p', null, 'Pick the playlists you want as buttons — they show up here in the order you add them.'));
  const link = el('a', 'primary', 'Choose playlists');
  link.href = settingsHref;
  box.append(link);
  root.append(box);
}

export function renderSignedOut(root, onLogin) {
  clear(root);
  const box = el('div', 'notice');
  box.append(el('p', null, 'Connect Spotify to load your playlists.'));
  const button = el('button', 'primary', 'Log in with Spotify');
  button.addEventListener('click', onLogin);
  box.append(button);
  root.append(box);
}

/**
 * One delegated listener for the whole grid, attached once for the life of the page.
 *
 * It records the tap — the now-playing marker moves immediately, which is the feedback
 * that something is happening while the fade-out runs — and then hands the playlist id
 * to `onTap`, which is allowed to take as long as it likes. A fallback tile navigates to
 * Spotify instead.
 *
 * This used to be forbidden from awaiting and from calling `preventDefault` (#4). Both
 * are fine now; see the note at the top of this file before changing it back.
 */
export function attachTileHandler(root, {
  onTap = () => {},
  // Injected so a test can watch where a fallback tile goes without jsdom trying to
  // navigate. Nothing else needs to override it.
  onOpen = (href) => { globalThis.location.assign(href); },
} = {}) {
  root.addEventListener('click', async (event) => {
    const tile = event.target.closest?.('.tile');
    if (!tile || !root.contains(tile)) return;
    const id = tile.dataset.id;
    if (!id) return;

    if (tile.dataset.mode === 'fallback') {
      if (tile.dataset.href) onOpen(tile.dataset.href);
      return;
    }

    recordNowPlaying(id);
    await onTap(id);
  });
}
