/** Native Source payload metadata for the existing MapSource/Scene/worker ABI.
 * Callers supply actual visual and physics outputs; this module never converts
 * archives, invents collision/light, discovers resources or qualifies runtime capabilities. */
import type { SourceWorld } from './raw-source-geometry';
import type { SourceLightingResult, SourceLightingRequirement } from './raw-source-lighting';
import type { SourceLightingGlbAssets } from './raw-source-lighting-glb';
import { encodeSourceJson, preflightSourceJson, type SourceJsonOptions } from './raw-source-json';
import type { SourceMapPropView } from './source';

export interface SourceMapLight {
  azimuth: number; elevation: number; color: number; intensity: number;
  ambientColor: number; ambient: number;
}
/** The existing import_source_materials.py LDR renderer metadata, not a capability receipt. */
export interface SourceMapRenderer { version: 1; color: 'ldr-gamma-lut'; antialiasing: 'fxaa' }
export interface SourceMapManifest {
  id: string; name: string; game: string;
  files: string[]; visual: 'visual.glb'; props?: { visual: 'props.glb' };
  boxes: number; hulls: number; hfields: number; disp_prisms: number;
  source_lightmaps: SourceLightingResult['manifest']['source_lightmaps'];
  light: SourceMapLight | null;
  spawn: string; spawn_source: number[]; spawn_yaw: number;
  visibility?: 'visibility.json';
  source_renderer?: SourceMapRenderer;
  source_prop_view?: SourceMapPropView;
  color_corrections?: { file: string; origin: number[]; enabled: boolean; minfalloff: number; maxfalloff: number }[];
}
export interface SourceMapFilesOptions {
  id: string; name: string; game: string;
  /** Only the actual physics closure, including map.xml. Never raw game inputs. */
  physics: ReadonlyMap<string, Blob>;
  visual: Blob;
  props?: Blob;
  /** Explicit parent decision. Null omits the renderer declaration. */
  renderer: SourceMapRenderer | null;
  /** Other writers' unresolved requirements; none are resolved or discarded here. */
  requirements: readonly SourceLightingRequirement[];
  signal?: AbortSignal;
  maxOutputBytes: number;
  maxMetadataBytes: number;
  maxMetadataAllocationBytes: number;
  maxFiles?: number;
  jsonLimits?: Omit<SourceJsonOptions, 'signal' | 'maxBytes'>;
}
export interface SourceMapFiles {
  manifest: SourceMapManifest;
  files: ReadonlyMap<string, Blob>;
  requirements: readonly SourceLightingRequirement[];
  limitations: readonly string[];
}

/** Matches scripts/import_source_bsp.py map_light: only an authored
 * light_environment produces a light. Missing sun stays null. */
export function sourceMapLight(world: SourceWorld): SourceMapLight | null {
  const entity = world.bsp.entities.find(item => item.values.classname === 'light_environment');
  if (!entity) return null;
  if (!Number.isFinite(world.frame.yaw)) throw new Error('Invalid Source light_environment frame yaw');
  const values = entity.values;
  const vector = (text: string, lengths: readonly number[]) => {
    const parts = text.trim().split(/\s+/, 5);
    if (!lengths.includes(parts.length) || parts.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)))
      throw new Error('Invalid Source light_environment values');
    const result = parts.map(Number);
    if (result.some(value => !Number.isFinite(value))) throw new Error('Nonfinite Source light_environment values');
    return result;
  };
  const angles = vector(values.angles ?? '0 0 0', [3]);
  const pitch = values.pitch === undefined ? angles[0] : -vector(values.pitch, [1])[0];
  const direct = vector(values._light ?? '255 255 255 200', [3, 4]);
  const ambient = vector(values._ambient ?? '60 70 90 60', [3, 4]);
  if (direct.some(value => value < 0) || ambient.some(value => value < 0))
    throw new Error('Invalid negative Source light_environment value');
  const color = (rgb: number[]) => (Math.trunc(Math.min(rgb[0], 255)) << 16)
    | (Math.trunc(Math.min(rgb[1], 255)) << 8) | Math.trunc(Math.min(rgb[2], 255));
  return {
    azimuth: Math.round((((angles[1] - world.frame.yaw + 360) % 360 + 360) % 360 - 180) * 10) / 10,
    elevation: Math.round(Math.max(5, Math.min(89, pitch)) * 10) / 10,
    color: color(direct), intensity: Math.round(Math.max(0.6, Math.min(4, Math.sqrt((direct[3] ?? 255) / 255) * 1.8)) * 100) / 100,
    ambientColor: color(ambient), ambient: Math.round(Math.max(0.35, Math.min(2, Math.sqrt((ambient[3] ?? 255) / 255) * 1.2)) * 100) / 100,
  };
}

