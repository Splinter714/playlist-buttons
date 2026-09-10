// @vitest-environment jsdom
//
// The thing that matters about the grid is a DOM fact, not a function's return value:
// every tile is an `<a>` whose handoff href is already on it before anything is tapped
// (#4). Testing a click handler would test the wrong thing — there is deliberately no
// click handler in the navigation path at all.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderGrid, attachTriggerRecorder, HANDOFF_ERROR_TEXT, NO_TOKEN_TEXT, NO_URI_TEXT,
  EDIT_ENTER_TEXT, EDIT_EXIT_TEXT, EDIT_HINT_TEXT,
} from '../src/grid.js';
import { HANDOFF_ENDPOINT } from '../src/handoff.js';
import { readNowPlaying } from '../src/nowplaying.js';
import { readRotation, writeRotation, reorderRotation, joinRotation } from '../src/rotation.js';

const TOKEN = 'fake-access-token';

const items = [
  { id: 'aaa', uri: 'spotify:playlist:aaa', name: 'Tavern', trackTotal: 40, nofadein: false },
  { id: 'bbb', uri: 'spotify:playlist:bbb', name: 'Battle', trackTotal: 12, nofadein: true },
];

let root;
beforeEach(() => {
  vi.restoreAllMocks();
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
    expect(tavern).toMatchObject({ offset: 20, shuffle: 'true' });
    expect(battle).toMatchObject({ offset: 0, shuffle: 'false' });
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

// ------------------------------------------------------------------------------------
// Edit mode (#3)
// ------------------------------------------------------------------------------------
//
// The whole reason edit mode exists is that tap-to-play must be off inside it: a drag
// started on a live grid would swap playlists mid-session. So the assertions that matter
// here are about what a tap does NOT do — and, just as importantly, that none of that
// suppression is present in play mode, where a prevented default risks bringing back
// iOS's "Open in Shortcuts?" prompt (#4).

const TILE = 100;
const GAP = 10;
const slotRect = (i) => {
  const left = (i % 3) * (TILE + GAP);
  const top = Math.floor(i / 3) * (TILE + GAP);
  return { left, top, right: left + TILE, bottom: top + TILE, width: TILE, height: TILE };
};
const centreOf = (i) => ({ x: slotRect(i).left + TILE / 2, y: slotRect(i).top + TILE / 2 });

/** jsdom does no layout, so tiles report the slot they currently sit in, plus any drag. */
function stubGeometry() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
    const base = slotRect(index < 0 ? 0 : index);
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(this.style.transform ?? '');
    const dx = m ? Number(m[1]) : 0;
    const dy = m ? Number(m[2]) : 0;
    return { ...base, left: base.left + dx, right: base.right + dx, top: base.top + dy, bottom: base.bottom + dy };
  });
}

const pointer = (type, target, x, y) =>
  target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y,
  }));

/** Drag the tile in slot `from` onto slot `to` and drop it. */
function dragTile(from, to) {
  const tile = root.querySelectorAll('a.tile')[from];
  pointer('pointerdown', tile, centreOf(from).x, centreOf(from).y);
  pointer('pointermove', window, centreOf(to).x, centreOf(to).y);
  pointer('pointerup', window, centreOf(to).x, centreOf(to).y);
}

const editButton = () => root.querySelector('.grid-edit');
const flagsOn = (tile) => Array.from(tile.querySelectorAll('.tile-flag')).map((f) => f.textContent);

