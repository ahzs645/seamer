// Assemble GPU-ready simulation data from triangulated, arranged pieces.
//
// Pieces are drafted as halves and mirrored: a seam reference with `mirrored: true` targets an
// x-mirrored instance of the piece. We therefore emit a mirrored instance for any piece referenced
// mirrored by a seam, so the full symmetric garment is sewn together (center + side seams).
//
// Rest lengths come from the FLAT 2D pattern (mm -> m); arranged 3D positions are only the initial
// state. Stretch compliance is anisotropic (warp/weft blended by edge orientation vs grain). Bend
// is a distance constraint between opposite corners. Edges are greedily colored so each color group
// has no shared vertex (conflict-free Gauss-Seidel).

import type { Pattern, Material } from '$lib/types/pattern';
import type { PieceCloth } from '$lib/geometry/boundary';
import type { Vec2 } from '$lib/utils/patternGeometry';
import {
  stretchScaleToCompliance,
  bendScaleToCompliance,
  clampStretchAlpha,
  clampBendAlpha,
  DISABLED_COMPLIANCE
} from './config';

export interface ColorGroup {
  edges: Float32Array; // vec4 per edge: p1, p2, restLength(m), longRangeFlag
  props: Float32Array; // vec4 per edge: compliance, 0, 0, 0
  count: number;
}

export interface SimPiece {
  pieceId: string; // instance id (mirror instances suffixed "#M")
  materialId: string;
  start: number;
  count: number;
  triangles: number[]; // global particle indices, flat
  uv: Float32Array;
}

export interface SimData {
  particleCount: number;
  positions: Float32Array; // vec4: x,y,z, invMass (initial = cached/arranged drape)
  arrangedPositions: Float32Array; // vec4: flat-on-body placement (pre-drape), for "Arrange"
  positions2d: Float32Array; // vec4: x2d(m), y2d(m), pieceIndex, 0
  anchors: Float32Array; // vec4: anchor xyz (initial), w = anchor weight (1 = hold to saved drape)
  stretchColors: ColorGroup[];
  bendColors: ColorGroup[];
  seams: Int32Array; // particleCount * 4, init -1
  pieces: SimPiece[];
  // Self-collision (cloth-vs-cloth) inputs:
  triangles: Uint32Array; // vec4u per cloth triangle: a, b, c, meta(layer | outsideFlag)
  triangleCount: number;
  particleLayers: Uint32Array; // particleCount: collision layer (0 default)
  // Near-damping input:
  neighborIndices: Int32Array; // particleCount * 8, mesh-connected neighbours, -1 fill
  // Body-collision cloth-normal filter: per particle, [flag, tri0, tri1, ...] with stride
  // (maxIncidentTrianglesPerParticle+1). flag: 0 = no filter, +1 = filter, -1 = filter + flip normal.
  incidentTriangles: Int32Array;
  maxIncidentTrianglesPerParticle: number;
}

export interface ArrangedPiece {
  cloth: PieceCloth;
  positions3d: Float32Array; // arranged, length cloth.mesh.points.length*3 (m)
  frozen: boolean;
  fromSaved: boolean; // initial positions came from the original settled drape (anchor to them)
  boundaryLocal?: number[]; // local indices of boundary particles (saved-drape pieces) for seam linking
  arranged3d?: Float32Array; // flat-on-body placement for the same particles (pre-drape); defaults to positions3d
}

interface Instance {
  ap: ArrangedPiece;
  mirror: boolean;
  pieceIndex: number;
}

function tri2DArea(a: Vec2, b: Vec2, c: Vec2): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

