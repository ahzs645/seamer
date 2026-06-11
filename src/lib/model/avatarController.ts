// High-level avatar: loads assets, solves shape coefficients from body measurements, reconstructs
// the mesh, and manages the skinned/posed THREE mesh. Used by the 3D scene.

import * as THREE from 'three';
import type { Body } from '$lib/types/pattern';
import { loadAvatarAssets, loadGenderAssets, type AvatarAssets, type Cylinder, type ArrangementPointDef } from './assets';
import { solveBodyCoefficients } from './measurements';
import { reconstructVertices } from './avatar';
import { SkinnedAvatar } from './skinnedAvatar';

export class AvatarController {
  private assets: AvatarAssets;
  private material: THREE.Material;
  private skinned: SkinnedAvatar | null = null;
  private pose: string | null = 'T';
  private gender = 'female';

  private constructor(assets: AvatarAssets, material: THREE.Material) {
    this.assets = assets;
    this.material = material;
  }

  static async create(body: Body, material: THREE.Material): Promise<AvatarController> {
    const assets = await loadAvatarAssets();
    const c = new AvatarController(assets, material);
    await c.setBody(body);
    return c;
  }

  get mesh(): THREE.Mesh | null {
    return this.skinned?.mesh ?? null;
  }

  poseNames(): string[] {
    return this.skinned?.poseNames() ?? [];
  }

  /** Recompute the avatar from body measurements + gender. */
  async setBody(body: Body): Promise<void> {
    this.gender = body.gender === 'male' ? 'male' : 'female';
    const genderAssets = await loadGenderAssets(this.gender);
    const { coeff } = solveBodyCoefficients(genderAssets.model, body);
    const verts = reconstructVertices(
      this.assets.baseModel,
      genderAssets.coefficients,
      coeff,
      this.assets.numVertices
    );
    if (!this.skinned) {
      this.skinned = new SkinnedAvatar(
        this.assets.baseModel,
        this.assets.indices,
        this.assets.skinIndices,
        this.assets.skinWeights,
        verts,
        this.material
      );
      this.skinned.setPose(this.pose);
    } else {
      this.skinned.setRestVertices(verts);
    }
  }

  setPose(name: string | null): void {
    this.pose = name;
    this.skinned?.setPose(name);
  }

  get skinnedAvatar(): SkinnedAvatar | null {
    return this.skinned;
  }

  get vertexPositions(): Float32Array {
    return this.skinned?.positions ?? new Float32Array(0);
  }

  get indices(): Uint32Array {
    return this.skinned?.indices ?? new Uint32Array(0);
  }

  get cylinderDefs(): Cylinder[] {
    return this.assets.baseModel.cylinders;
  }

  get arrangementPointDefs(): ArrangementPointDef[] {
    return this.assets.baseModel.arrangementPoints ?? [];
  }

  bonePosition(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    return this.skinned?.boneWorldPosition(name, out) ?? null;
  }

  setMaterial(material: THREE.Material): void {
    this.material = material;
    if (this.skinned) this.skinned.mesh.material = material;
  }

  dispose(): void {
    this.skinned?.dispose();
  }
}