describe('getting in and out of edit mode', () => {
  it('offers a control on the grid itself, not somewhere else', () => {
    renderGrid(root, { items, linkOptions: { token: TOKEN }, onToggleEdit: () => {} });
    expect(editButton().textContent).toBe(EDIT_ENTER_TEXT);
    expect(editButton().getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.grid').classList.contains('grid--editing')).toBe(false);
  });

  it('asks to switch modes when the control is tapped, both ways', () => {
    const onToggleEdit = vi.fn();
    renderGrid(root, { items, linkOptions: { token: TOKEN }, onToggleEdit });
    editButton().click();
    expect(onToggleEdit).toHaveBeenCalledWith(true);

    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit });
    expect(editButton().textContent).toBe(EDIT_EXIT_TEXT);
    expect(editButton().getAttribute('aria-pressed')).toBe('true');
    editButton().click();
    expect(onToggleEdit).toHaveBeenLastCalledWith(false);
  });

  it('says what edit mode does, and says it only there', () => {
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });
    expect(root.textContent).toContain(EDIT_HINT_TEXT);
    renderGrid(root, { items, linkOptions: { token: TOKEN }, onToggleEdit: () => {} });
    expect(root.textContent).not.toContain(EDIT_HINT_TEXT);
  });

  it('shows no edit control at all when the caller does not offer one', () => {
    paint();
    expect(editButton()).toBe(null);
  });

  it('holds back the tap-time notices while editing — nothing there answers a tap', () => {
    renderGrid(root, {
      items, linkOptions: { token: null }, notice: HANDOFF_ERROR_TEXT, editing: true, onToggleEdit: () => {},
    });
    expect(root.textContent).not.toContain(NO_TOKEN_TEXT);
    expect(root.textContent).not.toContain(HANDOFF_ERROR_TEXT);
    // …and they come straight back on the way out.
    renderGrid(root, { items, linkOptions: { token: null }, notice: HANDOFF_ERROR_TEXT, onToggleEdit: () => {} });
    expect(root.textContent).toContain(NO_TOKEN_TEXT);
    expect(root.textContent).toContain(HANDOFF_ERROR_TEXT);
  });
});

describe('a tap does not play anything while rearranging', () => {
  it('leaves an edit-mode tile with no href to follow', () => {
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });
    for (const a of tiles()) {
      expect(a.hasAttribute('href')).toBe(false);
      expect(a.dataset.playHref.startsWith(`${HANDOFF_ENDPOINT}?`)).toBe(true);
    }
  });

  it('prevents the default on a tap in edit mode, and records nothing', () => {
    attachTriggerRecorder(root);
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    tiles()[1].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(readNowPlaying()).toBe(null);
  });

  it('a drag in edit mode never leaves a live link behind for the drop to follow', () => {
    stubGeometry();
    attachTriggerRecorder(root);
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });
    dragTile(1, 0);
    // The drop's own click, which a browser fires after pointerup on an anchor.
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    tiles()[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(tiles()[0].hasAttribute('href')).toBe(false);
    expect(readNowPlaying()).toBe(null);
  });

  it('goes straight back to a plain link navigation on the way out — no preventDefault', () => {
    attachTriggerRecorder(root);
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: false, onToggleEdit: () => {} });
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    tiles()[1].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(tiles()[1].getAttribute('href').startsWith(`${HANDOFF_ENDPOINT}?`)).toBe(true);
    expect(readNowPlaying()?.id).toBe('bbb');
  });

  it('leaves nothing behind that could prevent a default after edit mode ends', () => {
    // Every render replaces the DOM, so the element carrying the suppression is gone —
    // this is the assertion that the mode cannot leak as a stuck flag.
    renderGrid(root, { items, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });
    const editedGrid = root.querySelector('.grid--editing');
    renderGrid(root, { items, linkOptions: { token: TOKEN }, onToggleEdit: () => {} });
    expect(root.contains(editedGrid)).toBe(false);
    expect(root.querySelector('.grid--editing')).toBe(null);
    for (let i = 0; i < 3; i++) {
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      tiles()[0].dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });
});

