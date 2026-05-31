// DXF / SVG importers. Both parse 2D geometry into the Seamer schema: each closed loop becomes a
// pattern Piece (points + line edges + a boundary loop); open polylines become loose ConstrainablePaths.
// Coordinates are treated as millimeters. DXF is Y-up (kept as-is); SVG is Y-down (flipped to Y-up).

import { createEmptyPattern } from '$lib/types/pattern';
import type { Pattern, Piece, PiecePath, ConstrainablePath } from '$lib/types/pattern';

interface Vec2 { x: number; y: number; }
interface Loop { points: Vec2[]; closed: boolean; }

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;

/** Drop a trailing point that duplicates the first (explicit-close polylines) and near-dupes. */
function cleanLoop(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-3) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-3) out.pop();
  }
  return out;
}

/** Build a Pattern from a set of loops. Closed loops → pieces; open loops → loose line paths. */
function patternFromLoops(loops: Loop[], name: string): Pattern {
  const p = createEmptyPattern();
  p.name = name;
  let pointN = 0;
  const addPoint = (v: Vec2): string => {
    const id = uid('ConstrainablePoint');
    p.points.push({ id, name: `${p.pointPrefix || 'A'}${pointN++}`, x: v.x, y: v.y });
    return id;
  };
  const edgeName = (fromId: string, toId: string) => {
    const nm = (id: string) => p.points.find((q) => q.id === id)?.name ?? id.slice(0, 4);
    return `Line${nm(fromId)}${nm(toId)}`;
  };

  for (const loop of loops) {
    const pts = cleanLoop(loop.points);
    if (pts.length < 2) continue;
    const ids = pts.map(addPoint);

    if (!loop.closed || ids.length < 3) {
      // open polyline → a single loose ConstrainablePath through the points
      const path: ConstrainablePath = {
        id: uid('ConstrainablePath'), name: '', pathType: 'line',
        pathPoints: ids.map((id) => ({ id })), version: 1
      };
      p.paths.push(path);
      continue;
    }

    // closed loop → a piece with one line edge per segment
    const newPaths: ConstrainablePath[] = [];
    const mainPaths: PiecePath[] = [];
    for (let i = 0; i < ids.length; i++) {
      const from = ids[i], to = ids[(i + 1) % ids.length];
      const path: ConstrainablePath = {
        id: uid('ConstrainablePath'), name: edgeName(from, to), pathType: 'line',
        pathPoints: [{ id: from }, { id: to }], version: 1
      };
      newPaths.push(path);
      mainPaths.push({ id: uid('PiecePath'), name: edgeName(from, to), path: path.id, from, to, reversed: false, notches: [] });
    }
    p.paths.push(...newPaths);
    const op = p.points.find((q) => q.id === ids[0])!;
    const piece: Piece = {
      id: uid('Piece'), name: `Piece ${p.pieces.length + 1}`, type: 'dynamic',
      materialId: p.materials[0]?.id ?? '', origin: { id: uid('Point'), name: '', x: 0, y: 0 },
      originPoint: ids[0], position: { x: op.x, y: op.y }, rotation: 0,
      grainVector: { id: uid('Point'), name: '', x: 0, y: 1 }, text: null,
      rightPieces: 0, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
      seamAllowanceInside: false, mainPaths, internalPaths: [],
      settings3d: {
        arrangement: { mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: true, positionChanged: false, matrixWorld: [], position: [] },
        enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: []
      }
    };
    p.pieces.push(piece);
  }
  p.hasChanged = true;
  return p;
}

// ---- DXF -----------------------------------------------------------------------------------------