// Bend color groups for the dihedral bending shader. Each constraint moves p1/p2 (the opposite
// vertices) and reads the hinge pair, so we colour by p1/p2 only (conflict-free Gauss-Seidel).
// edges vec4 = [p1, p2, hingeA, hingeB]; props vec4 = [compliance, complianceBeyond, restLen, targetAngle].
function buildBendColorGroups(
  opp: [number, number][],
  hinge: [number, number][],
  restLen: number[],
  compliance: number[],
  targetAngle: number[]
): ColorGroup[] {
  const usedByVertex = new Map<number, Set<number>>();
  const colorOf = new Int32Array(opp.length);
  const get = (v: number) => {
    let s = usedByVertex.get(v);
    if (!s) { s = new Set(); usedByVertex.set(v, s); }
    return s;
  };
  let maxColor = -1;
  for (let i = 0; i < opp.length; i++) {
    const ua = get(opp[i][0]);
    const ub = get(opp[i][1]);
    let c = 0;
    while (ua.has(c) || ub.has(c)) c++;
    colorOf[i] = c;
    ua.add(c); ub.add(c);
    if (c > maxColor) maxColor = c;
  }
  const groups: { e: number[]; p: number[] }[] = [];
  for (let c = 0; c <= maxColor; c++) groups.push({ e: [], p: [] });
  for (let i = 0; i < opp.length; i++) {
    const g = groups[colorOf[i]];
    g.e.push(opp[i][0], opp[i][1], hinge[i][0], hinge[i][1]);
    g.p.push(compliance[i], compliance[i], restLen[i], targetAngle[i]);
  }
  return groups.map((g) => ({ edges: Float32Array.from(g.e), props: Float32Array.from(g.p), count: g.e.length / 4 }));
}

function buildColorGroups(
  edges: [number, number][],
  restLen: number[],
  compliance: number[],
  longRange: number[]
): ColorGroup[] {
  const usedByVertex = new Map<number, Set<number>>();
  const colorOf = new Int32Array(edges.length);
  const get = (v: number) => {
    let s = usedByVertex.get(v);
    if (!s) { s = new Set(); usedByVertex.set(v, s); }
    return s;
  };
  let maxColor = -1;
  for (let i = 0; i < edges.length; i++) {
    const ua = get(edges[i][0]);
    const ub = get(edges[i][1]);
    let c = 0;
    while (ua.has(c) || ub.has(c)) c++;
    colorOf[i] = c;
    ua.add(c); ub.add(c);
    if (c > maxColor) maxColor = c;
  }
  const groups: { e: number[]; p: number[] }[] = [];
  for (let c = 0; c <= maxColor; c++) groups.push({ e: [], p: [] });
  for (let i = 0; i < edges.length; i++) {
    const g = groups[colorOf[i]];
    g.e.push(edges[i][0], edges[i][1], restLen[i], longRange[i]);
    g.p.push(compliance[i], 0, 0, 0);
  }
  return groups.map((g) => ({ edges: Float32Array.from(g.e), props: Float32Array.from(g.p), count: g.e.length / 4 }));
}

