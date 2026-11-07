/** Ghost's Source material effects. Adapted from noclip.website Material_Generic.ts,
 * MaterialBase.ts and WorldLight.ts. Copyright (c) 2018 Jasper St. Pierre, MIT (LICENSE.noclip). */
import * as THREE from 'three';
import { sourceTextureControl,sourceTextureShader,SOURCE_TEXTURE_FALLBACK } from './source-textures';
import { MAX_SHOT_LIGHTS } from '../record/post';
import { SourceTemporalProxyState, type SourceTemporalProxies } from './source-material-proxies';
import type { GLTFExporterPlugin, GLTFWriter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { losslessExportSource } from '../record/lossless-textures';


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
  temporalProxies?: SourceTemporalProxies;
}
export interface MaterialResources {
  detail?: THREE.Texture; base2?: THREE.Texture; normal?: THREE.Texture; mask?: THREE.Texture; exponent?: THREE.Texture; selfIllum?: THREE.Texture;
  frames?: THREE.Texture[]; lightmaps?: THREE.Texture[];
}

/** `fixed`: an authored static $basetexturetransform, not a proxy-driven matrix. */
interface TemporalTransformPatch { uniform: { value: THREE.Matrix3 }; owner?: object; fixed?: boolean }

const temporalTransformPatches = new WeakMap<THREE.Material, TemporalTransformPatch>();

const inactiveTemporalTransform = new THREE.Matrix3();

/** Wrap once with ONE stable uniform per target material. Three calls
 * onBeforeCompile once per material/program key, so a rebind cannot install a
 * new uniform object; the getter follows whichever patch the material holds.
 * Source samples $bumpmap at the base coordinates in every generic shader
 * (SDK 2013 vertexlit_and_unlit_generic_bump_ps2x.fxc:166, skin_ps20b.fxc:190,
 * common_lightmappedgeneric_fxc.h GetBaseTextureAndNormal), so a Studio
 * material's normal map follows the same matrix as its base map. */
function installTemporalTransform(material: THREE.Material, patch: TemporalTransformPatch) {
  const installed = temporalTransformPatches.has(material);
  temporalTransformPatches.set(material, patch);
  if (installed) return;
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey();
  const live = { get value() { return temporalTransformPatches.get(material)!.uniform.value; } };
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.sourceProxyBaseTransform = live;
    shader.vertexShader = 'uniform mat3 sourceProxyBaseTransform;\n' + shader.vertexShader.replace('#include <uv_vertex>',
      '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = (sourceProxyBaseTransform * vec3(uv, 1.0)).xy;\n#endif'
      + '\n#ifdef USE_NORMALMAP\nvNormalMapUv = (sourceProxyBaseTransform * vec3(uv, 1.0)).xy;\n#endif');
  };
  material.customProgramCacheKey = () => key + '|source-temporal-base-transform';
  material.needsUpdate = true;
}

/** Depth cutouts share the owning material's live transform, including clear/rebind. */
export function copySourceTemporalTransform(from: THREE.Material, to: THREE.Material) {
  const patch = temporalTransformPatches.get(from);
  if (patch && temporalTransformPatches.get(to) !== patch) installTemporalTransform(to, patch);
}

/** Three's shadow pass (WebGLShadowMap.getDepthMaterial) gives a map/alphaMap
 * cutout or alpha-to-coverage material its OWN cached depth/distance material,
 * keyed by material uuid, and copies the live map and alphaTest into it before
 * every draw, so AnimatedTexture frames already reach shadows. The proxy UV
 * transform is a shader uniform it cannot see: share it with that private copy
 * immediately before the draw. Any other depth material is Three's shared one,
 * where UVs cannot change the silhouette and must never be patched. */
const sourceTemporalShadow: THREE.Object3D['onBeforeShadow'] = function (this: THREE.Object3D,
  _renderer, _scene, _camera, _shadowCamera, _geometry, depthMaterial, group) {
  const material = (this as THREE.Mesh).material;
  const selected = (Array.isArray(material)
    ? material[(group as unknown as THREE.GeometryGroup).materialIndex ?? 0] : material) as THREE.MeshStandardMaterial;
  if (selected && ((selected.map || selected.alphaMap) && selected.alphaTest > 0 || selected.alphaToCoverage))
    copySourceTemporalTransform(selected, depthMaterial);
};

