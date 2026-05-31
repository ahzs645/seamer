// DXF / SVG importers. Both parse 2D geometry into the Seamer schema: each closed loop becomes a
// pattern Piece (points + edges + a boundary loop); open polylines become loose ConstrainablePaths.
// Coordinates are treated as millimeters. DXF is Y-up (kept as-is); SVG is Y-down (flipped to Y-up).
//
// Curves are preserved as cubic Bézier handles, not flattened to line vertices:
//   - SVG  C/c (cubic) and Q/q (quadratic, elevated to cubic) carry control points through.
//   - DXF  LWPOLYLINE bulge values (arc segments) are converted to cubic handles.
// Each loop vertex therefore carries an optional outgoing/incoming tangent; the builder emits a
// `curve` ConstrainablePath when any vertex on the edge is curved, else a `line`.

import { createEmptyPattern } from '$lib/types/pattern';
import type { Pattern, Piece, PiecePath, ConstrainablePath, PathPoint, BezierHandle, Formula } from '$lib/types/pattern';

interface Vec2 { x: number; y: number; }
/** A loop vertex with optional cubic tangents (offsets relative to the vertex, in pattern mm). */
interface Vtx {
  x: number;
  y: number;
  /** outgoing control offset (toward the next vertex) */
  out?: Vec2;
  /** incoming control offset (from the previous vertex) */
  in?: Vec2;
}
interface Loop { points: Vtx[]; closed: boolean; }

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
const ZERO_FORMULA = (): Formula => ({ formula: '', unit: 'mm' });
const ANGLE_FORMULA = (): Formula => ({ formula: '', unit: 'degrees' });

function hasTangent(v: Vtx): boolean {
  return !!((v.out && (v.out.x || v.out.y)) || (v.in && (v.in.x || v.in.y)));
}

function makeHandle(v: Vtx): BezierHandle {
  return {
    v1: v.in ? { ...v.in } : { x: 0, y: 0 },
    v2: v.out ? { ...v.out } : { x: 0, y: 0 },
    sameLength: false,
    sameAngle: false,
    lengthFormula: ZERO_FORMULA(),
    angleFormula: ANGLE_FORMULA()
  };
}

/** Drop a trailing vertex that duplicates the first (explicit-close), preserving its incoming tangent. */
function cleanLoop(pts: Vtx[]): Vtx[] {
  const out: Vtx[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-3) out.push(p);
    else if (p.out && (p.out.x || p.out.y)) last.out = p.out; // merge a coincident control
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-3) {
      if (b.in && (b.in.x || b.in.y)) a.in = b.in; // carry the closing segment's tangent onto the anchor
      out.pop();
    }
  }
  return out;
}

