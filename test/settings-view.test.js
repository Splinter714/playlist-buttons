// @vitest-environment jsdom
//
// The settings screen. Two things here are worth pinning down beyond "it renders":
//
//  1. THE SORT. Members come first, in button order. Everything on this screen rests on
//     it — a drag reorders DOM siblings, so if the DOM were in account order (button 3
//     forty rows below button 4) dragging could not express an order at all.
//  2. IN-PLACE UPDATES. A tap renumbers every badge and lifts a row across the divider,
//     and it has to do that by MOVING nodes. Re-rendering would re-create hundreds of
//     <img> elements and flicker the whole list, so the tests check node identity, not
//     just the text that came out.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderSettings, sortForDisplay, FLAG_LABELS, REST_HEADING,
  SHORTCUT_HEADING, SHORTCUT_NOTE, SHORTCUT_LINK_TEXT,
} from '../src/settings-view.js';
import { SHORTCUT_URL } from '../src/config.js';
import {
  readRotation, writeRotation, buildCandidates, reorderRotation,
  addToRotation, removeFromRotation, isInRotation, toggleNofadein, toggleInorder,
} from '../src/rotation.js';

const account = [
  { id: 'aaa', name: 'Tavern', trackTotal: 38, image: 'https://img/aaa' },
  { id: 'bbb', name: 'Battle', trackTotal: 12, image: 'https://img/bbb' },
  { id: 'ccc', name: 'Calm', trackTotal: 30, image: 'https://img/ccc' },
  { id: 'ddd', name: 'City', trackTotal: 11, image: 'https://img/ddd' },
];

let root;
let onDragChange;

/** What main.js wires up: every callback writes through rotation.js and hands back rows. */
function paint() {
  renderSettings(root, {
    loggedIn: true,
    candidates: buildCandidates(account),
    onToggleMember: (id) => {
      if (isInRotation(id)) removeFromRotation(id);
      else addToRotation(id);
      return buildCandidates(account);
    },
    onToggleNofadein: (id) => { toggleNofadein(id); return buildCandidates(account); },
    onToggleInorder: (id) => { toggleInorder(id); return buildCandidates(account); },
    onReorder: (ids) => { reorderRotation(ids); return buildCandidates(account); },
    onDragChange,
  });
}

const rows = () => Array.from(root.querySelectorAll('.pl-row'));
const rowIds = () => rows().map((li) => li.dataset.id);
const rowFor = (id) => root.querySelector(`.pl-row[data-id="${id}"]`);
const badgeOf = (id) => rowFor(id).querySelector('.pl-badge');
const badges = () => rows().map((li) => (li.querySelector('.pl-badge').hidden ? null : li.querySelector('.pl-badge').textContent));
const divider = () => root.querySelector('.pl-divider');

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.replaceChildren();
  root = document.createElement('main');
  document.body.append(root);
  onDragChange = vi.fn();
});

