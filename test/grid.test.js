// @vitest-environment jsdom
//
// What matters about the grid changed with #13, and so did this file.
//
// It used to assert a DOM fact that was load-bearing: every tile is an `<a>` whose
// `shortcuts://` href is already on it before anything is tapped, and the click handler
// never calls `preventDefault` (`defaultPrevented === false` was asserted twice). Those
// assertions existed to pin down the one thing that must not regress about the handoff
// into Shortcuts — an await or a synthesised navigation in the tap path can lose gesture
// attribution and bring iOS's "Open in Shortcuts?" prompt back (#4).
//
// There is no handoff any more, so those assertions were not protecting anything; they
// were pinning the app to a constraint that no longer exists. They are rewritten here,
// not deleted: the new tests say the opposite on purpose — tiles are buttons, and the
// handler is allowed to await a transition that takes seconds — so that the change reads
// as deliberate rather than as coverage quietly going missing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderGrid, attachTileHandler,
  NO_TOKEN_TEXT, NO_URI_TEXT, NO_VOLUME_TEXT, TRANSITION_FAILED_TEXT,
} from '../src/grid.js';
import { readNowPlaying } from '../src/nowplaying.js';

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

const tiles = () => Array.from(root.querySelectorAll('.tile'));
const paint = (extra = {}) =>
  renderGrid(root, { items, linkOptions: { token: TOKEN }, ...extra });
const tap = (node) => node.dispatchEvent(new window.MouseEvent('click', {
  bubbles: true, cancelable: true,
}));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('every tile is a button (#13 — it used to have to be an anchor)', () => {
  it('renders one button per playlist, never an anchor', () => {
    paint();
    expect(tiles()).toHaveLength(2);
    for (const node of tiles()) {
      expect(node.tagName).toBe('BUTTON');
      expect(node.type).toBe('button');
      expect(node.hasAttribute('href')).toBe(false);
    }
  });

  it('carries no URL to navigate to — the tap runs a transition in this tab', () => {
    paint();
    expect(root.innerHTML).not.toContain('shortcuts://');
    for (const node of tiles()) {
      expect(node.dataset.mode).toBe('play');
      expect(node.dataset.href).toBe(undefined);
    }
  });

  it('decides nothing about the transition at render time', () => {
    // The offset used to be rolled into every href on every render. It is now rolled when
    // a tile is tapped, so two renders are byte-identical.
    paint();
    const first = root.innerHTML;
    paint();
    expect(root.innerHTML).toBe(first);
  });
});

