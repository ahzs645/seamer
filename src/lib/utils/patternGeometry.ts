// Shared resolution of the real Seamer schema into renderable 2D geometry.
// Used by the 2D canvas (display) and by the 3D boundary/triangulation builder (Phase 4).
// All coordinates are in millimeters.
//
// Piece outlines are built by: (1) resolving each mainPath into a polyline along its referenced
// ConstrainablePath between the `from` and `to` points (which may be sliding points lying ON the
// path), then (2) stitching the edges into a single closed loop by matching shared endpoints
// (the mainPaths array is NOT guaranteed to already be in boundary order/orientation).

import type { Pattern, ConstrainablePoint, ConstrainablePath, PathPoint, PiecePath, Piece, Seam } from '$lib/types/pattern';

export interface Vec2 {
  x: number;
  y: number;
}

/** A piece-local point mapped to its placed position on the 2D plan. */
export type Transform = (p: Vec2) => Vec2;

export interface CubicSegment {
  a: Vec2;
  c1: Vec2;
  c2: Vec2;
  b: Vec2;
  curve: boolean;
}

export function indexPoints(pattern: Pattern): Map<string, ConstrainablePoint> {
  const m = new Map<string, ConstrainablePoint>();
  for (const p of pattern.points) m.set(p.id, p);
  return m;
}

export function indexPaths(pattern: Pattern): Map<string, ConstrainablePath> {
  const m = new Map<string, ConstrainablePath>();
  for (const p of pattern.paths) m.set(p.id, p);
  return m;
}

export function indexPiecePaths(pattern: Pattern): Map<string, PiecePath> {
  const m = new Map<string, PiecePath>();
  for (const piece of pattern.pieces) {
    for (const pp of piece.mainPaths) m.set(pp.id, pp);
    for (const pp of piece.internalPaths) m.set(pp.id, pp);
  }
  return m;
}

/** Ordered cubic segments between a ConstrainablePath's successive anchor points. */
export function pathSegments(
  path: ConstrainablePath,
  points: Map<string, ConstrainablePoint>
): CubicSegment[] {
  const anchors: { pt: ConstrainablePoint; handle: PathPoint['handle'] }[] = [];
  for (const pp of path.pathPoints) {
    const pt = points.get(pp.id);
    if (pt) anchors.push({ pt, handle: pp.handle });
  }
  const segs: CubicSegment[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const A = anchors[i];
    const B = anchors[i + 1];
    const a: Vec2 = { x: A.pt.x, y: A.pt.y };
    const b: Vec2 = { x: B.pt.x, y: B.pt.y };
    const out = A.handle?.v2;
    const inc = B.handle?.v1;
    const curve = !!(out || inc);
    const c1: Vec2 = out ? { x: a.x + out.x, y: a.y + out.y } : { x: a.x, y: a.y };
    const c2: Vec2 = inc ? { x: b.x + inc.x, y: b.y + inc.y } : { x: b.x, y: b.y };
    segs.push({ a, c1, c2, b, curve });
  }
  return segs;
}

export function cubicAt(s: CubicSegment, t: number): Vec2 {
  if (!s.curve) return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s.a.x + w1 * s.c1.x + w2 * s.c2.x + w3 * s.b.x,
    y: w0 * s.a.y + w1 * s.c1.y + w2 * s.c2.y + w3 * s.b.y
  };
}