/** Install the shadow hook on a map mesh whose displayable materials (every
 * lighting variant) include a base UV transform. Mesh-level custom depth or
 * distance materials are shared by all of a mesh's materials, so a transformed
 * cutout there is refused rather than drawn with an untransformed shadow. An
 * opaque silhouette does not depend on UVs and needs no hook. */
export function bindSourceTemporalShadows(mesh: THREE.Mesh, materials: readonly THREE.Material[]): void {
  const transformed = materials.filter(material => temporalTransformPatches.has(material));
  if (!transformed.length) return;
  if (mesh.onBeforeShadow === sourceTemporalShadow) return;
  if (mesh.customDepthMaterial || mesh.customDistanceMaterial || mesh.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow) {
    const cutout = transformed.some(material => {
      const m = material as THREE.MeshStandardMaterial;
      return (m.map || m.alphaMap) && m.alphaTest > 0 || m.alphaToCoverage;
    });
    if (!cutout) return;
    throw new Error('Source base-transformed cutout material cannot share a custom shadow material or shadow hook');
  }
  mesh.onBeforeShadow = sourceTemporalShadow;
}

const KHR_TEXTURE_TRANSFORM = 'KHR_texture_transform';
/** Live authored static base matrix of a displayed material, or of the live material a
 * lossless export copy stands for (TextureScroll's time-varying matrix is not a static
 * texture transform and is excluded). */
function sourceStaticBaseTransform(material: THREE.Material): THREE.Matrix3 | undefined {
  const patch = temporalTransformPatches.get(losslessExportSource(material));
  return patch?.fixed && patch.owner ? patch.uniform.value : undefined;
}

/** Register with exporter.register(sourceBaseTransformWriter). Writes the exact
 * static base matrix the renderer applies (base map and, on Studio materials, the
 * normal map) as standard KHR_texture_transform (spec order T(offset)·R(rotation)·S(scale),
 * R = [cos sin; -sin cos]). The renderer's base matrix replaces any Three texture
 * offset/repeat, so it also replaces the exporter's texture-level transform. Source's
 * R(θ)·S matrices never shear; a non-decomposable matrix is refused, not approximated. */
export function sourceBaseTransformWriter(writer: GLTFWriter): GLTFExporterPlugin {
  type Info = { extensions?: Record<string, unknown> } | undefined;
  return {
    async writeMaterialAsync(material, definition) {
      const matrix = sourceStaticBaseTransform(material);
      if (!matrix) return;
      const infos = [(definition.pbrMetallicRoughness as { baseColorTexture?: Info } | undefined)?.baseColorTexture,
        definition.normalTexture as Info].filter((info): info is NonNullable<Info> => info !== undefined);
      if (!infos.length) return;
      const e = matrix.elements, m00 = e[0], m10 = e[1], m01 = e[3], m11 = e[4];
      const sx = Math.hypot(m00, m10);
      let rotation: number, sy: number;
      if (sx > 0) { rotation = Math.atan2(-m10, m00); sy = m01 * Math.sin(rotation) + m11 * Math.cos(rotation); }
      else { rotation = Math.atan2(m01, m11); sy = Math.hypot(m01, m11); }
      const c = Math.cos(rotation), s = Math.sin(rotation), scale = Math.max(1, Math.abs(m00), Math.abs(m10), Math.abs(m01), Math.abs(m11));
      if (Math.max(Math.abs(c * sx - m00), Math.abs(-s * sx - m10), Math.abs(s * sy - m01), Math.abs(c * sy - m11)) > 1e-6 * scale)
        throw new Error('A Source base texture transform cannot be represented as KHR_texture_transform');
      for (const info of infos) {
        info.extensions ??= {};
        info.extensions[KHR_TEXTURE_TRANSFORM] = { offset: [e[6], e[7]], rotation, scale: [sx, sy] };
      }
      writer.extensionsUsed[KHR_TEXTURE_TRANSFORM] = true;
    },
  };
}

/** Authored row-major static $basetexturetransform from sourceMaterial metadata
 * (raw exporter and converter share this key), when it changes base UVs. */
