// Build a piece's cloth mesh from the pattern schema: resolve + stitch the boundary edges (one per
// mainPath), resample by particle spacing (tracking which PiecePath each boundary particle belongs
// to, for seam matching), incorporate internal lines, and triangulate.

import Delaunator from 'delaunator';
import type { Pattern, Piece } from '$lib/types/pattern';
import {
  indexPaths,
  indexPoints,
  piecePathPolyline,
  type Vec2
} from '$lib/utils/patternGeometry';
import { triangulate, type ClothMesh } from './triangulate';

export interface PieceCloth {
  pieceId: string;
  materialId: string;
  mesh: ClothMesh;
  /** ordered boundary particle indices per PiecePath id (for seam correspondence) */
  edgeParticles: Map<string, number[]>;
  /** 2D centroid (mm) of the boundary, used by arrangement */
  particleDistanceMm: number;
}

const DEFAULT_PARTICLE_DISTANCE = 14; // mm

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polylineLength(poly: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1], poly[i]);
  return len;
}

/** Resample a polyline to evenly spaced points (~spacing apart), keeping both endpoints. */
function resample(poly: Vec2[], spacing: number): Vec2[] {
  if (poly.length < 2) return poly.slice();
  const total = polylineLength(poly);
  const n = Math.max(1, Math.round(total / spacing));
  const out: Vec2[] = [poly[0]];
  const step = total / n;
  let segIdx = 0;
  let segPos = 0; // distance consumed in current segment
  let acc = 0;
  for (let k = 1; k < n; k++) {
    const target = k * step;
    while (segIdx < poly.length - 1) {
      const segLen = dist(poly[segIdx], poly[segIdx + 1]);
      if (acc + (segLen - segPos) >= target) {
        const remain = target - acc;
        const t = segLen > 1e-9 ? (segPos + remain) / segLen : 0;
        out.push({
          x: poly[segIdx].x + (poly[segIdx + 1].x - poly[segIdx].x) * t,
          y: poly[segIdx].y + (poly[segIdx + 1].y - poly[segIdx].y) * t
        });
        break;
      }
      acc += segLen - segPos;
      segPos = 0;
      segIdx++;
    }
  }
  out.push(poly[poly.length - 1]);
  return out;
}

interface LoopEdge {
  ppId: string;
  poly: Vec2[];
}

/** Stitch the mainPath edges into an ordered closed loop by matching shared endpoints. */
function stitchLoop(edges: LoopEdge[]): LoopEdge[] {
  if (edges.length === 0) return [];
  const used = new Array(edges.length).fill(false);
  const tol = 1.5;
  const loop: LoopEdge[] = [{ ...edges[0] }];
  used[0] = true;
  let tail = edges[0].poly[edges[0].poly.length - 1];
  let guard = edges.length * 2;
  while (guard-- > 0) {
    let found = -1;
    let flip = false;
    let best = tol;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const e = edges[i];
      const dS = dist(tail, e.poly[0]);
      const dE = dist(tail, e.poly[e.poly.length - 1]);
      if (dS <= best) { best = dS; found = i; flip = false; }
      if (dE <= best) { best = dE; found = i; flip = true; }
    }
    if (found === -1) break;
    used[found] = true;
    const poly = flip ? edges[found].poly.slice().reverse() : edges[found].poly;
    loop.push({ ppId: edges[found].ppId, poly });
    tail = poly[poly.length - 1];
  }
  return loop;
}

