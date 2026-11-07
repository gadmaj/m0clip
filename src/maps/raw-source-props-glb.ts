/** Native studio geometry assembly; Source conventions follow noclip.website and
 * scripts/import_source_props.py (MIT, LICENSE.noclip). No file/network ownership. */
import { SourceGlb, type SourceGltfRoot } from './raw-source-gltf';
import { sourceLinearColor, type SourceMaterialExport } from './raw-source-materials';
import type { SourceWorld } from './raw-source-geometry';
import type { SourceProps, SourcePropPlacement } from './raw-source-props';
import { selectSourceStudioMeshes, sourceStudioMeshMaterial, type SourceStudioModel, type SourceStudioMesh } from './raw-source-studio';
import type { SourceLightingRequirement } from './raw-source-lighting';
import type { SourcePropCollision } from './raw-source-collision';
import type { PropLightCache } from '../render/source-materials';
import { sourceAbort } from './raw-source-lzma';
import { sampleSourceStudioSequence, sourceStudioSequenceIndex, SourceStudioClipWriter, type SourceStudioSample } from './raw-source-animation';

const METRES = .0254;
/** Conservative LOGICAL bytes of retained glTF JSON metadata: UTF-16 strings,
 * numbers at their longest JSON text, plus per-record object overhead. */
const META_NUMBER = 24, META_RECORD = 128;
const metaString = (text: string | undefined) => 32 + 2 * (text?.length ?? 0);
/** Fixed placement node/extras/mesh records and their scalar/vector fields. */
const PLACEMENT_RECORDS = 16, PLACEMENT_NUMBERS = 96;
const CACHE_METADATA = 8 * META_RECORD + 100 * META_NUMBER;
type Primitive = SourceGltfRoot['meshes'][number]['primitives'][number];
export interface SourcePropsGlbOptions {
  lightingForPlacement(placement: SourcePropPlacement): PropLightCache | undefined;
  cubeForPlacement?(placement: SourcePropPlacement): readonly number[] | undefined;
  /** The physics closure's collision outcome, recorded on the placement node. */
  collisionForPlacement?(placement: SourcePropPlacement): SourcePropCollision | undefined;
  signal?: AbortSignal;
  /** Unique emitted vertex/accessor payloads, including inverse-bind matrices. */
  maxGeometryBytes: number;
  maxVertices: number;
  /** Aggregate logical bytes of retained placement/node/mesh/primitive/bone/skin
   * JSON metadata, authored leaf IDs and visibility clusters. Default 128 MiB. */
  maxMetadataBytes?: number;
  /** Import-owned aggregate limits; defaults are finite even for API callers. */
  animation?: {
    maxFrames?: number; maxSamples?: number; maxInputBytes?: number;
    /** Retained sampled arrays plus encoded channel/time payloads. */
    maxBytes?: number; maxClips?: number;
    /** Aggregate per-placement channel/sampler records, including shared clips. */
    maxChannels?: number;
  };
}
export interface SourcePropsGlbResult {
  placements: { placement: SourcePropPlacement; node: number; meshNode: number; meshes: readonly SourceStudioMesh[]; bones: readonly number[]; skin?: number; clip?: number }[];
  requirements: SourceLightingRequirement[];
  geometryBytes: number;
  vertices: number;
  /** Logical metadata bytes reserved against maxMetadataBytes (separate from geometry). */
  metadataBytes: number;
  /** Borrowed originals remain available even for blocked/missing placements.
   * Retaining native MDL/ANI is explicitly NOT sampled animation support. */
  original: SourceProps;
  animationSamples: number;
  animationBytes: number;
  animationInputBytes: number;
}

function cacheSnapshot(cache: PropLightCache): PropLightCache {
  if (cache.cube.length !== 6 || cache.cube.some(v => v.length !== 3 || v.some(n => !Number.isFinite(n))) || cache.lights.length > 4)
    throw new Error('Invalid actual Source prop light cache');
  const triple = (v: readonly number[]) => {
    if (v.length !== 3 || v.some(n => !Number.isFinite(n))) throw new Error('Invalid Source prop cache vector');
    return [...v];
  };
  return { cube: cache.cube.map(triple), lights: cache.lights.map(light => {
    if ([light.kind, light.exponent, light.inner, light.outer].some(n => !Number.isFinite(n))) throw new Error('Invalid Source prop cache light');
    return { ...light, pos: triple(light.pos), color: triple(light.color), attenuation: triple(light.attenuation), normal: triple(light.normal) };
  }) };
}

