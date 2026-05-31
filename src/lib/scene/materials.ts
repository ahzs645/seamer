// PBR materials for the garment pieces and the body avatar, following the original renderer.

import * as THREE from 'three';
import type { Material } from '$lib/types/pattern';

export interface GarmentMatOpts {
  /** render only this face (default DoubleSide) — used to split front/back when a back texture is set */
  side?: THREE.Side;
  /** use the material's backTexture slot instead of frontTexture */
  back?: boolean;
}

/** True when this material wants its back face rendered with a different texture. */
export function hasSeparateBack(material: Material | undefined): boolean {
  return !!(material?.useSeparateBackSide && material.backTexture);
}

/** Garment material — MeshPhysicalMaterial, double-sided cloth, color or texture from the slot. */
export function createGarmentMaterial(material: Material | undefined, flat: boolean, opts: GarmentMatOpts = {}): THREE.MeshPhysicalMaterial {
  const dRough = flat ? 0 : 0.08;
  const pSpec = flat ? 1 : 0.65;
  const slot = opts.back ? (material?.backTexture ?? material?.frontTexture) : material?.frontTexture;
  const color = slot?.color ?? '#6b7a8f';
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    roughness: Math.min(1, (material?.roughness ?? 0.8) + dRough),
    metalness: material?.metalness ?? 0.1,
    specularIntensity: (material?.specularIntensity ?? 0.25) * pSpec,
    opacity: material?.opacity ?? 1,
    transparent: (material?.opacity ?? 1) < 1,
    side: opts.side ?? THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    sheen: 0.2,
    sheenRoughness: 0.8
  });

  // Texture maps. UVs are in mm, so repeat = 1/scale tiles every `scale` mm. Best-effort loads
  // (remote media may be unavailable offline / CORS-blocked) — failures keep the solid color/no-map.
  if (slot) {
    const scale = slot.scale && slot.scale > 0 ? slot.scale : 100;
    const loader = new THREE.TextureLoader();
    const tile = (tex: THREE.Texture, srgb: boolean) => {
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1 / scale, 1 / scale);
    };
    if (slot.url) {
      loader.load(slot.url, (tex) => {
        tile(tex, true);
        mat.map = tex; mat.color.set('#ffffff'); mat.needsUpdate = true;
      }, undefined, () => {});
    }
    // Normal map — gives the fabric weave depth under the new image-based lighting (linear, not sRGB).
    if (slot.normalUrl) {
      loader.load(slot.normalUrl, (tex) => {
        tile(tex, false);
        const ns = material?.normalScale ?? slot.normalMapScale ?? 1;
        mat.normalMap = tex; mat.normalScale = new THREE.Vector2(ns, ns); mat.needsUpdate = true;
      }, undefined, () => {});
    }
    // Opacity / cutwork map — alphaMap drives per-texel transparency (lace, eyelets, sheers).
    if (slot.opacityUrl) {
      loader.load(slot.opacityUrl, (tex) => {
        tile(tex, false);
        mat.alphaMap = tex; mat.transparent = true; mat.needsUpdate = true;
      }, undefined, () => {});
    }
  }
  return mat;
}

/** Skin-like avatar material. */
export function createAvatarMaterial(bodyColor: string): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(bodyColor || '#b58a6a'),
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.45,
    sheen: 0.15,
    sheenRoughness: 0.6,
    specularIntensity: 0.35,
    specularColor: new THREE.Color('#f5ede2'),
    side: THREE.DoubleSide
  });
}