export function buildPieceCloth(pattern: Pattern, piece: Piece, particleDistanceMm?: number): PieceCloth | null {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const pd = particleDistanceMm ?? piece.settings3d.particleDistance ?? DEFAULT_PARTICLE_DISTANCE;

  const mirrorPpId = piece.mainPaths.find((pp) => pp.isMirrorLine)?.id;
  const rawEdges: LoopEdge[] = piece.mainPaths
    .map((pp) => ({ ppId: pp.id, poly: piecePathPolyline(pp, paths, points, Math.min(4, pd / 2)) }))
    .filter((e) => e.poly.length >= 2);
  if (rawEdges.length === 0) return null;

  let loop = stitchLoop(rawEdges);

  // If the piece is a half (has a mirror-line edge), drop that edge and rotate so the remaining
  // edges form one contiguous open arc between the mirror-line endpoints; we reflect it below.
  let mirrorEnds: [Vec2, Vec2] | null = null;
  if (mirrorPpId) {
    const ml = loop.findIndex((e) => e.ppId === mirrorPpId);
    if (ml !== -1) {
      const mEdge = loop[ml];
      mirrorEnds = [mEdge.poly[0], mEdge.poly[mEdge.poly.length - 1]];
      loop = [...loop.slice(ml + 1), ...loop.slice(0, ml)];
    }
  }

  // Resample each edge and concatenate into the outer loop, tracking per-edge particle indices.
  const outer: Vec2[] = [];
  const edgeOuterRanges = new Map<string, number[]>();
  for (let li = 0; li < loop.length; li++) {
    const e = loop[li];
    const rs = resample(e.poly, pd);
    const idxs: number[] = [];
    for (let i = 0; i < rs.length; i++) {
      // skip the first point if it duplicates the current tail (shared endpoint)
      if (i === 0 && outer.length > 0 && dist(outer[outer.length - 1], rs[0]) < 1e-6) {
        idxs.push(outer.length - 1);
        continue;
      }
      // skip the last point if it closes onto the very first outer point
      if (li === loop.length - 1 && i === rs.length - 1 && outer.length > 0 && dist(outer[0], rs[i]) < 1e-6) {
        idxs.push(0);
        continue;
      }
      idxs.push(outer.length);
      outer.push(rs[i]);
    }
    const existing = edgeOuterRanges.get(e.ppId) ?? [];
    edgeOuterRanges.set(e.ppId, existing.concat(idxs));
  }

  // Reflect the open arc across the mirror line to form the full piece (half -> full). The reflected
  // copy of each edge is tracked under `${ppId}#M` so seam refs with `mirrored: true` resolve to it.
  if (mirrorEnds && outer.length >= 2) {
    const [A, B] = mirrorEnds;
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy || 1;
    const reflect = (p: Vec2): Vec2 => {
      const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / len2;
      const px = A.x + dx * t, py = A.y + dy * t;
      return { x: 2 * px - p.x, y: 2 * py - p.y };
    };
    const arcIdxToPp: (string | undefined)[] = new Array(outer.length);
    for (const [ppId, idxs] of edgeOuterRanges) for (const i of idxs) arcIdxToPp[i] = ppId;
    const reflected = outer.map(reflect);
    for (let i = reflected.length - 2; i >= 1; i--) {
      const newIdx = outer.length;
      outer.push(reflected[i]);
      const ppId = arcIdxToPp[i];
      if (ppId) {
        const k = `${ppId}#M`;
        const arr = edgeOuterRanges.get(k) ?? [];
        arr.push(newIdx);
        edgeOuterRanges.set(k, arr);
      }
    }
  }

  // internal lines -> constraint points (darts / internal seams)
  const internalPoints: Vec2[] = [];
  for (const ip of piece.internalPaths) {
    const poly = piecePathPolyline(ip, paths, points, Math.min(4, pd / 2));
    for (const p of resample(poly, pd)) internalPoints.push(p);
  }

  const mesh = triangulate({
    outer,
    internalPoints,
    particleDistanceMm: pd,
    grain: piece.grainVector
  });

  // Map outer-input indices -> compacted particle indices via mesh.boundary (aligned to outer order).
  const outerToParticle = mesh.boundary; // boundary[i] is the particle index of outer[i]
  const edgeParticles = new Map<string, number[]>();
  for (const [ppId, outerIdxs] of edgeOuterRanges) {
    const mapped: number[] = [];
    for (const oi of outerIdxs) {
      if (oi < outerToParticle.length && outerToParticle[oi] >= 0) mapped.push(outerToParticle[oi]);
    }
    edgeParticles.set(ppId, mapped);
  }

  return { pieceId: piece.id, materialId: piece.materialId, mesh, edgeParticles, particleDistanceMm: pd };
}

