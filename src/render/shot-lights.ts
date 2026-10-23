/** Non-destructive, unshadowed shot lighting in world metres (Z-up).
 * Preview uniforms and glTF punctual nodes share Three's physical light units. */
import * as THREE from 'three';
import { MAX_SHOT_LIGHTS, validShotLights, type ShotLight } from '../record/post';

// Independent of Three's light cache: never displace an authored Source light.
// Functions precede <common>, so use GLSL built-ins rather than Three's macros.
const declarations = `
  #define SOURCE_SHOT_LIGHTS
  struct ShotLightUniform {
    vec4 position;
    vec4 radiance;
    vec4 direction;
    float innerCosine;
  };
  uniform ShotLightUniform shotLights[${MAX_SHOT_LIGHTS}];
  uniform int shotLightCount;
  uniform float shotLightExposure;
  void sourceShotLight(int index, vec3 point, out vec3 direction, out vec3 radiance) {
    ShotLightUniform light = shotLights[index];
    direction = light.direction.xyz;
    float attenuation = 1.0;
    if (light.position.w < 2.5) {
      vec3 delta = light.position.xyz - point;
      float distanceSquared = dot(delta, delta);
      float distanceToLight = sqrt(distanceSquared);
      // A fragment at the emitter has no defined direction, but stays finite.
      direction = distanceToLight > 0.0 ? delta / distanceToLight : vec3(0.0, 0.0, 1.0);
      attenuation = 1.0 / max(distanceSquared, 0.01);
      if (light.radiance.w > 0.0) {
        float ratio = distanceToLight / light.radiance.w;
        float ratioSquared = ratio * ratio;
        float cutoff = clamp(1.0 - ratioSquared * ratioSquared, 0.0, 1.0);
        attenuation *= cutoff * cutoff;
      }
      if (light.position.w > 1.5) {
        float angleCosine = dot(direction, light.direction.xyz);
        // smoothstep with equal edges is undefined (penumbra = 0).
        attenuation *= light.innerCosine > light.direction.w
          ? smoothstep(light.direction.w, light.innerCosine, angleCosine)
          : step(light.direction.w, angleCosine);
      }
    }
    radiance = light.radiance.rgb * attenuation;
  }
  vec3 sourceShotDiffuse(vec3 point, vec3 normal) {
    vec3 irradiance = vec3(0.0);
    for (int i = 0; i < ${MAX_SHOT_LIGHTS}; i++) {
      if (i >= shotLightCount) break;
      vec3 direction, radiance;
      sourceShotLight(i, point, direction, radiance);
      irradiance += radiance * max(dot(normal, direction), 0.0);
    }
    return irradiance;
  }
`;

export class ShotLights {
  readonly count = { value: 0 };
  private snapshot: ShotLight[] = [];
  private readonly lights = { value: Array.from({ length: MAX_SHOT_LIGHTS }, () => ({
    position: new THREE.Vector4(), radiance: new THREE.Vector4(),
    direction: new THREE.Vector4(), innerCosine: 0,
  })) };
  private readonly color = new THREE.Color();
  private readonly direction = new THREE.Vector3();
  private readonly patched = new WeakSet<THREE.Material>();

  constructor(private readonly exposure: { value: number }) {}

  get(): ShotLight[] {
    return this.snapshot.map<ShotLight>(light => ({ ...light,
      position: [...light.position], target: [...light.target] }));
  }

  /** Only an intentional edit updates storage; rendering reuses all uniform objects. */
  set(lights: readonly ShotLight[]): void {
    if (!validShotLights(lights)) throw new Error('Invalid shot lights');
    this.snapshot = lights.map<ShotLight>(light => ({ ...light,
      position: [...light.position], target: [...light.target] }));
    let count = 0;
    for (const light of lights) {
      if (!light.enabled) continue;
      const uniform = this.lights.value[count++];
      uniform.position.set(...light.position, light.kind === 'point' ? 1 : light.kind === 'spot' ? 2 : 3);
      this.color.setHex(light.color).multiplyScalar(light.intensity);
      uniform.radiance.set(this.color.r, this.color.g, this.color.b, light.range);
      // Incoming direction: target -> emitter, matching Three's light uniforms.
      this.direction.set(light.position[0] - light.target[0], light.position[1] - light.target[1],
        light.position[2] - light.target[2]).normalize();
      const angle = THREE.MathUtils.degToRad(light.angle);
      uniform.direction.set(this.direction.x, this.direction.y, this.direction.z, Math.cos(angle));
      uniform.innerCosine = Math.cos(angle * (1 - light.penumbra));
    }
    this.count.value = count;
  }

