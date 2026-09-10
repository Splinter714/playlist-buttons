// The button grid: cover art tiles, three per row, name over the bottom of the art.
//
// Every tile is a real `<a>` whose href — the shortcut handoff — is fully built before
// the tap (see handoff.js). The click listener here records the now-playing marker and
// then gets out of the way: it never calls preventDefault and never awaits, so the
// browser handles the tap as an ordinary link navigation (#4).
//
// Because the hrefs are built here, at render, every page load re-rolls each playlist's
// random start offset. That is not incidental — every transition reloads the page, so
// rendering IS the re-randomising step.
//
// ---------------------------------------------------------------------------------
// EDIT MODE (#3) — and the one rule that matters most in this file
// ---------------------------------------------------------------------------------
// The grid has two modes. Play mode is the grid as above. Edit mode is entered from a
// control on the grid itself, disables tap-to-play, turns on drag-to-reorder (drag.js)
// and shows the per-playlist markers (#6, #10). Tap-to-play being off is the ENTIRE
// justification for having a mode: on a live grid a tap changes the music, so a drag
// that starts there risks swapping playlists mid-session in front of people. A fiddly
// drag is a far better failure than that one.
//
// Disabling the tap means suppressing an anchor, and #4's on-device spike found that
// suppressing/synthesising navigation is exactly what can bring back iOS's "Open in
// Shortcuts?" prompt. So the suppression is scoped as tightly as it can be, twice over:
//
//  1. An edit-mode tile carries NO href at all. Its handoff URL sits on `data-play-href`
//     instead, so there is no navigation to prevent in the first place.
//  2. `suppressEditTap` — the only `preventDefault` in this file, and the only one on the
//     grid — is attached ONLY to a grid element built by an edit-mode render. That
//     element is destroyed the moment edit mode ends (every render replaces the DOM), so
//     the listener cannot outlive the mode. There is no flag to get stuck, and no code
//     path where a play-mode render attaches it.
//
// A leak here would be invisible on a desktop browser and would only show up as a prompt
// on the phone, so it is guarded structurally rather than by a boolean.

import { SKELETON_COUNT } from './view.js';
import { resolveTileLink } from './handoff.js';
import { recordNowPlaying } from './nowplaying.js';
import { attachTileDrag } from './drag.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(root) {
  root.replaceChildren();
}

/**
 * The two per-playlist flags, as they read on a tile in edit mode.
 *
 * Short on purpose: a tile is ~113px wide at 375px and can carry BOTH at once, so these
 * words have to stack in a corner without covering the cover art or crowding the name.
 * The wording matches the settings pills (#6/#10) so the same flag reads the same in
 * both places.
 */
export const MARKERS = [
  { flag: 'nofadein', className: 'tile-flag--nofadein', text: 'full volume', spoken: 'starts at full volume' },
  { flag: 'inorder', className: 'tile-flag--inorder', text: 'in order', spoken: 'plays in order' },
];

/** The markers a playlist earns. Empty for the ordinary case, which is most tiles. */
function markersFor(playlist) {
  return MARKERS.filter((m) => playlist?.[m.flag] === true);
}

function buildTile(playlist, isNowPlaying, linkOptions, editing) {
  const link = resolveTileLink(playlist, linkOptions);
  const a = el('a', 'tile');
  // Edit mode parks the handoff URL out of reach rather than leaving a live link to
  // suppress — see the note at the top of this file.
  if (editing) a.dataset.playHref = link.href ?? '';
  else a.href = link.href ?? '';
  a.dataset.id = playlist.id ?? '';
  // Which kind of link this tile ended up with, so renderGrid can say so once at the top
  // instead of a tile silently looking normal and doing something else on tap.
  a.dataset.handoff = link.mode;
  if (link.reason) a.dataset.handoffReason = link.reason;
  const marks = markersFor(playlist);
  const label = link.mode === 'fallback' ? `${playlist.name} (opens in Spotify)` : playlist.name;
  if (editing) {
    // In edit mode the tile is a thing to move, not a thing to play, so the label says
    // that — and carries the markers, which are otherwise only visible.
    const suffix = marks.length ? `, ${marks.map((m) => m.spoken).join(', ')}` : '';
    a.setAttribute('aria-label', `${playlist.name} — drag to reorder${suffix}`);
    a.draggable = false; // kills the desktop native link-drag ghost (drag.js is pointer-based)
  } else {
    a.setAttribute('aria-label', isNowPlaying ? `${playlist.name} (playing)` : label);
  }
  if (link.mode === 'fallback') a.classList.add('tile--nohandoff');
  if (isNowPlaying) {
    a.classList.add('is-playing');
    a.setAttribute('aria-current', 'true');
  }

  if (playlist.image) {
    const img = el('img', 'tile-art');
    img.src = playlist.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // A dead cover URL should leave the tile looking deliberate, not broken.
    img.addEventListener('error', () => img.remove(), { once: true });
    a.append(img);
  }

  // The name carries its own solid pill (see grid.css), so nothing else is needed to
  // keep it readable over arbitrary covers — light ones included.
  a.append(el('span', 'tile-name', playlist.name ?? ''));

  // Markers, edit mode only. The grid stays purely cover art while it is being played
  // from — the difference these describe is audible, so it does not need a badge sitting
  // on the art all evening (#6). Top-left corner, stacked, clear of the now-playing dot
  // (top-right) and the name pill (bottom). aria-hidden because the label above already
  // says the same thing in words.
  if (editing && marks.length) {
    const flags = el('span', 'tile-flags');
    flags.setAttribute('aria-hidden', 'true');
    for (const m of marks) flags.append(el('span', `tile-flag ${m.className}`, m.text));
    a.append(flags);
  }

  if (isNowPlaying) {
    const dot = el('span', 'tile-dot');
    dot.setAttribute('aria-hidden', 'true');
    a.append(dot);
  }

  return a;
}