describe('the tap path, which may now await', () => {
  it('records now-playing immediately and hands the id to the transition', async () => {
    const onTap = vi.fn(async () => {});
    attachTileHandler(root, { onTap });
    paint();

    tap(tiles()[1]);
    // The marker moves synchronously — that is the feedback while the fade-out runs.
    expect(readNowPlaying()?.id).toBe('bbb');

    await flush();
    expect(onTap).toHaveBeenCalledWith('bbb');
  });

  it('awaits a handler that takes as long as a fade does', async () => {
    // The old rule was that nothing in this path could await at all. This asserts the
    // rule is gone: a slow handler runs to completion and the grid does not care.
    let resolveTransition;
    const onTap = vi.fn(() => new Promise((r) => { resolveTransition = r; }));
    attachTileHandler(root, { onTap });
    paint();

    tap(tiles()[0]);
    await flush();
    expect(onTap).toHaveBeenCalledTimes(1);
    resolveTransition();
    await flush();
    // And a second tap still works afterwards — nothing is left in a stuck state.
    tap(tiles()[0]);
    await flush();
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it('lets a rapid series of taps all through, for transition.js to supersede', async () => {
    const onTap = vi.fn(async () => {});
    attachTileHandler(root, { onTap });
    paint();
    tap(tiles()[0]);
    tap(tiles()[1]);
    tap(tiles()[0]);
    await flush();
    expect(onTap.mock.calls.map(([id]) => id)).toEqual(['aaa', 'bbb', 'aaa']);
  });

  it('ignores a tap that did not land on a tile', async () => {
    const onTap = vi.fn(async () => {});
    attachTileHandler(root, { onTap });
    paint();
    tap(root.querySelector('.grid'));
    await flush();
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe('when there is no usable token', () => {
  it('points the tile at Spotify instead of pretending it can transition', () => {
    renderGrid(root, { items, linkOptions: { token: null } });
    for (const node of tiles()) {
      expect(node.dataset.mode).toBe('fallback');
      expect(node.dataset.href).toContain('open.spotify.com');
      expect(node.classList.contains('tile--fallback')).toBe(true);
    }
  });

  it('opens Spotify on tap, and does not record a transition that cannot happen', async () => {
    const onTap = vi.fn(async () => {});
    const onOpen = vi.fn();
    attachTileHandler(root, { onTap, onOpen });
    renderGrid(root, { items, linkOptions: { token: null } });

    tap(tiles()[0]);
    await flush();
    expect(onOpen).toHaveBeenCalledWith('https://open.spotify.com/playlist/aaa');
    expect(onTap).not.toHaveBeenCalled();
    expect(readNowPlaying()).toBe(null);
  });

  it('says so on the grid rather than looking normal and failing on tap', () => {
    renderGrid(root, { items, linkOptions: { token: null } });
    expect(root.textContent).toContain(NO_TOKEN_TEXT);
  });

  it('says something different when it is one playlist missing its URI, not the session', () => {
    const [tavern, battle] = items;
    renderGrid(root, {
      items: [tavern, { ...battle, uri: undefined }],
      linkOptions: { token: TOKEN },
    });
    const [a, b] = tiles();
    expect(a.dataset.mode).toBe('play');
    expect(b.dataset.mode).toBe('fallback');
    expect(root.textContent).toContain(NO_URI_TEXT);
    expect(root.textContent).not.toContain(NO_TOKEN_TEXT);
  });

  it('says nothing when every tile can really transition', () => {
    paint();
    expect(root.querySelector('.grid-notice')).toBe(null);
  });
});

describe('the one line above the grid about the last transition (#13)', () => {
  it('shows a failed transition as an error, with the grid still usable', () => {
    paint({ notice: { text: TRANSITION_FAILED_TEXT, kind: 'error' } });
    expect(root.querySelector('.grid-notice--error').textContent).toBe(TRANSITION_FAILED_TEXT);
    expect(tiles()).toHaveLength(2);
  });

  it('shows a device that cannot be faded quietly, as information rather than failure', () => {
    paint({ notice: { text: NO_VOLUME_TEXT, kind: 'info' } });
    const line = root.querySelector('.grid-notice');
    expect(line.textContent).toBe(NO_VOLUME_TEXT);
    expect(line.classList.contains('grid-notice--info')).toBe(true);
    // It never stops the grid working — the playlist did switch, just without a fade.
    expect(tiles()).toHaveLength(2);
  });

  it('treats a bare string as an error, which is what every caller of that shape meant', () => {
    paint({ notice: 'something went wrong' });
    expect(root.querySelector('.grid-notice--error').textContent).toBe('something went wrong');
  });
});

describe('the grid stays one kind of tile', () => {
  it('keeps the grid pure cover art — the per-playlist flags are settings\' business', () => {
    // The flags used to show as markers on the tile inside edit mode. Order moved to the
    // settings screen (#3) and the markers went with it: the difference they describe is
    // audible, and the pills on the settings row say the same thing in words.
    const marked = [
      { ...items[0], nofadein: true, inorder: true },
      { ...items[1], nofadein: false, inorder: false },
    ];
    renderGrid(root, { items: marked, linkOptions: { token: TOKEN } });
    expect(root.querySelectorAll('.tile-flag')).toHaveLength(0);
    expect(root.textContent).not.toContain('no fade');
    expect(root.textContent).not.toContain('no shuffle');
  });

  it('offers no rearrange control — that lives on the settings screen now', () => {
    paint();
    expect(root.querySelector('.grid-edit')).toBe(null);
    expect(root.querySelector('.grid-bar')).toBe(null);
    expect(root.textContent.toLowerCase()).not.toContain('rearrange');
  });

  it('marks the now-playing tile and nothing else', () => {
    paint({ nowPlayingId: 'bbb' });
    const [a, b] = tiles();
    expect(a.classList.contains('is-playing')).toBe(false);
    expect(b.classList.contains('is-playing')).toBe(true);
    expect(b.getAttribute('aria-label')).toBe('Battle (playing)');
  });
});
