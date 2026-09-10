// @vitest-environment jsdom
//
// The drag itself (#3). Two layers:
//
//  1. The two decisions worth pinning down on their own — where a pointer lands, and what
//     an order looks like after a move — are pure functions.
//  2. The controller, driven with real PointerEvents against stubbed geometry. jsdom does
//     no layout, so every row's rect is faked; the list is laid out as a stack of 60px
//     rows, which is the shape the settings screen actually has.
//
// The controller takes its item selector as an option, so these tests drive it exactly
// the way the settings screen does: only `.row.is-member` moves, and only a press that
// starts on a `.handle` starts a drag at all.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attachDragReorder, dropTargetIndex, moveInOrder, itemOrder, DRAG_THRESHOLD } from '../src/drag.js';

const ITEM = '.row.is-member';
const HANDLE = '.handle';

describe('dropTargetIndex — hit test, not nearest centre', () => {
  const rects = [
    { left: 0, top: 0, right: 100, bottom: 100 },
    { left: 110, top: 0, right: 210, bottom: 100 },
    { left: 0, top: 110, right: 100, bottom: 210 },
  ];

  it('finds the item the pointer is inside', () => {
    expect(dropTargetIndex(rects, 50, 50)).toBe(0);
    expect(dropTargetIndex(rects, 150, 50)).toBe(1);
    expect(dropTargetIndex(rects, 50, 150)).toBe(2);
  });

  it('returns -1 in the gap, so nothing flicks about while the finger sits still', () => {
    expect(dropTargetIndex(rects, 105, 50)).toBe(-1);
    expect(dropTargetIndex(rects, 50, 105)).toBe(-1);
  });

  it('returns -1 off the list entirely', () => {
    expect(dropTargetIndex(rects, 900, 900)).toBe(-1);
    expect(dropTargetIndex(undefined, 5, 5)).toBe(-1);
  });
});

describe('moveInOrder', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves from the last position to the first', () => {
    expect(moveInOrder(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves from the first position to the last', () => {
    expect(moveInOrder(ids, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves from the middle in both directions', () => {
    expect(moveInOrder(ids, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveInOrder(ids, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('leaves the list alone for a no-op or an out-of-range index', () => {
    expect(moveInOrder(ids, 1, 1)).toEqual(ids);
    expect(moveInOrder(ids, -1, 2)).toEqual(ids);
    expect(moveInOrder(ids, 0, 9)).toEqual(ids);
  });

  it('does not mutate its input', () => {
    const original = ids.slice();
    moveInOrder(ids, 0, 3);
    expect(ids).toEqual(original);
  });
});

// ------------------------------------------------------------------------------------
// The controller
// ------------------------------------------------------------------------------------

const ROW = 60;

/** The rect of the nth row in a stack of 60px rows. */
function slotRect(index) {
  const top = index * ROW;
  return { left: 0, top, right: 340, bottom: top + ROW, width: 340, height: ROW };
}

/** The centre of a row — where a finger would be to be "over" that position. */
const centreOf = (index) => {
  const r = slotRect(index);
  return { x: r.left + 20, y: r.top + ROW / 2 };
};

let list;
let onReorder;

/**
 * Build a list of `ids` and teach every row to report the rect of whatever slot it
 * currently occupies — plus whatever translate the drag has put on it, which is how the
 * real thing behaves and is what `place()` subtracts back off.
 *
 * `members` is how many of the rows are in the rotation. They come first, exactly as the
 * settings screen sorts them, and the rest are there to prove a drag cannot reach them.
 */
function buildList(ids, members = ids.length) {
  list = document.createElement('ul');
  list.className = 'pl-list';
  ids.forEach((id, i) => {
    const li = document.createElement('li');
    li.className = i < members ? 'row is-member' : 'row';
    li.dataset.id = id;
    const handle = document.createElement('span');
    handle.className = 'handle';
    li.append(handle);
    list.append(li);
  });
  document.body.append(list);

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const row = this.closest('li') ?? this;
    const index = Array.from(row.parentElement?.children ?? []).indexOf(row);
    const base = slotRect(index < 0 ? 0 : index);
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(row.style.transform ?? '');
    const dx = match ? Number(match[1]) : 0;
    const dy = match ? Number(match[2]) : 0;
    return {
      ...base,
      left: base.left + dx,
      right: base.right + dx,
      top: base.top + dy,
      bottom: base.bottom + dy,
    };
  });
}

const attach = (opts = {}) =>
  attachDragReorder(list, { selector: ITEM, handle: HANDLE, onReorder, ...opts });

const order = () => itemOrder(list, ITEM);
const handleOf = (index) => list.children[index].querySelector(HANDLE);

const pointer = (type, target, x, y, extra = {}) =>
  target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    clientX: x, clientY: y, ...extra,
  }));

/** Press the handle of the row at `from`, drag to the centre of `to`, drop. */
function drag(fromIndex, toIndex, { drop = true } = {}) {
  const row = list.children[fromIndex];
  const start = centreOf(fromIndex);
  const end = centreOf(toIndex);
  pointer('pointerdown', handleOf(fromIndex), start.x, start.y);
  // A couple of intermediate moves, because the controller re-anchors on each one and a
  // single jump would not exercise that.
  pointer('pointermove', window, (start.x + end.x) / 2, (start.y + end.y) / 2);
  pointer('pointermove', window, end.x, end.y);
  if (drop) pointer('pointerup', window, end.x, end.y);
  return row;
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  onReorder = vi.fn();
});