/** Parse a DXF (R12 ASCII) into loops. Handles LWPOLYLINE, POLYLINE/VERTEX, and LINE entities. */
export function dxfToPattern(text: string, name = 'Imported DXF'): Pattern {
  // tokenize into (code, value) pairs
  const raw = text.split(/\r\n|\r|\n/);
  const toks: { code: number; val: string }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const code = parseInt(raw[i].trim(), 10);
    if (Number.isNaN(code)) { i -= 1; continue; } // resync on stray blank line
    toks.push({ code, val: raw[i + 1].trim() });
  }

  const loops: Loop[] = [];
  let i = 0;
  const isEntityStart = (t: { code: number }) => t.code === 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.code !== 0) { i++; continue; }
    const type = t.val;
    i++;

    if (type === 'LWPOLYLINE') {
      const pts: Vec2[] = [];
      let closed = false;
      let cx: number | null = null;
      for (; i < toks.length && !isEntityStart(toks[i]); i++) {
        const { code, val } = toks[i];
        if (code === 70) closed = (parseInt(val, 10) & 1) === 1;
        else if (code === 10) cx = parseFloat(val);
        else if (code === 20 && cx !== null) { pts.push({ x: cx, y: parseFloat(val) }); cx = null; }
      }
      if (pts.length) loops.push({ points: pts, closed });
    } else if (type === 'POLYLINE') {
      let closed = false;
      for (; i < toks.length && !isEntityStart(toks[i]); i++) {
        if (toks[i].code === 70) closed = (parseInt(toks[i].val, 10) & 1) === 1;
      }
      const pts: Vec2[] = [];
      while (i < toks.length && toks[i].code === 0 && toks[i].val === 'VERTEX') {
        i++;
        let vx = 0, vy = 0;
        for (; i < toks.length && !isEntityStart(toks[i]); i++) {
          if (toks[i].code === 10) vx = parseFloat(toks[i].val);
          else if (toks[i].code === 20) vy = parseFloat(toks[i].val);
        }
        pts.push({ x: vx, y: vy });
      }
      if (toks[i] && toks[i].val === 'SEQEND') i++;
      if (pts.length) loops.push({ points: pts, closed });
    } else if (type === 'LINE') {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
      for (; i < toks.length && !isEntityStart(toks[i]); i++) {
        const { code, val } = toks[i];
        if (code === 10) x1 = parseFloat(val);
        else if (code === 20) y1 = parseFloat(val);
        else if (code === 11) x2 = parseFloat(val);
        else if (code === 21) y2 = parseFloat(val);
      }
      loops.push({ points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false });
    }
    // other entity types are skipped (the while loop advances past them)
  }
  return patternFromLoops(loops, name);
}

// ---- SVG -----------------------------------------------------------------------------------------

function parsePointsAttr(attr: string): Vec2[] {
  const nums = attr.trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
  const pts: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/** Parse a minimal SVG path `d` (absolute/relative M/L/H/V/Z) into a loop. Curves are flattened to lines. */
function parsePathD(d: string): Loop | null {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!tokens) return null;
  const pts: Vec2[] = [];
  let closed = false;
  let cx = 0, cy = 0;
  let cmd = '';
  let idx = 0;
  const num = () => parseFloat(tokens[idx++]);
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (/[a-zA-Z]/.test(t)) { cmd = t; idx++; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'M' || C === 'L') {
      const x = num(), y = num();
      cx = rel ? cx + x : x; cy = rel ? cy + y : y;
      pts.push({ x: cx, y: cy });
      if (C === 'M') cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit lineto
    } else if (C === 'H') { const x = num(); cx = rel ? cx + x : x; pts.push({ x: cx, y: cy }); }
    else if (C === 'V') { const y = num(); cy = rel ? cy + y : y; pts.push({ x: cx, y: cy }); }
    else if (C === 'C') { num(); num(); num(); num(); const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; pts.push({ x: cx, y: cy }); }
    else if (C === 'Q') { num(); num(); const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; pts.push({ x: cx, y: cy }); }
    else if (C === 'Z') { closed = true; idx++; }
    else { idx++; } // unsupported command token — skip
  }
  return pts.length ? { points: pts, closed } : null;
}

/** Parse an SVG document into loops (polygon/polyline/path/line/rect). Y is flipped to Y-up. */
export function svgToPattern(text: string, name = 'Imported SVG'): Pattern {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const loops: Loop[] = [];
  doc.querySelectorAll('polygon').forEach((el) => {
    const pts = parsePointsAttr(el.getAttribute('points') ?? '');
    if (pts.length) loops.push({ points: pts, closed: true });
  });
  doc.querySelectorAll('polyline').forEach((el) => {
    const pts = parsePointsAttr(el.getAttribute('points') ?? '');
    if (pts.length) loops.push({ points: pts, closed: false });
  });
  doc.querySelectorAll('line').forEach((el) => {
    const x1 = parseFloat(el.getAttribute('x1') ?? '0'), y1 = parseFloat(el.getAttribute('y1') ?? '0');
    const x2 = parseFloat(el.getAttribute('x2') ?? '0'), y2 = parseFloat(el.getAttribute('y2') ?? '0');
    loops.push({ points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false });
  });
  doc.querySelectorAll('rect').forEach((el) => {
    const x = parseFloat(el.getAttribute('x') ?? '0'), y = parseFloat(el.getAttribute('y') ?? '0');
    const w = parseFloat(el.getAttribute('width') ?? '0'), h = parseFloat(el.getAttribute('height') ?? '0');
    if (w > 0 && h > 0) loops.push({ points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true });
  });
  doc.querySelectorAll('path').forEach((el) => {
    const loop = parsePathD(el.getAttribute('d') ?? '');
    if (loop) loops.push(loop);
  });
  // SVG y grows downward; flip to pattern space (y up)
  for (const loop of loops) for (const pt of loop.points) pt.y = -pt.y;
  return patternFromLoops(loops, name);
}