/** Vertices and bind translations are scaled once; placement is solely a root
 * node transform. Geometry/material resources never own placement metadata. */
export async function appendSourceProps(glb: SourceGlb, materials: SourceMaterialExport, props: SourceProps,
  world: SourceWorld, options: SourcePropsGlbOptions): Promise<SourcePropsGlbResult> {
  sourceAbort(options.signal);
  for (const value of [options.maxGeometryBytes, options.maxVertices])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid Source prop geometry limit');
  const maxMetadataBytes = options.maxMetadataBytes ?? 128 * 1024 ** 2;
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1) throw new Error('Invalid Source prop metadata limit');
  if (props.frame.yaw !== world.frame.yaw || props.frame.origin.some((v, i) => v !== world.frame.origin[i]) || props.frame.metresPerUnit !== METRES || world.frame.metresPerUnit !== METRES)
    throw new Error('Source props and world must share the same native frame');
  const result: SourcePropsGlbResult = { placements: [], requirements: [], geometryBytes: 0, metadataBytes: 0, vertices: 0,
    original: props, animationSamples: 0, animationBytes: 0, animationInputBytes: 0 };
  let sprites = 0, ropes = 0;
  for (const entity of props.entities) {
    if (entity.kind === 'sprite') sprites++;
    else if (entity.kind === 'rope') ropes++;
  }
  if (sprites) result.requirements.push({ code: 'sprite-entity-runtime', blocking: true,
    detail: `Sprite/glow rendering is unsupported (${sprites} entities).` });
  if (ropes) result.requirements.push({ code: 'rope-entity-runtime', blocking: true,
    detail: `Rope rendering is unsupported (${ropes} entities).` });
  const animationLimits = {
    maxFrames: options.animation?.maxFrames ?? 10000, maxSamples: options.animation?.maxSamples ?? 2_000_000,
    maxInputBytes: options.animation?.maxInputBytes ?? 256 * 1024 ** 2,
    maxBytes: options.animation?.maxBytes ?? 128 * 1024 ** 2, maxClips: options.animation?.maxClips ?? 10000,
    maxChannels: options.animation?.maxChannels ?? 200000,
  };
  for (const value of Object.values(animationLimits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid Source prop animation limit');
  const clipWriter = new SourceStudioClipWriter(glb), samples = new Map<SourceStudioModel, Map<string | number, SourceStudioSample>>();
  const inputBlobs = new Set<Blob>(), inputModels = new Set<SourceStudioModel>();
  let clips = 0, channels = 0, sampleCount = 0;
  const selections = new Map<SourceStudioModel, Map<string | number, number | undefined>>();
  const sequenceIndex = (model: SourceStudioModel, selection: string | number) => {
    let indices = selections.get(model);
    if (!indices) { indices = new Map(); selections.set(model, indices); }
    const key = typeof selection === 'string' ? selection.toLowerCase() : selection;
    if (!indices.has(key)) indices.set(key, sourceStudioSequenceIndex(model, selection, options.signal));
    return indices.get(key);
  };
  const sampleFor = async (model: SourceStudioModel, selection: string | number) => {
    const index = sequenceIndex(model, selection), key = index ?? selection;
    let modelSamples = samples.get(model);
    if (!modelSamples) { modelSamples = new Map(); samples.set(model, modelSamples); }
    const existing = modelSamples.get(key); if (existing) return existing;
    if (sampleCount >= animationLimits.maxClips) throw new Error('Source prop animation sequence limit exceeded');
    sampleCount++;
    if (!inputModels.has(model)) {
      const seen = new Set<string>();
      const addBlob = (blob: Blob) => {
        if (inputBlobs.has(blob)) return;
        if (blob.size > animationLimits.maxInputBytes - result.animationInputBytes) throw new Error('Source prop animation input byte limit exceeded');
        inputBlobs.add(blob); result.animationInputBytes += blob.size;
      };
      const visit = (owner: Pick<SourceStudioModel, 'path' | 'rawBlob' | 'animation'>, depth: number) => {
        sourceAbort(options.signal);
        if (seen.has(owner.path)) return;
        if (depth > 64 || seen.size >= 1024) throw new Error('Native animation include graph exceeds limit');
        seen.add(owner.path); addBlob(owner.rawBlob);
        for (const companion of owner.animation.companions) if (companion.blob) addBlob(companion.blob);
        for (const include of owner.animation.includedModels) visit(include, depth + 1);
      };
      visit(model, 0); inputModels.add(model);
    }
    // A bone-frame owns 28 sampled + 28 encoded bytes, <=8 time bytes,
    // and <=12 temporary translated bytes. Reserve before sampler allocation.
    const remainingSamples = Math.min(animationLimits.maxSamples - result.animationSamples,
      Math.floor((animationLimits.maxBytes - result.animationBytes) / 76));
    if (remainingSamples < 1) throw new Error('Source prop aggregate animation sample/byte limit exceeded');
    const sample = await sampleSourceStudioSequence(model, index ?? selection, {
      signal: options.signal, maxFrames: animationLimits.maxFrames, maxSamples: remainingSamples, maxInputBytes: animationLimits.maxInputBytes,
    });
    sourceAbort(options.signal);
    result.animationSamples += sample.pose ? sample.pose.length : sample.times.length * sample.tracks.length;
    result.animationBytes += sample.pose
      ? sample.pose.reduce((sum, track) => sum + track.positions.byteLength + track.quaternions.byteLength, 0)
      : 2 * (sample.times.byteLength + sample.tracks.reduce((sum, track) => sum + track.positions.byteLength + track.quaternions.byteLength, 0));
    result.requirements.push(...sample.requirements);
    modelSamples.set(key, sample); return sample;
  };
  const block = (code: string, path: string, detail: string) => result.requirements.push({ code, path, detail, blocking: true });
  for (const missing of props.missingModels) block('prop-missing-model', missing.path, `Missing native model resources: ${missing.resources.join(', ')}`);
  for (const missing of props.missingMaterials) block('prop-missing-material', missing.model, `Missing ${missing.name}: ${missing.candidates.join(', ')}`);
  for (const missing of props.missingAnimationResources) block('prop-missing-animation-resource', missing.path, `Required by ${missing.model}; original authored state is retained.`);
  const reserve = (bytes: number, vertices = 0) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > options.maxGeometryBytes - result.geometryBytes || vertices > options.maxVertices - result.vertices)
      throw new Error('Source prop geometry limit exceeded');
    result.geometryBytes += bytes; result.vertices += vertices;
  };
  const reserveMetadata = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxMetadataBytes - result.metadataBytes)
      throw new Error('Source prop metadata limit exceeded');
    result.metadataBytes += bytes;
  };
  const boneNameMetadata = new Map<SourceStudioModel, number>();
  const geometry = new Map<SourceStudioMesh, { attributes: Record<string, number>; indices: number }>();
  const inverseBinds = new Map<SourceStudioModel, number>();
  const variants = new Map<string, number>();
  // Leaf IDs are authored static-prop membership, not reachable-leaf indices.
  let leafView: DataView | undefined, leafStride = 0;
  if (props.placements.some(p => p.kind === 'static-prop')) {
    const version = world.bsp.lumps[10].version;
    if (version !== 0 && version !== 1) throw new Error(`Unsupported Source prop leaf version ${version}`);
    const bytes = await world.bsp.getLump(10, options.signal); sourceAbort(options.signal);
    leafStride = version === 0 ? 56 : 32;
    if (bytes.length % leafStride) throw new Error('Malformed Source prop leaf table');
    leafView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const attributesFor = (mesh: SourceStudioMesh, model: SourceStudioModel) => {
    const cached = geometry.get(mesh); if (cached) return cached;
    const count = mesh.positions.length / 3;
    if (!Number.isSafeInteger(count) || !count || mesh.normals.length !== count * 3 || mesh.tangents.length !== count * 4 || mesh.uv.length !== count * 2 || mesh.joints.length !== count * 4 || mesh.weights.length !== count * 4 || mesh.indices.length % 3)
      throw new Error(`Invalid Source studio mesh layout: ${model.path}`);
    for (const index of mesh.indices) if (index >= count) throw new Error('Source prop index out of range');
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let j = 0; j < 4; j++) {
        const weight = mesh.weights[i * 4 + j];
        if (!Number.isFinite(weight) || weight < 0 || (weight > 0 && mesh.joints[i * 4 + j] >= model.bones.length)) throw new Error('Invalid Source prop skin influence');
        sum += weight;
      }
      if (model.bones.length && Math.abs(sum - 1) > 1e-4) throw new Error('Source prop weights are not normalized');
    }
    reserve(mesh.positions.byteLength + mesh.normals.byteLength + mesh.tangents.byteLength + mesh.uv.byteLength + mesh.indices.byteLength +
      (model.bones.length ? mesh.joints.byteLength + mesh.weights.byteLength : 0), count);
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i] * METRES;
    const attributes: Record<string, number> = {
      POSITION: glb.accessor(positions, 'VEC3', { target: 34962, bounds: true }),
      NORMAL: glb.accessor(mesh.normals, 'VEC3', { target: 34962 }),
      TANGENT: glb.accessor(mesh.tangents, 'VEC4', { target: 34962 }),
      TEXCOORD_0: glb.accessor(mesh.uv, 'VEC2', { target: 34962 }),
    };
    if (model.bones.length) {
      attributes.JOINTS_0 = glb.accessor(mesh.joints, 'VEC4', { target: 34962 });
      attributes.WEIGHTS_0 = glb.accessor(mesh.weights, 'VEC4', { target: 34962 });
    }
    const emitted = { attributes, indices: glb.accessor(mesh.indices, 'SCALAR', { target: 34963 }) };
    geometry.set(mesh, emitted); return emitted;
  };
  const materialFor = async (mesh: SourceStudioMesh, placement: SourcePropPlacement, cube?: readonly number[]) => {
    const material = sourceStudioMeshMaterial(mesh, placement.skin);
    if (!material?.path) { block('prop-missing-material', placement.modelPath, `Placement ${placement.index}: missing ${material?.name ?? 'skin material'}.`); return undefined; }
    const baseIndex = await materials.material(material.path, cube); sourceAbort(options.signal);
    if (baseIndex === undefined) { block('prop-material-unavailable', material.path, `Placement ${placement.index}: material exporter could not emit the native material.`); return undefined; }
    const modulation = placement.diffuseModulation;
    if (modulation.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('Invalid Source prop modulation');
    // Normal rendermode ignores entity renderamt; static diffuse alpha remains authored.
    const alpha = placement.kind === 'entity-model' && placement.render.mode === 0 ? 1 : modulation[3] / 255;
    const key = `${baseIndex}:${modulation[0]},${modulation[1]},${modulation[2]}:${alpha}:${placement.render.mode}`;
    const cached = variants.get(key); if (cached !== undefined) return cached;
    const base = glb.json.materials[baseIndex];
    const factor = base.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    // The base factor is linear; byte modulation is a gamma-space colour that
    // multiplies Source's gamma tint before linearization, so linearize it too.
    const variant: SourceGltfRoot['materials'][number] = { ...base,
      pbrMetallicRoughness: { ...base.pbrMetallicRoughness, baseColorFactor: factor.map((v, i) => v * (i === 3 ? alpha : sourceLinearColor(modulation[i] / 255))) },
      extras: { ...base.extras, sourceVertexLighting: 6 },
    };
    if (alpha < 1 && variant.alphaMode !== 'MASK') variant.alphaMode = 'BLEND';
    const index = glb.json.materials.length; glb.json.materials.push(variant); variants.set(key, index); return index;
  };
  let placementWork = 0;
  for (const placement of props.placements) {
    if (placementWork++ % 32 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); sourceAbort(options.signal);
    }
    sourceAbort(options.signal);
    const model = props.models.get(placement.modelPath);
    if (!model) {
      if (!props.missingModels.some(m => m.path === placement.modelPath)) block('prop-missing-model', placement.modelPath, `Placement ${placement.index} has no native model.`);
      continue;
    }
    for (const path of model.missingResources) if (!props.missingAnimationResources.some(m => m.path === path)) block('prop-missing-animation-resource', path, `Required by ${model.path}.`);
    if (placement.matrixInputUnits !== 'metres' || placement.matrix.length !== 16 || placement.matrix.some(n => !Number.isFinite(n))) throw new Error('Invalid native Source prop placement matrix');
    if (!Number.isSafeInteger(placement.skin)) {
      block('prop-skin-selection', model.path, `Placement ${placement.index}: skin ${placement.skin} is not a safe integer.`); continue;
    }
    const selected = selectSourceStudioMeshes(model, placement.body);
    if (selected.some(mesh => mesh.lod !== model.lod)) throw new Error('Source prop selected mesh LOD mismatch');
    const animation = placement.animation;
    let sequence: string | number | undefined;
    if (animation && placement.kind === 'entity-model') {
      if (!Number.isFinite(animation.cycle) || !Number.isFinite(animation.playbackRate)) throw new Error('Invalid native Source placement cycle/playback rate');
      // CDynamicProp::Spawn/PropSetAnim and noclip BaseEntity::spawn:
      // DefaultAnim supersedes the base sequence; an unknown default uses 0.
      // BaseAnimating's sequence key is an integer, while API labels remain
      // exact names (including whitespace); do not pick the first blend.
      if (animation.defaultAnimation) sequence = sequenceIndex(model, animation.defaultAnimation) ?? 0;
      else if (animation.sequence) sequence = /^[-+]?\d+$/.test(animation.sequence) ? Number(animation.sequence) : animation.sequence;
      else if (sequenceIndex(model, 0) !== undefined || animation.cycle !== 0 || animation.playbackRate !== 1) sequence = 0;
    }
    if (model.bones.some(bone => bone.proceduralType !== 0)) block('prop-procedural-bone-runtime', model.path, `Placement ${placement.index}: native procedural bones require evaluation.`);
    if (selected.some(mesh => mesh.flexCount > 0)) block('prop-flex-runtime', model.path, `Placement ${placement.index}: authored flex geometry requires native evaluation.`);
    if (placement.render.effect || placement.render.renderFx || ![0, 6, 10].includes(placement.render.mode))
      block('prop-render-runtime', model.path, `Placement ${placement.index}: authored render mode/effect requires native evaluation.`);
    if ([3, 5].includes(placement.render.mode)) block('prop-render-blend-runtime', model.path, `Placement ${placement.index}: glow/additive entity blending requires native state support.`);
    if (placement.render.initiallyDisabled || placement.render.mode === 6 || placement.render.mode === 10)
      block('prop-visibility-runtime', model.path, `Placement ${placement.index}: authored disabled/hidden baseline requires native visibility state.`);
    if (!placement.castShadow || !placement.render.receiveShadow)
      block('prop-shadow-runtime', model.path, `Placement ${placement.index}: authored cast/receive shadow controls require native per-mesh state.`);
    if (placement.fadeMaxDistance > 0 || placement.fadeMinDistance > 0 || placement.forcedFadeScale !== 1
      || (placement.kind === 'static-prop' && (placement.flags & 1)))
      block('prop-fade-runtime', model.path, `Placement ${placement.index}: authored distance/screen fade and forced-scale policy require qualified native camera/display integration.`);
    if ([placement.dxLevels, placement.cpuLevels, placement.gpuLevels].some(levels => levels?.some(level => level !== 0)) || placement.disableX360)
      block('prop-hardware-gating-runtime', model.path, `Placement ${placement.index}: authored DX/CPU/GPU/platform visibility constraints are retained and require an explicit native profile.`);
    const sampled = options.lightingForPlacement(placement);
    const cache = sampled ? cacheSnapshot(sampled) : undefined;
    if (!cache) block('prop-light-cache', model.path, `Placement ${placement.index}: actual sampled PropLightCache is required; no ambient substitute was emitted.`);
    const cube = options.cubeForPlacement?.(placement)?.slice();
    if (cube && (cube.length !== 6 || cube.some(i => !Number.isSafeInteger(i) || i < 0 || i >= glb.json.textures.length))) throw new Error('Invalid actual Source prop cube binding');
    // Charge every retained JSON record below before it is built: placement node,
    // extras and mesh records, primitives, bone nodes/extras/children, skin joints,
    // authored leaf IDs and their visibility clusters. The aggregate counter makes
    // placements that alias one leaf array or model pay for every emitted copy.
    const name = `${placement.classname}:${placement.index}:${model.name}`;
    let boneNames = boneNameMetadata.get(model);
    if (boneNames === undefined) {
      boneNames = 0; for (const bone of model.bones) boneNames += metaString(bone.name);
      boneNameMetadata.set(model, boneNames);
    }
    const staticLeaves = placement.kind === 'static-prop' ? placement.leaves.length : 0;
    const optionalNumbers = (placement.dxLevels?.length ?? 0) + (placement.cpuLevels?.length ?? 0) + (placement.gpuLevels?.length ?? 0)
      + (placement.lightmapResolution?.length ?? 0);
    reserveMetadata(PLACEMENT_RECORDS * META_RECORD + PLACEMENT_NUMBERS * META_NUMBER
      + 3 * metaString(name) + metaString(model.path) + metaString(placement.classname) + metaString(placement.render.renderFx)
      + metaString(animation?.defaultAnimation) + metaString(animation?.sequence)
      + (placement.leaves.length + 2 * staticLeaves + optionalNumbers) * META_NUMBER
      + (cache ? CACHE_METADATA : 0) + (cube ? 6 * META_NUMBER : 0)
      + selected.length * (3 * META_RECORD + 8 * META_NUMBER)
      + model.bones.length * (3 * META_RECORD + 12 * META_NUMBER + metaString(name)) + 2 * boneNames);
    const primitives: Primitive[] = [];
    const emittedMeshes: SourceStudioMesh[] = [];
    for (const mesh of selected) {
      const material = await materialFor(mesh, placement, cube);
      if (material === undefined) continue;
      const emitted = attributesFor(mesh, model);
      primitives.push({ attributes: emitted.attributes, indices: emitted.indices, material,
        extras: { sourceStudioMesh: { bodypart: mesh.bodypart, submodel: mesh.submodel, lod: mesh.lod, skinref: mesh.skinref, switchPoint: mesh.switchPoint } } });
      emittedMeshes.push(mesh);
    }
    if (!primitives.length) {
      // An explicitly selected blank bodygroup is valid; unavailable materials are not.
      if (selected.length) block('prop-no-emitted-geometry', model.path, `Placement ${placement.index}: all selected native primitives were blocked.`);
      continue;
    }
    const clusters = new Set<number>();
    if (placement.kind === 'static-prop') for (const leaf of placement.leaves) {
      if (!leafView || leaf >= leafView.byteLength / leafStride) throw new Error('Source static prop leaf out of range');
      const cluster = leafView.getUint16(leaf * leafStride + 4, true); if (cluster !== 65535) clusters.add(cluster);
    }
    const node = glb.json.nodes.length;
    const extras: Record<string, unknown> = {
      sourceProp: model.path, sourceClass: placement.classname, skin: placement.skin, body: placement.body, solid: placement.solid,
      castShadow: placement.castShadow, receiveShadow: placement.render.receiveShadow,
      sourceOrigin: [...world.frame.origin], sourceYaw: world.frame.yaw,
      sourcePlacement: { index: placement.index, entityIndex: placement.entityIndex, kind: placement.kind, sourceOrigin: [...placement.sourceOrigin],
        sourceAngles: [...placement.sourceAngles], scale: placement.scale, flags: placement.flags, flagsEx: placement.flagsEx,
        modelBounds: model.bounds.map(bound => [...bound]), modelFlags: model.flags,
        modelRenderBounds: model.renderBounds.map(bound => [...bound]),
        leaves: Array.from(placement.leaves), fadeMinDistance: placement.fadeMinDistance, fadeMaxDistance: placement.fadeMaxDistance,
        forcedFadeScale: placement.forcedFadeScale, diffuseModulation: [...placement.diffuseModulation],
        dxLevels: placement.dxLevels?.slice(), cpuLevels: placement.cpuLevels?.slice(), gpuLevels: placement.gpuLevels?.slice(),
        lightmapResolution: placement.lightmapResolution?.slice(), disableX360: placement.disableX360,
        sourceLightingOrigin: placement.sourceLightingOrigin?.slice(), worldLightingOrigin: placement.worldLightingOrigin?.slice(),
        render: { ...placement.render, color: [...placement.render.color] },
        animation: animation ? { defaultAnimation: animation.defaultAnimation, sequence: animation.sequence, cycle: animation.cycle,
          playbackRate: animation.playbackRate, skin: animation.skin, body: animation.body } : undefined,
        baselineVisible: !placement.render.initiallyDisabled && placement.render.mode !== 6 && placement.render.mode !== 10 && (placement.render.mode === 0 || placement.render.amount !== 0) },
    };
    if (cache) extras.sourceLighting = cache;
    const collision = options.collisionForPlacement?.(placement);
    if (collision) extras.sourceCollision = { ...collision };
    if (cube) extras.sourceCubeFaces = cube;
    if (placement.kind === 'static-prop') { extras.sourceStaticIndex = placement.index; extras.sourceVisibilityClusters = [...clusters].sort((a, b) => a - b); }
    glb.json.nodes.push({ name, matrix: Array.from(placement.matrix), extras, children: [] });
    glb.json.scenes[glb.json.scene].nodes.push(node);
    const meshIndex = glb.json.meshes.length; glb.json.meshes.push({ name, primitives });
    const meshNode = glb.json.nodes.length; glb.json.nodes.push({ name: `${name}:mesh`, mesh: meshIndex });
    glb.json.nodes[node].children!.push(meshNode);
    const sample = sequence === undefined ? undefined : await sampleFor(model, sequence);
    if (sample?.pose && sample.pose.length !== model.bones.length) throw new Error('Invalid Source constant pose bone count');
    const bones: number[] = [];
    for (const bone of model.bones) {
      const index = glb.json.nodes.length; bones.push(index);
      if (bone.parent < -1 || bone.parent >= bones.length - 1) throw new Error('Invalid Source prop bone hierarchy');
      const pose = sample?.pose?.[bones.length - 1];
      if (pose && (pose.bone !== bones.length - 1 || pose.positions.length !== 3 || pose.quaternions.length !== 4)) throw new Error('Invalid Source constant pose transform');
      glb.json.nodes.push({ name: `${name}:${bone.name}`,
        translation: pose ? Array.from(pose.positions, n => n * METRES) : bone.position.map(n => n * METRES),
        rotation: pose ? Array.from(pose.quaternions) : [...bone.quaternion],
        extras: { sourceStudioBone: { index: bones.length - 1, name: bone.name, flags: bone.flags, proceduralType: bone.proceduralType } } });
      const parent = bone.parent < 0 ? node : bones[bone.parent]; (glb.json.nodes[parent].children ??= []).push(index);
    }
    let skin: number | undefined;
    if (bones.length) {
      let inverse = inverseBinds.get(model);
      if (inverse === undefined) {
        reserve(model.bones.length * 16 * 4);
        const values = new Float32Array(model.bones.length * 16);
        model.bones.forEach((bone, i) => { values.set(bone.inverseBindMatrix, i * 16); for (let j = 12; j < 15; j++) values[i * 16 + j] *= METRES; });
        inverse = glb.accessor(values, 'MAT4'); inverseBinds.set(model, inverse);
      }
      const skins = glb.json.skins ??= []; skin = skins.length;
      skins.push({ joints: bones, inverseBindMatrices: inverse, skeleton: node }); glb.json.nodes[meshNode].skin = skin;
    }
    let clip: number | undefined;
    if (sample && !sample.pose) {
      if (clips >= animationLimits.maxClips) throw new Error('Source prop animation clip limit exceeded');
      const channelCount = sample.tracks.length * 2;
      if (channelCount > animationLimits.maxChannels - channels) throw new Error('Source prop animation channel limit exceeded');
      clip = clipWriter.append(sample, bones, { signal: options.signal, name: `${name}:sequence:${sample.owner?.nativeIndex ?? sequence}`,
        playback: { version: 1, loop: sample.loop, cycle: animation!.cycle, rate: animation!.playbackRate } });
      if (clip !== undefined) { clips++; channels += channelCount; }
    }
    result.placements.push({ placement, node, meshNode, meshes: emittedMeshes, bones, skin, clip });
  }
  return result;
}
