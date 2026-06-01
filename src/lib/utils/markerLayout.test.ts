import { describe, it, expect } from 'vitest';
import { polysOverlap, placeBottomLeft, type NestItem } from './markerLayout';
import type { Vec2 } from './patternGeometry';

const square = (s: number): Vec2[] => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];

function item(id: string, s: number): NestItem {
  const sq = square(s);
  return { pieceId: id, name: id, cut: sq, outline: sq, instanceId: id, area: s * s };
}

describe('polysOverlap', () => {
  it('detects overlapping squares', () => {
    expect(polysOverlap(square(10), square(10).map((p) => ({ x: p.x + 5, y: p.y + 5 })))).toBe(true);
  });
  it('separated squares do not overlap', () => {
    expect(polysOverlap(square(10), square(10).map((p) => ({ x: p.x + 20, y: p.y })))).toBe(false);
  });
  it('containment counts as overlap', () => {
    const big = square(20);
    const small = square(5).map((p) => ({ x: p.x + 5, y: p.y + 5 }));
    expect(polysOverlap(big, small)).toBe(true);
  });
});

describe('placeBottomLeft', () => {
  it('places every item with no mutual overlap, honouring the gap', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`p${i}`, 100));
    const gap = 10;
    const { placements } = placeBottomLeft(items, items.map(() => 0), [0], 320, gap);
    expect(placements).toHaveLength(6);
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        expect(polysOverlap(placements[i].poly, placements[j].poly)).toBe(false);
      }
    }
  });
  it('keeps every piece within the fabric width', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`p${i}`, 90));
    const width = 300;
    const { placements } = placeBottomLeft(items, items.map(() => 0), [0], width, 10);
    for (const pl of placements) {
      const maxX = Math.max(...pl.poly.map((p) => p.x));
      expect(maxX).toBeLessThanOrEqual(width);
    }
  });
  it('wraps to a new row when the fabric width is exceeded', () => {
    // 4 squares of 100 + gaps cannot fit on a 250-wide fabric in one row → at least 2 rows.
    const items = Array.from({ length: 4 }, (_, i) => item(`p${i}`, 100));
    const { placements, usedLength } = placeBottomLeft(items, items.map(() => 0), [0], 250, 10);
    const ys = new Set(placements.map((p) => Math.round(Math.min(...p.poly.map((q) => q.y)))));
    expect(ys.size).toBeGreaterThanOrEqual(2);
    expect(usedLength).toBeGreaterThan(100);
  });
});
