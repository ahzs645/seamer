// Orchestrates the cloth simulation. prepare() does all GPU-free work (triangulate + arrange +
// assemble sim data + body grid) so the avatar and arranged panels render even without WebGPU;
// the live XPBD drape (ClothSimulation) is created on demand once a GPU device is available.

import type { Pattern } from '$lib/types/pattern';
import type { CylinderFrame } from '$lib/geometry/cylinders';
import { buildPieceCloth, buildSavedCloth } from '$lib/geometry/boundary';
import { arrangeParticles } from '$lib/geometry/arrangement';
import { buildSimData, type SimData, type ArrangedPiece } from './build';
import { buildBodyGrid, type BodyGrid } from './bodyGrid';
import { ClothEngine } from './webgpu/engine';
import { SIM_CONFIG } from './config';
import { kabschRigid, applyRigid } from './refit';

export interface PreparedCloth {
  simData: SimData;
  grid: BodyGrid;
}

export interface PrepareInit {
  pattern: Pattern;
  avatarVertices: Float32Array; // posed, meters
  avatarIndices: Uint32Array;
  cylinders: Map<string, CylinderFrame>;
}


/** GPU-free: triangulate + arrange every dynamic piece, assemble sim data + body collision grid.
 *  `fromArrangement` forces the source's literal pipeline: ignore the cached drape blob, triangulate
 *  the piece fresh and seed from its cylinder arrangement, so the solver drapes it live (no anchor). */
export function prepareCloth(init: PrepareInit, opts: { fromArrangement?: boolean } = {}): PreparedCloth | null {
  const { pattern, cylinders } = init;
  const arranged: ArrangedPiece[] = [];
  for (const piece of pattern.pieces) {
    if (piece.type !== 'dynamic' || piece.settings3d.enable3d === false) continue;

    // If a settled drape was cached, build the mesh DIRECTLY from those particles (their 2D for
    // topology + UV, their 3D as the drape) — reproduces the original render with no mapping error.
    const savedCloth = opts.fromArrangement ? null : buildSavedCloth(piece);
    if (savedCloth) {
      // also compute the flat-on-body placement for the same particles (used by "Arrange")
      const arranged3d = arrangeParticles(savedCloth.cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
        flipNormals: piece.settings3d.flipNormals
      });
      arranged.push({ cloth: savedCloth.cloth, positions3d: savedCloth.positions3d, frozen: piece.settings3d.frozen, fromSaved: true, boundaryLocal: savedCloth.boundaryParticles, arranged3d });
      continue;
    }

    // Otherwise triangulate the piece boundary and arrange it on its body cylinder, then simulate.
    const cloth = buildPieceCloth(pattern, piece);
    if (!cloth || cloth.mesh.points.length < 3) continue;
    const positions3d = arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
      flipNormals: piece.settings3d.flipNormals
    });
    arranged.push({ cloth, positions3d, frozen: piece.settings3d.frozen, fromSaved: false });
  }
  if (arranged.length === 0) return null;
  const simData = buildSimData(pattern, arranged);
  const grid = buildBodyGrid(init.avatarVertices, init.avatarIndices);
  return { simData, grid };
}

export class ClothSimulation {
  readonly simData: SimData;
  private engine: ClothEngine;
  private latest: Float32Array;

  constructor(device: GPUDevice, prepared: PreparedCloth) {
    this.simData = prepared.simData;
    this.engine = new ClothEngine(device, prepared.simData, prepared.grid, SIM_CONFIG);
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
    this.engine.updateBodyGrid(buildBodyGrid(avatarVertices, avatarIndices));
  }

  dispose() {
    this.engine.dispose();
  }
}
