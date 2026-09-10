import { describe, it, expect } from 'vitest';
import { assignOrders, applyAssignments, sortForGrid, compareNames } from '../src/order.js';

const pl = (id, name, order = null) => ({ id, name, order });

describe('assignOrders — next free integer, in name order', () => {
  it('numbers a fresh set from 1 in name order', () => {
    const out = assignOrders([pl('c', 'Chase'), pl('a', 'Ambient'), pl('b', 'Battle')]);
    expect(out.map((p) => [p.name, p.order])).toEqual([
      ['Ambient', 1], ['Battle', 2], ['Chase', 3],
    ]);
  });

  it('returns nothing when everything already has an order', () => {
    expect(assignOrders([pl('a', 'A', 1), pl('b', 'B', 2)])).toEqual([]);
  });

  it('skips orders already taken', () => {
    const out = assignOrders([pl('a', 'Taken', 1), pl('b', 'Also', 3), pl('c', 'New')]);
    expect(out).toEqual([expect.objectContaining({ id: 'c', order: 2 })]);
  });

  it('fills gaps before extending past the end', () => {
    const out = assignOrders([
      pl('a', 'One', 1), pl('d', 'Four', 4),
      pl('x', 'Alpha'), pl('y', 'Beta'), pl('z', 'Gamma'),
    ]);
    expect(out.map((p) => [p.name, p.order])).toEqual([
      ['Alpha', 2], ['Beta', 3], ['Gamma', 5],
    ]);
  });

  it('never reuses an order it just handed out', () => {
    const out = assignOrders([pl('a', 'A'), pl('b', 'B'), pl('c', 'C')]);
    expect(new Set(out.map((p) => p.order)).size).toBe(3);
  });

  it('never renumbers a playlist that already has an order', () => {
    const input = [pl('a', 'Zulu', 9), pl('b', 'Alpha')];
    const out = assignOrders(input);
    expect(out.map((p) => p.id)).toEqual(['b']);
    expect(input[0].order).toBe(9);
  });

  it('works around a duplicated existing order', () => {
    const out = assignOrders([pl('a', 'A', 2), pl('b', 'B', 2), pl('c', 'C')]);
    expect(out).toEqual([expect.objectContaining({ id: 'c', order: 1 })]);
  });

  it('treats order 0 as taken', () => {
    const out = assignOrders([pl('a', 'A', 0), pl('b', 'B')]);
    expect(out[0].order).toBe(1);
  });

  it('handles an empty list', () => {
    expect(assignOrders([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [pl('b', 'B'), pl('a', 'A')];
    const snapshot = JSON.parse(JSON.stringify(input));
    assignOrders(input);
    expect(input).toEqual(snapshot);
  });

  it('is independent of input order', () => {
    const items = [pl('c', 'Chase'), pl('a', 'Ambient'), pl('b', 'Battle')];
    const forward = assignOrders(items);
    const reversed = assignOrders(items.slice().reverse());
    const key = (list) => list.map((p) => [p.id, p.order]).sort();
    expect(key(forward)).toEqual(key(reversed));
  });

  it('orders names case-insensitively', () => {
    const out = assignOrders([pl('a', 'zeta'), pl('b', 'Alpha')]);
    expect(out.map((p) => p.name)).toEqual(['Alpha', 'zeta']);
  });

  it('breaks identical names by id so assignment stays deterministic', () => {
    const out = assignOrders([pl('zzz', 'Same'), pl('aaa', 'Same')]);
    expect(out.map((p) => [p.id, p.order])).toEqual([['aaa', 1], ['zzz', 2]]);
  });
});

describe('applyAssignments', () => {
  it('merges assigned orders back in without mutating', () => {
    const input = [pl('a', 'A', 5), pl('b', 'B')];
    const merged = applyAssignments(input, assignOrders(input));
    expect(merged.map((p) => p.order)).toEqual([5, 1]);
    expect(input[1].order).toBe(null);
  });
});

describe('sortForGrid — collision tiebreak', () => {
  it('sorts by order', () => {
    const out = sortForGrid([pl('a', 'A', 3), pl('b', 'B', 1), pl('c', 'C', 2)]);
    expect(out.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a collision by name, deterministically', () => {
    const out = sortForGrid([pl('a', 'Zulu', 2), pl('b', 'Alpha', 2), pl('c', 'Mike', 2)]);
    expect(out.map((p) => p.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('gives the same answer regardless of input order', () => {
    const items = [pl('a', 'Zulu', 2), pl('b', 'Alpha', 2), pl('c', 'Mike', 1)];
    const a = sortForGrid(items).map((p) => p.id);
    const b = sortForGrid(items.slice().reverse()).map((p) => p.id);
    expect(a).toEqual(b);
  });

  it('breaks an identical name+order collision by id', () => {
    const out = sortForGrid([pl('zzz', 'Same', 1), pl('aaa', 'Same', 1)]);
    expect(out.map((p) => p.id)).toEqual(['aaa', 'zzz']);
  });

  it('puts unordered playlists last, in name order', () => {
    const out = sortForGrid([pl('a', 'Zeta'), pl('b', 'Alpha'), pl('c', 'Ordered', 1)]);
    expect(out.map((p) => p.name)).toEqual(['Ordered', 'Alpha', 'Zeta']);
  });

  it('does not mutate its input', () => {
    const input = [pl('a', 'A', 3), pl('b', 'B', 1)];
    sortForGrid(input);
    expect(input.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('compareNames', () => {
  it('is antisymmetric', () => {
    const a = pl('a', 'Alpha');
    const b = pl('b', 'Beta');
    expect(Math.sign(compareNames(a, b))).toBe(-Math.sign(compareNames(b, a)));
  });

  it('returns 0 for the same playlist', () => {
    const a = pl('a', 'Alpha');
    expect(compareNames(a, a)).toBe(0);
  });

  it('survives missing names', () => {
    expect(() => compareNames({ id: 'a' }, { id: 'b' })).not.toThrow();
  });
});
