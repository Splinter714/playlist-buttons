// @vitest-environment jsdom
//
// The drag itself (#3). Two layers:
//
//  1. The two decisions worth pinning down on their own — where a pointer lands, and what
//     an order looks like after a move — are pure functions.
//  2. The controller, driven with real PointerEvents against stubbed geometry. jsdom does
//     no layout, so every tile's rect is faked; the grid is laid out as a 3-wide grid of
//     100px tiles, which is close enough to the real 375px shape to reason about.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attachTileDrag, dropTargetIndex, moveInOrder, tileOrder, DRAG_THRESHOLD } from '../src/drag.js';

describe('dropTargetIndex — hit test, not nearest centre', () => {
  const rects = [
    { left: 0, top: 0, right: 100, bottom: 100 },
    { left: 110, top: 0, right: 210, bottom: 100 },
    { left: 0, top: 110, right: 100, bottom: 210 },
  ];

  it('finds the tile the pointer is inside', () => {
    expect(dropTargetIndex(rects, 50, 50)).toBe(0);
    expect(dropTargetIndex(rects, 150, 50)).toBe(1);
    expect(dropTargetIndex(rects, 50, 150)).toBe(2);
  });

  it('returns -1 in the gap, so nothing flicks about while the finger sits still', () => {
    expect(dropTargetIndex(rects, 105, 50)).toBe(-1);
    expect(dropTargetIndex(rects, 50, 105)).toBe(-1);
  });

  it('returns -1 off the grid entirely', () => {
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

const TILE = 100;
const GAP = 10;
const PER_ROW = 3;

/** Slot geometry for the nth tile in a 3-wide grid of 100px tiles with 10px gaps. */
function slotRect(index) {
  const left = (index % PER_ROW) * (TILE + GAP);
  const top = Math.floor(index / PER_ROW) * (TILE + GAP);
  return { left, top, right: left + TILE, bottom: top + TILE, width: TILE, height: TILE };
}

/** The centre of a slot — where a finger would be to be "over" that position. */
const centreOf = (index) => {
  const r = slotRect(index);
  return { x: r.left + TILE / 2, y: r.top + TILE / 2 };
};

let grid;
let onReorder;

/**
 * Build a grid of `ids` and teach every tile to report the rect of whatever slot it
 * currently occupies — plus whatever translate the drag has put on it, which is how the
 * real thing behaves and is what `place()` subtracts back off.
 */
function buildGrid(ids) {
  grid = document.createElement('div');
  grid.className = 'grid grid--editing';
  for (const id of ids) {
    const a = document.createElement('a');
    a.className = 'tile';
    a.dataset.id = id;
    grid.append(a);
  }
  document.body.append(grid);

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
    const base = slotRect(index < 0 ? 0 : index);
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(this.style.transform ?? '');
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

const pointer = (type, target, x, y, extra = {}) =>
  target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    clientX: x, clientY: y, ...extra,
  }));

/** Press the tile at `from`, drag to the centre of `to`, drop. */
function drag(fromIndex, toIndex, { drop = true } = {}) {
  const tile = grid.children[fromIndex];
  const start = centreOf(fromIndex);
  const end = centreOf(toIndex);
  pointer('pointerdown', tile, start.x, start.y);
  // A couple of intermediate moves, because the controller re-anchors on each one and a
  // single jump would not exercise that.
  pointer('pointermove', window, (start.x + end.x) / 2, (start.y + end.y) / 2);
  pointer('pointermove', window, end.x, end.y);
  if (drop) pointer('pointerup', window, end.x, end.y);
  return tile;
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  onReorder = vi.fn();
});

describe('dragging a tile to a new position', () => {
  beforeEach(() => {
    buildGrid(['a', 'b', 'c', 'd', 'e']);
    attachTileDrag(grid, { onReorder });
  });

  it('drags the last tile to the first position', () => {
    drag(4, 0);
    expect(tileOrder(grid)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(onReorder).toHaveBeenCalledWith(['e', 'a', 'b', 'c', 'd']);
  });

  it('drags the first tile to the last position', () => {
    drag(0, 4);
    expect(tileOrder(grid)).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'd', 'e', 'a']);
  });

  it('drags a middle tile forwards', () => {
    drag(2, 4);
    expect(tileOrder(grid)).toEqual(['a', 'b', 'd', 'e', 'c']);
  });

  it('drags a middle tile backwards', () => {
    drag(2, 0);
    expect(tileOrder(grid)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('crosses a row boundary — the second row is where a 3-wide grid gets interesting', () => {
    drag(3, 1); // second row, first column -> first row, second column
    expect(tileOrder(grid)).toEqual(['a', 'd', 'b', 'c', 'e']);
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

describe('gestures that are not a reorder', () => {
  beforeEach(() => {
    buildGrid(['a', 'b', 'c']);
    attachTileDrag(grid, { onReorder });
  });

  it('does not write anything when a tile is dragged away and dropped back', () => {
    const tile = grid.children[1];
    const start = centreOf(1);
    pointer('pointerdown', tile, start.x, start.y);
    pointer('pointermove', window, centreOf(2).x, centreOf(2).y);
    expect(tileOrder(grid)).toEqual(['a', 'c', 'b']); // the preview did move
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    pointer('pointerup', window, centreOf(1).x, centreOf(1).y);
    expect(tileOrder(grid)).toEqual(['a', 'b', 'c']);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores a press that never moves past the threshold', () => {
    const tile = grid.children[0];
    const start = centreOf(0);
    pointer('pointerdown', tile, start.x, start.y);
    pointer('pointermove', window, start.x + DRAG_THRESHOLD - 1, start.y);
    pointer('pointerup', window, start.x + DRAG_THRESHOLD - 1, start.y);
    expect(onReorder).not.toHaveBeenCalled();
    expect(tile.classList.contains('is-dragging')).toBe(false);
  });

  it('ignores a press that did not start on a tile', () => {
    pointer('pointerdown', grid, 500, 500);
    pointer('pointermove', window, 5, 5);
    pointer('pointerup', window, 5, 5);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores a non-primary pointer and a right button', () => {
    const tile = grid.children[0];
    const start = centreOf(0);
    pointer('pointerdown', tile, start.x, start.y, { isPrimary: false });
    pointer('pointerdown', tile, start.x, start.y, { button: 2 });
    pointer('pointermove', window, centreOf(2).x, centreOf(2).y);
    pointer('pointerup', window, centreOf(2).x, centreOf(2).y);
    expect(onReorder).not.toHaveBeenCalled();
    expect(tileOrder(grid)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a finger in the gap between tiles alone', () => {
    const tile = grid.children[0];
    const start = centreOf(0);
    pointer('pointerdown', tile, start.x, start.y);
    pointer('pointermove', window, TILE + GAP / 2, start.y); // dead centre of the gap
    pointer('pointerup', window, TILE + GAP / 2, start.y);
    expect(tileOrder(grid)).toEqual(['a', 'b', 'c']);
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('while the drag is happening', () => {
  beforeEach(() => {
    buildGrid(['a', 'b', 'c']);
    attachTileDrag(grid, { onReorder });
  });

  it('marks the tile and the grid, and clears both on drop', () => {
    const tile = grid.children[0];
    const start = centreOf(0);
    pointer('pointerdown', tile, start.x, start.y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    expect(tile.classList.contains('is-dragging')).toBe(true);
    expect(grid.classList.contains('grid--dragging')).toBe(true);
    pointer('pointerup', window, centreOf(1).x, centreOf(1).y);
    expect(tile.classList.contains('is-dragging')).toBe(false);
    expect(grid.classList.contains('grid--dragging')).toBe(false);
    expect(tile.style.transform).toBe('');
  });

  it('keeps the tile under the finger across a reorder', () => {
    const tile = grid.children[0];
    const start = centreOf(0);
    const end = centreOf(2);
    pointer('pointerdown', tile, start.x, start.y);
    pointer('pointermove', window, end.x, end.y);
    // Grabbed at the centre, so the tile's rect should be centred on the finger — which
    // is only true if the translate was recomputed after the DOM moved it to slot 2.
    const rect = tile.getBoundingClientRect();
    expect(rect.left + TILE / 2).toBeCloseTo(end.x, 5);
    expect(rect.top + TILE / 2).toBeCloseTo(end.y, 5);
  });

  it('recovers from a gesture that never got its pointerup', () => {
    // A lost pointer must not wedge the grid: the next press has to work. Bailing out of
    // pointerdown while a stale gesture is open is what makes a grid silently stop being
    // draggable, and nothing on screen says so.
    const start = centreOf(0);
    pointer('pointerdown', grid.children[0], start.x, start.y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    // …and no pointerup ever arrives. A fresh drag still works.
    expect(tileOrder(grid)).toEqual(['b', 'a', 'c']);
    drag(2, 0);
    expect(tileOrder(grid)).toEqual(['c', 'b', 'a']);
    expect(onReorder).toHaveBeenLastCalledWith(['c', 'b', 'a']);
  });

  it('leaves no drag styling behind when a gesture is abandoned', () => {
    const stale = grid.children[0];
    pointer('pointerdown', stale, centreOf(0).x, centreOf(0).y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    pointer('pointerdown', grid.children[2], centreOf(2).x, centreOf(2).y);
    expect(stale.classList.contains('is-dragging')).toBe(false);
    expect(stale.style.transform).toBe('');
  });

  it('commits on pointercancel rather than snapping back to where it was', () => {
    drag(2, 0, { drop: false });
    pointer('pointercancel', window, centreOf(0).x, centreOf(0).y);
    expect(tileOrder(grid)).toEqual(['c', 'a', 'b']);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });
});

describe('detaching', () => {
  it('stops listening and cleans up a drag in progress', () => {
    buildGrid(['a', 'b', 'c']);
    const off = attachTileDrag(grid, { onReorder });
    const tile = grid.children[0];
    pointer('pointerdown', tile, centreOf(0).x, centreOf(0).y);
    pointer('pointermove', window, centreOf(1).x, centreOf(1).y);
    off();
    expect(tile.classList.contains('is-dragging')).toBe(false);
    pointer('pointerup', window, centreOf(1).x, centreOf(1).y);
    expect(onReorder).not.toHaveBeenCalled();
    // And a fresh gesture does nothing at all.
    pointer('pointerdown', grid.children[0], centreOf(0).x, centreOf(0).y);
    pointer('pointermove', window, centreOf(2).x, centreOf(2).y);
    pointer('pointerup', window, centreOf(2).x, centreOf(2).y);
    expect(onReorder).not.toHaveBeenCalled();
  });
});