function staticBaseTransform(meta: Metadata): readonly number[] | undefined {
  const value = meta.basetexturetransform;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 9 || !value.every(Number.isFinite) || value[6] !== 0 || value[7] !== 0 || value[8] !== 1)
    throw new Error('Invalid Source base texture transform metadata');
  return value.every((v, i) => v === (i % 4 === 0 ? 1 : 0)) ? undefined : value;
}
/** Each map request owns its resources and clock, including allocations that finish
 * after cancellation. Stale requests can never clear or animate the current map. */
export class SourceMaterials {
  readonly time={value:0};
  private resources=new Set<{dispose():void}>();
  private animated:{material:THREE.MeshBasicMaterial;frames:THREE.Texture[];fps:number}[]=[];
  
private temporal: { state: SourceTemporalProxyState; matrix: THREE.Matrix3;
    original: THREE.MeshStandardMaterial; frames: THREE.Texture[]; transforms: boolean;
    sources: { material: THREE.MeshBasicMaterial; frames: THREE.Texture[] }[];
    registered: WeakSet<THREE.MeshBasicMaterial> }[] = [];

private temporalOriginals = new WeakMap<THREE.MeshStandardMaterial, SourceMaterials['temporal'][number]>();

private baseTransforms = new WeakMap<THREE.MeshStandardMaterial, THREE.Matrix3>();

private temporalTransformOwners: { patch: TemporalTransformPatch; owner: object }[] = [];
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
  
private patchTemporalTransform(material: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial, matrix: THREE.Matrix3, fixed = false) {
    let patch = temporalTransformPatches.get(material);
    if (!patch) {
      patch = { uniform: { value: inactiveTemporalTransform } };
      installTemporalTransform(material, patch);
    }
    const owner = {};
    patch.owner = owner;
    patch.fixed = fixed;
    patch.uniform.value = matrix;
    this.temporalTransformOwners.push({ patch, owner });
  }

/** Authored static $basetexturetransform: the same base UV binding as TextureScroll,
 * shared by every lighting variant, shadow cutout and flashlight depth copy. Callers
 * never combine it with TextureScroll, whose SDK OnBind replaces the whole matrix. */
bindBaseTransform(source: THREE.MeshBasicMaterial, original: THREE.MeshStandardMaterial, values: readonly number[]) {
    if (this.disposed) return;
    let matrix = this.baseTransforms.get(original);
    if (!matrix) {
      matrix = new THREE.Matrix3().set(values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8]);
      this.baseTransforms.set(original, matrix);
      this.patchTemporalTransform(original, matrix, true);
    }
    if (temporalTransformPatches.get(source)?.uniform.value !== matrix) this.patchTemporalTransform(source, matrix, true);
  }

bindTemporal(source: THREE.MeshBasicMaterial, original: THREE.MeshStandardMaterial, frames: THREE.Texture[], program: SourceTemporalProxies) {
    if (this.disposed) return;
    let entry = this.temporalOriginals.get(original);
    if (!entry) {
      const matrix = new THREE.Matrix3(), transforms = program.operations.some(operation => operation.kind === 'texturescroll');
      entry = { state: new SourceTemporalProxyState(program, frames.length || 1), matrix, original, frames, transforms,
        sources: [], registered: new WeakSet() };
      this.temporalOriginals.set(original, entry);
      this.temporal.push(entry);
      if (transforms) this.patchTemporalTransform(original, matrix);
    }
    // GLTF primitives can share one PBR material. Its native state and shader
    // patch are shared too, while every Source variant retains its own frames.
    if (!entry.registered.has(source)) {
      entry.registered.add(source);
      entry.sources.push({ material: source, frames });
      if (entry.transforms) this.patchTemporalTransform(source, entry.matrix);
    }
    this.updateTemporal(entry, this.time.value);
  }

private updateTemporal(entry: SourceMaterials['temporal'][number], time: number) {
    entry.state.update(time);
    if (entry.transforms) {
      const m = entry.state.matrix;
      entry.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    }
    const frame = Math.trunc(entry.state.frame);
    if (entry.frames.length) entry.original.map = entry.frames[frame >= 0 && frame < entry.frames.length ? frame : 0];
    for (const binding of entry.sources) if (binding.frames.length)
      binding.material.map = binding.frames[frame >= 0 && frame < binding.frames.length ? frame : 0];
  }
