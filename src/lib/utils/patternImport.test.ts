import { describe, it, expect } from 'vitest';
import { dxfToPattern } from './patternImport';

/** Build a DXF code/value pair stream from a flat list. */
const dxf = (...pairs: (string | number)[]) => pairs.map(String).join('\n');

const HEADER_INCHES = dxf(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 1, 0, 'ENDSEC');

/** Closed 100×50 rectangle LWPOLYLINE on `layer` with optional color index. */
const rect = (layer: string, color?: number) => dxf(
  0, 'LWPOLYLINE', 8, layer, ...(color !== undefined ? [62, color] : []),
  90, 4, 70, 1,
  10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 50, 10, 0, 20, 50
);

/** Open LINE on `layer` with optional color index. */
const line = (layer: string, color: number | undefined, x1: number, y1: number, x2: number, y2: number) => dxf(
  0, 'LINE', 8, layer, ...(color !== undefined ? [62, color] : []),
  10, x1, 20, y1, 11, x2, 21, y2
);

const entities = (...ents: string[]) => dxf(0, 'SECTION', 2, 'ENTITIES') + '\n' + ents.join('\n') + '\n' + dxf(0, 'ENDSEC', 0, 'EOF');

describe('dxfToPattern (no options — backward compatible)', () => {
  it('closed loop → piece, open line → loose path, coordinates read as mm', () => {
    const p = dxfToPattern(entities(rect('0'), line('0', undefined, 0, 0, 10, 10)));
    expect(p.pieces.length).toBe(1);
    expect(p.pieces[0].mainPaths.length).toBe(4);
    // 4 rect corners + 2 line endpoints
    expect(p.points.length).toBe(6);
    const xs = p.points.map((q) => q.x);
    expect(Math.max(...xs)).toBe(100);
  });

  it('ignores $INSUNITS without options (historic mm behavior)', () => {
    const p = dxfToPattern(HEADER_INCHES + '\n' + entities(rect('0')));
    expect(Math.max(...p.points.map((q) => q.x))).toBe(100);
  });
});

describe('dxfToPattern units override', () => {
  it("'auto' honours $INSUNITS (inches → ×25.4)", () => {
    const p = dxfToPattern(HEADER_INCHES + '\n' + entities(rect('0')), 'u', { unitsOverride: 'auto' });
    expect(Math.max(...p.points.map((q) => q.x))).toBeCloseTo(2540);
  });

  it("'auto' without a header stays mm", () => {
    const p = dxfToPattern(entities(rect('0')), 'u', { unitsOverride: 'auto' });
    expect(Math.max(...p.points.map((q) => q.x))).toBe(100);
  });

  it("'cm' forces ×10 regardless of the header", () => {
    const p = dxfToPattern(HEADER_INCHES + '\n' + entities(rect('0')), 'u', { unitsOverride: 'cm' });
    expect(Math.max(...p.points.map((q) => q.x))).toBeCloseTo(1000);
  });

  it("'inch' forces ×25.4 and scales bulge tangents too", () => {
    // open polyline with a bulge so the imported path carries handles
    const bulged = dxf(0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 10, 20, 0);
    const mm = dxfToPattern(entities(bulged));
    const inch = dxfToPattern(entities(bulged), 'u', { unitsOverride: 'inch' });
    const h = (p: typeof mm) => p.paths[0].pathPoints[0].handle!.v2.x;
    expect(h(inch)).toBeCloseTo(h(mm) * 25.4);
  });
});

describe('dxfToPattern line classification', () => {
  it('color index map overrides everything: seam color → loose path, not a piece', () => {
    const p = dxfToPattern(entities(rect('0', 2)), 'c', { classify: { colorMap: { 2: 'seam' } } });
    expect(p.pieces.length).toBe(0);
    expect(p.paths.length).toBe(1);
    expect(p.paths[0].name).toBe('Seam');
  });

  it('classifies by layer name when no color mapping matches', () => {
    const p = dxfToPattern(entities(rect('cut'), line('seam', undefined, 0, 0, 50, 25)), 'c', { classify: {} });
    expect(p.pieces.length).toBe(1);
    // seam line stays a loose path
    expect(p.paths.some((q) => q.name === 'Seam')).toBe(true);
  });

  it('"Import seam lines" off drops seam entities', () => {
    const p = dxfToPattern(entities(rect('cut'), line('seam', undefined, 0, 0, 50, 25)), 'c', { classify: { importSeam: false } });
    expect(p.pieces.length).toBe(1);
    expect(p.paths.some((q) => q.name === 'Seam')).toBe(false);
  });

  it('"Import cut lines" off drops the piece', () => {
    const p = dxfToPattern(entities(rect('cut')), 'c', { classify: { importCut: false } });
    expect(p.pieces.length).toBe(0);
  });

  it('internal lines inside a cut boundary attach to the piece as internal paths', () => {
    const p = dxfToPattern(entities(rect('cut'), line('internal', undefined, 10, 10, 90, 40)), 'c', { classify: {} });
    expect(p.pieces.length).toBe(1);
    expect(p.pieces[0].internalPaths.length).toBe(1);
    const ip = p.pieces[0].internalPaths[0];
    expect(p.paths.some((q) => q.id === ip.path)).toBe(true);
  });

  it('internal lines outside any piece stay loose', () => {
    const p = dxfToPattern(entities(rect('cut'), line('internal', undefined, 200, 200, 300, 300)), 'c', { classify: {} });
    expect(p.pieces[0].internalPaths.length).toBe(0);
  });

  it('unclassified topology default: closed → cut, open → internal', () => {
    const p = dxfToPattern(entities(rect('whatever'), line('whatever', undefined, 10, 10, 20, 20)), 'c', { classify: { importInternal: false } });
    expect(p.pieces.length).toBe(1); // closed loop kept as cut
    expect(p.paths.length).toBe(4); // only the piece's 4 edges — the open line was dropped
  });
});
