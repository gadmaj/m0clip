/** Authored character skins driven by compatible recorded physics, never substitute motion tracks. */
import type * as THREE from 'three';
import type { RenderModel } from '../../sim/protocol';
import type { PartPaint } from '../scene';
import type { GeometryTrack } from '../../core/geometry';

export interface CharacterAttribution {
  title: string;
  creator: string;
  source: string;
  license: string;
  licenseUrl?: string;
  modifications: string[];
}
export type CharacterPhysics = 'r1' | 'go2';
export interface CharacterDefinition {
  id: string;
  label: string;
  url: string;
  preview: string;
  attribution: CharacterAttribution;
  /** Recorded physics family used by this calibration; R1 by default. */
  physics?: CharacterPhysics;
  rig: {
    root: string;
    /** Authored coordinates to MuJoCo Z-up, +X forward; validated four-component xyzw. */
    alignment: readonly number[];
    /** Bone name to compatible physics-body candidates, ordered by preference. */
    bindings: Record<string, readonly string[]>;
    /** Native descendant, or a bone-local direction aimed at ordered physics-body endpoints. */
    aim?: Record<string, string | { direction: readonly number[]; target: readonly string[] }>;
    /** Anatomical joint pivots in native bone-local coordinates, when the bone head is not the joint. */
    pivots?: Record<string, readonly number[]>;
    /** Bind-relative pose attachments; the original native hierarchy and inverse binds stay intact. */
    attachments?: Record<string, string>;
    feet: (string | { bone: string; target: readonly string[] })[];
  };
}
export interface CharacterBodyExport {
  root: THREE.Object3D;
  tracks: THREE.KeyframeTrack[];
}
/** True means the caller deliberately owns emissive/lighting instead of authored unlit restoration. */
export type CharacterPaint = (part: string, material: THREE.MeshPhysicalMaterial) => boolean | void;
export interface CharacterBody {
  readonly root: THREE.Object3D;
  /** Includes authored rigid bone attachments as well as skinned surfaces. */
  readonly meshes: THREE.Mesh[];
  partNames(): string[];
  nativePaintFor(part: string): PartPaint | undefined;
  updateMaterials(): void;
  eachMaterial(visit: (material: THREE.Material) => void): void;
  preview(part: string | null, paint: CharacterPaint): THREE.Object3D;
  sync(xpos: Float32Array, xmat: Float32Array): void;
  visibility(opacity: number, visible: boolean): void;
  export(geometry: GeometryTrack, times: Float32Array): CharacterBodyExport;
  dispose(): void;
}
export interface CharacterAsset {
  create(model: RenderModel, paint: CharacterPaint): CharacterBody;
  /** Releases the cached source after every created body has been disposed. */
  dispose(): void;
}