update(time:number){
    if(this.disposed)return;
    this.time.value=time;
    for(const entry of this.animated)entry.material.map=entry.frames[Math.floor(time*entry.fps)%entry.frames.length];
    for (const entry of this.temporal) this.updateTemporal(entry, time);
  }
  clear(){
    this.animated.length=0;
    for(const {patch,owner} of this.temporalTransformOwners)if(patch.owner===owner){
      patch.owner=undefined;patch.fixed=false;patch.uniform.value=inactiveTemporalTransform;
    }
    this.temporalTransformOwners.length=0;this.temporal.length=0;this.temporalOriginals=new WeakMap();this.baseTransforms=new WeakMap();
    for(const resource of this.resources){if(this.disposed)this.release(resource);else resource.dispose();}
    this.resources.clear();
  }
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
  // SDK BT_BLENDADD/BT_ADD is a blend state of the material itself: both the Source
  // variant and the Studio (PBR) original draw additively without depth writes.
  if (meta.additive) for (const entry of [material, original]) { entry.blending = THREE.AdditiveBlending; entry.depthWrite = false; }
  // Converter metadata keeps TextureScroll as its rate vector: the same SDK proxy
  // (texturescale 1), so it drives the shared base matrix and every pass using it.
  let temporal = meta.temporalProxies;
  if (!temporal && meta.scroll !== undefined) {
    const rate = meta.scroll;
    if (!Array.isArray(rate) || rate.length !== 2 || !rate.every(Number.isFinite)) throw new Error('Invalid Source scroll metadata');
    temporal = { operations: [{ kind: 'texturescroll', scroll: [rate[0], rate[1]], scale: 1 },
      ...(resources.frames?.length && meta.animationfps ? [{ kind: 'animatedtexture' as const, fps: meta.animationfps }] : [])] };
  }
  // SDK TextureScroll OnBind writes the complete base matrix (texturescrollmaterialproxy.cpp
  // SetMatrixValue), so a scrolled material never applies its static one.
  const scrolled = !!temporal?.operations.some(operation => operation.kind === 'texturescroll');
  const baseTransform = scrolled ? undefined : staticBaseTransform(meta);
  if (baseTransform) context.bindBaseTransform(material, original, baseTransform);
  if (temporal) context.bindTemporal(material, original, resources.frames ?? [], temporal);
  else if (resources.frames?.length && meta.animationfps) context.animate(material, resources.frames, meta.animationfps);
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
  const signedNormal=resources.normal?.userData.sourceNativeTexture?.format===22;
  // Effective Source base coordinates: the bound static/TextureScroll matrix (vertex)
  // plus a legacy converter scroll (fragment). SDK 2013 samples bump, envmap mask,
  // self-illum mask and Phong exponent there (vertexlit_and_unlit_generic_ps2x.fxc:335,441;
  // skin_ps20b.fxc:190,253,338), detail at $detailscale × that matrix without
  // $detailtexturetransform (vertexlitgeneric_dx9_helper.cpp:986, lightmappedgeneric_dx9_helper.cpp:802,
  // BaseVSShader.cpp SetVertexShaderTextureScaledTransform). LightmappedGeneric and
  // WorldVertexTransition sample the envmap mask at $envmapmasktransform·uv instead
  // (lightmappedgeneric_vs20.fxc:200-203; authored mask transforms are refused upstream).
  const baseTransformed = temporalTransformPatches.has(material);
  const worldMaskUv = meta.shader === 'lightmappedgeneric' || meta.shader === 'worldvertextransition';
  const previous = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    sourceTextureShader(material,shader);
    Object.assign(shader.uniforms, {
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
      varying vec3 vSourceEffectTangent; varying vec3 vSourceEffectBitangent; varying vec2 vSourceEffectUv; varying vec2 vSourceEffectBaseUv;\n`;
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
      vSourceEffectBaseUv = ${baseTransformed ? '(sourceProxyBaseTransform * vec3(uv, 1.0)).xy' : 'uv'};
      #ifdef USE_UV1
        vSourceEffectLightUv = uv1;
      #else
        vSourceEffectLightUv = vec2(0.0);
      #endif
      vSourceEffectLightAttenuation = sourceVertexAttenuation(vSourceEffectPosition);
      vSourceEffectVertexLight = sourceVertexDiffuse(vSourceEffectPosition, vSourceEffectNormal);
    `);
    // Companion samplers use the effective base coordinates; the tangent frame stays
    // on the authored UVs, as Source's vertex tangents do.
    shader.fragmentShader = shader.fragmentShader.replace(SOURCE_TEXTURE_FALLBACK,'').replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = sourceDiffuseSample(texture2D(map, vMapUv));
        // Source retains the primary sample for reflection/Phong/glow masks,
        // while secondary textures and detail blending modify the albedo.
        float sourceBaseTextureAlpha = sampledDiffuseColor.a;
        #ifdef USE_COLOR_ALPHA
          if (${flag(resources.base2)}) sampledDiffuseColor = mix(sampledDiffuseColor, sourceDiffuseSample(texture2D(sourceEffectBase2, vSourceEffectBaseUv)), vColor.a);
        #endif
        // Ghost uses Source MulDetail2 (mode 0). Detail samples stay linear:
        // a 0.5 texel leaves the base unchanged, independent of scene lighting.
        if (${flag(resources.detail)}) sampledDiffuseColor *= mix(vec4(1.0),
          sourceDiffuseSample(texture2D(sourceEffectDetail, vSourceEffectBaseUv * sourceEffectDetailParams.x)) * 2.0, sourceEffectDetailParams.y);
        diffuseColor *= sampledDiffuseColor;
      #endif
    `);
    shader.fragmentShader = shader.fragmentShader.replace('uniform float sourceExposure;', '');
    shader.fragmentShader = '#define SOURCE_MATERIAL_EFFECTS\n' + declarations + `
      uniform float sourceExposure;
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
        vec3 tn = vec3(0.0, 0.0, 1.0);
        if (${flag(resources.normal)}) {
          bump = texture2D(sourceEffectNormal, vSourceEffectBaseUv);
          vec3 t = vSourceEffectTangent, b = vSourceEffectBitangent;
          if (dot(t, t) < 0.1) {
            vec3 q1 = dFdx(vSourceEffectPosition), q2 = dFdy(vSourceEffectPosition);
            vec2 st1 = dFdx(vSourceEffectUv), st2 = dFdy(vSourceEffectUv);
            float signUv = st1.x * st2.y - st1.y * st2.x < 0.0 ? -1.0 : 1.0;
            t = normalize(q1 * st2.y - q2 * st1.y) * signUv;
            b = normalize(-q1 * st2.x + q2 * st1.x) * signUv;
          }
          tn = ${signedNormal?'vec3(bump.rg, sqrt(max(0.0, 1.0 - dot(bump.rg, bump.rg))))':'bump.rgb * 2.0 - 1.0'};
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
          specMap = texture2D(sourceEffectExponent, vSourceEffectBaseUv);
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
          vec3 mask = ${resources.selfIllum ? 'texture2D(sourceEffectSelfIllum, vSourceEffectBaseUv).rgb' : 'vec3(baseAlpha)'};
          result = mix(result, albedo * sourceEffectEmissiveTint * sourceExposure, mask);
        }
        if (${flag(cube && meta.envmap)}) {
          vec3 env = textureCube(sourceEffectCube, sourceEffectRotation * reflected).rgb * sourceEffectEnvTint;
          if (${flag(resources.mask)}) env *= texture2D(sourceEffectMask, ${worldMaskUv ? 'vSourceEffectUv' : 'vSourceEffectBaseUv'}).rgb;
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
  const features = [!!resources.detail, props, hasTangent, !!resources.base2, !!(cube && meta.envmap), !!resources.normal, signedNormal, !!resources.mask,
    !!resources.exponent, !!resources.selfIllum, resources.lightmaps?.length === 3,
    meta.unlit, meta.phong, meta.selfillum, meta.halflambert, meta.ssbump, meta.nodiffusebumplighting,
    meta.basealphaphongmask, meta.phongmaskinvert, meta.phongalbedotint, meta.normalmapalphaenvmapmask, meta.basealphaenvmapmask,
    baseTransformed, worldMaskUv].map(Boolean);
  material.customProgramCacheKey = () => `${key}-source-effects-v12-${features.map(Number).join('')}`;
  material.needsUpdate = true;
}
