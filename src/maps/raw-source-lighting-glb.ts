/** Native atlas/cube/sidecar packaging. No renderer, network or filesystem ownership.
 * One call belongs to one import's GLB/material exporter and AbortSignal. */
import type { SourceGlb } from './raw-source-gltf';
import type { SourceMaterialExport } from './raw-source-materials';
import type { SourceLightingResult, SourceLightingRequirement } from './raw-source-lighting';
import { encodeSourcePng } from './raw-source-png';
import { canonicalSourcePath } from './raw-source-files';
import { sourceAbort } from './raw-source-lzma';
import { sourceLightingBase64 } from './raw-source-lighting-data';
import { encodeSourceJson, type SourceJsonOptions } from './raw-source-json';
import { Gzip } from 'fflate';

/** Raw page bytes compressed between cancellation checks. */
const GZIP_CHUNK_BYTES = 1024 * 1024;
/** Gzip for converted lightstyle pages. CompressionStream('gzip') follows the
 * platform zlib, whose header records the operating system, so the same map could
 * convert to different bytes (and fingerprints) on different machines. The pinned
 * pure-JS fflate encoder with mtime 0 writes a fixed header (OS byte 3) and the same
 * deflate stream everywhere; any standard gzip decoder reads it. */
export async function sourceDeterministicGzip(bytes: Uint8Array<ArrayBuffer>, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  const parts: Blob[] = [];
  let size = 0, lastYield = performance.now();
  const gzip = new Gzip({ level: 6, mtime: 0 }, chunk => { size += chunk.length; parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>])); });
  for (let offset = 0; ; offset += GZIP_CHUNK_BYTES) {
    sourceAbort(signal);
    const end = Math.min(bytes.length, offset + GZIP_CHUNK_BYTES), final = end === bytes.length;
    gzip.push(bytes.subarray(offset, end), final);
    if (size > maxBytes) throw new RangeError('Source lighting encoded output limit exceeded');
    if (final) break;
    if (performance.now() - lastYield >= 16) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
      lastYield = performance.now();
    }
  }
  sourceAbort(signal);
  return new Blob(parts);
}

