/** Ghost's Source material effects. Adapted from noclip.website Material_Generic.ts,
 * MaterialBase.ts and WorldLight.ts. Copyright (c) 2018 Jasper St. Pierre, MIT (LICENSE.noclip). */
import * as THREE from 'three';
import { sourceTextureControl,sourceTextureShader,SOURCE_TEXTURE_FALLBACK } from './source-textures';
import { MAX_SHOT_LIGHTS } from '../record/post';

type V = number[];
interface Light { pos: V; color: V; attenuation: V; kind: number; normal: V; exponent: number; inner: number; outer: number }
export interface PropLightCache { cube: V[]; lights: Light[] }
interface Metadata {
  [key: string]: unknown;
  phong: boolean; selfillum: boolean; unlit: boolean; halflambert: boolean; envmap: string;
  envmaptint: V; envmapcontrast: number; envmapsaturation: number; envmapfresnel: number; envmaplightscale: number;
  phongfresnelranges: V; phongtint: V; phongboost: number; phongexponent: number; phongexponentfactor: number;
  normalmapalphaenvmapmask: boolean; basealphaenvmapmask: boolean; basealphaphongmask: boolean;
  phongmaskinvert: boolean; phongalbedotint: boolean; phongalbedoboost: number; selfillumtint: V;
  detailscale?: number; detailblendfactor?: number; detailblendmode?: number;
  additive: boolean; scroll?: number[]; animationfps?: number;
}
export interface MaterialResources {
  detail?: THREE.Texture; base2?: THREE.Texture; normal?: THREE.Texture; mask?: THREE.Texture; exponent?: THREE.Texture; selfIllum?: THREE.Texture;
  frames?: THREE.Texture[]; lightmaps?: THREE.Texture[];
}
/** Each map request owns its resources and clock, including allocations that finish
 * after cancellation. Stale requests can never clear or animate the current map. */
export class SourceMaterials {
  readonly time={value:0};
  private resources=new Set<{dispose():void}>();
  private animated:{material:THREE.MeshBasicMaterial;frames:THREE.Texture[];fps:number}[]=[];
  private disposed=false;
  private released=new WeakSet<object>();
  private release(resource:{dispose():void}){if(!this.released.has(resource)){this.released.add(resource);resource.dispose();}}
  own<T extends {dispose():void}>(resource:T):T {
    // GLTFLoader resolves failed optional image dependencies as null. Reject
    // that result before it can interrupt disposal of the remaining resources.
    if(!resource||typeof resource.dispose!=='function')throw new Error('A Source map resource failed to load. Retry the map download.');
    if(this.disposed)this.release(resource);else this.resources.add(resource);
    return resource;
  }
  discard(resource:{dispose():void}){if(this.resources.delete(resource))this.release(resource);}
  animate(material:THREE.MeshBasicMaterial,frames:THREE.Texture[],fps:number){if(!this.disposed)this.animated.push({material,frames,fps});}
  update(time:number){
    if(this.disposed)return;
    this.time.value=time;
    for(const entry of this.animated)entry.material.map=entry.frames[Math.floor(time*entry.fps)%entry.frames.length];
  }
  clear(){this.animated.length=0;for(const resource of this.resources){if(this.disposed)this.release(resource);else resource.dispose();}this.resources.clear();}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();}
}
const defaultMaterials=new SourceMaterials();
export const sourceMaterialTime=defaultMaterials.time;
export const updateSourceMaterials=(time:number)=>defaultMaterials.update(time);
export const clearSourceMaterials=()=>defaultMaterials.clear();
const vec = (v?: number[], fallback = [1, 1, 1]) => new THREE.Vector3().fromArray(v ?? fallback);

