/** CPU Source lighting assembly. RGBExp32/RGBM and atlas rules follow this project's
 * scripts/source_lightmaps.py and noclip.website (Copyright 2018 Jasper St. Pierre,
 * MIT; see LICENSE.noclip). No renderer, image encoder, URL or network ownership. */
import type { SourceWorld, SourceSurface } from './raw-source-geometry';
import type { SourceFileSystem } from './raw-source-files';
import type { SourceEntity, SourceLump } from './raw-source-bsp';
import { sourceAbort } from './raw-source-lzma';
import type { SourceVisibilityData } from '../render/source-sky3d';
import { readSourceLightingMetadata, sourceLightingBase64, sourceLightingLimit, sourceLightingYield } from './raw-source-lighting-data';

export interface SourceLightingRequirement {
  code: string;
  detail: string;
  /** A native integration must implement/resolve this before claiming fidelity. */
  blocking: true;
  face?: number;
  path?: string;
}
export interface SourceLightingOptions {
  signal?: AbortSignal;
  atlasSize?: number;
  /** Aggregate four-layer page + UV allocation ceiling; not a per-page limit. */
  maxAtlasBytes?: number;
  /** Shared metadata record and traversal/RLE work limits. */
  maxRecords?: number;
  maxWork?: number;
  maxCompanionBytes?: number;
  /** Actual selected BSP's map stem, never inferred from an unrelated archive. */
  mapName?: string;
  /** Only these explicitly chosen VFS paths may be read, including LUTs/cubes. */
  selectedCompanionPaths?: readonly string[];
}
export interface SourceLightingPage {
  width: number;
  height: number;
  /** [flat, bump1, bump2, bump3], top row first, RGBA8 RGBM range 6.
   * Non-bump tiles repeat flat in directional layers, as the native converter. */
  layers: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
}
export interface SourceLightingPlacement {
  face: number;
  page: number;
  /** Interior rectangle, excluding its one-texel replicated-edge gutter. */
  x: number; y: number; width: number; height: number;
  /** TEXCOORD_1 in the surface's unchanged vertex order. Input already has +.5. */
  uv: Float32Array;
  styles: Uint8Array;
  layersPerStyle: number;
  /** Borrowed immutable view: style-major, then layer-major, then row-major RGBExp32. */
  samples: Uint8Array;
  hdr: boolean;
}
export interface SourceNativeLightStyles {
  size: number;
  /** Keys are CPU atlas pages until packaging remaps them to actual GLB textures. */
  pages: Record<string, string>;
  patches: {
    page: number; x: number; y: number; width: number; height: number; styles: number[]; samples: string;
    /** Optional paired native extension; indices belong to the owning GLTFParser. */
    bumpPages?: [number, number, number];
    bumpSamples?: [string, string, string];
  }[];
  patterns: Record<string, { pattern: string | null; default: number; off: boolean }>;
}
export interface SourceWorldLightData {
  pos: number[]; color: number[]; normal: number[]; kind: number; style: number;
  inner: number; outer: number; exponent: number; radius: number; attenuation: number[]; flags: number;
}
export interface SourceAmbientLightingData {
  origin: number[]; yaw: number; head: number; nodes: number[][];
  /** Each sample: Source-space xyz followed by 6 RGB triples (+X,-X,+Y,-Y,+Z,-Z). */
  leaves: number[][][];
  lights: SourceWorldLightData[];
}
export interface SourceLightingResult {
  pages: SourceLightingPage[];
  placements: SourceLightingPlacement[];
  /** Exact serializable existing sidecar ABIs. Null means missing, never a fake probe. */
  native: {
    lighting: SourceAmbientLightingData;
    visibility: SourceVisibilityData | null;
    lightstyles: SourceNativeLightStyles;
    /** Raw flat pages: write verbatim .rgba or gzip to the native .rgba.gz names. */
    stylePages: { page: number; file: string; rgba: Uint8Array }[];
    colorCorrections: { file: string; source: string; origin: number[]; enabled: boolean; minfalloff: number; maxfalloff: number }[];
  };
  manifest: { source_lightmaps: { version: 1; pages: number; faces: number; hdr: boolean; encoding: 'RGBM6' } };
  /** Parent assigns texture indices; do NOT serialize page numbers as texture indices. */
  glb: {
    uvAttribute: 'TEXCOORD_1'; flatExtra: 'sourceLightmap'; bumpExtra: 'sourceBumpLightmaps';
    faceRangesExtra: 'sourceFaceRanges';
    sampler: { wrapS: 33071; wrapT: 33071; magFilter: 9729; minFilter: 9729; flipY: false; generateMipmaps: false; colorSpace: 'linear' };
  };
  cubemaps: { position: number[]; size: number; hdr: boolean; path: string | null; blob?: Blob }[];
  /** Caller-selected files, retained without unnecessary decoding/copying. */
  companions: ReadonlyMap<string, Blob>;
  /** Area portals are not flattened into an all-visible PVS. */
  areas: { numPortals: number; firstPortal: number }[];
  areaPortals: { key: number; otherArea: number; firstClipVertex: number; clipVertexCount: number; plane: number }[];
  areaPortalClipVertices: Float32Array;
  leafAreas: number[];
  /** Original binary ownership, including both HDR/LDR and portal clip vertices. */
  original: { lumps: readonly SourceLump[]; entities: readonly SourceEntity[]; surfaces: readonly SourceSurface[] };
  authored: {
    skyName: string | null;
    entities: readonly SourceEntity[];
  };
  identity: { hdr: boolean; lightingLump: 8 | 53; worldLightsLump: 15 | 54; ambientLightingLump: 55 | 56; ambientIndexLump: 51 | 52 };
  requirements: SourceLightingRequirement[];
  capabilities: {
    rgbm6: true; flatStyles: true; directionalStatic: true;
    directionalStylesNative: false; hdrPostprocessingNative: false; areaPortalsNative: false;
    entitySimulationNative: false;
  };
}