  /** Install after SourceFlashlight/RobotIllumination (the Basic fallback uses
   * their deformed world varyings). Native effects consume the shared light
   * function inside sourceEffectShade instead, never the fallback as well. */
  patch(material: THREE.Material): void {
    if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial)
      || material.userData.sourceUnlit === true || material.userData.sourceMaterial?.unlit === true
      || this.patched.has(material)) return;
    this.patched.add(material);
    const original = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      original(shader, renderer);
      Object.assign(shader.uniforms, { shotLightCount: this.count, shotLights: this.lights,
        shotLightExposure: this.exposure });
      if (material instanceof THREE.MeshStandardMaterial) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', `
          #include <lights_fragment_begin>
          if (shotLightCount > 0) {
            vec3 shotWorldPosition = ((vec4(geometryPosition, 1.0) - viewMatrix[3]) * viewMatrix).xyz;
            for (int i = 0; i < ${MAX_SHOT_LIGHTS}; i++) {
              if (i >= shotLightCount) break;
              vec3 shotDirection, shotRadiance;
              sourceShotLight(i, shotWorldPosition, shotDirection, shotRadiance);
              IncidentLight shotLight;
              shotLight.color = shotRadiance;
              shotLight.direction = transformDirection(shotDirection, viewMatrix);
              shotLight.visible = true;
              RE_Direct(shotLight, geometryPosition, geometryNormal, geometryViewDir,
                geometryClearcoatNormal, material, reflectedLight);
            }
          }
        `);
      } else {
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
          #ifndef SOURCE_MATERIAL_EFFECTS
            if (shotLightCount > 0) {
              outgoingLight += diffuseColor.rgb * RECIPROCAL_PI * shotLightExposure
                * sourceShotDiffuse(vFlashPosition, normalize(vFlashNormal));
            }
          #endif
          #include <opaque_fragment>
        `);
      }
      shader.fragmentShader = declarations + shader.fragmentShader;
    };
    material.customProgramCacheKey = () => key + '-shot-lights-v1';
    material.needsUpdate = true;
  }
}

/** Real punctual nodes, not preview overlays. The export owner applies the
 * scene's Z-up -> Y-up conversion once around this otherwise unchanged group. */
export function shotLightObjects(lights: readonly ShotLight[]): THREE.Group {
  if (!validShotLights(lights)) throw new Error('Invalid shot lights');
  const group = new THREE.Group();
  group.name = 'Shot lights';
  group.up.set(0, 0, 1);
  for (const light of lights) {
    if (!light.enabled) continue;
    const object = light.kind === 'point'
      ? new THREE.PointLight(light.color, light.intensity, light.range, 2)
      : light.kind === 'spot'
        ? new THREE.SpotLight(light.color, light.intensity, light.range,
          THREE.MathUtils.degToRad(light.angle), light.penumbra, 2)
        : new THREE.DirectionalLight(light.color, light.intensity);
    object.name = THREE.PropertyBinding.sanitizeNodeName(light.name) || 'Shot light';
    object.userData.shotLightId = light.id;
    object.position.fromArray(light.position);
    object.up.set(0, 0, 1);
    object.castShadow = false;
    group.add(object);
    if (object instanceof THREE.SpotLight || object instanceof THREE.DirectionalLight) {
      object.lookAt(...light.target);
      // GLTFExporter encodes the local -Z axis, not Three's independent target.
      // Keeping the target here also preserves the actual aim in a Three scene.
      object.target.name = object.name + '_target';
      object.target.position.set(0, 0, -1);
      object.add(object.target);
    }
  }
  group.updateMatrixWorld(true);
  return group;
}
