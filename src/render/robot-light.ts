/** Opt-in robot illumination; independent of the map's original lighting. */
import * as THREE from 'three';

export interface RobotLight { brightness: number; color: number; range: number; dull: boolean }
export const DEFAULT_ROBOT_LIGHT: RobotLight = { brightness: 0, color: 0xffffff, range: 8, dull: false };
export function robotLightSettings(value?: Partial<RobotLight>): RobotLight {
  const bounded = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const dull = value?.dull === true;
  return { dull, brightness: dull ? 0 : bounded(value?.brightness, 0, 0, 100),
    color: Math.round(bounded(value?.color, 0xffffff, 0, 0xffffff)), range: bounded(value?.range, 8, 1, 30) };
}

export class RobotIllumination {
  readonly position = { value: new THREE.Vector3() };
  readonly brightness = { value: 0 };
  private color = { value: new THREE.Color() };
  private range = { value: 8 };
  private patched = new WeakMap<THREE.Material, { value: number }>();
  settings = { ...DEFAULT_ROBOT_LIGHT };
  set(value?: Partial<RobotLight>) {
    this.settings = robotLightSettings(value);
    this.color.value.setHex(this.settings.color);
    this.range.value = this.settings.range;
  }
  visibility(opacity: number) { this.brightness.value = this.settings.brightness * opacity; }

  /** Called after the flashlight patch, which supplies deformed world position/normal. */
  patch(material: THREE.Material, robot = false) {
    if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial)) return;
    const existing = this.patched.get(material);
    if (existing) { if (robot) existing.value = 1; return; }
    const surface = { value: robot ? 1 : 0 };
    this.patched.set(material, surface);
    const original = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      original(shader, renderer);
      Object.assign(shader.uniforms, { robotLightPosition: this.position, robotLightBrightness: this.brightness,
        robotLightColor: this.color, robotLightRange: this.range, robotLightSurface: surface });
      shader.fragmentShader = `
        uniform vec3 robotLightPosition;
        uniform vec3 robotLightColor;
        uniform float robotLightBrightness;
        uniform float robotLightRange;
        uniform float robotLightSurface;
        vec3 robotIllumination(vec3 p, vec3 n) {
          if (robotLightBrightness <= 0.0) return vec3(0.0);
          vec3 delta = robotLightPosition - p;
          float d = length(delta);
          float cutoff = pow(clamp(1.0 - pow(d / robotLightRange, 4.0), 0.0, 1.0), 2.0);
          return robotLightColor * robotLightBrightness * cutoff * max(dot(n, delta / max(d, 0.001)), 0.0)
            / max(d * d, 0.25);
        }
      ` + shader.fragmentShader.replace('#include <opaque_fragment>', `
        outgoingLight += mix(diffuseColor.rgb * robotIllumination(vFlashPosition, normalize(vFlashNormal)), vec3(0.0), robotLightSurface);
        #include <opaque_fragment>
      `);
    };
    material.customProgramCacheKey = () => key + '-robot-light-v1';
    material.needsUpdate = true;
  }
}