/** Build a Pattern from a set of loops. Closed loops → pieces; open loops → loose paths. */
function patternFromLoops(loops: Loop[], name: string): Pattern {
  const p = createEmptyPattern();
  p.name = name;
  let pointN = 0;
  const addPoint = (v: Vtx): string => {
    const id = uid('ConstrainablePoint');
    p.points.push({ id, name: `${p.pointPrefix || 'A'}${pointN++}`, x: v.x, y: v.y });
    return id;
  };
  const nameOf = (id: string) => p.points.find((q) => q.id === id)?.name ?? id.slice(0, 4);
  const edgeName = (fromId: string, toId: string, curve: boolean) =>
    `${curve ? 'Curve' : 'Line'}${nameOf(fromId)}${nameOf(toId)}`;

  /** A 2-point ConstrainablePath; cubic if either endpoint carries a tangent toward the other. */
  function edgePath(fromV: Vtx, toV: Vtx, fromId: string, toId: string): { path: ConstrainablePath; curve: boolean } {
    const curve = !!((fromV.out && (fromV.out.x || fromV.out.y)) || (toV.in && (toV.in.x || toV.in.y)));
    const fromPP: PathPoint = { id: fromId };
    const toPP: PathPoint = { id: toId };
    if (curve) {
      // only the relevant tangent on each anchor matters for a single edge
      fromPP.handle = makeHandle({ x: fromV.x, y: fromV.y, out: fromV.out });
      toPP.handle = makeHandle({ x: toV.x, y: toV.y, in: toV.in });
    }
    return {
      path: {
        id: uid('ConstrainablePath'), name: edgeName(fromId, toId, curve),
        pathType: curve ? 'curve' : 'line', pathPoints: [fromPP, toPP], version: 1
      },
      curve
    };
  }

  for (const loop of loops) {
    const pts = cleanLoop(loop.points);
    if (pts.length < 2) continue;
    const ids = pts.map(addPoint);

    if (!loop.closed || ids.length < 3) {
      // open polyline → a single loose ConstrainablePath (curve if any vertex has a tangent)
      const curve = pts.some(hasTangent);
      const path: ConstrainablePath = {
        id: uid('ConstrainablePath'), name: '', pathType: curve ? 'curve' : 'line',
        pathPoints: pts.map((v, i) => (curve ? { id: ids[i], handle: makeHandle(v) } : { id: ids[i] })),
        version: 1
      };
      p.paths.push(path);
      continue;
    }

    // closed loop → a piece with one edge per segment
    const newPaths: ConstrainablePath[] = [];
    const mainPaths: PiecePath[] = [];
    for (let i = 0; i < ids.length; i++) {
      const j = (i + 1) % ids.length;
      const { path } = edgePath(pts[i], pts[j], ids[i], ids[j]);
      newPaths.push(path);
      mainPaths.push({ id: uid('PiecePath'), name: path.name, path: path.id, from: ids[i], to: ids[j], reversed: false, notches: [] });
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

/** Cubic control offsets for a circular arc from A to B with the given DXF bulge (tan(included/4)). */
function bulgeToTangents(ax: number, ay: number, bx: number, by: number, bulge: number): { out: Vec2; in: Vec2 } {
  // included angle θ = 4·atan(bulge); chord from A to B. Convert the arc to one cubic.
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(bx - ax, by - ay) || 1;
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2 || 1e-6));
  // cubic alpha for a circular arc segment
  const alpha = (4 / 3) * Math.tan(theta / 4);
  // unit chord + perpendicular (sign of bulge gives arc side)
  const ux = (bx - ax) / chord, uy = (by - ay) / chord;
  // tangent directions at A and B are the chord rotated by ±θ/2
  const half = theta / 2;
  const cosH = Math.cos(half), sinH = Math.sin(half);
  // tangent at A: chord rotated by +half; at B: chord rotated by -(half) but pointing backward
  const tAx = ux * cosH - uy * sinH, tAy = ux * sinH + uy * cosH;
  const tBx = ux * Math.cos(-half) - uy * Math.sin(-half), tBy = ux * Math.sin(-half) + uy * Math.cos(-half);
  const len = alpha * radius;
  return { out: { x: tAx * len, y: tAy * len }, in: { x: -tBx * len, y: -tBy * len } };
}

/** Parse a DXF (R12 ASCII) into loops. Handles LWPOLYLINE (with bulges), POLYLINE/VERTEX, and LINE. */
export function dxfToPattern(text: string, name = 'Imported DXF'): Pattern {
  const raw = text.split(/\r\n|\r|\n/);
  const toks: { code: number; val: string }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const code = parseInt(raw[i].trim(), 10);
    if (Number.isNaN(code)) { i -= 1; continue; }
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
      const verts: { x: number; y: number; bulge: number }[] = [];
      let closed = false;
      let cx: number | null = null;
      let pendingBulge = 0;
      for (; i < toks.length && !isEntityStart(toks[i]); i++) {
        const { code, val } = toks[i];
        if (code === 70) closed = (parseInt(val, 10) & 1) === 1;
        else if (code === 42) { if (verts.length) verts[verts.length - 1].bulge = parseFloat(val); else pendingBulge = parseFloat(val); }
        else if (code === 10) cx = parseFloat(val);
        else if (code === 20 && cx !== null) { verts.push({ x: cx, y: parseFloat(val), bulge: 0 }); cx = null; }
      }
      if (pendingBulge && verts.length) verts[0].bulge = pendingBulge;
      loops.push({ points: bulgeVertsToLoop(verts, closed), closed });
    } else if (type === 'POLYLINE') {
      let closed = false;
      for (; i < toks.length && !isEntityStart(toks[i]); i++) {
        if (toks[i].code === 70) closed = (parseInt(toks[i].val, 10) & 1) === 1;
      }
      const verts: { x: number; y: number; bulge: number }[] = [];
      while (i < toks.length && toks[i].code === 0 && toks[i].val === 'VERTEX') {
        i++;
        let vx = 0, vy = 0, bulge = 0;
        for (; i < toks.length && !isEntityStart(toks[i]); i++) {
          if (toks[i].code === 10) vx = parseFloat(toks[i].val);
          else if (toks[i].code === 20) vy = parseFloat(toks[i].val);
          else if (toks[i].code === 42) bulge = parseFloat(toks[i].val);
        }
        verts.push({ x: vx, y: vy, bulge });
      }
      if (toks[i] && toks[i].val === 'SEQEND') i++;
      loops.push({ points: bulgeVertsToLoop(verts, closed), closed });
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
  }
  return patternFromLoops(loops, name);
}

/** Convert bulge-bearing DXF vertices into tangent-bearing loop vertices. */
function bulgeVertsToLoop(verts: { x: number; y: number; bulge: number }[], closed: boolean): Vtx[] {
  const out: Vtx[] = verts.map((v) => ({ x: v.x, y: v.y }));
  const n = verts.length;
  const last = closed ? n : n - 1;
  for (let k = 0; k < last; k++) {
    const a = verts[k];
    if (!a.bulge) continue;
    const b = verts[(k + 1) % n];
    const { out: oTan, in: iTan } = bulgeToTangents(a.x, a.y, b.x, b.y, a.bulge);
    out[k].out = oTan;
    out[(k + 1) % n].in = iTan;
  }
  return out;
}

