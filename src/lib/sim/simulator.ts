// Orchestrates the cloth simulation. prepare() does all GPU-free work (triangulate + arrange +
// assemble sim data + body mesh packing) so the avatar and arranged panels render even without
// WebGPU; the live XPBD drape (ClothSimulation) is created on demand once a GPU device is available.

import type { Pattern } from '$lib/types/pattern';
import type { CylinderFrame } from '$lib/geometry/cylinders';
import { buildPieceCloth, buildSavedCloth, reuseSavedDrape } from '$lib/geometry/boundary';
import { arrangeParticles } from '$lib/geometry/arrangement';
import { buildSimData, type SimData, type ArrangedPiece } from './build';
import { ClothEngine, type BodyMesh } from './webgpu/engine';
import { SIM_CONFIG } from './config';
import { kabschRigid, applyRigid } from './refit';

export interface PreparedCloth {
  simData: SimData;
  body: BodyMesh;
}

/** Pack the avatar mesh into the engine's vec4 layout (positions x,y,z,0; triangles i0,i1,i2,0).
 *  The body broad-phase itself (a triangle spatial hash) is built on the GPU, like the original. */
export function packBodyMesh(vertexPositions: Float32Array, indices: Uint32Array): BodyMesh {
  const numVerts = vertexPositions.length / 3;
  const numTris = indices.length / 3;
  const positions = new Float32Array(numVerts * 4);
  for (let i = 0; i < numVerts; i++) {
    positions[i * 4] = vertexPositions[i * 3];
    positions[i * 4 + 1] = vertexPositions[i * 3 + 1];
    positions[i * 4 + 2] = vertexPositions[i * 3 + 2];
  }
  const triangles = new Uint32Array(numTris * 4);
  for (let t = 0; t < numTris; t++) {
    triangles[t * 4] = indices[t * 3];
    triangles[t * 4 + 1] = indices[t * 3 + 1];
    triangles[t * 4 + 2] = indices[t * 3 + 2];
  }
  return { positions, triangles, numTriangles: numTris };
}

export interface PrepareInit {
  pattern: Pattern;
  avatarVertices: Float32Array; // posed, meters
  avatarIndices: Uint32Array;
  cylinders: Map<string, CylinderFrame>;
}


/** GPU-free: triangulate + arrange every dynamic piece, assemble sim data + body collision grid.
 *  `fromArrangement` forces the source's literal pipeline: ignore the cached drape blob, triangulate
 *  the piece fresh and seed from its cylinder arrangement, so the solver drapes it live (no anchor).
 *  `changedPieces` lists pieces whose 2D shape was just edited: those re-triangulate from the live
 *  mainPaths (so the edit shows) and reuse the cached drape only where the new mesh still overlaps it,
 *  while every unedited piece keeps building from its frozen savedPositions blob. */
export function prepareCloth(
  init: PrepareInit,
  opts: { fromArrangement?: boolean; changedPieces?: Set<string> } = {}
): PreparedCloth | null {
  const { pattern, cylinders } = init;
  const arranged: ArrangedPiece[] = [];
  for (const piece of pattern.pieces) {
    if (piece.type !== 'dynamic' || piece.settings3d.enable3d === false) continue;
    const edited = opts.changedPieces?.has(piece.id) ?? false;

    // If a settled drape was cached, build the mesh DIRECTLY from those particles (their 2D for
    // topology + UV, their 3D as the drape) — reproduces the original render with no mapping error.
    // BUT if this piece's 2D shape was just edited, skip the frozen blob and re-triangulate from the
    // live mainPaths below, so the new shape actually shows in 3D.
    const savedCloth = (opts.fromArrangement || edited) ? null : buildSavedCloth(piece);
    if (savedCloth) {
      // also compute the flat-on-body placement for the same particles (used by "Arrange")
      const arranged3d = arrangeParticles(savedCloth.cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
        flipNormals: piece.settings3d.flipNormals
      });
      arranged.push({ cloth: savedCloth.cloth, positions3d: savedCloth.positions3d, frozen: piece.settings3d.frozen, fromSaved: true, boundaryLocal: savedCloth.boundaryParticles, arranged3d });
      continue;
    }

    // Triangulate the piece boundary from its live mainPaths and arrange it on its body cylinder.
    const cloth = buildPieceCloth(pattern, piece);
    if (!cloth || cloth.mesh.points.length < 3) continue;
    const arranged3d = arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
      flipNormals: piece.settings3d.flipNormals
    });

    // An edited piece that previously had a drape: reuse that drape via the source's 3-way seed —
    // exact-reuse where the shape is unchanged, KNN-from-drape for added area (so it follows the drape,
    // not flat-on-body), and a null return (handled below) when too much of the shape is new. The
    // reconstructed drape is coherent, so gently anchor (fromSaved) to hold it; boundaryLocal lets it
    // proximity-sew onto neighbouring saved-drape pieces (which carry no explicit edgeParticles).
    const reuse = edited ? reuseSavedDrape(cloth.mesh.points, piece.settings3d.savedPositions, cloth.particleDistanceMm) : null;
    if (reuse) {
      arranged.push({
        cloth,
        positions3d: reuse.positions3d,
        arranged3d,
        frozen: piece.settings3d.frozen,
        fromSaved: true,
        boundaryLocal: cloth.mesh.boundary
      });
      continue;
    }

    // Never-draped (or the edit changed the shape too much to reuse / fromArrangement): seed from the
    // cylinder arrangement and simulate.
    arranged.push({ cloth, positions3d: arranged3d, frozen: piece.settings3d.frozen, fromSaved: false });
  }
  if (arranged.length === 0) return null;
  const simData = buildSimData(pattern, arranged);
  const body = packBodyMesh(init.avatarVertices, init.avatarIndices);
  return { simData, body };
}