/** What a returning `?err=1` says on the grid (#4). */
export const HANDOFF_ERROR_TEXT =
  'That did not play — the shortcut reported an error. Tap again to retry.';

/** Shown when a tile could not be given a real handoff href — two reasons, two lines. */
export const NO_TOKEN_TEXT =
  'Not connected to Spotify right now, so these tiles just open the playlist — no fade.';
export const NO_URI_TEXT =
  'Some playlists are missing their Spotify link — those tiles open the playlist instead of fading into it.';

function renderNotice(text, kind) {
  const p = el('p', `grid-notice grid-notice--${kind}`, text);
  p.setAttribute('role', 'status');
  return p;
}

/** The control that switches modes, and what edit mode says about itself. */
export const EDIT_ENTER_TEXT = 'rearrange';
export const EDIT_EXIT_TEXT = 'done';
export const EDIT_HINT_TEXT =
  'Drag the buttons into the order you want. Tapping one in here will not change the music.';

function renderEditBar(editing, onToggleEdit) {
  const bar = el('div', `grid-bar${editing ? ' grid-bar--editing' : ''}`);
  const button = el('button', 'grid-edit', editing ? EDIT_EXIT_TEXT : EDIT_ENTER_TEXT);
  button.type = 'button';
  button.dataset.action = 'edit';
  button.setAttribute('aria-pressed', String(editing));
  button.addEventListener('click', () => onToggleEdit(!editing));
  bar.append(button);
  if (editing) bar.append(el('p', 'grid-bar-note', EDIT_HINT_TEXT));
  return bar;
}

/**
 * THE ONE preventDefault. Attached only to an edit-mode grid element (see the note at the
 * top of this file), never to a play-mode one.
 *
 * Edit-mode tiles have no href, so this is the second of two guards rather than the only
 * one — but it also stops the click bubbling up to `attachTriggerRecorder`, which would
 * otherwise mark a playlist as now-playing because the user nudged it half a slot.
 */
function suppressEditTap(grid) {
  grid.addEventListener('click', (event) => {
    if (!event.target.closest?.('a.tile')) return;
    event.preventDefault();
    event.stopPropagation();
  });
}

/**
 * @param {HTMLElement} root
 * @param {object} state
 * @param {Array} state.items
 * @param {string|null} state.nowPlayingId
 * @param {string|null} state.notice     e.g. the message for a returning `?err=1`
 * @param {object} [state.linkOptions]   passed through to handoff.js (tests seed it)
 * @param {boolean} [state.editing]      edit mode: no tap-to-play, drag to reorder, markers
 * @param {(next: boolean) => void} [state.onToggleEdit]
 * @param {(ids: string[]) => void} [state.onReorder]  the new id order, on drop
 */
export function renderGrid(root, {
  items,
  nowPlayingId = null,
  notice = null,
  linkOptions,
  editing = false,
  onToggleEdit = null,
  onReorder = () => {},
} = {}) {
  clear(root);
  const grid = el('div', `grid${editing ? ' grid--editing' : ''}`);
  const reasons = new Set();
  for (const p of items) {
    const tile = buildTile(p, p.id === nowPlayingId, linkOptions, editing);
    if (tile.dataset.handoff === 'fallback') reasons.add(tile.dataset.handoffReason);
    grid.append(tile);
  }
  if (onToggleEdit) root.append(renderEditBar(editing, onToggleEdit));
  // Both notices describe what the NEXT tap will do, and in edit mode a tap does nothing —
  // so they would be describing a thing that cannot happen. The hint line is the only text
  // above the grid while rearranging.
  if (!editing) {
    if (notice) root.append(renderNotice(notice, 'error'));
    // A missing token is about the whole grid; a missing URI is about particular tiles.
    // Saying "not connected" for the second would send Jackson to the wrong place.
    if (reasons.has('no-token')) root.append(renderNotice(NO_TOKEN_TEXT, 'warn'));
    else if (reasons.size) root.append(renderNotice(NO_URI_TEXT, 'warn'));
  }
  root.append(grid);
  if (editing) {
    suppressEditTap(grid);
    attachTileDrag(grid, { onReorder });
  }
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
 * Synchronous and side-effect-only: record which playlist was triggered, then let the
 * link navigate. It does not, and must not, call preventDefault (#4).
 *
 * The edit-mode check is a plain early return, not a suppression — an edit-mode click is
 * already stopped before it gets here, and this is the belt to that braces.
 */
export function attachTriggerRecorder(root, onRecord = () => {}) {
  root.addEventListener('click', (event) => {
    const tile = event.target.closest?.('a.tile');
    if (!tile || !root.contains(tile)) return;
    if (tile.closest('.grid--editing')) return; // rearranging, not playing (#3)
    const id = tile.dataset.id;
    if (!id) return;
    recordNowPlaying(id);
    onRecord(id);
  });
}
