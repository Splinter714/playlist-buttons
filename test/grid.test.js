// @vitest-environment jsdom
//
// The thing that matters about the grid is a DOM fact, not a function's return value:
// every tile is an `<a>` whose handoff href is already on it before anything is tapped
// (#4). Testing a click handler would test the wrong thing — there is deliberately no
// click handler in the navigation path at all.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderGrid, attachTriggerRecorder, HANDOFF_ERROR_TEXT, NO_TOKEN_TEXT, NO_URI_TEXT,
} from '../src/grid.js';
import { HANDOFF_ENDPOINT } from '../src/handoff.js';
import { readNowPlaying } from '../src/nowplaying.js';

const TOKEN = 'fake-access-token';

const items = [
  { id: 'aaa', uri: 'spotify:playlist:aaa', name: 'Tavern', trackTotal: 40, nofadein: false },
  { id: 'bbb', uri: 'spotify:playlist:bbb', name: 'Battle', trackTotal: 12, nofadein: true },
];

let root;
beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  root = document.createElement('main');
  document.body.append(root);
});

const tiles = () => Array.from(root.querySelectorAll('a.tile'));
const payloadOf = (a) => {
  const raw = a.getAttribute('href');
  return JSON.parse(new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('text'));
};

const paint = (extra = {}) =>
  renderGrid(root, { items, linkOptions: { token: TOKEN, random: () => 0.5 }, ...extra });

describe('every tile is an anchor with its handoff href already in the DOM', () => {
  it('renders one anchor per playlist, never a button or a div', () => {
    paint();
    expect(tiles()).toHaveLength(2);
    for (const a of tiles()) expect(a.tagName).toBe('A');
  });

  it('has the shortcuts:// href on the anchor before any interaction', () => {
    paint();
    for (const a of tiles()) {
      expect(a.getAttribute('href').startsWith(`${HANDOFF_ENDPOINT}?`)).toBe(true);
      expect(a.dataset.handoff).toBe('handoff');
    }
  });

  it('gives each tile its own playlist and its own fade values', () => {
    paint();
    const [tavern, battle] = tiles().map(payloadOf);
    expect(tavern.context_uri).toBe('spotify:playlist:aaa');
    expect(battle.context_uri).toBe('spotify:playlist:bbb');
    expect(tavern.upMs).toBe(3000);
    expect(battle.upMs).toBe(0); // nofadein (#6)
  });

  it('re-rolls the offset on every render, since every transition reloads the page', () => {
    const rolls = [0.1, 0.1, 0.9, 0.9];
    let i = 0;
    const linkOptions = { token: TOKEN, random: () => rolls[i++] };
    renderGrid(root, { items, linkOptions });
    const first = tiles().map((a) => payloadOf(a).offset);
    renderGrid(root, { items, linkOptions });
    const second = tiles().map((a) => payloadOf(a).offset);
    expect(first).toEqual([4, 1]);
    expect(second).toEqual([36, 10]);
  });

  it('marks an in-order playlist offset 0 / shuffle off, and leaves the others alone (#10)', () => {
    const mixed = [items[0], { ...items[1], inorder: true }];
    renderGrid(root, { items: mixed, linkOptions: { token: TOKEN, random: () => 0.5 } });
    const [tavern, battle] = tiles().map(payloadOf);
    expect(tavern).toMatchObject({ offset: 20, shuffle: true });
    expect(battle).toMatchObject({ offset: 0, shuffle: false });
  });

  it('keeps re-rolling the shuffled tiles while an in-order tile stays on track 1', () => {
    const mixed = [items[0], { ...items[1], inorder: true }];
    const rolls = [0.1, 0.9];
    let i = 0;
    const linkOptions = { token: TOKEN, random: () => rolls[i++] };
    renderGrid(root, { items: mixed, linkOptions });
    expect(tiles().map((a) => payloadOf(a).offset)).toEqual([4, 0]);
    renderGrid(root, { items: mixed, linkOptions });
    // Only one roll was consumed by the first render — the in-order tile never asks.
    expect(tiles().map((a) => payloadOf(a).offset)).toEqual([36, 0]);
  });
});

describe('when there is no usable token', () => {
  it('points the tile at Spotify instead of emitting a doomed handoff URL', () => {
    renderGrid(root, { items, linkOptions: { token: null } });
    for (const a of tiles()) {
      expect(a.getAttribute('href')).not.toContain('shortcuts://');
      expect(a.getAttribute('href')).toContain('open.spotify.com');
      expect(a.classList.contains('tile--nohandoff')).toBe(true);
    }
  });

  it('says so on the grid rather than looking normal and failing on tap', () => {
    renderGrid(root, { items, linkOptions: { token: null } });
    expect(root.textContent).toContain(NO_TOKEN_TEXT);
  });

  it('says something different when it is one playlist missing its URI, not the session', () => {
    const [tavern, battle] = items;
    renderGrid(root, {
      items: [tavern, { ...battle, uri: undefined }],
      linkOptions: { token: TOKEN, random: () => 0.5 },
    });
    const [a, b] = tiles();
    expect(a.dataset.handoff).toBe('handoff');
    expect(b.dataset.handoff).toBe('fallback');
    expect(root.textContent).toContain(NO_URI_TEXT);
    expect(root.textContent).not.toContain(NO_TOKEN_TEXT);
  });

  it('says nothing when every tile got a real handoff', () => {
    paint();
    expect(root.querySelector('.grid-notice')).toBe(null);
  });
});

describe('coming back from a failed shortcut run', () => {
  it('shows the failure above the grid, with the grid still usable', () => {
    paint({ notice: HANDOFF_ERROR_TEXT });
    expect(root.querySelector('.grid-notice--error').textContent).toBe(HANDOFF_ERROR_TEXT);
    expect(tiles()).toHaveLength(2);
  });
});

describe('the tap path stays a plain link navigation', () => {
  it('records now-playing without preventing the default navigation', () => {
    attachTriggerRecorder(root);
    paint();
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    tiles()[1].dispatchEvent(event);
    expect(readNowPlaying()?.id).toBe('bbb');
    expect(event.defaultPrevented).toBe(false);
  });
});
