// The button grid: cover art tiles, three per row, name over the bottom of the art.
//
// Every tile is a real `<a>` with a real href, built before the tap — see handoff.js.
// The click listener here records the now-playing marker and then gets out of the way:
// it never calls preventDefault and never awaits, so the browser handles the tap as an
// ordinary link navigation (#4).

import { SKELETON_COUNT } from './view.js';
import { buildTileHref } from './handoff.js';
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

function buildTile(playlist, isNowPlaying) {
  const href = buildTileHref(playlist);
  const a = el('a', 'tile');
  a.href = href ?? '';
  a.dataset.id = playlist.id ?? '';
  a.setAttribute('aria-label', isNowPlaying ? `${playlist.name} (playing)` : playlist.name);
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

/**
 * @param {HTMLElement} root
 * @param {{items: Array, nowPlayingId: string|null}} state
 */
export function renderGrid(root, { items, nowPlayingId = null } = {}) {
  clear(root);
  const grid = el('div', 'grid');
  for (const p of items) {
    grid.append(buildTile(p, p.id === nowPlayingId));
  }
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
 * Nothing tagged. Deliberately plain and deliberately temporary: #8 replaces this with
 * a real setup page that lists every playlist and lets you pick. Not worth investing in.
 */
export function renderEmpty(root) {
  clear(root);
  const box = el('div', 'notice');
  box.append(el('p', null, 'No playlists in the rotation yet.'));
  box.append(el('p', null, 'In the Spotify app, edit a playlist you own and add [game] to its description. It shows up here on the next load.'));
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