describe('sortForDisplay', () => {
  it('puts members first in button order, then the rest as they came', () => {
    const list = [
      { id: 'a', inRotation: false },
      { id: 'b', inRotation: true, position: 2 },
      { id: 'c', inRotation: false },
      { id: 'd', inRotation: true, position: 1 },
    ];
    expect(sortForDisplay(list).map((c) => c.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('leaves a list with no members exactly as it was', () => {
    const list = [{ id: 'a', inRotation: false }, { id: 'b', inRotation: false }];
    expect(sortForDisplay(list).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('does not mutate its input, and survives junk', () => {
    const list = [{ id: 'a', inRotation: true, position: 2 }, { id: 'b', inRotation: true, position: 1 }];
    sortForDisplay(list);
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
    expect(sortForDisplay(undefined)).toEqual([]);
  });
});

describe('the link to the shortcut', () => {
  const link = () => root.querySelector('.settings-link');

  it('is on the screen even before anything is in the rotation', () => {
    renderSettings(root, { loggedIn: false });
    expect(link().textContent).toBe(SHORTCUT_LINK_TEXT);
    expect(link().getAttribute('href')).toBe(SHORTCUT_URL);
    expect(root.textContent).toContain(SHORTCUT_NOTE);
  });

  it('sits above the rotation, which can run to hundreds of rows', () => {
    paint();
    const headings = Array.from(root.querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings).toEqual(['Fade', SHORTCUT_HEADING, 'Rotation']);
  });

  it('opens away from the app, without handing the opener over', () => {
    paint();
    expect(link().target).toBe('_blank');
    expect(link().rel).toContain('noopener');
  });

  it('can be pointed somewhere else without touching the view', () => {
    renderSettings(root, { loggedIn: true, candidates: [], shortcutUrl: 'https://www.icloud.com/shortcuts/abc' });
    expect(link().getAttribute('href')).toBe('https://www.icloud.com/shortcuts/abc');
  });
});

describe('the list is sorted before anything is dragged', () => {
  it('lifts the rotation to the top, in button order, whatever order the account is in', () => {
    writeRotation([{ id: 'ddd' }, { id: 'bbb' }]);
    paint();
    expect(rowIds()).toEqual(['ddd', 'bbb', 'aaa', 'ccc']);
  });

  it('separates the two blocks with one divider, and only when both exist', () => {
    paint();
    expect(divider().hidden).toBe(true); // nothing in the rotation yet
    writeRotation([{ id: 'aaa' }]);
    paint();
    expect(divider().hidden).toBe(false);
    expect(divider().textContent).toBe(REST_HEADING);
    writeRotation(account.map((p) => ({ id: p.id })));
    paint();
    expect(divider().hidden).toBe(true); // everything is a member
  });

  it('counts the buttons, not the playlists', () => {
    writeRotation([{ id: 'aaa' }, { id: 'bbb' }]);
    paint();
    expect(root.querySelector('.rot-count').textContent).toBe('2 buttons');
  });
});

describe('the button number', () => {
  beforeEach(() => {
    writeRotation([{ id: 'ccc' }, { id: 'aaa' }]);
    paint();
  });

  it('sits on the cover art, not loose in the row where the pills can shove it about', () => {
    expect(badgeOf('ccc').parentElement.classList.contains('pl-art')).toBe(true);
  });

  it('reads as the position in the rotation, and is hidden for everything else', () => {
    expect(badges()).toEqual(['1', '2', null, null]);
  });

  it('leaves the trailing column to the add affordance for a non-member', () => {
    expect(rowFor('bbb').querySelector('.pl-add').hidden).toBe(false);
    expect(rowFor('ccc').querySelector('.pl-add').hidden).toBe(true);
  });
});

describe('the two flag pills', () => {
  beforeEach(() => {
    writeRotation([{ id: 'aaa' }]);
    paint();
  });

  it('names the exception rather than the behaviour', () => {
    expect(FLAG_LABELS.map(([, label]) => label)).toEqual(['no fade', 'no shuffle']);
    const labels = Array.from(rowFor('aaa').querySelectorAll('.pl-flag')).map((b) => b.textContent);
    expect(labels).toEqual(['no fade', 'no shuffle']);
  });

  it('toggles each flag independently, through the rotation', () => {
    rowFor('aaa').querySelector('.pl-flag--nofadein').click();
    expect(readRotation()[0]).toEqual({ id: 'aaa', nofadein: true, inorder: false });
    rowFor('aaa').querySelector('.pl-flag--inorder').click();
    expect(readRotation()[0]).toEqual({ id: 'aaa', nofadein: true, inorder: true });
    expect(rowFor('aaa').querySelector('.pl-flag--nofadein').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows no pills at all on a row that is not in the rotation', () => {
    expect(rowFor('bbb').querySelector('.pl-flags').hidden).toBe(true);
  });
});

describe('adding and removing move the row across the divider', () => {
  it('lifts a newly added playlist to the end of the member block, keeping its artwork', () => {
    writeRotation([{ id: 'ddd' }]);
    paint();
    const img = rowFor('bbb').querySelector('img');
    rowFor('bbb').querySelector('.pl-main').click();
    expect(readRotation().map((e) => e.id)).toEqual(['ddd', 'bbb']);
    expect(rowIds()).toEqual(['ddd', 'bbb', 'aaa', 'ccc']);
    expect(badges()).toEqual(['1', '2', null, null]);
    // The same <img> node, never re-created — this is why rows move instead of re-render.
    expect(rowFor('bbb').querySelector('img')).toBe(img);
  });

  it('drops a removed playlist back below the divider and renumbers what is left', () => {
    writeRotation([{ id: 'aaa' }, { id: 'bbb' }, { id: 'ccc' }]);
    paint();
    rowFor('aaa').querySelector('.pl-main').click();
    expect(readRotation().map((e) => e.id)).toEqual(['bbb', 'ccc']);
    expect(rowIds().slice(0, 2)).toEqual(['bbb', 'ccc']);
    expect(badgeOf('bbb').textContent).toBe('1');
    expect(badgeOf('aaa').hidden).toBe(true);
  });

  it('reveals the divider the moment the first playlist is added', () => {
    paint();
    expect(divider().hidden).toBe(true);
    rowFor('ccc').querySelector('.pl-main').click();
    expect(divider().hidden).toBe(false);
    expect(rowIds()[0]).toBe('ccc');
  });
});

// ------------------------------------------------------------------------------------
// Reordering (#3)
// ------------------------------------------------------------------------------------
//
// jsdom does no layout, so every row reports the slot it currently sits in. Rows are 60px
// tall and the drag is vertical, which is the shape the real screen has.

const ROW = 60;
const centreOf = (i) => ({ x: 20, y: i * ROW + ROW / 2 });

function stubGeometry() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const li = this.closest('li') ?? this;
    const index = Array.from(li.parentElement?.children ?? []).indexOf(li);
    const top = (index < 0 ? 0 : index) * ROW;
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(li.style.transform ?? '');
    const dy = m ? Number(m[2]) : 0;
    return { left: 0, right: 340, top: top + dy, bottom: top + ROW + dy, width: 340, height: ROW };
  });
}

const pointer = (type, target, x, y) =>
  target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y,
  }));

/** Drag the row in slot `from` onto slot `to` by its handle, and drop it. */
function dragRow(from, to) {
  const handle = root.querySelectorAll('.pl-row')[from].querySelector('.pl-handle');
  pointer('pointerdown', handle, centreOf(from).x, centreOf(from).y);
  pointer('pointermove', window, centreOf(to).x, centreOf(to).y);
  pointer('pointerup', window, centreOf(to).x, centreOf(to).y);
}

describe('dragging a row writes the new order through rotation.js', () => {
  beforeEach(() => {
    stubGeometry();
    writeRotation([{ id: 'aaa' }, { id: 'bbb', nofadein: true, inorder: true }, { id: 'ccc' }]);
    paint();
  });

  it('offers a handle on a member and on nothing else', () => {
    expect(rowFor('aaa').querySelector('.pl-handle').hidden).toBe(false);
    expect(rowFor('ddd').querySelector('.pl-handle').hidden).toBe(true);
  });

  it('saves on drop — no save button to forget', () => {
    dragRow(2, 0);
    expect(readRotation().map((e) => e.id)).toEqual(['ccc', 'aaa', 'bbb']);
  });

  it('renumbers the badges in place, without rebuilding the rows', () => {
    const img = rowFor('ccc').querySelector('img');
    dragRow(2, 0);
    expect(rowIds()).toEqual(['ccc', 'aaa', 'bbb', 'ddd']);
    expect(badges()).toEqual(['1', '2', '3', null]);
    expect(rowFor('ccc').querySelector('img')).toBe(img);
  });

  it('carries each playlist flags along with it rather than reordering ids only', () => {
    dragRow(1, 0);
    expect(readRotation()[0]).toEqual({ id: 'bbb', nofadein: true, inorder: true });
  });

  it('survives a reload: the screen repaints from the store in the new order', () => {
    dragRow(0, 2);
    root.replaceChildren();
    paint();
    expect(rowIds()).toEqual(['bbb', 'ccc', 'aaa', 'ddd']);
  });

  it('says when a drag starts and finishes, so nothing repaints under the finger', () => {
    dragRow(2, 0);
    expect(onDragChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('does not start a drag from the row body — that gesture adds or removes', () => {
    pointer('pointerdown', rowFor('ccc'), centreOf(2).x, centreOf(2).y);
    pointer('pointermove', window, centreOf(0).x, centreOf(0).y);
    pointer('pointerup', window, centreOf(0).x, centreOf(0).y);
    expect(readRotation().map((e) => e.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });
});
