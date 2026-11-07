/** Native Source geometry assembly; coordinates/winding belong to the BSP decoder.
 * ABI follows scripts/import_source_bsp.py, import_source_props.py and source_visibility.py.
 * Source conventions: noclip.website, Copyright 2018 Jasper St. Pierre (MIT, LICENSE.noclip).
 * This is a CPU asset writer, not a complete-map/runtime capability claim. */
import { SourceGlb, type SourceGltfRoot } from './raw-source-gltf';
import type { SourceMaterialExport } from './raw-source-materials';
import type { SourceSurface, SourceWorld } from './raw-source-geometry';
import type { SourceLightingPlacement, SourceLightingRequirement, SourceLightingResult } from './raw-source-lighting';
import { sourceLightingYield } from './raw-source-lighting-data';
import type { SourceBrushVisual } from './raw-source-props';

export interface SourceWorldGlbOptions {
  /** Actual GLB texture indices, in CPU lighting-page order. */
  lightmaps: readonly { flat: number; bump: readonly [number, number, number] }[];
  brushes?: readonly SourceBrushVisual[];
  cubeForSurface?: (surface: SourceSurface) => readonly number[] | undefined;
  signal?: AbortSignal;
  /** Aggregate unique emitted geometry, not per-primitive ceilings. */
  maxGeometryBytes: number;
  maxVertices: number;
}
export interface SourceWorldFaceRange {
  face: number; mesh: number; primitive: number;
  /** Index-element offsets, not byte or triangle offsets. */
  start: number; count: number; vertexStart: number; vertexCount: number;
}
export interface SourceWorldGlbResult {
  worldNodes: number[];
  brushes: { entityIndex: number; model: number; node: number; attached: boolean; faces: SourceWorldFaceRange[] }[];
  faces: SourceWorldFaceRange[];
  /** Includes CPU lighting and newly encountered material blockers. Inputs stay immutable. */
  requirements: SourceLightingRequirement[];
  /** Only face-without-baked-samples requirements for actual UnlitGeneric faces. */
  resolvedUnlitFaces: number[];
  geometryBytes: number;
  vertices: number;
}
type Primitive = SourceGltfRoot['meshes'][number]['primitives'][number];
interface Entry { surface: SourceSurface; placement?: SourceLightingPlacement }
interface Group { material: number; entries: Entry[]; vertices: number; indices: number; alpha: boolean; lit: boolean }
interface Packed { mesh: number; faces: SourceWorldFaceRange[] }
const limit = (n: number, name: string): number => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 0xffffffff) throw new RangeError(`Invalid Source world ${name} limit`);
  return n;
};
function finite(values: Float32Array, length: number, name: string, signal?: AbortSignal): void {
  if (!(values instanceof Float32Array) || values.length !== length) throw new RangeError(`Source world ${name} attribute length mismatch`);
  for (let i = 0; i < values.length; i++) {
    if ((i & 16383) === 0) signal?.throwIfAborted();
    if (!Number.isFinite(values[i])) throw new RangeError(`Source world nonfinite ${name} attribute`);
  }
}
function validate(surface: SourceSurface, signal?: AbortSignal): number {
  if (!Number.isSafeInteger(surface.face) || surface.face < 0) throw new RangeError('Invalid Source face identity');
  const n = surface.positions.length / 3;
  if (!Number.isSafeInteger(n) || n < 3) throw new RangeError(`Face ${surface.face}: invalid vertex count`);
  finite(surface.positions, n * 3, 'position', signal); finite(surface.normals, n * 3, 'normal', signal);
  finite(surface.tangents, n * 4, 'tangent', signal); finite(surface.uv, n * 2, 'UV', signal);
  if (surface.alpha) {
    finite(surface.alpha, n, 'blend alpha', signal);
    if (surface.alpha.some(a => a < 0 || a > 1)) throw new RangeError(`Face ${surface.face}: blend alpha out of bounds`);
  }
  if (!(surface.indices instanceof Uint32Array) || !surface.indices.length || surface.indices.length % 3) throw new RangeError(`Face ${surface.face}: invalid triangle index count`);
  for (let i = 0; i < surface.indices.length; i++) {
    if ((i & 16383) === 0) signal?.throwIfAborted();
    if (surface.indices[i] >= n) throw new RangeError(`Face ${surface.face}: index out of bounds`);
  }
  return n;
}
function validateBrush(brush: SourceBrushVisual): void {
  const m = brush.matrix;
  if (brush.matrixInputUnits !== 'metres' || m.length !== 16 || m.some(v => !Number.isFinite(v))
    || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new RangeError('Invalid Source brush affine metre matrix');
  const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (!Number.isFinite(determinant) || determinant <= 0) throw new RangeError('Invalid Source brush matrix orientation');
}

/** Appends merged world primitives and shared model-local brush meshes. Missing
 * resources produce blockers, never substitute geometry/white baked lighting.
 * The caller owns this import's GLB/material exporter, encoded atlas/cube assets,
 * sidecars and final transaction; discard partial output on throw/cancellation. */
export async function appendSourceWorld(glb: SourceGlb, materials: SourceMaterialExport, world: SourceWorld,
  lighting: SourceLightingResult, options: SourceWorldGlbOptions): Promise<SourceWorldGlbResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const maxBytes = limit(options.maxGeometryBytes, 'geometry byte');
  const maxVertices = limit(options.maxVertices, 'vertex');
  if (options.lightmaps.length !== lighting.pages.length) throw new RangeError('Source lightmap binding/page count mismatch');
  for (const binding of options.lightmaps) for (const index of [binding.flat, ...binding.bump]) {
    if (binding.bump.length !== 3 || !Number.isSafeInteger(index) || index < 0 || index >= glb.json.textures.length) throw new RangeError('Source lightmap texture index out of bounds');
  }
  const placements = new Map<number, SourceLightingPlacement>();
  for (const p of lighting.placements) {
    if (!Number.isSafeInteger(p.face) || p.face < 0 || placements.has(p.face) || !Number.isSafeInteger(p.page) || p.page < 0 || p.page >= lighting.pages.length) throw new RangeError('Invalid or duplicate Source lighting placement');
    placements.set(p.face, p);
  }
  // Validate every unique mesh before material I/O or large packing allocations.
  const models = new Map<number, readonly SourceSurface[]>();
  for (const brush of options.brushes ?? []) {
    signal?.throwIfAborted(); validateBrush(brush);
    const previous = models.get(brush.model);
    if (previous && previous !== brush.surfaces) throw new Error('Source brush model must share its decoded geometry');
    models.set(brush.model, brush.surfaces);
  }
  const seenFaces = new Set<number>();
  let reservedBytes = 0, reservedVertices = 0, checkedSurfaces = 0;
  for (const surfaces of [world.surfaces, ...models.values()]) for (const s of surfaces) {
    signal?.throwIfAborted();
    if ((checkedSurfaces++ & 127) === 0) await sourceLightingYield(signal);
    if (!s.visible) continue;
    if (seenFaces.has(s.face)) throw new RangeError(`Duplicate Source geometry face ${s.face}`);
    seenFaces.add(s.face);
    const n = validate(s, signal), p = placements.get(s.face);
    if (p) finite(p.uv, n * 2, 'lightmap UV', signal);
    const bytes = n * (48 + (p ? 8 : 0) + (s.alpha ? 16 : 0)) + s.indices.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes - reservedBytes || n > maxVertices - reservedVertices) throw new RangeError('Source world aggregate geometry allocation limit exceeded');
    reservedBytes += bytes; reservedVertices += n;
  }
  const result: SourceWorldGlbResult = { worldNodes: [], brushes: [], faces: [], requirements: [], resolvedUnlitFaces: [], geometryBytes: 0, vertices: 0 };
  const startRequirements = materials.requirements.length;
  const variants = new Map<string, number>(), resolved = new Set<number>();
  const missingBaked = new Set(lighting.requirements.filter(r => r.code === 'face-without-baked-samples').map(r => r.face));
  const block = (code: string, detail: string, face?: number): void => { result.requirements.push({ code, detail, blocking: true, ...(face === undefined ? {} : { face }) }); };
  const variant = (base: number, page: number | undefined, brush: boolean, unlit: boolean): number => {
    const key = `${base}:${page ?? '-'}:${brush}:${unlit}`;
    const cached = variants.get(key); if (cached !== undefined) return cached;
    const original = glb.json.materials[base];
    const extras = { ...original.extras };
    delete extras.sourceLightmap; delete extras.sourceBumpLightmaps; delete extras.sourceVertexLighting; delete extras.sourcePropBrush;
    if (unlit) extras.sourceVertexLighting = 1;
    else if (page !== undefined) {
      extras.sourceLightmap = options.lightmaps[page].flat;
      const meta = extras.sourceMaterial;
      if (meta && typeof meta === 'object' && 'bumpmapIndex' in meta && typeof meta.bumpmapIndex === 'number') extras.sourceBumpLightmaps = [...options.lightmaps[page].bump];
    }
    if (brush) extras.sourcePropBrush = true;
    const index = glb.json.materials.length;
    glb.json.materials.push({ ...original, extras }); variants.set(key, index); return index;
  };
  const pack = async (surfaces: readonly SourceSurface[], brush: boolean, name: string): Promise<Packed | undefined> => {
    const groups = new Map<string, Group>();
    for (const surface of surfaces) {
      signal?.throwIfAborted(); if (!surface.visible) continue;
      const cube = options.cubeForSurface?.(surface);
      const base = await materials.material(surface.material, cube); signal?.throwIfAborted();
      if (base === undefined) { block('world-material-unavailable', 'The native face material could not be exported.', surface.face); continue; }
      const record = glb.json.materials[base], meta = record.extras?.sourceMaterial;
      const shader = meta && typeof meta === 'object' && 'shader' in meta ? meta.shader : undefined;
      const unlit = record.extras?.sourceUnlit === true && (shader === 'unlitgeneric' || shader === 'sdk_unlitgeneric');
      const placement = unlit ? undefined : placements.get(surface.face);
      if (!unlit && !placement) { block('world-face-lighting-unavailable', 'A lit native face has no actual baked atlas placement.', surface.face); continue; }
      if (brush && placement && (placement.styles.length !== 1 || placement.styles[0] !== 0))
        block('brush-lightstyle-runtime', 'The native brush material currently bypasses animated lightstyle textures; authored styles require shared-atlas runtime binding.', surface.face);
      if (unlit && !placements.has(surface.face) && missingBaked.has(surface.face)) resolved.add(surface.face);
      const material = variant(base, placement?.page, brush, unlit), alpha = !!surface.alpha;
      const key = `${material}:${alpha}:${!!placement}`;
      let group = groups.get(key);
      if (!group) { group = { material, entries: [], vertices: 0, indices: 0, alpha, lit: !!placement }; groups.set(key, group); }
      group.entries.push({ surface, placement }); group.vertices += surface.positions.length / 3; group.indices += surface.indices.length;
    }
    if (!groups.size) return undefined;
    const mesh = glb.json.meshes.length, primitives: Primitive[] = [], faces: SourceWorldFaceRange[] = [];
    for (const group of groups.values()) {
      await sourceLightingYield(signal);
      // Conservative preflight above bounds these buffers and all retained geometry.
      const positions = new Float32Array(group.vertices * 3), normals = new Float32Array(group.vertices * 3);
      const tangents = new Float32Array(group.vertices * 4), uv = new Float32Array(group.vertices * 2);
      const lmuv = group.lit ? new Float32Array(group.vertices * 2) : undefined;
      const colors = group.alpha ? new Float32Array(group.vertices * 4) : undefined;
      const indices = new Uint32Array(group.indices), ranges: number[][] = [];
      let vertex = 0, index = 0, packedSurfaces = 0;
      for (const entry of group.entries) {
        signal?.throwIfAborted();
        if ((packedSurfaces++ & 127) === 0) await sourceLightingYield(signal);
        const s = entry.surface, n = s.positions.length / 3;
        positions.set(s.positions, vertex * 3); normals.set(s.normals, vertex * 3); tangents.set(s.tangents, vertex * 4); uv.set(s.uv, vertex * 2);
        if (lmuv && entry.placement) lmuv.set(entry.placement.uv, vertex * 2);
        if (colors && s.alpha) for (let i = 0; i < n; i++) { const p = (vertex + i) * 4; colors[p] = colors[p + 1] = colors[p + 2] = 1; colors[p + 3] = s.alpha[i]; }
        for (let i = 0; i < s.indices.length; i++) { if ((i & 16383) === 0) signal?.throwIfAborted(); indices[index + i] = s.indices[i] + vertex; }
        ranges.push([s.face, index, s.indices.length]);
        faces.push({ face: s.face, mesh, primitive: primitives.length, start: index, count: s.indices.length, vertexStart: vertex, vertexCount: n });
        vertex += n; index += s.indices.length;
      }
      const attributes: Record<string, number> = {
        POSITION: glb.accessor(positions, 'VEC3', { target: 34962, bounds: true }), NORMAL: glb.accessor(normals, 'VEC3', { target: 34962 }),
        TANGENT: glb.accessor(tangents, 'VEC4', { target: 34962 }), TEXCOORD_0: glb.accessor(uv, 'VEC2', { target: 34962 }),
      };
      if (lmuv) attributes.TEXCOORD_1 = glb.accessor(lmuv, 'VEC2', { target: 34962 });
      if (colors) attributes.COLOR_0 = glb.accessor(colors, 'VEC4', { target: 34962 });
      primitives.push({ attributes, indices: glb.accessor(indices, 'SCALAR', { target: 34963 }), material: group.material,
        // Brush faces are NOT world-PVS leaf-face members. Keep their ranges in
        // the returned associations, not geometry metadata consumed as world PVS.
        ...(!brush ? { extras: { sourceFaceRanges: ranges } } : {}) });
      result.vertices += group.vertices;
      result.geometryBytes += positions.byteLength + normals.byteLength + tangents.byteLength + uv.byteLength + indices.byteLength + (lmuv?.byteLength ?? 0) + (colors?.byteLength ?? 0);
    }
    glb.json.meshes.push({ name, primitives }); return { mesh, faces };
  };
  const sourceFrame = { sourceOrigin: [...world.frame.origin], sourceYaw: world.frame.yaw };
  const worldMesh = await pack(world.surfaces, false, 'Source world');
  if (worldMesh) {
    const node = glb.json.nodes.length;
    glb.json.nodes.push({ name: 'Source world', mesh: worldMesh.mesh, extras: sourceFrame }); glb.json.scenes[glb.json.scene].nodes.push(node);
    result.worldNodes.push(node); result.faces = worldMesh.faces;
  }
  const packedModels = new Map<number, Packed | undefined>();
  for (const brush of options.brushes ?? []) {
    signal?.throwIfAborted();
    if (!packedModels.has(brush.model)) packedModels.set(brush.model, await pack(brush.surfaces, true, `Source brush *${brush.model}`));
    const packed = packedModels.get(brush.model), node = glb.json.nodes.length;
    glb.json.nodes.push({ name: `${brush.classname}:*${brush.model}:${brush.entityIndex}`, ...(packed ? { mesh: packed.mesh } : {}), matrix: Array.from(brush.matrix), extras: {
      ...sourceFrame, sourceBrush: `*${brush.model}`, sourceClass: brush.classname, sourceEntityIndex: brush.entityIndex,
      sourceBaselineVisible: brush.baselineVisible, sourceRender: { ...brush.render, color: [...brush.render.color] }, sourceEntity: brush.entity,
      sourceBrushCapability: brush.capability,
      castShadow: brush.render.castShadow, receiveShadow: brush.render.receiveShadow,
    } });
    const attached = brush.baselineVisible && brush.capability !== 'nonvisual-brush';
    if (attached) glb.json.scenes[glb.json.scene].nodes.push(node);
    result.brushes.push({ entityIndex: brush.entityIndex, model: brush.model, node, attached, faces: packed?.faces ?? [] });
    if (brush.capability !== 'nonvisual-brush') {
      if (brush.render.effect !== 0 || brush.render.mode !== 0 || brush.render.amount !== 255 || brush.render.color.some(v => v !== 255)
        || !brush.render.castShadow || !brush.render.receiveShadow) block('brush-render-runtime', `Entity ${brush.entityIndex}: authored brush render state is retained but not implemented by the native renderer.`);
      if (brush.classname !== 'func_detail' && brush.classname !== 'func_illusionary' && brush.classname !== 'func_wall') block('brush-entity-runtime', `Entity ${brush.entityIndex}: ${brush.classname} uses authored baseline placement only; entity simulation is not implemented.`);
      if (brush.entity.values.parentname) block('brush-parenting-runtime', `Entity ${brush.entityIndex}: authored entity parenting requires native evaluation.`);
    }
  }
  result.resolvedUnlitFaces = [...resolved];
  result.requirements.push(...lighting.requirements.filter(r => !(r.code === 'face-without-baked-samples' && r.face !== undefined && resolved.has(r.face))),
    ...materials.requirements.slice(startRequirements));
  signal?.throwIfAborted(); return result;
}