describe('the per-playlist markers (#6, #10)', () => {
  const marked = [
    { ...items[0], nofadein: false, inorder: false },
    { ...items[0], id: 'ccc', name: 'Loud', nofadein: true, inorder: false },
    { ...items[0], id: 'ddd', name: 'Story', nofadein: false, inorder: true },
    { ...items[0], id: 'eee', name: 'Both', nofadein: true, inorder: true },
  ];
  const editMarked = () =>
    renderGrid(root, { items: marked, linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {} });

  it('shows one marker per flag that is actually set, and none for a plain playlist', () => {
    editMarked();
    const [plain, loud, story, both] = tiles();
    expect(flagsOn(plain)).toEqual([]);
    expect(flagsOn(loud)).toEqual(['full volume']);
    expect(flagsOn(story)).toEqual(['in order']);
    expect(flagsOn(both)).toEqual(['full volume', 'in order']);
  });

  it('keeps the grid pure cover art in play mode — neither marker appears there', () => {
    renderGrid(root, { items: marked, linkOptions: { token: TOKEN }, onToggleEdit: () => {} });
    expect(root.querySelectorAll('.tile-flag')).toHaveLength(0);
    expect(root.textContent).not.toContain('full volume');
    expect(root.textContent).not.toContain('in order');
  });

  it('says the same thing to a screen reader as the pills say by eye', () => {
    editMarked();
    const [, , , both] = tiles();
    expect(both.getAttribute('aria-label')).toBe('Both — drag to reorder, starts at full volume, plays in order');
    expect(tiles()[0].getAttribute('aria-label')).toBe('Tavern — drag to reorder');
    expect(both.querySelector('.tile-flags').getAttribute('aria-hidden')).toBe('true');
  });

  it('stacks both markers clear of the name and the now-playing dot', () => {
    renderGrid(root, {
      items: marked, nowPlayingId: 'eee', linkOptions: { token: TOKEN }, editing: true, onToggleEdit: () => {},
    });
    const both = tiles()[3];
    // One container in the top-left; the dot and the name pill are separate elements, so
    // two markers can never push either of them around.
    expect(both.querySelectorAll('.tile-flags')).toHaveLength(1);
    expect(both.querySelector('.tile-name').textContent).toBe('Both');
    expect(both.querySelector('.tile-dot')).not.toBe(null);
  });
});

describe('a drag writes the new order through rotation.js', () => {
  const seed = [
    { id: 'aaa', uri: 'spotify:playlist:aaa', name: 'Tavern', trackTotal: 40 },
    { id: 'bbb', uri: 'spotify:playlist:bbb', name: 'Battle', trackTotal: 12 },
    { id: 'ccc', uri: 'spotify:playlist:ccc', name: 'Calm', trackTotal: 30 },
  ];

  /** What main.js does: paint the rotation joined against cached metadata. */
  const paintFromStore = (editing) =>
    renderGrid(root, {
      items: joinRotation(readRotation(), seed),
      linkOptions: { token: TOKEN },
      editing,
      onToggleEdit: () => {},
      onReorder: (ids) => reorderRotation(ids),
    });

  beforeEach(() => {
    stubGeometry();
    writeRotation([{ id: 'aaa' }, { id: 'bbb', nofadein: true, inorder: true }, { id: 'ccc' }]);
  });

  it('saves on drop — no save button to forget', () => {
    paintFromStore(true);
    dragTile(2, 0);
    expect(readRotation().map((e) => e.id)).toEqual(['ccc', 'aaa', 'bbb']);
  });

  it('survives a reload: the grid repaints from the store in the new order', () => {
    paintFromStore(true);
    dragTile(2, 0); // last to first
    // A reload is the only thing that ever happens here — every transition is one (#4).
    root.replaceChildren();
    paintFromStore(false);
    expect(tiles().map((a) => a.dataset.id)).toEqual(['ccc', 'aaa', 'bbb']);
  });

  it('carries each playlist flags along with it rather than reordering ids only', () => {
    paintFromStore(true);
    dragTile(1, 0);
    expect(readRotation()[0]).toEqual({ id: 'bbb', nofadein: true, inorder: true });
  });

  it('reorders from the first position', () => {
    paintFromStore(true);
    dragTile(0, 2);
    expect(readRotation().map((e) => e.id)).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('reorders from the middle', () => {
    paintFromStore(true);
    dragTile(1, 2);
    expect(readRotation().map((e) => e.id)).toEqual(['aaa', 'ccc', 'bbb']);
  });

  it('does not touch the rotation from a drag in play mode, because there is none', () => {
    paintFromStore(false);
    dragTile(2, 0);
    expect(readRotation().map((e) => e.id)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(tiles().map((a) => a.dataset.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });
});