describe('dragging a row to a new position', () => {
  beforeEach(() => {
    buildList(['a', 'b', 'c', 'd', 'e']);
    attach();
  });

  it('drags the last row to the first position', () => {
    drag(4, 0);
    expect(order()).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(onReorder).toHaveBeenCalledWith(['e', 'a', 'b', 'c', 'd']);
  });

  it('drags the first row to the last position', () => {
    drag(0, 4);
    expect(order()).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'd', 'e', 'a']);
  });

  it('drags a middle row forwards', () => {
    drag(2, 4);
    expect(order()).toEqual(['a', 'b', 'd', 'e', 'c']);
  });

  it('drags a middle row backwards', () => {
    drag(2, 0);
    expect(order()).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('reports the whole order, not just what moved', () => {
    drag(4, 0);
    expect(onReorder.mock.calls[0][0]).toHaveLength(5);
  });

  it('calls onReorder exactly once per drop', () => {
    drag(4, 0);
    expect(onReorder).toHaveBeenCalledTimes(1);
  });
});

describe('a drag starts on the handle and nowhere else', () => {
  beforeEach(() => {
    buildList(['a', 'b', 'c']);
    attach();
  });

  it('ignores a press on the row body — that gesture is the add/remove tap', () => {
    const start = centreOf(2);
    pointer('pointerdown', list.children[2], start.x, start.y);
    pointer('pointermove', window, centreOf(0).x, centreOf(0).y);
    pointer('pointerup', window, centreOf(0).x, centreOf(0).y);
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('drags when the press is on the handle', () => {
    drag(2, 0);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });
});

describe('rows that are not in the rotation', () => {
  beforeEach(() => {
    // Three members, then two rows that are only candidates.
    buildList(['a', 'b', 'c', 'x', 'y'], 3);
    attach();
  });

  it('leaves a non-member out of the order entirely', () => {
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('cannot push a member below the divider, however far the finger goes', () => {
    drag(0, 4); // way past the last member, into the candidates
    // It lands at the end of the member block and stops there — a row cannot leave the
    // rotation by being dragged out of it, because leaving is a tap on the row.
    expect(order()).toEqual(['b', 'c', 'a']);
    expect(Array.from(list.children).map((li) => li.dataset.id))
      .toEqual(['b', 'c', 'a', 'x', 'y']);
  });

  it('does not move a non-member the finger passes over', () => {
    drag(0, 3);
    expect(Array.from(list.children).map((li) => li.dataset.id).slice(3)).toEqual(['x', 'y']);
  });

  it('still reorders freely within the member block', () => {
    drag(2, 0);
    expect(order()).toEqual(['c', 'a', 'b']);
    expect(Array.from(list.children).map((li) => li.dataset.id))
      .toEqual(['c', 'a', 'b', 'x', 'y']);
  });
});

describe('gestures that are not a reorder', () => {
  beforeEach(() => {
    buildList(['a', 'b', 'c']);
    attach();
  });

  it('does not write anything when a row is dragged away and dropped back', () => {
    const start = centreOf(1);
    pointer('pointerdown', handleOf(1), start.x, start.y);
    pointer('pointermove', window, centreOf(2).x, centreOf(2).y);
    expect(order()).toEqual(['a', 'c', 'b']); // the preview did move
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    pointer('pointerup', window, centreOf(1).x, centreOf(1).y);
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores a press that never moves past the threshold', () => {
    const row = list.children[0];
    const start = centreOf(0);
    pointer('pointerdown', handleOf(0), start.x, start.y);
    pointer('pointermove', window, start.x, start.y + DRAG_THRESHOLD - 1);
    pointer('pointerup', window, start.x, start.y + DRAG_THRESHOLD - 1);
    expect(onReorder).not.toHaveBeenCalled();
    expect(row.classList.contains('is-dragging')).toBe(false);
  });

  it('ignores a press that did not start on a row at all', () => {
    pointer('pointerdown', list, 5, 500);
    pointer('pointermove', window, 5, 5);
    pointer('pointerup', window, 5, 5);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores a non-primary pointer and a right button', () => {
    const start = centreOf(0);
    pointer('pointerdown', handleOf(0), start.x, start.y, { isPrimary: false });
    pointer('pointerdown', handleOf(0), start.x, start.y, { button: 2 });
    pointer('pointermove', window, centreOf(2).x, centreOf(2).y);
    pointer('pointerup', window, centreOf(2).x, centreOf(2).y);
    expect(onReorder).not.toHaveBeenCalled();
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('leaves a finger below the last row alone', () => {
    const start = centreOf(0);
    pointer('pointerdown', handleOf(0), start.x, start.y);
    pointer('pointermove', window, start.x, 3 * ROW + 40); // past the end of the list
    pointer('pointerup', window, start.x, 3 * ROW + 40);
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('while the drag is happening', () => {
  beforeEach(() => {
    buildList(['a', 'b', 'c']);
    attach();
  });

  it('marks the row and the list, and clears both on drop', () => {
    const row = list.children[0];
    const start = centreOf(0);
    pointer('pointerdown', handleOf(0), start.x, start.y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    expect(row.classList.contains('is-dragging')).toBe(true);
    expect(list.classList.contains('is-reordering')).toBe(true);
    pointer('pointerup', window, centreOf(1).x, centreOf(1).y);
    expect(row.classList.contains('is-dragging')).toBe(false);
    expect(list.classList.contains('is-reordering')).toBe(false);
    expect(row.style.transform).toBe('');
  });

  it('says when a drag starts and finishes, so nothing repaints under the finger', () => {
    const onDragChange = vi.fn();
    document.body.replaceChildren();
    buildList(['a', 'b', 'c']);
    attach({ onDragChange });
    drag(2, 0);
    expect(onDragChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('says nothing at all for a press that never became a drag', () => {
    const onDragChange = vi.fn();
    document.body.replaceChildren();
    buildList(['a', 'b', 'c']);
    attach({ onDragChange });
    const start = centreOf(0);
    pointer('pointerdown', handleOf(0), start.x, start.y);
    pointer('pointerup', window, start.x, start.y);
    expect(onDragChange).not.toHaveBeenCalled();
  });

  it('keeps the row under the finger across a reorder', () => {
    const row = list.children[0];
    const start = centreOf(0);
    const end = centreOf(2);
    pointer('pointerdown', handleOf(0), start.x, start.y);
    pointer('pointermove', window, end.x, end.y);
    // Grabbed at the vertical centre, so the row's rect should be centred on the finger —
    // which is only true if the translate was recomputed after the DOM moved it to slot 2.
    const rect = row.getBoundingClientRect();
    expect(rect.top + ROW / 2).toBeCloseTo(end.y, 5);
  });

  it('recovers from a gesture that never got its pointerup', () => {
    // A lost pointer must not wedge the list: the next press has to work. Bailing out of
    // pointerdown while a stale gesture is open is what makes a list silently stop being
    // draggable, and nothing on screen says so.
    const start = centreOf(0);
    pointer('pointerdown', handleOf(0), start.x, start.y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    // …and no pointerup ever arrives. A fresh drag still works.
    expect(order()).toEqual(['b', 'a', 'c']);
    drag(2, 0);
    expect(order()).toEqual(['c', 'b', 'a']);
    expect(onReorder).toHaveBeenLastCalledWith(['c', 'b', 'a']);
  });

  it('leaves no drag styling behind when a gesture is abandoned', () => {
    const stale = list.children[0];
    pointer('pointerdown', handleOf(0), centreOf(0).x, centreOf(0).y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    pointer('pointerdown', handleOf(2), centreOf(2).x, centreOf(2).y);
    expect(stale.classList.contains('is-dragging')).toBe(false);
    expect(stale.style.transform).toBe('');
  });

  it('commits on pointercancel rather than snapping back to where it was', () => {
    drag(2, 0, { drop: false });
    pointer('pointercancel', window, centreOf(0).x, centreOf(0).y);
    expect(order()).toEqual(['c', 'a', 'b']);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });
});

describe('detaching', () => {
  it('stops listening and cleans up a drag in progress', () => {
    buildList(['a', 'b', 'c']);
    const off = attach();
    const row = list.children[0];
    pointer('pointerdown', handleOf(0), centreOf(0).x, centreOf(0).y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    off();
    expect(row.classList.contains('is-dragging')).toBe(false);
    pointer('pointerup', window, centreOf(1).x, centreOf(1).y);
    expect(onReorder).not.toHaveBeenCalled();
    // And a fresh gesture does nothing at all.
    pointer('pointerdown', handleOf(0), centreOf(0).x, centreOf(0).y);
    pointer('pointermove', window, centreOf(2).x, centreOf(2).y);
    pointer('pointerup', window, centreOf(2).x, centreOf(2).y);
    expect(onReorder).not.toHaveBeenCalled();
  });
});