/** Select only actual packaged runtime assets. Generic path/schema/dependency
 * validation and canonical identity remain exclusively in bundle.ts. This
 * synchronous composition snapshots Blob bodies before returning; bounded JSON
 * preflight covers newly copied metadata and manifest encoding, not the caller's
 * retained BSP/lighting/GLB data or whole-browser memory. */
export function composeSourceMapFiles(world: SourceWorld, lighting: SourceLightingResult,
  assets: SourceLightingGlbAssets, options: SourceMapFilesOptions): SourceMapFiles {
  const { signal } = options;
  signal?.throwIfAborted();
  for (const value of [options.maxOutputBytes, options.maxMetadataBytes, options.maxMetadataAllocationBytes, options.maxFiles ?? 65534])
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid Source manifest resource limit');
  const maxFiles = Math.min(options.maxFiles ?? 65534, 65534);
  const fileCount = options.physics.size + assets.files.size + 2 + (options.props === undefined ? 0 : 1);
  if (fileCount > maxFiles) throw new RangeError('Source manifest file limit exceeded');
  let metadataBytes = 0, allocationBytes = fileCount * 1024;
  if (allocationBytes > options.maxMetadataAllocationBytes) throw new RangeError('Source manifest metadata allocation limit exceeded');
  // Preflight borrowed graphs before making per-layer/requirement/path copies.
  for (const graph of [lighting.native.colorCorrections, lighting.manifest, lighting.requirements,
    assets.requirements, options.requirements, world.limitations]) {
    const size = preflightSourceJson(graph, { ...options.jsonLimits, signal, maxBytes: options.maxMetadataBytes - metadataBytes });
    metadataBytes += size.byteLength;
    allocationBytes += size.byteLength * 4 + size.nodes * 128 + size.members * 64;
    if (!Number.isSafeInteger(allocationBytes) || allocationBytes > options.maxMetadataAllocationBytes)
      throw new RangeError('Source manifest metadata allocation limit exceeded');
  }
  if (world.frame.origin.length !== 3 || world.frame.origin.some(value => !Number.isFinite(value))
    || !Number.isFinite(world.frame.yaw) || world.frame.metresPerUnit !== 0.0254 || world.frame.up !== 'Z')
    throw new Error('Invalid native Source world frame');
  if (!options.physics.has('map.xml')) throw new Error('Source physics output must include map.xml');
  if (!assets.files.has('lighting.json') || !assets.files.has('lightstyles.json')
    || assets.files.has('visibility.json') !== (lighting.native.visibility !== null))
    throw new Error('Source lighting sidecars do not match native lighting output');
  if (options.renderer !== null && (options.renderer.version !== 1 || options.renderer.color !== 'ldr-gamma-lut'
    || options.renderer.antialiasing !== 'fxaa' || lighting.identity.hdr))
    throw new Error('Source renderer metadata does not describe the supplied native lighting');
  // CWorld's FIELD_FLOAT endpoints are zero-initialized; view fade settings are separate.
  const worldspawn = world.bsp.entities.find(item => item.values.classname === 'worldspawn');
  let minText: string | undefined, maxText: string | undefined;
  if (worldspawn) for (const [key, text] of worldspawn.pairs) {
    signal?.throwIfAborted();
    const suffix = key.indexOf('#'), name = (suffix < 0 ? key : key.slice(0, suffix)).toLowerCase();
    if (name === 'minpropscreenwidth') minText = text;
    else if (name === 'maxpropscreenwidth') maxText = text;
  }
  let propView: SourceMapPropView | undefined;
  let propViewRequirement: SourceLightingRequirement | undefined;
  if (minText !== undefined || maxText !== undefined) {
    const scalar = (text: string | undefined): number | undefined => {
      if (text === undefined) return 0;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return undefined;
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    };
    const min = scalar(minText), max = scalar(maxText);
    if (min !== undefined && max !== undefined) propView = { levelScreenFade: [min, max] };
    else propViewRequirement = { code: 'prop-level-screen-fade-policy', blocking: true,
      detail: 'Worldspawn level screen fade requires finite authored endpoints; absent fields remain zero.' };
  }
  const files = new Map<string, Blob>();
  let outputBytes = 0;
  const add = (path: string, input: Blob) => {
    signal?.throwIfAborted();
    if (files.has(path)) throw new Error(`Duplicate generated Source resource ${path}`);
    if (input.size > options.maxOutputBytes - outputBytes) throw new RangeError('Source manifest output limit exceeded');
    if (files.size >= maxFiles) throw new RangeError('Source manifest file limit exceeded');
    const pathBytes = path.length * 8;
    if (pathBytes > options.maxMetadataAllocationBytes - allocationBytes) throw new RangeError('Source manifest path metadata limit exceeded');
    allocationBytes += pathBytes;
    // Retain native immutable Blob ownership, not a caller's mutable buffer/view.
    const blob = Blob.prototype.slice.call(input, 0, input.size, input.type) as Blob;
    outputBytes += blob.size; files.set(path, blob);
  };
  for (const [path, blob] of options.physics) {
    // The caller supplies a physics closure, not an arbitrary output directory.
    if (!/\.(?:xml|stl|obj|msh|png|bin)$/i.test(path)) throw new Error(`Not a Source physics resource: ${path}`);
    add(path, blob);
  }
  add('visual.glb', options.visual);
  if (options.props !== undefined) add('props.glb', options.props);
  const luts = new Set(lighting.native.colorCorrections.map(layer => layer.file));
  for (const [path, blob] of assets.files) {
    if (!['lighting.json', 'lightstyles.json', 'visibility.json'].includes(path)
      && !/^lightmap_\d+(?:\.bump[123])?\.rgba\.gz$/.test(path) && !luts.has(path))
      throw new Error(`Not a packaged Source runtime resource: ${path}`);
    add(path, blob);
  }
  const colorCorrections = lighting.native.colorCorrections.map(layer => {
    if (!/^source-color-\d+\.rgb$/.test(layer.file) || !files.has(layer.file)
      || layer.origin.length !== 3 || layer.origin.some(value => !Number.isFinite(value))
      || !Number.isFinite(layer.minfalloff) || !Number.isFinite(layer.maxfalloff) || typeof layer.enabled !== 'boolean')
      throw new Error('Invalid packaged Source color-correction layer');
    return { file: layer.file, origin: [...layer.origin], enabled: layer.enabled,
      minfalloff: layer.minfalloff, maxfalloff: layer.maxfalloff };
  });
  const manifest: SourceMapManifest = {
    id: options.id, name: options.name, game: options.game,
    files: [...options.physics.keys()].sort(), visual: 'visual.glb',
    boxes: 0, hulls: 0, hfields: 0, disp_prisms: 0,
    source_lightmaps: { ...lighting.manifest.source_lightmaps }, light: sourceMapLight(world),
    spawn: world.frame.spawnClass, spawn_source: [...world.frame.origin], spawn_yaw: world.frame.yaw,
  };
  for (const collision of world.collision) {
    signal?.throwIfAborted();
    if (collision.kind === 'box') manifest.boxes++;
    else if (collision.kind === 'heightfield') manifest.hfields++;
    else if (collision.kind === 'displacement-prism') manifest.disp_prisms++;
    else manifest.hulls++;
  }
  if (options.props !== undefined) manifest.props = { visual: 'props.glb' };
  if (lighting.native.visibility !== null) manifest.visibility = 'visibility.json';
  if (options.renderer !== null) manifest.source_renderer = { ...options.renderer };
  if (colorCorrections.length) manifest.color_corrections = colorCorrections;
  if (propView !== undefined) manifest.source_prop_view = propView;
  const size = preflightSourceJson(manifest, { ...options.jsonLimits, signal,
    maxBytes: Math.min(options.maxMetadataBytes - metadataBytes, options.maxOutputBytes - outputBytes) });
  allocationBytes += size.byteLength * 4 + size.nodes * 128 + size.members * 64;
  if (!Number.isSafeInteger(allocationBytes) || allocationBytes > options.maxMetadataAllocationBytes)
    throw new RangeError('Source manifest metadata allocation limit exceeded');
  const bytes = encodeSourceJson(manifest, { ...options.jsonLimits, signal, maxBytes: size.byteLength });
  add('manifest.json', new Blob([bytes], { type: 'application/json' }));
  // Writers retain their input blockers, and per-variant writers can repeat the
  // same cause. Join identical code/path/face/detail records once, without
  // collapsing independently authored faces or paths that share a code.
  const causes = new Map<string, SourceLightingRequirement>();
  for (const requirement of [...lighting.requirements, ...assets.requirements, ...options.requirements, ...(propViewRequirement ? [propViewRequirement] : [])]) {
    const key = JSON.stringify([requirement.code, requirement.path ?? null, requirement.face ?? null, requirement.detail]);
    if (!causes.has(key)) causes.set(key, requirement);
  }
  const requirements = Array.from(causes.values(), item => Object.freeze({ ...item }));
  signal?.throwIfAborted();
  return { manifest, files, requirements: Object.freeze(requirements), limitations: Object.freeze([...world.limitations]) };
}