/** Static atlas parity: Float32 accumulation, then double precision RGBM6 packing.
 * Directional layers use flat/mean(directionals), not an averaged flat replacement. */
async function paint(placement: SourceLightingPlacement, page: SourceLightingPage, signal?: AbortSignal): Promise<void> {
  const { width, height, styles, layersPerStyle: layers, samples } = placement;
  const count = width * height, sums = new Float32Array(12);
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0) await sourceLightingYield(signal);
    for (let x = 0; x < width; x++) {
      sums.fill(0);
      for (let style = 0; style < styles.length; style++) for (let layer = 0; layer < layers; layer++) {
        const at = ((style * layers + layer) * count + y * width + x) * 4;
        const byte = samples[at + 3], scale = 2 ** (byte > 127 ? byte - 256 : byte) / 255;
        for (let c = 0; c < 3; c++) sums[layer * 3 + c] += samples[at + c] * scale;
      }
      const out = ((placement.y + y) * page.width + placement.x + x) * 4;
      for (let layer = 0; layer < 4; layer++) {
        let r = sums[0], g = sums[1], b = sums[2];
        if (layer > 0 && layers === 4) {
          const ar = (sums[3] + sums[6] + sums[9]) / 3, ag = (sums[4] + sums[7] + sums[10]) / 3, ab = (sums[5] + sums[8] + sums[11]) / 3;
          r = ar ? sums[layer * 3] * (sums[0] / ar) : 0;
          g = ag ? sums[layer * 3 + 1] * (sums[1] / ag) : 0;
          b = ab ? sums[layer * 3 + 2] * (sums[2] / ab) : 0;
        }
        r = Math.max(0, Math.min(1, r / 6)); g = Math.max(0, Math.min(1, g / 6)); b = Math.max(0, Math.min(1, b / 6));
        const m = Math.ceil(Math.max(r, g, b, 1e-6) * 255) / 255, pixels = page.layers[layer];
        pixels[out] = r / m * 255; pixels[out + 1] = g / m * 255; pixels[out + 2] = b / m * 255; pixels[out + 3] = m * 255;
      }
    }
  }
  // Duplicate edges including corners, so bilinear samples never bleed another face.
  for (const pixels of page.layers) {
    for (let y = 0; y < height; y++) {
      const row = ((placement.y + y) * page.width + placement.x) * 4;
      pixels.copyWithin(row - 4, row, row + 4);
      pixels.copyWithin(row + width * 4, row + (width - 1) * 4, row + width * 4);
    }
    const row = ((placement.y) * page.width + placement.x - 1) * 4, length = (width + 2) * 4;
    pixels.copyWithin(row - page.width * 4, row, row + length);
    const last = row + (height - 1) * page.width * 4;
    pixels.copyWithin(last + page.width * 4, last, last + length);
  }
}

