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

import { SKELETON_COUNT } from './view.js';
import { resolveTileLink } from './handoff.js';
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
  const link = resolveTileLink(playlist, linkOptions);
  const a = el('a', 'tile');
  a.href = link.href ?? '';
  a.dataset.id = playlist.id ?? '';
  // Which kind of link this tile ended up with, so renderGrid can say so once at the top
  // instead of a tile silently looking normal and doing something else on tap.
  a.dataset.handoff = link.mode;
  if (link.reason) a.dataset.handoffReason = link.reason;
  const label = link.mode === 'fallback' ? `${playlist.name} (opens in Spotify)` : playlist.name;
  a.setAttribute('aria-label', isNowPlaying ? `${playlist.name} (playing)` : label);
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

  // The scrim is its own element rather than a gradient on the label, so it can cover
  // more of the art than the text does and fade out well above the first line. The
  // name has to stay readable over arbitrary covers, light ones included.
  a.append(el('span', 'tile-scrim'));
  a.append(el('span', 'tile-name', playlist.name ?? ''));

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

/**
 * @param {HTMLElement} root
 * @param {object} state
 * @param {Array} state.items
 * @param {string|null} state.nowPlayingId
 * @param {string|null} state.notice     e.g. the message for a returning `?err=1`
 * @param {object} [state.linkOptions]   passed through to handoff.js (tests seed it)
 */
export function renderGrid(root, { items, nowPlayingId = null, notice = null, linkOptions } = {}) {
  clear(root);
  const grid = el('div', 'grid');
  const reasons = new Set();
  for (const p of items) {
    const tile = buildTile(p, p.id === nowPlayingId, linkOptions);
    if (tile.dataset.handoff === 'fallback') reasons.add(tile.dataset.handoffReason);
    grid.append(tile);
  }
  if (notice) root.append(renderNotice(notice, 'error'));
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
 * One delegated listener for the whole grid. Synchronous and side-effect-only: record
 * which playlist was triggered, then let the link navigate.
 */
export function attachTriggerRecorder(root, onRecord = () => {}) {
  root.addEventListener('click', (event) => {
    const tile = event.target.closest?.('a.tile');
    if (!tile || !root.contains(tile)) return;
    const id = tile.dataset.id;
    if (!id) return;
    recordNowPlaying(id);
    onRecord(id);
  });
}