// ---- SVG -----------------------------------------------------------------------------------------

function parsePointsAttr(attr: string): Vtx[] {
  const nums = attr.trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
  const pts: Vtx[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/**
 * Parse an SVG path `d` into a loop, preserving cubic/quadratic curves as tangent offsets.
 * Supports M/L/H/V/C/S/Q/T/Z (absolute + relative). Arcs (A) are approximated by their endpoint.
 */
function parsePathD(d: string): Loop | null {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!tokens) return null;
  const pts: Vtx[] = [];
  let closed = false;
  let cx = 0, cy = 0;
  let cmd = '';
  let idx = 0;
  let prevCubicCtrl: Vec2 | null = null; // for S/s reflection
  let prevQuadCtrl: Vec2 | null = null;  // for T/t reflection
  const num = () => parseFloat(tokens[idx++]);
  const push = (x: number, y: number) => { pts.push({ x, y }); };

  while (idx < tokens.length) {
    const tk = tokens[idx];
    if (/[a-zA-Z]/.test(tk)) { cmd = tk; idx++; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M' || C === 'L') {
      const x = num(), y = num();
      cx = rel ? cx + x : x; cy = rel ? cy + y : y;
      push(cx, cy);
      prevCubicCtrl = prevQuadCtrl = null;
      if (C === 'M') cmd = rel ? 'l' : 'L';
    } else if (C === 'H') {
      const x = num(); cx = rel ? cx + x : x; push(cx, cy); prevCubicCtrl = prevQuadCtrl = null;
    } else if (C === 'V') {
      const y = num(); cy = rel ? cy + y : y; push(cx, cy); prevCubicCtrl = prevQuadCtrl = null;
    } else if (C === 'C' || C === 'S') {
      let c1x: number, c1y: number;
      if (C === 'C') { c1x = rel ? cx + num() : num(); c1y = rel ? cy + num() : num(); }
      else { const r = prevCubicCtrl ? { x: 2 * cx - prevCubicCtrl.x, y: 2 * cy - prevCubicCtrl.y } : { x: cx, y: cy }; c1x = r.x; c1y = r.y; }
      const c2x = rel ? cx + num() : num(), c2y = rel ? cy + num() : num();
      const ex = rel ? cx + num() : num(), ey = rel ? cy + num() : num();
      // outgoing tangent on the current last point, incoming tangent on the new point
      const startV = pts[pts.length - 1];
      if (startV) startV.out = { x: c1x - cx, y: c1y - cy };
      pts.push({ x: ex, y: ey, in: { x: c2x - ex, y: c2y - ey } });
      prevCubicCtrl = { x: c2x, y: c2y };
      prevQuadCtrl = null;
      cx = ex; cy = ey;
    } else if (C === 'Q' || C === 'T') {
      let qx: number, qy: number;
      if (C === 'Q') { qx = rel ? cx + num() : num(); qy = rel ? cy + num() : num(); }
      else { const r = prevQuadCtrl ? { x: 2 * cx - prevQuadCtrl.x, y: 2 * cy - prevQuadCtrl.y } : { x: cx, y: cy }; qx = r.x; qy = r.y; }
      const ex = rel ? cx + num() : num(), ey = rel ? cy + num() : num();
      // elevate quadratic (P0,Q,P1) to cubic control points
      const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
      const c2x = ex + (2 / 3) * (qx - ex), c2y = ey + (2 / 3) * (qy - ey);
      const startV = pts[pts.length - 1];
      if (startV) startV.out = { x: c1x - cx, y: c1y - cy };
      pts.push({ x: ex, y: ey, in: { x: c2x - ex, y: c2y - ey } });
      prevQuadCtrl = { x: qx, y: qy };
      prevCubicCtrl = null;
      cx = ex; cy = ey;
    } else if (C === 'A') {
      // arc: skip the 5 flag/radii params, take the endpoint only (no tangent)
      num(); num(); num(); num(); num();
      const ex = rel ? cx + num() : num(), ey = rel ? cy + num() : num();
      push(ex, ey); cx = ex; cy = ey; prevCubicCtrl = prevQuadCtrl = null;
    } else if (C === 'Z') {
      closed = true; idx++;
    } else { idx++; }
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
  // SVG y grows downward; flip to pattern space (y up). Flip vertex positions AND tangent y-offsets.
  for (const loop of loops) for (const v of loop.points) {
    v.y = -v.y;
    if (v.out) v.out.y = -v.out.y;
    if (v.in) v.in.y = -v.in.y;
  }
  return patternFromLoops(loops, name);
}