export function segmentLength(s: CubicSegment, samples = 24): number {
  if (!s.curve) return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  let len = 0;
  let prev = s.a;
  for (let i = 1; i <= samples; i++) {
    const p = cubicAt(s, i / samples);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Flatten a path's full geometry into a dense ordered polyline (anchor order). */
export function pathPolyline(
  path: ConstrainablePath,
  points: Map<string, ConstrainablePoint>,
  spacingMm = 4
): Vec2[] {
  const segs = pathSegments(path, points);
  const pts: Vec2[] = [];
  const push = (p: Vec2) => {
    const last = pts[pts.length - 1];
    if (!last || dist(last, p) > 1e-6) pts.push(p);
  };
  for (const s of segs) {
    if (!s.curve) {
      push(s.a);
      push(s.b);
    } else {
      const n = Math.max(2, Math.ceil(segmentLength(s) / spacingMm));
      for (let i = 0; i <= n; i++) push(cubicAt(s, i / n));
    }
  }
  return pts;
}

function nearestIndex(poly: Vec2[], target?: ConstrainablePoint): number {
  if (!target) return 0;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[i], target);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/**
 * Resolve a PiecePath into a polyline oriented from `from` to `to`, sliced from its referenced
 * path between the (possibly interior / sliding) endpoints. Honors the `reversed` flag.
 */
export function piecePathPolyline(
  pp: PiecePath,
  paths: Map<string, ConstrainablePath>,
  points: Map<string, ConstrainablePoint>,
  spacingMm = 4
): Vec2[] {
  const path = paths.get(pp.path);
  const fromPt = points.get(pp.from);
  const toPt = points.get(pp.to);
  if (!path) {
    return fromPt && toPt ? [fromPt, toPt] : [];
  }
  const chord = (): Vec2[] => (fromPt && toPt ? [{ x: fromPt.x, y: fromPt.y }, { x: toPt.x, y: toPt.y }] : []);
  const full = pathPolyline(path, points, spacingMm);
  if (full.length < 2 || !fromPt || !toPt) return chord();

  const iFrom = nearestIndex(full, fromPt);
  const iTo = nearestIndex(full, toPt);
  // If the endpoints land on the same/adjacent samples the path is too coarse to represent the
  // span (e.g. an interior span of a straight line) — use the straight chord instead.
  if (Math.abs(iFrom - iTo) < 1) return chord();

  let slice = iFrom <= iTo ? full.slice(iFrom, iTo + 1) : full.slice(iTo, iFrom + 1).reverse();
  // Orient from `from` to `to`.
  if (dist(slice[0], fromPt) > dist(slice[slice.length - 1], fromPt)) slice = slice.slice().reverse();
  // Reject a span that doesn't actually connect the two endpoints (coarse/interior mismatch).
  if (dist(slice[0], fromPt) > 2 || dist(slice[slice.length - 1], toPt) > 2) return chord();
  slice[0] = { x: fromPt.x, y: fromPt.y };
  slice[slice.length - 1] = { x: toPt.x, y: toPt.y };
  if (pp.reversed) slice = slice.slice().reverse();
  return slice;
}

/**
 * Build a single closed boundary polyline for a piece by stitching its mainPath edges on shared
 * endpoints. Robust to arbitrary edge order/orientation.
 */
export function pieceOutline(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[] {
  const edges = piece.mainPaths.map((pp) => piecePathPolyline(pp, paths, points, spacingMm)).filter((e) => e.length >= 2);
  if (edges.length === 0) return [];

  const used = new Array(edges.length).fill(false);
  const tol = 1.0; // mm
  const loop: Vec2[] = [...edges[0]];
  used[0] = true;
  let guard = edges.length * 2;
  while (guard-- > 0) {
    const tail = loop[loop.length - 1];
    let found = -1;
    let flip = false;
    let bestGap = tol;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const e = edges[i];
      const dStart = dist(tail, e[0]);
      const dEnd = dist(tail, e[e.length - 1]);
      if (dStart <= bestGap) { bestGap = dStart; found = i; flip = false; }
      if (dEnd <= bestGap) { bestGap = dEnd; found = i; flip = true; }
    }
    if (found === -1) break;
    used[found] = true;
    const e = flip ? edges[found].slice().reverse() : edges[found];
    for (let k = 1; k < e.length; k++) loop.push(e[k]);
  }
  return loop;
}

/** Internal paths (darts, internal seams) as individual polylines. */
export function pieceInternalPolylines(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[][] {
  return piece.internalPaths.map((pp) => piecePathPolyline(pp, paths, points, spacingMm)).filter((e) => e.length >= 2);
}

/**
 * A compact fingerprint of a piece's RESOLVED 2D geometry: its stitched outline, internal lines, grain
 * direction, and particle spacing. It changes whenever the piece's shape changes — moving a point,
 * dragging a bézier handle, retargeting a path — because those all alter the flattened polylines.
 * The 3D view uses this to (a) trigger a rebuild when a shape is edited and (b) detect WHICH pieces
 * changed, so only those re-triangulate from live geometry while the rest keep their cached drape.
 * Rounded to 0.1 mm to absorb float jitter that should not force a rebuild.
 */
export function pieceGeometrySignature(pattern: Pattern, piece: Piece): string {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const r = (n: number) => Math.round(n * 10) / 10; // 0.1 mm
  const enc = (poly: Vec2[]) => poly.map((p) => `${r(p.x)},${r(p.y)}`).join(' ');
  const outline = enc(pieceOutline(pattern, piece, paths, points, 4));
  const internals = pieceInternalPolylines(pattern, piece, paths, points, 4).map(enc).join('|');
  const g = piece.grainVector ?? { x: 0, y: 1 };
  return `${outline}#${internals}#g${r(g.x)},${r(g.y)}#pd${piece.settings3d.particleDistance ?? ''}`;
}

// ---------------------------------------------------------------------------
// 2D-plan placement (matches the original app's pattern layout).
//
// A ConstrainablePoint lives in shared drafting space; the same point can be
// referenced by several pieces (e.g. a piece and its mirrored copy). Each piece
// is *placed* on the plan by its own transform, so its geometry must be mapped
// from drafting space into world (canvas) space before drawing or hit-testing:
//
//   local = mirror(P - originPoint)        // mirrorX/Y about the origin point
//   world = position + rotate(local, θ)    // rotate by piece.rotation, translate
//
// `piece.origin` caches (position - originPoint); we recompute from the live
// origin point so edits to that point keep the placement correct.
// ---------------------------------------------------------------------------

/** Build the drafting-space → plan-space transform for a piece. */
export function pieceTransform(
  piece: Piece,
  points: Map<string, ConstrainablePoint>
): Transform {
  const op = points.get(piece.originPoint);
  const ox = op ? op.x : 0;
  const oy = op ? op.y : 0;
  const rad = ((piece.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = piece.mirrorX ? -1 : 1;
  const my = piece.mirrorY ? -1 : 1;
  const px = piece.position?.x ?? 0;
  const py = piece.position?.y ?? 0;
  return (p: Vec2): Vec2 => {
    const lx = (p.x - ox) * mx;
    const ly = (p.y - oy) * my;
    return { x: px + lx * cos - ly * sin, y: py + lx * sin + ly * cos };
  };
}

function applyTransform(poly: Vec2[], t: Transform): Vec2[] {
  return poly.map(t);
}

/** Piece boundary outline placed on the plan (drafting space → world). */
export function pieceWorldOutline(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[] {
  return applyTransform(pieceOutline(pattern, piece, paths, points, spacingMm), pieceTransform(piece, points));
}

/** Internal piece paths (darts, fold lines) placed on the plan. */
export function pieceWorldInternalPolylines(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[][] {
  const t = pieceTransform(piece, points);
  return pieceInternalPolylines(pattern, piece, paths, points, spacingMm).map((poly) => applyTransform(poly, t));
}

export interface PlacedPoint {
  pointId: string;
  pieceId: string;
  world: Vec2;
  /** invert: map a world position back to a drafting-space coordinate for this piece. */
  invert: Transform;
}

/** Inverse of pieceTransform: world → drafting space (for dragging placed points). */
export function pieceInverseTransform(
  piece: Piece,
  points: Map<string, ConstrainablePoint>
): Transform {
  const op = points.get(piece.originPoint);
  const ox = op ? op.x : 0;
  const oy = op ? op.y : 0;
  const rad = ((piece.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = piece.mirrorX ? -1 : 1;
  const my = piece.mirrorY ? -1 : 1;
  const px = piece.position?.x ?? 0;
  const py = piece.position?.y ?? 0;
  return (w: Vec2): Vec2 => {
    const dx = w.x - px;
    const dy = w.y - py;
    // inverse rotation
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return { x: lx * mx + ox, y: ly * my + oy };
  };
}

/**
 * Every ConstrainablePoint as it appears on the plan — one entry per (piece,point)
 * pair plus loose points not used by any piece. Used for hit-testing and dragging.
 */
export function placedPoints(
  pattern: Pattern,
  points = indexPoints(pattern)
): PlacedPoint[] {
  const out: PlacedPoint[] = [];
  const seen = new Set<string>();
  for (const piece of pattern.pieces) {
    const t = pieceTransform(piece, points);
    const inv = pieceInverseTransform(piece, points);
    const ids = new Set<string>();
    for (const pp of piece.mainPaths) { ids.add(pp.from); ids.add(pp.to); }
    for (const pp of piece.internalPaths) { ids.add(pp.from); ids.add(pp.to); }
    // include all anchor points of the referenced paths so curve anchors are draggable too
    for (const pp of [...piece.mainPaths, ...piece.internalPaths]) {
      const path = pattern.paths.find((p) => p.id === pp.path);
      if (path) for (const ap of path.pathPoints) ids.add(ap.id);
    }
    for (const id of ids) {
      const p = points.get(id);
      if (!p) continue;
      out.push({ pointId: id, pieceId: piece.id, world: t(p), invert: inv });
      seen.add(id);
    }
  }
  for (const p of pattern.points) {
    if (seen.has(p.id)) continue;
    out.push({ pointId: p.id, pieceId: '', world: { x: p.x, y: p.y }, invert: (w) => w });
  }
  return out;
}

/** Map a PiecePath id to its owning piece and the PiecePath itself. */
export function indexPiecePathOwners(pattern: Pattern): Map<string, { piece: Piece; pp: PiecePath }> {
  const m = new Map<string, { piece: Piece; pp: PiecePath }>();
  for (const piece of pattern.pieces) {
    for (const pp of piece.mainPaths) m.set(pp.id, { piece, pp });
    for (const pp of piece.internalPaths) m.set(pp.id, { piece, pp });
  }
  return m;
}

/** Human label for one side of a seam: "PieceName: EdgeName" (resolved through the owner index). */
function seamRefLabel(
  pattern: Pattern,
  ref: { id: string },
  owners: Map<string, { piece: Piece; pp: PiecePath }>
): string {
  const owner = owners.get(ref.id);
  if (!owner) return ref.id;
  const edge = owner.pp.name || pattern.paths.find((p) => p.id === owner.pp.path)?.name || owner.pp.path;
  return `${owner.piece.name}: ${edge}`;
}

/**
 * Faithful seam label matching the original app, e.g.
 *   "Piece2: LineA8A4 -> Piece: LineA2A3 (reversed)"
 * Falls back to a stored seam.name if one was set. Uses the first ref of each side (the original
 * shows one edge per side; multi-edge sides still read correctly from their first edge).
 */
export function seamLabel(
  pattern: Pattern,
  seam: Seam,
  owners: Map<string, { piece: Piece; pp: PiecePath }> = indexPiecePathOwners(pattern)
): string {
  if (seam.name && seam.name.trim()) return seam.name;
  const from = seam.fromPaths[0];
  const to = seam.toPaths[0];
  if (!from || !to) return seam.id;
  const reversed = from.reversed || to.reversed ? ' (reversed)' : '';
  return `${seamRefLabel(pattern, from, owners)} -> ${seamRefLabel(pattern, to, owners)}${reversed}`;
}

/** Resample a polyline to exactly `n` points evenly spaced by arc length. */
function resample(poly: Vec2[], n: number): Vec2[] {
  if (poly.length === 0) return [];
  if (poly.length === 1 || n <= 1) return new Array(n).fill(0).map(() => ({ ...poly[0] }));
  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1] || 1;
  const out: Vec2[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < poly.length - 2 && cum[j + 1] < target) j++;
    const segLen = cum[j + 1] - cum[j] || 1;
    const f = Math.max(0, Math.min(1, (target - cum[j]) / segLen));
    out.push({ x: poly[j].x + (poly[j + 1].x - poly[j].x) * f, y: poly[j].y + (poly[j + 1].y - poly[j].y) * f });
  }
  return out;
}

export interface SeamGeometry {
  id: string;
  /** index of the seam in pattern.seams (drives its colour) */
  index: number;
  /** ids of the pieces this seam joins */
  pieceIds: string[];
  /** the two sewn edges, placed on the plan */
  fromEdge: Vec2[];
  toEdge: Vec2[];
  /** rung lines tying corresponding points on the two edges together */
  rungs: { a: Vec2; b: Vec2 }[];
}

/** The original app's per-seam colour: golden-angle hue spacing so adjacent seams stay distinct. */
export function seamColor(index: number): string {
  return `hsl(${(Math.max(0, index) * 137.508) % 360}, 70%, 45%)`;
}

/**
 * Resolve a seam's two sides into placed (world) polylines and the connector
 * "rungs" the original app draws between them as red dashed lines — this is what
 * makes the 2D pieces read as *connected*.
 */
export function seamGeometry(
  pattern: Pattern,
  seam: Seam,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  owners = indexPiecePathOwners(pattern),
  spacingMm = 4
): SeamGeometry | null {
  const pieceIds = new Set<string>();
  const side = (refs: Seam['fromPaths']): Vec2[] => {
    const segs: Vec2[] = [];
    for (const ref of refs) {
      const owner = owners.get(ref.id);
      if (!owner) continue;
      pieceIds.add(owner.piece.id);
      const t = pieceTransform(owner.piece, points);
      let poly = applyTransform(piecePathPolyline(owner.pp, paths, points, spacingMm), t);
      if (ref.reversed) poly = poly.slice().reverse();
      if (segs.length && poly.length) segs.push(...poly.slice(1));
      else segs.push(...poly);
    }
    return segs;
  };
  const fromEdge = side(seam.fromPaths);
  const toEdge = side(seam.toPaths);
  if (fromEdge.length < 2 || toEdge.length < 2) return null;

  const n = Math.max(2, Math.min(8, Math.round(Math.max(
    polylineLength(fromEdge), polylineLength(toEdge)
  ) / 60)));
  const a = resample(fromEdge, n);
  const b = resample(toEdge, n);
  const rungs = a.map((p, i) => ({ a: p, b: b[i] }));
  const index = pattern.seams.indexOf(seam);
  return { id: seam.id, index, pieceIds: [...pieceIds], fromEdge, toEdge, rungs };
}

function polylineLength(poly: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1], poly[i]);
  return len;
}

export function allSeamGeometry(
  pattern: Pattern,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): SeamGeometry[] {
  const owners = indexPiecePathOwners(pattern);
  const out: SeamGeometry[] = [];
  for (const seam of pattern.seams) {
    const g = seamGeometry(pattern, seam, paths, points, owners, spacingMm);
    if (g) out.push(g);
  }
  return out;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