export class ClothSimulation {
  readonly simData: SimData;
  private engine: ClothEngine;
  private latest: Float32Array;

  constructor(device: GPUDevice, prepared: PreparedCloth) {
    this.simData = prepared.simData;
    this.engine = new ClothEngine(device, prepared.simData, prepared.body, SIM_CONFIG);
    this.latest = prepared.simData.positions.slice();
  }

  /** Advance one frame; returns the global vec4 position buffer (x,y,z,invMass per particle). */
  async step(): Promise<Float32Array> {
    const out = await this.engine.step();
    if (out.length === this.latest.length) this.latest = out;
    return this.latest;
  }

  get positions(): Float32Array {
    return this.latest;
  }

  /** 1 = hold the cached drape; 0 = release so it re-drapes (e.g. on a changed body). */
  setAnchorScale(scale: number) {
    this.engine.setAnchorScale(scale);
  }

  /** Toggle self-collision at runtime (off during a body-change re-drape to avoid curling). */
  setSelfCollision(enabled: boolean) {
    this.engine.setSelfCollisionEnabled(enabled);
  }

  /** Re-point the anchor targets at the latest settled positions and softly hold them. Used after a
   *  body-change re-drape so the garment gently holds the NEW clean drape (not a rigid freeze). */
  reanchorToSettled(scale = 0.25) {
    this.engine.setAnchors(this.latest);
    this.engine.setAnchorScale(scale);
  }

  /** Rigidly re-fit the cached drape onto the NEW-body arrangement (per-piece Kabsch), matching the
   *  original's createCloth re-fit of saved positions. Each piece's settled drape is rotated+translated
   *  so it best overlays where that piece now sits on the changed body, preserving the drape's shape;
   *  the solver then settles the non-rigid residual. Re-seeds both positions and anchors to the fit. */
  refitToArrangement(scale = 0.25) {
    const sd = this.simData;
    const out = sd.positions.slice();
    for (const piece of sd.pieces) {
      const n = piece.count;
      if (n < 3) continue;
      const cached = new Float32Array(n * 3); // current drape (old body)
      const arranged = new Float32Array(n * 3); // arrangement on the new body
      for (let i = 0; i < n; i++) {
        const g = piece.start + i;
        cached[i * 3] = sd.positions[g * 4]; cached[i * 3 + 1] = sd.positions[g * 4 + 1]; cached[i * 3 + 2] = sd.positions[g * 4 + 2];
        arranged[i * 3] = sd.arrangedPositions[g * 4]; arranged[i * 3 + 1] = sd.arrangedPositions[g * 4 + 1]; arranged[i * 3 + 2] = sd.arrangedPositions[g * 4 + 2];
      }
      const tr = kabschRigid(cached, arranged, n);
      for (let i = 0; i < n; i++) {
        const g = piece.start + i;
        const [x, y, z] = applyRigid(tr, cached[i * 3], cached[i * 3 + 1], cached[i * 3 + 2]);
        out[g * 4] = x; out[g * 4 + 1] = y; out[g * 4 + 2] = z; // .w (invMass) preserved from slice()
      }
    }
    this.engine.resetPositions(out);
    this.engine.setAnchors(out);
    this.engine.setAnchorScale(scale);
    this.latest = out;
  }

  /** Interactive grab: pull global particle `index` (and same-piece neighbours) toward world `pos`. */
  setGrab(grabbing: boolean, index: number, pos: [number, number, number]) {
    this.engine.setGrab(grabbing, index, pos);
  }

  /** Re-seed to the cached/settled drape. */
  resetToSaved() {
    this.engine.resetPositions(this.simData.positions);
    this.latest = this.simData.positions.slice();
  }

  /** Re-seed to the flat-on-body arrangement (pre-drape). */
  resetToArranged() {
    this.engine.resetPositions(this.simData.arrangedPositions);
    this.latest = this.simData.arrangedPositions.slice();
  }

  /** Re-seed to an arbitrary global stride-4 position array (e.g. a user arrangement). */
  resetTo(positions: Float32Array) {
    this.engine.resetPositions(positions);
    this.latest = positions.slice();
  }

  /** Seed to `positions`, anchor to them, and softly hold (used after a coherent re-fit so the new
   *  positions become the held target without a physics re-settle). */
  seedAndHold(positions: Float32Array, scale = 0.25) {
    this.engine.resetPositions(positions);
    this.engine.setAnchors(positions);
    this.engine.setAnchorScale(scale);
    this.latest = positions.slice();
  }

  rebuildBodyGrid(avatarVertices: Float32Array, avatarIndices: Uint32Array) {
    this.engine.updateBodyMesh(packBodyMesh(avatarVertices, avatarIndices));
  }

  dispose() {
    this.engine.dispose();
  }
}