export function buildSimData(pattern: Pattern, arranged: ArrangedPiece[]): SimData {
  const materials = new Map<string, Material>();
  for (const m of pattern.materials) materials.set(m.id, m);

  // One instance per piece: half-pieces are already reflected to full in boundary.ts, so no 3D
  // mirror instances are needed. (Seam `mirrored` refs to reflected edges are matched to the base
  // edge below; the saved/arranged drape keeps the panels joined.)
  const instances: Instance[] = arranged.map((ap, pi) => ({ ap, mirror: false, pieceIndex: pi }));
  // Experimental (opt-in via settings3d.drapeMirroredPieces): also drape an X-mirrored instance of
  // each piece cut as a left/right pair (leftPieces > 0). Its seam edges register under `#M` keys
  // (see below), so seam refs with `mirrored:true` sew to it. Additive — when the flag is off this
  // loop emits nothing and the drape is identical to one-instance-per-piece.
  if (pattern.settings3d.drapeMirroredPieces) {
    const mirrors: Instance[] = [];
    for (let pi = 0; pi < arranged.length; pi++) {
      const owner = pattern.pieces.find((p) => p.id === arranged[pi].cloth.pieceId);
      if (owner && (owner.leftPieces ?? 0) > 0) mirrors.push({ ap: arranged[pi], mirror: true, pieceIndex: pi });
    }
    instances.push(...mirrors);
  }

  let total = 0;
  for (const inst of instances) total += inst.ap.cloth.mesh.points.length;

  const positions = new Float32Array(total * 4);
  const arrangedPositions = new Float32Array(total * 4);
  const positions2d = new Float32Array(total * 4);
  const anchors = new Float32Array(total * 4);
  const invMass = new Float64Array(total);
  const simPieces: SimPiece[] = [];

  const allStretchEdges: [number, number][] = [];
  const stretchRest: number[] = [];
  const stretchCompliance: number[] = [];
  const stretchLong: number[] = [];
  const allBendEdges: [number, number][] = [];
  const bendHinge: [number, number][] = [];
  const bendRest: number[] = [];
  const bendCompliance: number[] = [];
  const bendTargetAngle: number[] = [];

  // `${pieceId}::${edgeKey}` -> global particle indices (for seams). edgeKey is a PiecePath id,
  // optionally suffixed `#M` for the reflected (mirrored) copy of that edge.
  const edgeParticlesGlobal = new Map<string, number[]>();
  const key = (pieceId: string, edgeKey: string) => `${pieceId}::${edgeKey}`;
  const instBoundaryGlobals: number[][] = []; // global boundary particle indices per instance (saved pieces)

  let offset = 0;
  for (let ii = 0; ii < instances.length; ii++) {
    const inst = instances[ii];
    const ap = inst.ap;
    const mesh = ap.cloth.mesh;
    const n = mesh.points.length;
    const sgn = inst.mirror ? -1 : 1;
    const mat = materials.get(ap.cloth.materialId);
    const s = (mat?.weight ?? 120) / 1000;
    const warpA = clampStretchAlpha(stretchScaleToCompliance(mat?.stretchWarpValue ?? 10));
    const weftA = clampStretchAlpha(stretchScaleToCompliance(mat?.stretchWeftValue ?? 10));
    const bendA = clampBendAlpha(bendScaleToCompliance(mat?.bendValue ?? 0));

    const piece = pattern.pieces.find((p) => p.id === ap.cloth.pieceId)!;
    const gl = Math.hypot(piece.grainVector.x, piece.grainVector.y) || 1;
    const xHat = { x: piece.grainVector.x / gl, y: piece.grainVector.y / gl };
    const yHat = { x: -xHat.y, y: xHat.x };

    // UVs in millimeters (the material tiles every `scale` mm via texture.repeat = 1/scale)
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const g = offset + i;
      positions[g * 4] = sgn * ap.positions3d[i * 3]; // mirror across X
      positions[g * 4 + 1] = ap.positions3d[i * 3 + 1];
      positions[g * 4 + 2] = ap.positions3d[i * 3 + 2];
      const arr3 = ap.arranged3d ?? ap.positions3d;
      arrangedPositions[g * 4] = sgn * arr3[i * 3];
      arrangedPositions[g * 4 + 1] = arr3[i * 3 + 1];
      arrangedPositions[g * 4 + 2] = arr3[i * 3 + 2];
      anchors[g * 4] = positions[g * 4];
      anchors[g * 4 + 1] = positions[g * 4 + 1];
      anchors[g * 4 + 2] = positions[g * 4 + 2];
      anchors[g * 4 + 3] = ap.fromSaved ? 1 : 0;
      positions2d[g * 4] = mesh.points[i].x / 1000;
      positions2d[g * 4 + 1] = mesh.points[i].y / 1000;
      positions2d[g * 4 + 2] = 0;
      positions2d[g * 4 + 3] = ii; // piece/instance index (used by the grab influence test)
      uv[i * 2] = sgn * mesh.points[i].x;
      uv[i * 2 + 1] = mesh.points[i].y;
    }

    if (!ap.frozen) {
      for (let t = 0; t < mesh.triangles.length; t += 3) {
        const ia = mesh.triangles[t], ib = mesh.triangles[t + 1], ic = mesh.triangles[t + 2];
        const area = tri2DArea(mesh.points[ia], mesh.points[ib], mesh.points[ic]) / 1e6;
        if (area <= 0) continue;
        const m = 1 / ((area * s) / 3);
        invMass[offset + ia] += m;
        invMass[offset + ib] += m;
        invMass[offset + ic] += m;
      }
    }

    for (const [a, b] of mesh.edges) {
      const pa = mesh.points[a];
      const pb = mesh.points[b];
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len2d = Math.hypot(dx, dy);
      const ex = len2d > 1e-9 ? dx / len2d : 1;
      const ey = len2d > 1e-9 ? dy / len2d : 0;
      const nWarp = Math.abs(ex * xHat.x + ey * xHat.y);
      const nWeft = Math.abs(ex * yHat.x + ey * yHat.y);
      const alpha = clampStretchAlpha((nWarp * warpA + nWeft * weftA) / Math.max(1e-8, nWarp + nWeft));
      allStretchEdges.push([offset + a, offset + b]);
      stretchRest.push(len2d / 1000);
      stretchCompliance.push(alpha);
      stretchLong.push(0);
    }

    // Bending: one constraint per interior mesh edge shared by two triangles. The two opposite
    // vertices are p1/p2 (the moved pair); the shared edge's two vertices are the hinge. The dihedral
    // bending shader rotates p1/p2 around the hinge toward a target fold angle; with targetAngle 0
    // (no fold line) it falls back to a distance constraint between p1 and p2 (our previous behaviour).
    const edgeToOpp = new Map<number, number[]>();
    const ekey = (x: number, y: number) => Math.min(x, y) * n + Math.max(x, y);
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const v = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
      for (let e = 0; e < 3; e++) {
        const k = ekey(v[e], v[(e + 1) % 3]);
        let arr = edgeToOpp.get(k);
        if (!arr) { arr = []; edgeToOpp.set(k, arr); }
        arr.push(v[(e + 2) % 3]);
      }
    }
    for (const [k, opps] of edgeToOpp.entries()) {
      if (opps.length !== 2) continue;
      const pa = mesh.points[opps[0]];
      const pb = mesh.points[opps[1]];
      const hingeA = Math.floor(k / n), hingeB = k % n; // local indices of the shared edge
      allBendEdges.push([offset + opps[0], offset + opps[1]]);
      bendHinge.push([offset + hingeA, offset + hingeB]);
      bendRest.push(Math.hypot(pb.x - pa.x, pb.y - pa.y) / 1000);
      bendCompliance.push(bendA);
      bendTargetAngle.push(0); // no internal fold lines in these pieces -> distance-mode bending
    }

    // Base instance registers edgeKey as-is; the mirror instance registers `${edgeKey}#M`, which is
    // exactly what chain() looks up for a seam ref with `mirrored:true`. Same base pieceId, distinct
    // key suffix → the mirror's edges never overwrite the base instance's registration.
    for (const [edgeKey, locals] of ap.cloth.edgeParticles) {
      edgeParticlesGlobal.set(key(ap.cloth.pieceId, inst.mirror ? `${edgeKey}#M` : edgeKey), locals.map((li) => offset + li));
    }
    instBoundaryGlobals.push((ap.boundaryLocal ?? []).map((li) => offset + li));

    // triangle winding flipped on mirror so face normals stay outward
    const tris = mesh.triangles.map((li) => offset + li);
    if (inst.mirror) {
      for (let t = 0; t < tris.length; t += 3) { const tmp = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = tmp; }
    }
    simPieces.push({
      pieceId: inst.mirror ? ap.cloth.pieceId + '#M' : ap.cloth.pieceId,
      materialId: ap.cloth.materialId,
      start: offset,
      count: n,
      triangles: tris,
      uv
    });
    offset += n;
  }

  for (let i = 0; i < total; i++) { positions[i * 4 + 3] = invMass[i]; arrangedPositions[i * 4 + 3] = invMass[i]; }

  // Seams.
  const seams = new Int32Array(total * 4).fill(-1);
  const addSeamLink = (a: number, b: number) => {
    if (a === b) return;
    for (let j = 0; j < 4; j++) {
      if (seams[a * 4 + j] === b) return;
      if (seams[a * 4 + j] === -1) { seams[a * 4 + j] = b; return; }
    }
  };
  const dist3 = (a: number, b: number) => Math.hypot(
    positions[a * 4] - positions[b * 4], positions[a * 4 + 1] - positions[b * 4 + 1], positions[a * 4 + 2] - positions[b * 4 + 2]
  );
  const chain = (refs: { id: string; mirrored: boolean; reversed: boolean }[]): number[] => {
    const out: number[] = [];
    for (const r of refs) {
      // a mirrored ref targets the mirror instance; find the owning piece for this PiecePath id
      const owner = pattern.pieces.find((p) => p.mainPaths.some((mp) => mp.id === r.id) || p.internalPaths.some((mp) => mp.id === r.id));
      if (!owner) continue;
      const edgeKey = r.mirrored ? `${r.id}#M` : r.id;
      const arr = edgeParticlesGlobal.get(key(owner.id, edgeKey));
      if (!arr) continue;
      out.push(...(r.reversed ? arr.slice().reverse() : arr.slice()));
    }
    return out;
  };

  // Dense 1:1 seam pairing, matching the original (which sews equal-count resampled edges by index).
  // The two chains are ordered along their shared edge; pair EVERY particle (walk the longer chain,
  // map proportionally onto the shorter) so every seam particle gets a partner — not just the few
  // that happened to be within a nearest-neighbour tolerance (which left long seams sparse/lumpy).
  // Auto-detect edge direction: in the cached drape sewn edges are coincident, so the correct
  // alignment (forward vs reversed) is the one with the smaller total paired distance.
  const sampleIdx = (len: number, n: number, k: number) => (len <= 1 ? 0 : Math.round((k * (len - 1)) / (n - 1)));
  for (const seam of pattern.seams) {
    const fromChain = chain(seam.fromPaths);
    const toChain = chain(seam.toPaths);
    if (fromChain.length === 0 || toChain.length === 0) continue;
    const n = Math.max(fromChain.length, toChain.length);
    const alignCost = (rev: boolean) => {
      let c = 0;
      for (let k = 0; k < n; k++) {
        const a = fromChain[sampleIdx(fromChain.length, n, k)];
        const b = toChain[sampleIdx(toChain.length, n, rev ? n - 1 - k : k)];
        c += dist3(a, b);
      }
      return c;
    };
    const rev = alignCost(true) < alignCost(false);
    for (let k = 0; k < n; k++) {
      const a = fromChain[sampleIdx(fromChain.length, n, k)];
      const b = toChain[sampleIdx(toChain.length, n, rev ? n - 1 - k : k)];
      addSeamLink(a, b); addSeamLink(b, a);
    }
  }

  // Proximity seams for saved-drape pieces: in the settled drape, sewn edges of adjacent pieces are
  // coincident, so link boundary particles of different pieces that nearly touch. This keeps the
  // garment sewn together when pulled / re-draped. Threshold ~> particle spacing so seam particles
  // on both edges reliably pair up (else pieces detach under interaction).
  const PROX = 0.016; // 16 mm
  for (let i = 0; i < instBoundaryGlobals.length; i++) {
    for (let j = i + 1; j < instBoundaryGlobals.length; j++) {
      const A = instBoundaryGlobals[i];
      const B = instBoundaryGlobals[j];
      if (A.length === 0 || B.length === 0) continue;
      for (const a of A) {
        let best = -1, bd = PROX;
        for (const b of B) {
          const d = dist3(a, b);
          if (d < bd) { bd = d; best = b; }
        }
        if (best >= 0) { addSeamLink(a, best); addSeamLink(best, a); }
      }
    }
  }

  // Soften BOTH stretch and bend across seams (matching the original's setupStretchingEdges +
  // setupBendingEdges): a stiff spring/fold spanning a seam fights the seam solver pulling the two
  // edges together, so disable compliance for edges whose endpoints are both seam particles.
  const isSeam = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (seams[i * 4] !== -1) isSeam[i] = 1;
  for (let i = 0; i < allStretchEdges.length; i++) {
    const [a, b] = allStretchEdges[i];
    if (isSeam[a] && isSeam[b]) stretchCompliance[i] = DISABLED_COMPLIANCE;
  }
  for (let i = 0; i < allBendEdges.length; i++) {
    const [a, b] = allBendEdges[i];
    if (isSeam[a] && isSeam[b]) bendCompliance[i] = DISABLED_COMPLIANCE;
  }

  const stretchColors = buildColorGroups(allStretchEdges, stretchRest, stretchCompliance, stretchLong);
  const bendColors = buildBendColorGroups(allBendEdges, bendHinge, bendRest, bendCompliance, bendTargetAngle);

  // Per-piece collision layer + flip flag (matches the original: layered garments self-collide in
  // layer order; flipNormals encodes the triangle's outside sign). Looked up from settings3d.
  const LAYER_MASK = 0x7fffffff;
  const OUTSIDE_FLAG = 0x80000000;
  const pieceMeta = (pieceId: string): { layer: number; flip: boolean; filterFlag: number } => {
    const pc = pattern.pieces.find((p) => p.id === pieceId.replace(/#M$/, ''));
    const layer = Math.min(LAYER_MASK, Math.max(0, (pc?.settings3d.collisionLayer ?? 0) >>> 0));
    const flip = !!pc?.settings3d.flipNormals;
    // Body-collision cloth-normal filter flag: 0 off, +1 on, -1 on+flip (per the original).
    const filterFlag = pc?.settings3d.filterExternalCollisionsByClothNormal ? (flip ? -1 : 1) : 0;
    return { layer, flip, filterFlag };
  };

  // Global cloth triangle list for self-collision: vec4u [a, b, c, meta]. meta packs the collision
  // layer (low 31 bits) and the outside-normal flag (bit 31). simPieces[].triangles already hold
  // global indices with mirror winding applied.
  let triCount = 0;
  for (const sp of simPieces) triCount += sp.triangles.length / 3;
  const triangles = new Uint32Array(triCount * 4);
  const particleLayers = new Uint32Array(total);
  // Incident triangles for the body-collision cloth-normal filter: per particle a filter flag + the
  // global indices of the cloth triangles it belongs to (used to estimate the cloth surface normal).
  const MAX_INCIDENT = 8;
  const incidentStride = MAX_INCIDENT + 1;
  const incidentTriangles = new Int32Array(total * incidentStride).fill(-1);
  const incidentCount = new Uint8Array(total); // filled slots per particle (excl. the flag slot)
  {
    let o = 0;
    let triGlobal = 0;
    for (const sp of simPieces) {
      const { layer, flip, filterFlag } = pieceMeta(sp.pieceId);
      const meta = (layer & LAYER_MASK) | (flip ? OUTSIDE_FLAG : 0);
      for (let k = 0; k < sp.count; k++) {
        particleLayers[sp.start + k] = layer;
        incidentTriangles[(sp.start + k) * incidentStride] = filterFlag; // slot 0 = flag
      }
      for (let t = 0; t < sp.triangles.length; t += 3) {
        const a = sp.triangles[t], b = sp.triangles[t + 1], c = sp.triangles[t + 2];
        triangles[o++] = a; triangles[o++] = b; triangles[o++] = c; triangles[o++] = meta;
        for (const v of [a, b, c]) {
          const n = incidentCount[v];
          if (n < MAX_INCIDENT) { incidentTriangles[v * incidentStride + 1 + n] = triGlobal; incidentCount[v] = n + 1; }
        }
        triGlobal++;
      }
    }
  }

  // Neighbour indices for near-damping: up to 8 mesh-connected particles per particle, -1 padded.
  const neighborIndices = new Int32Array(total * 8).fill(-1);
  {
    const adj: Set<number>[] = Array.from({ length: total }, () => new Set<number>());
    for (const [a, b] of allStretchEdges) { adj[a].add(b); adj[b].add(a); }
    for (let i = 0; i < total; i++) {
      let l = 0;
      for (const nb of adj[i]) { if (l >= 8) break; neighborIndices[i * 8 + l] = nb; l++; }
    }
  }

  return {
    particleCount: total, positions, arrangedPositions, positions2d, anchors,
    stretchColors, bendColors, seams, pieces: simPieces,
    triangles, triangleCount: triCount, particleLayers, neighborIndices,
    incidentTriangles, maxIncidentTrianglesPerParticle: MAX_INCIDENT
  };
}
