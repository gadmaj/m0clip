/** Runtime material composition; importing paint data alone must not load Three. */
import * as THREE from 'three';
import { FINISH } from './paint';
import type { PartOverride, PartPaint } from './scene';

/** Apply only deliberate axes, preserving authored textures, shader hooks and flags. */
export function applyPartPaint(
  material: THREE.MeshStandardMaterial, override: PartOverride | undefined, base?: PartOverride,
): void {
  const color = override?.color ?? base?.color;
  if (color !== undefined) {
    material.color.setHex(color);
    // Authored emissive surfaces use the same explicit tint as their diffuse map.
    // A finish/numeric edit must never tint that emission a second time.
    material.emissive.multiply(material.color);
  }
  const finishName = override?.finish ?? base?.finish;
  const finish = finishName === undefined ? undefined : FINISH[finishName];
  // A deliberate preset replaces base numeric adjustments, but a numeric-only
  // delta keeps those base axes. Resolve first so emissive receives one tint.
  const baseNumerics = override?.finish === undefined ? base : undefined;
  const roughness = override?.roughness ?? baseNumerics?.roughness ?? finish?.roughness;
  const metalness = override?.metalness ?? baseNumerics?.metalness ?? finish?.metalness;
  const clearcoat = override?.clearcoat ?? baseNumerics?.clearcoat ?? finish?.clearcoat;
  if (roughness !== undefined) material.roughness = roughness;
  if (metalness !== undefined) material.metalness = metalness;
  if (material instanceof THREE.MeshPhysicalMaterial) {
    if (clearcoat !== undefined) material.clearcoat = clearcoat;
    if (finish !== undefined) {
      material.clearcoatRoughness = finish.clearcoatRoughness;
      material.iridescence = finish.iridescence ?? 0;
      // Presets own their optical extras; absent axes above never reset them.
      material.iridescenceIOR = finish.iridescenceIOR ?? 1.3;
      material.iridescenceThicknessRange[0] = finish.iridescenceThicknessRange?.[0] ?? 100;
      material.iridescenceThicknessRange[1] = finish.iridescenceThicknessRange?.[1] ?? 400;
    }
  }
}

/** Representative source-slot readback, never a replacement for per-slot defaults. */
export function readPartPaint(material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial): PartPaint {
  const standard = material instanceof THREE.MeshStandardMaterial;
  const color = standard && material.userData.goldsrcFullbright ? material.emissive : material.color;
  return {
    color: color.getHex(), finish: 'satin',
    roughness: standard ? material.roughness : 1,
    metalness: standard ? material.metalness : 0,
    clearcoat: material instanceof THREE.MeshPhysicalMaterial ? material.clearcoat : 0,
  };
}
