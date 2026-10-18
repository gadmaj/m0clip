/** Source ambient-cube sampling, adapted from noclip.website Materials/WorldLight.ts
 * and Material_Generic.ts. Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';

export interface SourceAmbientData {
  origin: number[]; yaw: number; head: number;
  nodes: number[][]; leaves: number[][][];
  lights: SourceWorldLight[];
}

interface SourceWorldLight {
  pos: number[]; color: number[]; normal: number[]; kind: number; style: number;
  inner: number; outer: number; exponent: number; radius: number; attenuation: number[]; flags: number;
}

export class SourceAmbient {
  styleValue: (style: number) => number = () => 1;
  readonly enabled = { value: 0 };
  readonly cube = { value: Array.from({ length: 6 }, () => new THREE.Vector3()) };
  readonly rotation = { value: new THREE.Matrix3() };
  readonly exposure = { value: 1 };
  readonly linearOutput={value:0};
  private origin = { value: new THREE.Vector3() };
  private lights = Array.from({ length: 4 }, () => ({
    position: new THREE.Vector4(), color: new THREE.Vector4(),
    attenuation: new THREE.Vector4(), direction: new THREE.Vector4(),
  }));
  private data: SourceAmbientData | null = null;
  private patched = new WeakSet<THREE.Material>();

  setData(data: SourceAmbientData | null) {
    this.data = data;
    const yaw = (data?.yaw ?? 0) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    this.rotation.value.set(c, -s, 0, s, c, 0, 0, 0, 1);
    this.origin.value.fromArray(data?.origin ?? [0, 0, 0]);
  }

  get available() { return this.data !== null; }

  sample(x: number, y: number, z: number) {
    const d = this.data;
    if (!d) return;
    const p = new THREE.Vector3(x / 0.0254, y / 0.0254, z / 0.0254)
      .applyMatrix3(this.rotation.value).add(new THREE.Vector3(...d.origin as [number, number, number]));
    let leaf = d.head;
    while (leaf >= 0) {
      const n = d.nodes[leaf];
      leaf = n[p.x * n[0] + p.y * n[1] + p.z * n[2] >= n[3] ? 4 : 5];
    }
    const samples = d.leaves[-leaf - 1] ?? [];
    for (const v of this.cube.value) v.set(0, 0, 0);
    let total = 0;
    for (const sample of samples) {
      const distance2 = (sample[0] - p.x) ** 2 + (sample[1] - p.y) ** 2 + (sample[2] - p.z) ** 2;
      const weight = 1 / (distance2 + 1);
      total += weight;
      for (let i = 0; i < 6; i++) {
        const a = 3 + i * 3;
        this.cube.value[i].addScaledVector(new THREE.Vector3(sample[a], sample[a + 1], sample[a + 2]), weight);
      }
    }
    if (total > 0) for (const v of this.cube.value) v.multiplyScalar(1 / total);
    const best: { light: SourceWorldLight; strength: number }[] = [];
    const delta = new THREE.Vector3();
    const falloff = (l: SourceWorldLight) => {
      delta.fromArray(l.pos).sub(p);
      const distance = delta.length(), sq = distance * distance;
      if (l.kind === 3) return 0.1;
      if (l.kind === 5 || (l.radius > 0 && sq > l.radius * l.radius)) return 0;
      if (l.kind === 0) return 1 / Math.max(1, sq);
      if (l.kind === 4) return Math.max(0, l.attenuation[1] - distance);
      return 1 / Math.max(1e-12, l.attenuation[0] + distance * l.attenuation[1] + sq * l.attenuation[2]);
    };
    const addToAmbient = (l: SourceWorldLight) => {
      const ratio = falloff(l);
      delta.normalize();
      let angular = 1;
      const dot = -delta.dot(new THREE.Vector3().fromArray(l.normal));
      if (l.kind === 0 || l.kind === 3) angular = Math.max(0, dot);
      else if (l.kind === 2) angular = dot <= l.outer ? 0 : dot >= l.inner ? 1
        : ((dot - l.outer) / (l.inner - l.outer)) ** l.exponent;
      const color = new THREE.Vector3().fromArray(l.color).multiplyScalar(ratio * angular * this.styleValue(l.style));
      for (let i = 0; i < 6; i++) this.cube.value[i].addScaledVector(color,
        Math.max(0, delta.getComponent(i >> 1) * (i % 2 ? -1 : 1)));
    };
    // Source keeps the four strongest direct lights; lights ejected from its cache enter the cube.
    for (const light of d.lights ?? []) {
      if (samples.length && (light.flags & 1)) continue;
      const strength = falloff(light) * this.styleValue(light.style)
        * (0.299 * light.color[0] + 0.587 * light.color[1] + 0.114 * light.color[2]);
      if (strength <= 0) continue;
      const index = best.findIndex((entry) => strength > entry.strength);
      if (index < 0 && best.length === 4) continue;
      if (best.length === 4) addToAmbient(best.pop()!.light);
      best.splice(index < 0 ? best.length : index, 0, { light, strength });
    }
    for (let i = 0; i < 4; i++) {
      const u = this.lights[i], l = best[i]?.light;
      u.position.set(0, 0, 0, 0); u.color.set(0, 0, 0, 0);
      if (!l) continue;
      const kind = l.kind === 3 ? 3 : l.kind === 0 || l.kind === 2 ? 2 : 1;
      u.position.set(l.pos[0], l.pos[1], l.pos[2], kind);
      u.color.set(l.color[0], l.color[1], l.color[2], l.kind === 0 ? 0 : l.exponent);
      const style = this.styleValue(l.style);
      u.color.x *= style; u.color.y *= style; u.color.z *= style;
      u.attenuation.set(...l.attenuation as [number, number, number], l.inner);
      u.direction.set(...l.normal as [number, number, number], l.outer);
      if (l.kind === 0) { u.attenuation.set(0, 0, 1, 0); u.direction.set(0, 0, 0, 0); }
    }
  }

  patch(material: THREE.Material) {
    if (!(material instanceof THREE.MeshStandardMaterial) || this.patched.has(material)) return;
    this.patched.add(material);
    const original = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      original(shader, renderer);
      shader.uniforms.sourceAmbientEnabled = this.enabled;
      shader.uniforms.sourceAmbientCube = this.cube;
      shader.uniforms.sourceAmbientRotation = this.rotation;
      shader.uniforms.sourceOrigin = this.origin;
      shader.uniforms.sourceWorldLights = { value: this.lights };
      shader.uniforms.sourceExposure = this.exposure;
      shader.uniforms.sourceLinearOutput=this.linearOutput;
      shader.fragmentShader = `
        uniform float sourceAmbientEnabled;
        uniform vec3 sourceAmbientCube[6];
        uniform mat3 sourceAmbientRotation;
        uniform vec3 sourceOrigin;
        uniform float sourceExposure;
        uniform float sourceLinearOutput;
        struct SourceWorldLight { vec4 position; vec4 color; vec4 attenuation; vec4 direction; };
        uniform SourceWorldLight sourceWorldLights[4];
        vec3 sourceDirectLight(vec3 p, vec3 n) {
          vec3 result = vec3(0.0);
          for (int i = 0; i < 4; i++) {
            SourceWorldLight l = sourceWorldLights[i];
            if (l.position.w < 0.5) continue;
            vec3 delta = l.position.xyz - p;
            float distance = length(delta);
            vec3 direction = l.position.w > 2.5 ? -l.direction.xyz : normalize(delta);
            float attenuation = 1.0;
            if (l.position.w < 2.5) {
              attenuation = 1.0 / max(dot(l.attenuation.xyz, vec3(1.0, distance, distance * distance)), 1e-12);
              if (l.position.w > 1.5) {
                float angle = dot(l.direction.xyz, -direction);
                float cone = l.attenuation.w - l.direction.w;
                float t = cone == 0.0 ? (angle >= l.direction.w ? 1.0 : 0.01) : max((angle - l.direction.w) / cone, 0.01);
                attenuation *= clamp(pow(t, l.color.w), 0.0, 1.0);
              }
            }
            result += l.color.rgb * attenuation * max(dot(n, direction), 0.0);
          }
          return result;
        }
        vec3 sourceAmbientLight(vec3 n) {
          vec3 w = n * n;
          return w.x * (n.x < 0.0 ? sourceAmbientCube[1] : sourceAmbientCube[0])
               + w.y * (n.y < 0.0 ? sourceAmbientCube[3] : sourceAmbientCube[2])
               + w.z * (n.z < 0.0 ? sourceAmbientCube[5] : sourceAmbientCube[4]);
        }
      ` + shader.fragmentShader.replace('#include <lights_fragment_maps>', `
        if (sourceAmbientEnabled > 0.5) {
          vec3 sourceNormal = sourceAmbientRotation * inverseTransformDirection(geometryNormal, viewMatrix);
          vec3 worldPoint = ((vec4(geometryPosition, 1.0) - viewMatrix[3]) * viewMatrix).xyz;
          vec3 sourcePoint = sourceAmbientRotation * worldPoint / 0.0254 + sourceOrigin;
          irradiance = PI * (sourceAmbientLight(sourceNormal) + sourceDirectLight(sourcePoint, sourceNormal));
          iblIrradiance = vec3(0.0);
        }
        #include <lights_fragment_maps>
      `).replace('#include <tonemapping_fragment>', `
        if (sourceAmbientEnabled < 0.5) {
          #include <tonemapping_fragment>
        }
      `).replace('#include <colorspace_fragment>', `
        if (sourceAmbientEnabled > 0.5) {
          gl_FragColor.rgb *= sourceExposure;
          if(sourceLinearOutput<.5)gl_FragColor.rgb=pow(max(gl_FragColor.rgb,vec3(0.0)),vec3(1.0/2.2));
        } else {
          #include <colorspace_fragment>
        }
      `);
    };
    material.customProgramCacheKey = () => 'source-ambient-cube-v1';
    material.needsUpdate = true;
  }
}