export interface SavedCloth {
  cloth: PieceCloth;
  positions3d: Float32Array; // saved settled 3D positions (meters), per particle
  boundaryParticles: number[]; // indices of particles on the mesh boundary (for seam linking)
}

/**
 * Build a piece's cloth mesh directly from its cached `savedPositions` (stride 5: x2d,y2d, x3d,y3d,z3d).
 * Uses the saved particles as-is (their 2D for topology + UV, their 3D as the settled drape), so the
 * result reproduces the original render exactly — no boundary re-triangulation or mapping error.
 * Triangulated via Delaunay over the 2D points with long concavity-bridging edges pruned.
 */
export function buildSavedCloth(piece: Piece): SavedCloth | null {
  const sp = piece.settings3d.savedPositions;
  if (!sp || sp.length < 15) return null;
  const n = Math.floor(sp.length / 5);
  const points: Vec2[] = new Array(n);
  const positions3d = new Float32Array(n * 3);
  const coords: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    points[i] = { x: sp[i * 5], y: sp[i * 5 + 1] };
    coords[i * 2] = sp[i * 5];
    coords[i * 2 + 1] = sp[i * 5 + 1];
    positions3d[i * 3] = sp[i * 5 + 2];
    positions3d[i * 3 + 1] = sp[i * 5 + 3];
    positions3d[i * 3 + 2] = sp[i * 5 + 4];
  }
  if (n < 3) return null;

  const del = new Delaunator(Float64Array.from(coords));
  const tri = del.triangles;
  // median edge length -> prune triangles that bridge concavities / the convex hull
  const edgeLens: number[] = [];
  const elen = (a: number, b: number) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
  for (let t = 0; t < tri.length; t += 3) {
    edgeLens.push(elen(tri[t], tri[t + 1]), elen(tri[t + 1], tri[t + 2]), elen(tri[t + 2], tri[t]));
  }
  edgeLens.sort((a, b) => a - b);
  const median = edgeLens[Math.floor(edgeLens.length / 2)] || 10;
  const maxEdge = median * 2.5;

  const triangles: number[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    if (elen(a, b) > maxEdge || elen(b, c) > maxEdge || elen(c, a) > maxEdge) continue;
    triangles.push(a, b, c);
  }

  // unique edges + boundary detection (edges used by exactly one triangle)
  const edgeCount = new Map<number, number>();
  const ekey = (a: number, b: number) => Math.min(a, b) * n + Math.max(a, b);
  const addE = (a: number, b: number) => edgeCount.set(ekey(a, b), (edgeCount.get(ekey(a, b)) ?? 0) + 1);
  for (let t = 0; t < triangles.length; t += 3) {
    addE(triangles[t], triangles[t + 1]);
    addE(triangles[t + 1], triangles[t + 2]);
    addE(triangles[t + 2], triangles[t]);
  }
  const edges: [number, number][] = [];
  const boundarySet = new Set<number>();
  for (const [k, count] of edgeCount) {
    const a = Math.floor(k / n), b = k % n;
    edges.push([a, b]);
    if (count === 1) { boundarySet.add(a); boundarySet.add(b); }
  }

  const mesh: ClothMesh = { points, triangles, edges, boundary: [...boundarySet], numBoundary: boundarySet.size };
  const pd = piece.settings3d.particleDistance ?? median;
  return {
    cloth: { pieceId: piece.id, materialId: piece.materialId, mesh, edgeParticles: new Map(), particleDistanceMm: pd },
    positions3d,
    boundaryParticles: [...boundarySet]
  };
}