export function patchSourceMaterial(material: THREE.MeshBasicMaterial, original: THREE.MeshStandardMaterial,
  resources: MaterialResources, cache?: PropLightCache, cube?: THREE.CubeTexture, origin?: number[], yaw = 0, hasTangent = false,context=defaultMaterials) {
  const meta = original.userData.sourceMaterial as Metadata | undefined;
  if (!meta) return;
  // Legacy cutout imports marked all masked surfaces double-sided. Source's
  // $nocull flag controls this independently of alpha testing, in both looks.
  if (typeof meta.nocull === 'boolean') {
    const side = meta.nocull ? THREE.DoubleSide : THREE.FrontSide;
    for (const entry of [material, original]) if (entry.side !== side) {
      entry.side = side;
      entry.needsUpdate = true;
    }
  }
  sourceTextureControl(material);
  const props = !!cache;
  for (const texture of [resources.detail, resources.base2, resources.normal, resources.mask, resources.exponent, resources.selfIllum, cube,
      ...(resources.frames ?? []), ...(resources.lightmaps ?? [])]) if (texture) context.own(texture);
  if (props) material.vertexColors = false;
  else if (meta.shader === 'worldvertextransition') material.vertexColors = true;
  // Make Three expose authored tangents to this Basic-material shader when present.
  const custom = material as THREE.MeshBasicMaterial & { defines?: Record<string, string> };
  if (hasTangent) custom.defines = { ...custom.defines, USE_TANGENT: '' };
  if (meta.additive) { material.blending = THREE.AdditiveBlending; material.depthWrite = false; }
  if (resources.frames?.length && meta.animationfps) context.animate(material, resources.frames, meta.animationfps);
  const r = THREE.MathUtils.degToRad(yaw), c = Math.cos(r), s = Math.sin(r);
  const rotation = new THREE.Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
  const lights = Array.from({ length: 4 }, (_, i) => {
    const l = cache?.lights[i];
    return { position: new THREE.Vector4(...(l ? [...l.pos, l.kind === 3 ? 3 : l.kind === 2 || l.kind === 0 ? 2 : 1] : [0, 0, 0, 0]) as [number, number, number, number]),
      color: new THREE.Vector4(...(l ? [...l.color, l.kind === 0 ? 0 : l.exponent] : [0, 0, 0, 0]) as [number, number, number, number]),
      attenuation: new THREE.Vector4(...(l ? [...(l.kind === 0 ? [0, 0, 1] : l.attenuation), l.kind === 0 ? 0 : l.inner] : [1, 0, 0, 0]) as [number, number, number, number]),
      direction: new THREE.Vector4(...(l ? [...l.normal, l.kind === 0 ? 0 : l.outer] : [0, 0, 0, 0]) as [number, number, number, number]) };
  });
  const flag = (v: unknown) => v ? 'true' : 'false';
  const previous = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    sourceTextureShader(material,shader);
    Object.assign(shader.uniforms, {
      sourceEffectTime: context.time, sourceEffectScroll: { value: new THREE.Vector2(...(meta.scroll ?? [0, 0]) as [number, number]) },
      sourceEffectDetail: { value: resources.detail },
      sourceEffectDetailParams: { value: new THREE.Vector2(meta.detailscale ?? 4, meta.detailblendfactor ?? 1) },
      sourceEffectBase2: { value: resources.base2 }, sourceEffectNormal: { value: resources.normal }, sourceEffectMask: { value: resources.mask },
      sourceEffectExponent: { value: resources.exponent }, sourceEffectSelfIllum: { value: resources.selfIllum },
      sourceEffectBumpLight0: { value: resources.lightmaps?.[0] }, sourceEffectBumpLight1: { value: resources.lightmaps?.[1] }, sourceEffectBumpLight2: { value: resources.lightmaps?.[2] },
      sourceEffectCube: { value: cube }, sourceEffectRotation: { value: rotation }, sourceEffectOrigin: { value: vec(origin, [0, 0, 0]) },
      sourceEffectAmbient: { value: (cache?.cube ?? Array.from({ length: 6 }, () => [0, 0, 0])).map(v => vec(v)) },
      sourceEffectLights: { value: lights }, sourceEffectEnvTint: { value: vec(meta.envmaptint) },
      sourceEffectFresnel: { value: vec(meta.phongfresnelranges, [0, .5, 1]) },
      sourceEffectPhongTint: { value: vec(meta.phongtint) }, sourceEffectEmissiveTint: { value: vec(meta.selfillumtint) },
      sourceEffectSpecParams: { value: new THREE.Vector4(meta.phongexponent ?? 5, meta.phongexponentfactor ?? 149, meta.phongboost ?? 1, meta.phongalbedoboost ?? 1) },
      sourceEffectEnvParams: { value: new THREE.Vector4(meta.envmapcontrast ?? 0, meta.envmapsaturation ?? 1, meta.envmapfresnel ?? 1, meta.envmaplightscale ?? 0) },
    });
    const declarations = `varying vec3 vSourceEffectVertexLight; varying vec4 vSourceEffectLightAttenuation; varying vec2 vSourceEffectLightUv; varying vec3 vSourceEffectPosition; varying vec3 vSourceEffectNormal;
      varying vec3 vSourceEffectTangent; varying vec3 vSourceEffectBitangent; varying vec2 vSourceEffectUv;\n`;
    const lightingUniforms = `
      uniform mat3 sourceEffectRotation; uniform vec3 sourceEffectOrigin;
      uniform vec3 sourceEffectAmbient[6];
      struct SourceEffectLight { vec4 position; vec4 color; vec4 attenuation; vec4 direction; };
      uniform SourceEffectLight sourceEffectLights[4];
    `;
    const vertexLighting = `
      // noclip's WorldLightCalcAllAttenuation runs in the vertex shader for
      // diffuse Skin/Phong lighting. Specular keeps its per-pixel attenuation.
      vec4 sourceVertexAttenuation(vec3 point) {
        vec3 p = sourceEffectRotation * point / 0.0254 + sourceEffectOrigin;
        vec4 result = vec4(1.0);
        for (int i = 0; i < 4; i++) {
          SourceEffectLight l = sourceEffectLights[i];
          if (l.position.w < 0.5 || l.position.w > 2.5) continue;
          vec3 delta = l.position.xyz - p;
          float distance = length(delta);
          float attenuation = 1.0 / max(dot(l.attenuation.xyz, vec3(1.0, distance, distance * distance)), 1e-12);
          if (l.position.w > 1.5) {
            float cone = l.attenuation.w - l.direction.w;
            float angle = dot(l.direction.xyz, -normalize(delta));
            float t = cone == 0.0 ? (angle >= l.direction.w ? 1.0 : 0.01) : max((angle - l.direction.w) / cone, 0.01);
            attenuation *= clamp(pow(t, l.color.w), 0.0, 1.0);
          }
          result[i] = attenuation;
        }
        return result;
      }
      vec3 sourceVertexDiffuse(vec3 point, vec3 normal) {
        vec3 n = sourceEffectRotation * normal;
        vec3 p = sourceEffectRotation * point / 0.0254 + sourceEffectOrigin;
        vec3 w = n * n;
        vec3 lighting = w.x * (n.x < 0.0 ? sourceEffectAmbient[1] : sourceEffectAmbient[0])
          + w.y * (n.y < 0.0 ? sourceEffectAmbient[3] : sourceEffectAmbient[2])
          + w.z * (n.z < 0.0 ? sourceEffectAmbient[5] : sourceEffectAmbient[4]);
        for (int i = 0; i < 4; i++) {
          SourceEffectLight l = sourceEffectLights[i];
          if (l.position.w < 0.5) continue;
          vec3 delta = l.position.xyz - p;
          float distance = length(delta);
          vec3 dir = l.position.w > 2.5 ? -l.direction.xyz : normalize(delta);
          float attenuation = 1.0;
          if (l.position.w < 2.5) {
            attenuation = 1.0 / max(dot(l.attenuation.xyz, vec3(1.0, distance, distance * distance)), 1e-12);
            if (l.position.w > 1.5) {
              float cone = l.attenuation.w - l.direction.w;
              float angle = cone == 0.0 ? (dot(l.direction.xyz, -dir) >= l.direction.w ? 1.0 : 0.01) : max((dot(l.direction.xyz, -dir) - l.direction.w) / cone, 0.01);
              attenuation *= clamp(pow(angle, l.color.w), 0.0, 1.0);
            }
          }
          float lambert = dot(n, dir);
          lambert = ${flag(meta.halflambert)} ? pow(lambert * 0.5 + 0.5, 2.0) : max(lambert, 0.0);
          lighting += l.color.rgb * attenuation * lambert;
        }
        return lighting;
      }
    `;
    shader.vertexShader = declarations + lightingUniforms + vertexLighting + shader.vertexShader.replace('#include <skinning_vertex>', `
      #include <skinning_vertex>
      vSourceEffectPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #ifdef USE_SKINNING
        vSourceEffectNormal = normalize(mat3(modelMatrix) * objectNormal);
      #else
        vSourceEffectNormal = normalize(mat3(modelMatrix) * normal);
      #endif
      #ifdef USE_TANGENT
        #ifdef USE_SKINNING
          vSourceEffectTangent = normalize(mat3(modelMatrix) * objectTangent);
        #else
          vSourceEffectTangent = normalize(mat3(modelMatrix) * tangent.xyz);
        #endif
        vSourceEffectBitangent = cross(vSourceEffectNormal, vSourceEffectTangent) * tangent.w;
      #else
        vSourceEffectTangent = vec3(0.0); vSourceEffectBitangent = vec3(0.0);
      #endif
      vSourceEffectUv = uv;
      #ifdef USE_UV1
        vSourceEffectLightUv = uv1;
      #else
        vSourceEffectLightUv = vec2(0.0);
      #endif
      vSourceEffectLightAttenuation = sourceVertexAttenuation(vSourceEffectPosition);
      vSourceEffectVertexLight = sourceVertexDiffuse(vSourceEffectPosition, vSourceEffectNormal);
    `);
    // Keep the normal/mask UVs independent of the animated base-texture transform.
    shader.fragmentShader = shader.fragmentShader.replace(SOURCE_TEXTURE_FALLBACK,'').replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = sourceDiffuseSample(texture2D(map, vMapUv + sourceEffectScroll * sourceEffectTime));
        // Source retains the primary sample for reflection/Phong/glow masks,
        // while secondary textures and detail blending modify the albedo.
        float sourceBaseTextureAlpha = sampledDiffuseColor.a;
        #ifdef USE_COLOR_ALPHA
          if (${flag(resources.base2)}) sampledDiffuseColor = mix(sampledDiffuseColor, sourceDiffuseSample(texture2D(sourceEffectBase2, vMapUv)), vColor.a);
        #endif
        // Ghost uses Source MulDetail2 (mode 0). Detail samples stay linear:
        // a 0.5 texel leaves the base unchanged, independent of scene lighting.
        if (${flag(resources.detail)}) sampledDiffuseColor *= mix(vec4(1.0),
          sourceDiffuseSample(texture2D(sourceEffectDetail, vSourceEffectUv * sourceEffectDetailParams.x)) * 2.0, sourceEffectDetailParams.y);
        diffuseColor *= sampledDiffuseColor;
      #endif
    `);
    shader.fragmentShader = shader.fragmentShader.replace('uniform float sourceExposure;', '');
    shader.fragmentShader = '#define SOURCE_MATERIAL_EFFECTS\n' + declarations + `
      uniform float sourceExposure;
      uniform float sourceEffectTime; uniform vec2 sourceEffectScroll;
      uniform sampler2D sourceEffectDetail; uniform vec2 sourceEffectDetailParams;
      uniform sampler2D sourceEffectBase2, sourceEffectNormal, sourceEffectMask, sourceEffectExponent, sourceEffectSelfIllum;
      uniform samplerCube sourceEffectCube;
      uniform sampler2D sourceEffectBumpLight0, sourceEffectBumpLight1, sourceEffectBumpLight2;
      uniform mat3 sourceEffectRotation; uniform vec3 sourceEffectOrigin;
      uniform vec3 sourceEffectAmbient[6];
      struct SourceEffectLight { vec4 position; vec4 color; vec4 attenuation; vec4 direction; };
      uniform SourceEffectLight sourceEffectLights[4];
      uniform vec3 sourceEffectEnvTint, sourceEffectFresnel, sourceEffectPhongTint, sourceEffectEmissiveTint;
      uniform vec4 sourceEffectSpecParams, sourceEffectEnvParams;
      vec3 sourceEffectShade(vec3 albedo, float baseAlpha, vec3 baked) {
        // Source keeps the interpolated basis and decoded bump-vector length.
        // Renormalizing here changes ambient weights, Fresnel and Phong power.
        vec3 n = vSourceEffectNormal;
        vec4 bump = vec4(0.5, 0.5, 1.0, 1.0);
        if (${flag(resources.normal)}) {
          bump = texture2D(sourceEffectNormal, vSourceEffectUv);
          vec3 t = vSourceEffectTangent, b = vSourceEffectBitangent;
          if (dot(t, t) < 0.1) {
            vec3 q1 = dFdx(vSourceEffectPosition), q2 = dFdy(vSourceEffectPosition);
            vec2 st1 = dFdx(vSourceEffectUv), st2 = dFdy(vSourceEffectUv);
            float signUv = st1.x * st2.y - st1.y * st2.x < 0.0 ? -1.0 : 1.0;
            t = normalize(q1 * st2.y - q2 * st1.y) * signUv;
            b = normalize(-q1 * st2.x + q2 * st1.x) * signUv;
          }
          vec3 tn = bump.rgb * 2.0 - 1.0;
          if (${flag(meta.ssbump)}) tn = normalize(vec3(0.86602540, 0.0, 0.57735027) * bump.r
            + vec3(-0.40824829, 0.70710678, 0.57735027) * bump.g + vec3(-0.40824829, -0.70710678, 0.57735027) * bump.b);
          n = t * tn.x + b * tn.y + n * tn.z;
        }
        vec3 sn = sourceEffectRotation * n;
        vec3 p = sourceEffectRotation * vSourceEffectPosition / 0.0254 + sourceEffectOrigin;
        vec3 eye = normalize(cameraPosition - vSourceEffectPosition);
        // noclip's CalcReflection also works for nonunit interpolated normals.
        vec3 reflected = 2.0 * dot(n, eye) * n - dot(n, n) * eye;
        float fresnel = pow(1.0 - max(0.0, dot(n, eye)), 2.0);
        if (${flag(meta.phong)}) fresnel = fresnel <= 0.5 ? mix(sourceEffectFresnel.x, sourceEffectFresnel.y, fresnel * 2.0)
          : mix(sourceEffectFresnel.y, sourceEffectFresnel.z, (fresnel - 0.5) * 2.0);
        vec3 lighting = vec3(0.0), specular = vec3(0.0);
        float exponent = sourceEffectSpecParams.x;
        vec4 specMap = vec4(0.0);
        if (${flag(resources.exponent)}) {
          specMap = texture2D(sourceEffectExponent, vSourceEffectUv);
          exponent = 1.0 + sourceEffectSpecParams.y * specMap.r;
        }
        if (${flag(props)}) {
          vec3 weights = sn * sn;
          lighting = weights.x * (sn.x < 0.0 ? sourceEffectAmbient[1] : sourceEffectAmbient[0])
            + weights.y * (sn.y < 0.0 ? sourceEffectAmbient[3] : sourceEffectAmbient[2])
            + weights.z * (sn.z < 0.0 ? sourceEffectAmbient[5] : sourceEffectAmbient[4]);
          for (int i = 0; i < 4; i++) {
            SourceEffectLight l = sourceEffectLights[i];
            if (l.position.w < 0.5) continue;
            vec3 delta = l.position.xyz - p;
            float distance = length(delta);
            vec3 direction = l.position.w > 2.5 ? -l.direction.xyz : normalize(delta);
            float attenuation = 1.0;
            if (l.position.w < 2.5) {
              attenuation = 1.0 / max(dot(l.attenuation.xyz, vec3(1.0, distance, distance * distance)), 1e-12);
              if (l.position.w > 1.5) {
                float cone = l.attenuation.w - l.direction.w;
                float angle = cone == 0.0 ? (dot(l.direction.xyz, -direction) >= l.direction.w ? 1.0 : 0.01) : max((dot(l.direction.xyz, -direction) - l.direction.w) / cone, 0.01);
                attenuation *= clamp(pow(angle, l.color.w), 0.0, 1.0);
              }
            }
            float lambert = dot(sn, direction);
            lambert = ${flag(meta.halflambert)} ? pow(lambert * 0.5 + 0.5, 2.0) : max(lambert, 0.0);
            lighting += l.color.rgb * vSourceEffectLightAttenuation[i] * lambert;
            if (${flag(meta.phong)}) specular += l.color.rgb * attenuation
              * clamp(dot(sn, direction), 0.0, 1.0) * pow(clamp(dot(sourceEffectRotation * reflected, direction), 0.0, 1.0), exponent) * fresnel;
          }
        }
        if (${flag(props && !meta.phong)}) lighting = vSourceEffectVertexLight;
        vec3 result = ${flag(props)} ? albedo * (${flag(meta.unlit)} ? vec3(1.0) : lighting) * sourceExposure : baked;
        if (${flag(resources.lightmaps?.length === 3 && !meta.nodiffusebumplighting)}) {
          vec3 tn = bump.rgb * 2.0 - 1.0;
          vec3 influence = ${flag(meta.ssbump)} ? bump.rgb : clamp(vec3(
            dot(tn, vec3(0.86602540, 0.0, 0.57735027)),
            dot(tn, vec3(-0.40824829, 0.70710678, 0.57735027)),
            dot(tn, vec3(-0.40824829, -0.70710678, 0.57735027))), vec3(0.0), vec3(1.0));
          vec4 a = texture2D(sourceEffectBumpLight0, vSourceEffectLightUv);
          vec4 b = texture2D(sourceEffectBumpLight1, vSourceEffectLightUv);
          vec4 c = texture2D(sourceEffectBumpLight2, vSourceEffectLightUv);
          lighting = (a.rgb * a.a * influence.x + b.rgb * b.a * influence.y + c.rgb * c.a * influence.z) * 6.0;
          result = albedo * lighting * sourceExposure;
        }
        // Projected lighting uses the same bumped normal as the baked surface.
        // noclip adds its diffuse term before self-illumination, and its Phong
        // term before applying the authored specular mask/tint (without Fresnel).
        #ifdef SOURCE_FLASHLIGHT
          if (${flag(!meta.unlit)}) {
            vec3 projectedLight = sourceFlashlight(vSourceEffectPosition, n);
            result += albedo * projectedLight * sourceExposure;
            if (${flag(meta.phong)} && any(greaterThan(projectedLight, vec3(0.0)))) {
              vec3 lightDirection = normalize(flashlightPosition - vSourceEffectPosition);
              specular += projectedLight * pow(clamp(dot(reflected, lightDirection), 0.0, 1.0), exponent);
            }
          }
        #endif
        // Shot lights are physical world-space sources, independent of the
        // authored four-light cache. Use the decoded bump normal and keep their
        // Phong term inside the same authored mask/tint and exposure pipeline.
        #ifdef SOURCE_SHOT_LIGHTS
          if (${flag(!meta.unlit)} && shotLightCount > 0) {
            for (int i = 0; i < ${MAX_SHOT_LIGHTS}; i++) {
              if (i >= shotLightCount) break;
              vec3 shotDirection, shotRadiance;
              sourceShotLight(i, vSourceEffectPosition, shotDirection, shotRadiance);
              float shotLambert = max(dot(n, shotDirection), 0.0);
              result += albedo * shotRadiance * shotLambert * 0.3183098861837907 * sourceExposure;
              if (${flag(meta.phong)}) {
                specular += shotRadiance * shotLambert
                  * pow(clamp(dot(reflected, shotDirection), 0.0, 1.0), exponent) * fresnel;
              }
            }
          }
        #endif
        if (${flag(meta.phong)}) {
          float specMask = ${flag(meta.basealphaphongmask)} ? baseAlpha : bump.a;
          if (${flag(meta.phongmaskinvert)}) specMask = 1.0 - specMask;
          vec3 tint = vec3(sourceEffectSpecParams.z);
          if (${flag(meta.phongalbedotint)}) tint = mix(tint, albedo * sourceEffectSpecParams.w, specMap.g);
          else tint *= sourceEffectPhongTint;
          specular *= tint * specMask;
        }
        if (${flag(meta.selfillum)}) {
          vec3 mask = ${resources.selfIllum ? 'texture2D(sourceEffectSelfIllum, vSourceEffectUv).rgb' : 'vec3(baseAlpha)'};
          result = mix(result, albedo * sourceEffectEmissiveTint * sourceExposure, mask);
        }
        if (${flag(cube && meta.envmap)}) {
          vec3 env = textureCube(sourceEffectCube, sourceEffectRotation * reflected).rgb * sourceEffectEnvTint;
          if (${flag(resources.mask)}) env *= texture2D(sourceEffectMask, vSourceEffectUv).rgb;
          if (${flag(meta.normalmapalphaenvmapmask)}) env *= bump.a;
          if (${flag(meta.basealphaenvmapmask)}) env *= 1.0 - baseAlpha;
          env *= mix(vec3(1.0), clamp(lighting, 0.0, 1.0), sourceEffectEnvParams.w);
          env = mix(env, env * env, sourceEffectEnvParams.x);
          env = mix(vec3(dot(env, vec3(0.299, 0.587, 0.114))), env, sourceEffectEnvParams.y);
          env *= mix(fresnel, 1.0, sourceEffectEnvParams.z);
          result += env * sourceExposure;
        }
        return result + specular * sourceExposure;
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      #ifdef USE_MAP
        outgoingLight = sourceEffectShade(diffuseColor.rgb, sourceBaseTextureAlpha, outgoingLight);
      #else
        outgoingLight = sourceEffectShade(diffuseColor.rgb, 1.0, outgoingLight);
      #endif
      #include <opaque_fragment>
    `);
  };
  const features = [!!resources.detail, props, hasTangent, !!resources.base2, !!(cube && meta.envmap), !!resources.normal, !!resources.mask,
    !!resources.exponent, !!resources.selfIllum, resources.lightmaps?.length === 3,
    meta.unlit, meta.phong, meta.selfillum, meta.halflambert, meta.ssbump, meta.nodiffusebumplighting,
    meta.basealphaphongmask, meta.phongmaskinvert, meta.phongalbedotint, meta.normalmapalphaenvmapmask, meta.basealphaenvmapmask].map(Boolean);
  material.customProgramCacheKey = () => `${key}-source-effects-v10-${features.map(Number).join('')}`;
  material.needsUpdate = true;
}