export interface SourceLightmapBinding {
  flat: number;
  bump: readonly [number, number, number];
}
export interface SourceLightingGlbOptions {
  signal?: AbortSignal;
  maxAtlasBytes: number;
  /** Encoded PNGs and sidecars, not an estimate of total JS/GPU memory. */
  maxOutputBytes: number;
  maxCubeWork: number;
  /** Retained style strings/extraction and worst-case per-tick decoded texel work. */
  maxStyleBytes?: number;
  maxStyleWork?: number;
  jsonLimits?: Omit<SourceJsonOptions, 'maxBytes' | 'signal'>;
}
export interface SourceLightingGlbAssets {
  lightmaps: SourceLightmapBinding[];
  files: Map<string, Blob>;
  cubes: { position: number[]; path: string | null; faces?: readonly number[] }[];
  requirements: SourceLightingRequirement[];
  /** Positive CPU/packaging evidence only. Parent must still bind and qualify the
   * owning parser's textures before resolving any native runtime requirement. */
  directionalStyles: {
    face: number;
    page: number;
    flat: number;
    bumpPages: readonly [number, number, number];
  }[];
  /** Source-space point. Missing nearest cubes never silently select a farther one. */
  cubeAt(position: readonly number[]): readonly number[] | undefined;
}
function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid Source lighting ${name} limit`);
  return value;
}

/** Bind only native cube textures in this exporter's owning GLB. Props do not
 * need a second copy of the world atlas or its parser-specific style indices. */
export async function appendSourceCubemaps(materials: SourceMaterialExport,
  cubemaps: SourceLightingResult['cubemaps'], options: { signal?: AbortSignal; maxWork: number }):
  Promise<Pick<SourceLightingGlbAssets, 'cubes' | 'cubeAt'>> {
  const { signal } = options, maxWork = limit(options.maxWork, 'cubemap work');
  sourceAbort(signal);
  const cubes: SourceLightingGlbAssets['cubes'] = [];
  let work = 0;
  for (const cube of cubemaps) {
    sourceAbort(signal);
    if (cube.position.length !== 3 || cube.position.some(v => !Number.isFinite(v))) throw new RangeError('Invalid Source cubemap position');
    const entry: SourceLightingGlbAssets['cubes'][number] = { position: [...cube.position], path: cube.path };
    if (cube.path && cube.blob) {
      const faces: number[] = [];
      for (let face = 0; face < 6; face++) {
        const index = await materials.texture(cube.path, 0, face); sourceAbort(signal);
        if (index !== undefined) faces.push(index);
      }
      if (faces.length === 6) entry.faces = faces;
    }
    cubes.push(entry);
  }
  return { cubes, cubeAt(position) {
    sourceAbort(signal);
    if (position.length !== 3 || position.some(v => !Number.isFinite(v))) throw new RangeError('Invalid Source cubemap sample point');
    let nearest: (typeof cubes)[number] | undefined, best = Infinity;
    for (const cube of cubes) {
      if (++work > maxWork) throw new RangeError('Source cubemap selection work limit exceeded');
      const dx = cube.position[0] - position[0], dy = cube.position[1] - position[1], dz = cube.position[2] - position[2];
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < best) { best = distance; nearest = cube; }
    }
    return nearest?.faces;
  } };
}

/** Actual texture indices replace CPU atlas page IDs only in serialized snapshots.
 * Missing native capabilities stay blocking; partial output is discarded on throw. */
export async function appendSourceLightingAssets(glb: SourceGlb, materials: SourceMaterialExport,
  lighting: SourceLightingResult, options: SourceLightingGlbOptions): Promise<SourceLightingGlbAssets> {
  const signal = options.signal;
  sourceAbort(signal);
  const maxAtlasBytes = limit(options.maxAtlasBytes, 'atlas byte');
  const maxOutputBytes = limit(options.maxOutputBytes, 'output byte');
  const maxStyleBytes = limit(options.maxStyleBytes ?? options.maxAtlasBytes, 'style byte');
  const maxStyleWork = limit(options.maxStyleWork ?? 200_000_000, 'style work');
  let atlasBytes = 0, outputBytes = 0;
  const files = new Map<string, Blob>(), lightmaps: SourceLightmapBinding[] = [];
  const directionalStyles: SourceLightingGlbAssets['directionalStyles'] = [];
  const requirements = [...lighting.requirements], materialStart = materials.requirements.length;
  const account = (blob: Blob) => {
    sourceAbort(signal);
    if (blob.size > maxOutputBytes - outputBytes) throw new RangeError('Source lighting encoded output limit exceeded');
    outputBytes += blob.size;
  };
  const add = (name: string, blob: Blob) => {
    const path = canonicalSourcePath(name);
    if (files.has(path)) throw new Error(`Duplicate Source lighting sidecar ${path}`);
    account(blob); files.set(path, blob);
  };
  const json = (name: string, data: unknown) => add(name, new Blob([encodeSourceJson(data,
    { ...options.jsonLimits, maxBytes: maxOutputBytes - outputBytes, signal })], { type: 'application/json' }));
  for (const page of lighting.pages) {
    const bytes = page.width * page.height * 4;
    if (!Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height) || page.width < 1 || page.height < 1
      || !Number.isSafeInteger(bytes) || page.layers.length !== 4) throw new RangeError('Invalid Source lighting atlas layout');
    for (const layer of page.layers) {
      if (!(layer instanceof Uint8Array) || layer.byteLength !== bytes || layer.byteLength > maxAtlasBytes - atlasBytes)
        throw new RangeError('Source lighting atlas allocation limit or layer length mismatch');
      atlasBytes += layer.byteLength;
    }
  }
  // Native cube textures deliberately precede atlas textures; page numbers are not texture IDs.
  const cubeAssets = await appendSourceCubemaps(materials, lighting.cubemaps,
    { signal, maxWork: options.maxCubeWork });
  const sampler = glb.json.samplers.length;
  if (lighting.pages.length) glb.json.samplers.push({ wrapS: 33071, wrapT: 33071, magFilter: 9729, minFilter: 9729 });
  for (const page of lighting.pages) {
    const indices: number[] = [];
    for (const rgba of page.layers) {
      const png = await encodeSourcePng(page.width, page.height, rgba, signal); account(png);
      const image = glb.json.images.length;
      glb.json.images.push({ bufferView: glb.view(png), mimeType: 'image/png' });
      indices.push(glb.json.textures.length); glb.json.textures.push({ source: image, sampler });
    }
    lightmaps.push({ flat: indices[0], bump: [indices[1], indices[2], indices[3]] });
  }
  const binding = (page: number): SourceLightmapBinding => {
    if (!Number.isSafeInteger(page) || page < 0 || !lightmaps[page]) throw new RangeError('Source lightstyle atlas page out of bounds');
    return lightmaps[page];
  };
  const pages: Record<string, string> = Object.create(null);
  const styleFiles = new Set<number>();
  const directionalPages = new Set<number>();
  let styleBytes = 0, styleWork = 0;
  const chargeStyle = (bytes: number, work: number) => {
    sourceAbort(signal);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxStyleBytes - styleBytes)
      throw new RangeError('Source lighting style byte limit exceeded');
    if (!Number.isSafeInteger(work) || work < 0 || work > maxStyleWork - styleWork)
      throw new RangeError('Source lighting style work limit exceeded');
    styleBytes += bytes; styleWork += work;
  };
  const rectangle = (p: { page: number; x: number; y: number }) => `${p.page}:${p.x}:${p.y}`;
  const placements = new Map<string, SourceLightingResult['placements'][number]>();
  for (const placement of lighting.placements) {
    sourceAbort(signal);
    const key = rectangle(placement);
    if (placements.has(key)) throw new Error('Duplicate Source lightstyle placement');
    placements.set(key, placement);
  }
  const patched = new Set<string>();
  const patches = lighting.native.lightstyles.patches.map(patch => {
    sourceAbort(signal);
    const key = rectangle(patch), placement = placements.get(key), page = lighting.pages[patch.page];
    binding(patch.page);
    if (!placement || patched.has(key) || !page || !Number.isSafeInteger(placement.face) || placement.face < 0
      || !Number.isSafeInteger(patch.width) || !Number.isSafeInteger(patch.height) || patch.width < 1 || patch.height < 1
      || !Number.isSafeInteger(patch.x) || !Number.isSafeInteger(patch.y) || patch.x < 1 || patch.y < 1
      || patch.x + patch.width >= page.width || patch.y + patch.height >= page.height
      || placement.width !== patch.width || placement.height !== patch.height
      || !patch.styles.length || patch.styles.length > 4 || new Set(patch.styles).size !== patch.styles.length
      || patch.styles.some((style, i) => !Number.isSafeInteger(style) || style < 0 || style > 254 || style !== placement.styles[i])
      || patch.styles.length !== placement.styles.length || (placement.layersPerStyle !== 1 && placement.layersPerStyle !== 4)
      || patch.bumpPages !== undefined || patch.bumpSamples !== undefined)
      throw new Error('Source lightstyle patch/placement layout mismatch');
    patched.add(key);
    const count = patch.width * patch.height, bytes = count * patch.styles.length * 4, layers = placement.layersPerStyle;
    if (placement.samples.byteLength !== bytes * layers || typeof patch.samples !== 'string'
      || patch.samples.length !== Math.ceil(bytes / 3) * 4) throw new RangeError('Source lightstyle sample length mismatch');
    const work = layers === 4
      ? (count * patch.styles.length * 4 + (patch.width + 2) * (patch.height + 2)) * 4
      : (patch.width + 2) * (patch.height + 2) * patch.styles.length * 4;
    chargeStyle(patch.samples.length * 2, work);
    const bound = binding(patch.page);
    if (layers === 1) {
      chargeStyle(patch.samples.length * 2, 0);
      if (sourceLightingBase64(placement.samples) !== patch.samples) throw new Error('Source lightstyle samples do not match the owned flat placement');
      return { ...patch, page: bound.flat };
    }
    // Extract the original layer-major RGBExp32, not quantized page pixels.
    chargeStyle(4 * (bytes + Math.ceil(bytes / 3) * 8), 0);
    const extract = (layer: number) => {
      const samples = new Uint8Array(bytes);
      for (let style = 0; style < patch.styles.length; style++) {
        sourceAbort(signal);
        const from = (style * 4 + layer) * count * 4;
        samples.set(placement.samples.subarray(from, from + count * 4), style * count * 4);
      }
      return sourceLightingBase64(samples);
    };
    if (extract(0) !== patch.samples) throw new Error('Source lightstyle flat samples do not match the owned directional placement');
    const bumpSamples: [string, string, string] = [extract(1), extract(2), extract(3)];
    directionalPages.add(patch.page);
    directionalStyles.push({ face: placement.face, page: patch.page, flat: bound.flat, bumpPages: bound.bump });
    return { ...patch, page: bound.flat, bumpPages: [...bound.bump] as [number, number, number], bumpSamples };
  });
  for (const placement of lighting.placements) {
    if (placement.layersPerStyle === 4 && placement.styles.some(style => style !== 0) && !patched.has(rectangle(placement)))
      throw new Error('Missing Source directional lightstyle patch');
  }
  const compressPage = async (file: string, texture: number, rgba: Uint8Array) => {
    sourceAbort(signal);
    if (!(rgba.buffer instanceof ArrayBuffer)) throw new TypeError('Shared Source lightstyle input is not immutable');
    const view = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    add(file, await sourceDeterministicGzip(view, maxOutputBytes - outputBytes, signal)); pages[String(texture)] = file;
  };
  for (const page of lighting.native.stylePages) {
    sourceAbort(signal);
    const bound = binding(page.page), atlas = lighting.pages[page.page], size = lighting.native.lightstyles.size;
    if (styleFiles.has(page.page) || lighting.native.lightstyles.pages[String(page.page)] !== page.file
      || atlas.width !== size || atlas.height !== size || page.rgba.byteLength !== size ** 2 * 4
      || page.rgba.some((value, i) => value !== atlas.layers[0][i])) throw new Error('Source lightstyle page layout mismatch');
    styleFiles.add(page.page);
    await compressPage(page.file, bound.flat, page.rgba);
    if (directionalPages.has(page.page)) for (let layer = 1; layer < 4; layer++) {
      await compressPage(`lightmap_${page.page}.bump${layer}.rgba.gz`, bound.bump[layer - 1], atlas.layers[layer]);
    }
  }
  if (Object.keys(lighting.native.lightstyles.pages).length !== styleFiles.size) throw new Error('Missing Source lightstyle page payload');
  for (const patch of lighting.native.lightstyles.patches) {
    if (!styleFiles.has(patch.page)) throw new Error('Source lightstyle patch has no owned page payload');
  }
  json('lightstyles.json', { ...lighting.native.lightstyles, pages, patches });
  json('lighting.json', lighting.native.lighting);
  if (lighting.native.visibility) json('visibility.json', lighting.native.visibility);
  const writtenLuts = new Map<string, string>();
  for (const layer of lighting.native.colorCorrections) {
    const blob = lighting.companions.get(layer.source);
    if (!blob) throw new Error(`Missing selected Source color-correction file ${layer.source}`);
    const file = canonicalSourcePath(layer.file), previous = writtenLuts.get(file);
    if (previous !== undefined) {
      if (previous !== layer.source) throw new Error(`Conflicting Source color-correction file ${file}`);
      continue;
    }
    add(file, blob); writtenLuts.set(file, layer.source);
  }
  requirements.push(...materials.requirements.slice(materialStart));
  sourceAbort(signal);
  return { lightmaps, files, requirements, directionalStyles, ...cubeAssets };
}
