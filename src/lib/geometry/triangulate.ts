// Cloth-mesh triangulation: Delaunay (Delaunator) over the piece boundary + interior Steiner grid
// (aligned to the fabric grain), filtered to the polygon-with-holes, then degenerate-pruned.
// Produces the particle set, triangle faces and unique edges for the cloth simulation.

import Delaunator from 'delaunator';
import type { Vec2 } from '$lib/utils/patternGeometry';
import { pointInPolygon } from '$lib/utils/patternGeometry';

export interface ClothMesh {
  points: Vec2[]; // particle positions, mm (piece-local)
  triangles: number[]; // flat, 3 indices per triangle
  edges: [number, number][]; // unique edges
  // Aligned to the input outer order: boundary[i] = particle index of outer[i] (or -1 if pruned).
  boundary: number[];
  numBoundary: number;
}

export interface TriangulateInput {
  outer: Vec2[]; // ordered boundary loop (open, last != first)
  holes?: Vec2[][];
  internalPoints?: Vec2[]; // extra constraint points (internal lines)
  particleDistanceMm: number;
  grain: Vec2; // fabric grain direction
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Uniform spatial hash for clearance queries.
class Grid {
  private cell: number;
  private map = new Map<number, Vec2[]>();
  constructor(cell: number) { this.cell = Math.max(1e-3, cell); }
  private key(x: number, y: number): number {
    const ix = Math.floor(x / this.cell);
    const iy = Math.floor(y / this.cell);
    return ix * 73856093 ^ iy * 19349663;
  }
  add(p: Vec2) {
    const k = this.key(p.x, p.y);
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(p);
  }
  hasWithin(p: Vec2, r: number): boolean {
    const r2 = r * r;
    const ix = Math.floor(p.x / this.cell);
    const iy = Math.floor(p.y / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.map.get((ix + dx) * 73856093 ^ (iy + dy) * 19349663);
        if (!arr) continue;
        for (const q of arr) if (dist2(p, q) < r2) return true;
      }
    }
    return false;
  }
}

function bounds(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function triangulate(input: TriangulateInput): ClothMesh {
  const pd = Math.max(1, input.particleDistanceMm);
  const outer = input.outer;
  const holes = input.holes ?? [];
  const internal = input.internalPoints ?? [];

  // assemble constraint points (boundary + holes + internal)
  const constraints: Vec2[] = [...outer];
  const numBoundary = outer.length;
  for (const h of holes) constraints.push(...h);
  constraints.push(...internal);

  // grain-aligned Steiner grid
  const glen = Math.hypot(input.grain.x, input.grain.y) || 1;
  const gu = { x: input.grain.x / glen, y: input.grain.y / glen };
  const gw = { x: -gu.y, y: gu.x };
  const b = bounds(outer);
  const corners = [
    { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
    { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }
  ];
  let uMin = Infinity, uMax = -Infinity, wMin = Infinity, wMax = -Infinity;
  for (const c of corners) {
    const u = c.x * gu.x + c.y * gu.y;
    const w = c.x * gw.x + c.y * gw.y;
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
    wMin = Math.min(wMin, w); wMax = Math.max(wMax, w);
  }

  const grid = new Grid(pd);
  for (const c of constraints) grid.add(c);
  const clearance = pd * 0.6;
  const steiner: Vec2[] = [];
  for (let u = uMin; u <= uMax; u += pd) {
    for (let w = wMin; w <= wMax; w += pd) {
      const p = { x: u * gu.x + w * gw.x, y: u * gu.y + w * gw.y };
      if (!pointInPolygon(p, outer)) continue;
      let inHole = false;
      for (const h of holes) if (pointInPolygon(p, h)) { inHole = true; break; }
      if (inHole) continue;
      if (grid.hasWithin(p, clearance)) continue;
      grid.add(p);
      steiner.push(p);
    }
  }

  const all: Vec2[] = [...constraints, ...steiner];
  if (all.length < 3) {
    return { points: all.slice(), triangles: [], edges: [], boundary: outer.map((_, i) => i), numBoundary };
  }

  const coords: number[] = [];
  for (const p of all) { coords.push(p.x, p.y); }
  const del = new Delaunator(Float64Array.from(coords));
  const tri = del.triangles;

  // filter triangles: centroid inside outer and outside all holes; prune degenerates
  const minEdge = Math.max(pd * 0.1, 1e-4);
  const minEdge2 = minEdge * minEdge;
  const minArea = Math.max(pd * pd * 0.01, 1e-6);
  const keptTris: number[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const ia = tri[t], ib = tri[t + 1], ic = tri[t + 2];
    const A = all[ia], B = all[ib], C = all[ic];
    const cx = (A.x + B.x + C.x) / 3;
    const cy = (A.y + B.y + C.y) / 3;
    const cen = { x: cx, y: cy };
    if (!pointInPolygon(cen, outer)) continue;
    let inHole = false;
    for (const h of holes) if (pointInPolygon(cen, h)) { inHole = true; break; }
    if (inHole) continue;
    if (dist2(A, B) < minEdge2 || dist2(B, C) < minEdge2 || dist2(C, A) < minEdge2) continue;
    const area = Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y)) / 2;
    if (area < minArea) continue;
    keptTris.push(ia, ib, ic);
  }

  // compact: keep only referenced vertices
  const origToNew = new Int32Array(all.length).fill(-1);
  const points: Vec2[] = [];
  const remap = (i: number): number => {
    if (origToNew[i] === -1) { origToNew[i] = points.length; points.push(all[i]); }
    return origToNew[i];
  };
  const triangles: number[] = [];
  for (let t = 0; t < keptTris.length; t += 3) {
    triangles.push(remap(keptTris[t]), remap(keptTris[t + 1]), remap(keptTris[t + 2]));
  }

  // unique edges
  const edgeSet = new Set<number>();
  const edges: [number, number][] = [];
  const addEdge = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * points.length + hi;
    if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([lo, hi]); }
  };
  for (let t = 0; t < triangles.length; t += 3) {
    addEdge(triangles[t], triangles[t + 1]);
    addEdge(triangles[t + 1], triangles[t + 2]);
    addEdge(triangles[t + 2], triangles[t]);
  }

  // boundary aligned to outer order: boundary[i] = particle index of outer[i] (or -1 if pruned)
  const boundary: number[] = new Array(numBoundary);
  let kept = 0;
  for (let i = 0; i < numBoundary; i++) {
    boundary[i] = origToNew[i];
    if (origToNew[i] !== -1) kept++;
  }

  return { points, triangles, edges, boundary, numBoundary: kept };
}