export async function buildSourceLighting(world: SourceWorld, filesystem: Pick<SourceFileSystem, 'readFile'>, options: SourceLightingOptions = {}): Promise<SourceLightingResult> {
  sourceAbort(options.signal);
  const size = sourceLightingLimit(options.atlasSize, 2048, 'atlas size');
  if (size < 4 || size > 16384) throw new Error('Source lighting atlas size must be 4..16384');
  const maxBytes = sourceLightingLimit(options.maxAtlasBytes, 512 * 1024 * 1024, 'atlas bytes');
  const maxRecords = sourceLightingLimit(options.maxRecords, 2_000_000, 'records');
  const maxWork = sourceLightingLimit(options.maxWork, 200_000_000, 'work');
  if (world.surfaces.length > maxRecords) throw new Error('Source lighting surface limit exceeded');
  const hdr = world.bsp.lumps[53].length > 0;
  const requirements: SourceLightingRequirement[] = [], pages: SourceLightingPage[] = [], placements: SourceLightingPlacement[] = [];
  const lightstyles: SourceNativeLightStyles = { size, pages: {}, patches: [], patterns: {} };
  let allocated = 0, work = 0, x = 0, y = 0, rowHeight = 0;
  const charge = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - allocated) throw new Error('Source lighting aggregate atlas/UV byte limit exceeded');
    allocated += bytes;
  };
  // Same stable descending-height shelf order as the native LightmapAtlas.
  const surfaces = world.surfaces.filter(s => s.visible).sort((a, b) => b.lightmap.height - a.lightmap.height);
  for (let si = 0; si < surfaces.length; si++) {
    if ((si & 31) === 0) await sourceLightingYield(options.signal);
    const surface = surfaces[si], lm = surface.lightmap;
    if (lm.hdr !== hdr) throw new Error(`Face ${surface.face}: mixed lightmap HDR identity`);
    const end = lm.styles.indexOf(255), styles = end < 0 ? lm.styles : lm.styles.subarray(0, end);
    if (lm.styles.length !== 4 || (end >= 0 && lm.styles.subarray(end).some(s => s !== 255))) throw new Error(`Face ${surface.face}: nonterminal lightstyle sentinel`);
    if (lm.offset < 0 || !styles.length) {
      requirements.push({ code: 'face-without-baked-samples', blocking: true, face: surface.face, detail: 'No RGBExp32 lightmap: assembler must resolve authored unlit/fullbright semantics; no white tile was fabricated.' });
      continue;
    }
    const { width, height, layersPerStyle: layers } = lm;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width + 2 > size || height + 2 > size || (layers !== 1 && layers !== 4)) throw new Error(`Face ${surface.face}: invalid or oversized lightmap`);
    const expected = width * height * styles.length * layers * 4;
    if (lm.samples.length !== expected) throw new Error(`Face ${surface.face}: RGBExp32 sample length mismatch`);
    work += expected + (width + 2) * (height + 2) * 16;
    if (!Number.isSafeInteger(work) || work > maxWork) throw new Error('Source lighting pixel work limit exceeded');
    if (x + width + 2 > size) { x = 0; y += rowHeight; rowHeight = 0; }
    if (!pages.length || y + height + 2 > size) {
      charge(size * size * 16);
      pages.push({ width: size, height: size, layers: [new Uint8Array(size * size * 4), new Uint8Array(size * size * 4), new Uint8Array(size * size * 4), new Uint8Array(size * size * 4)] });
      x = y = rowHeight = 0;
    }
    if (surface.lightmapLuxels.length !== surface.positions.length / 3 * 2) throw new Error(`Face ${surface.face}: lightmap UV vertex count mismatch`);
    charge(surface.lightmapLuxels.byteLength);
    const uv = new Float32Array(surface.lightmapLuxels.length);
    for (let i = 0; i < uv.length; i += 2) {
      const u = surface.lightmapLuxels[i], v = surface.lightmapLuxels[i + 1];
      if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error(`Face ${surface.face}: nonfinite lightmap UV`);
      uv[i] = (u + x + 1) / size; uv[i + 1] = (v + y + 1) / size;
    }
    const placement: SourceLightingPlacement = { face: surface.face, page: pages.length - 1, x: x + 1, y: y + 1, width, height, uv, styles, layersPerStyle: layers, samples: lm.samples, hdr };
    await paint(placement, pages[placement.page], options.signal);
    placements.push(placement);
    if (styles.some(s => s !== 0)) {
      // Existing lightstyles.json ABI contains ONLY flat style samples. Full raw
      // directional samples remain zero-copy in placements for temporal integration.
      // Account retained base64 (worst-case UTF16), its bounded conversion strings,
      // and the temporary flat-layer extraction before allocating them.
      charge(Math.ceil(width * height * styles.length * 4 / 3) * 8 + (layers === 4 ? width * height * styles.length * 4 : 0));
      const flat = layers === 1 ? lm.samples : new Uint8Array(width * height * styles.length * 4);
      if (layers === 4) for (let j = 0; j < styles.length; j++) flat.set(lm.samples.subarray(j * width * height * 16, j * width * height * 16 + width * height * 4), j * width * height * 4);
      lightstyles.patches.push({ page: placement.page, x: placement.x, y: placement.y, width, height, styles: Array.from(styles), samples: sourceLightingBase64(flat) });
      lightstyles.pages[placement.page] = `lightmap_${placement.page}.rgba.gz`;
      if (layers === 4) requirements.push({ code: 'directional-style-runtime', blocking: true, face: surface.face, detail: 'Directional lightstyle data is retained; rendered playback is not yet verified for raw imports.' });
    }
    x += width + 2; rowHeight = Math.max(rowHeight, height + 2);
  }
  const metadata = await readSourceLightingMetadata(world, filesystem, options, requirements, lightstyles.patterns);
  if (hdr) requirements.push({ code: 'hdr-postprocessing-runtime', blocking: true, detail: 'HDR samples are retained with HDR identity; the existing native LDR final-color pipeline does not implement Source HDR exposure/bloom.' });
  sourceAbort(options.signal);
  return {
    pages, placements,
    native: { lighting: metadata.lighting, visibility: metadata.visibility, lightstyles, stylePages: Object.entries(lightstyles.pages).map(([page, file]) => ({ page: Number(page), file, rgba: pages[Number(page)].layers[0] })), colorCorrections: metadata.colorCorrections },
    manifest: { source_lightmaps: { version: 1, pages: pages.length, faces: placements.length, hdr, encoding: 'RGBM6' } },
    glb: { uvAttribute: 'TEXCOORD_1', flatExtra: 'sourceLightmap', bumpExtra: 'sourceBumpLightmaps', faceRangesExtra: 'sourceFaceRanges', sampler: { wrapS: 33071, wrapT: 33071, magFilter: 9729, minFilter: 9729, flipY: false, generateMipmaps: false, colorSpace: 'linear' } },
    cubemaps: metadata.cubemaps, companions: metadata.companions, areas: metadata.areas, areaPortals: metadata.areaPortals, leafAreas: metadata.leafAreas,
    areaPortalClipVertices: metadata.areaPortalClipVertices,
    original: { lumps: world.bsp.lumps, entities: world.bsp.entities, surfaces: world.surfaces },
    authored: metadata.authored, identity: metadata.identity, requirements,
    capabilities: { rgbm6: true, flatStyles: true, directionalStatic: true, directionalStylesNative: false, hdrPostprocessingNative: false, areaPortalsNative: false, entitySimulationNative: false },
  };
}
