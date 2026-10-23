/** Renderer-only shot edits. Recorded geometry, joint tracks and live preferences stay unchanged. */
import type { Appearance, HeadVisual } from '../render/scene';
import type { LookState } from '../ui/look';
import { validAppearance } from '../ui/view-appearance';
import { compatibleBody } from '../characters/catalog';

export const MAX_SHOT_LIGHTS = 8;
export type ShotLightKind = 'point' | 'spot' | 'directional';
export interface ShotLight {
  id: string;
  name: string;
  kind: ShotLightKind;
  enabled: boolean;
  color: number; // sRGB 0xRRGGBB
  intensity: number; // candela for point/spot; lux for directional
  position: [number, number, number]; // world metres, Z-up
  target: [number, number, number]; // world-space aim point; unused by point lights
  range: number; // metres; zero means no cutoff
  angle: number; // spot outer half-angle in degrees
  penumbra: number; // spot soft-edge fraction, 0–1
}
export interface ShotEdits {
  version: 1;
  appearance?: Appearance;
  sourceHead?: HeadVisual;
  look?: LookState;
  lights?: ShotLight[];
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const vector = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
const label = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;

/** Match saved-view Look semantics: named presets/AA and complete, finite custom lighting. */
export function validLook(v: unknown): v is LookState {
  if (!object(v) || !['auto', 'studio', 'map', 'custom', 'daylight', 'overcast', 'night'].includes(v.preset as string)
    || v.antialiasing !== undefined && !['fxaa', 'msaa4', 'none'].includes(v.antialiasing as string)) return false;
  const light = v.custom;
  return object(light) && typeof light.shadows === 'boolean' && [
    'sunAzimuth', 'sunElevation', 'sunIntensity', 'sunColor', 'ambient', 'skyColor',
    'groundColor', 'fill', 'reflections', 'exposure', 'background',
  ].every(key => typeof light[key] === 'number' && Number.isFinite(light[key]));
}

/** Shot lights are physical world-space data, not renderer objects or unbounded uniforms. */
export function validShotLight(v: unknown): v is ShotLight {
  if (!object(v) || !Object.keys(v).every(key => ['id', 'name', 'kind', 'enabled', 'color', 'intensity',
    'position', 'target', 'range', 'angle', 'penumbra'].includes(key))
    || !label(v.id) || !label(v.name) || !['point', 'spot', 'directional'].includes(v.kind as string)
    || typeof v.enabled !== 'boolean' || !number(v.color, 0, 0xffffff) || !Number.isInteger(v.color)
    || !number(v.intensity, 0, 100000) || v.intensity === 0
    || !vector(v.position) || !vector(v.target) || !number(v.range, 0, 10000)
    || !number(v.angle, 1, 89) || !number(v.penumbra, 0, 1)) return false;
  if (v.kind === 'point') return true;
  const distance = Math.hypot(v.position[0] - v.target[0], v.position[1] - v.target[1], v.position[2] - v.target[2]);
  return Number.isFinite(distance) && distance > 1e-6;
}

export function validShotLights(v: unknown): v is ShotLight[] {
  if (!Array.isArray(v) || v.length > MAX_SHOT_LIGHTS) return false;
  const ids = new Set<string>(), names = new Set<string>();
  for (const light of v) {
    if (!validShotLight(light) || ids.has(light.id) || names.has(light.name)) return false;
    ids.add(light.id); names.add(light.name);
  }
  return true;
}

/** Only cosmetic choices supported by the recorded robot may be applied to its fixed tracks. */
export function validShotEdits(v: unknown, robot: string): v is ShotEdits {
  if (!object(v) || v.version !== 1 || typeof robot !== 'string'
    || !Object.keys(v).every(key => ['version', 'appearance', 'sourceHead', 'look', 'lights'].includes(key))) return false;
  if (v.appearance !== undefined && (!validAppearance(v.appearance)
    || !compatibleBody(v.appearance.sourceBody, robot))) return false;
  if (v.sourceHead !== undefined && (v.sourceHead !== 'stock' && v.sourceHead !== 'ghost'
    || v.sourceHead === 'ghost' && !robot.startsWith('r1'))) return false;
  if (v.look !== undefined && !validLook(v.look)) return false;
  if (v.lights !== undefined && !validShotLights(v.lights)) return false;
  return true;
}
