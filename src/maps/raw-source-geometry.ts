// CPU algorithms adapted from scripts/import_source_bsp.py, source_surface_frames.py
// and noclip.website BSPFile.ts (2018 Jasper St. Pierre, MIT, LICENSE.noclip).
import type { SourceBsp, SourceWorldOptions } from './raw-source-bsp';
import type { SourceLightingRequirement } from './raw-source-lighting';
import { sourceAbort } from './raw-source-lzma';

/** CONTENTS_SOLID | WINDOW | GRATE | PLAYERCLIP, as in scripts/import_source_bsp.py. */
export const SOURCE_COLLISION_CONTENTS = 0x1000b;
/** Maximum distance between an authored collision surface and its emitted shape. */
export const SOURCE_COLLISION_TOLERANCE_METRES = 0.001;
const DISPLACEMENT_THICKNESS_METRES = 0.15;

type Vec3 = [number, number, number];
export interface SourceFrame {
  origin: Vec3;
  yaw: number;
  metresPerUnit: 0.0254;
  up: 'Z';
  spawnClass: string;
  /** The floor probe is not a full robot/clip/prop clearance test. */
  floorFound: boolean;
}
export interface SourceSurface {
  face: number;
  material: string;
  texinfo: number;
  flags: number;
  visible: boolean;
  displacement: number;
  sourceFrontNormal: Vec3;
  /** Native clockwise Source corner order; indices reverse front winding for glTF. */
  sourcePositions: Float64Array;
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  indices: Uint32Array;
  uv: Float32Array;
  /** Face-local half-luxel coordinates, not packed atlas coordinates. */
  lightmapLuxels: Float32Array;
  lightmap: {
    width: number; height: number; mins: [number, number];
    styles: Uint8Array; layersPerStyle: number; offset: number;
    /** RGBExp32 bytes, style-major then bump-layer-major; no averaging/baking. */
    samples: Uint8Array;
    hdr: boolean;
  };
  alpha?: Float32Array;
  /** Displacements retain undisplaced positions for Source material mapping. */
  basePositions?: Float64Array;
  gridSide?: number;
  displacementTriangleTags?: Uint16Array;
  /** ddispinfo_t contents and minTess-encoded CCoreDispInfo SURF_* flags (0 when absent). */
  displacementCollision?: { contents: number; flags: number };
}
export interface SourceHeightfield {
  kind: 'heightfield'; face: number;
  rows: number; columns: number;
  size: [number, number, number, number];
  position: Vec3;
  quaternion: [number, number, number, number];
  /** MuJoCo order: first row at +local Y; values normalized to [0,1]. */
  elevations: Float32Array;
  approximation: { maxLateralErrorMetres: number; baseRectangleErrorMetres: number; maxCellPlanarityErrorMetres: number };
}
export type SourceCollision = SourceHeightfield | {
  kind: 'box'; brush: number; contents: number;
  position: Vec3; halfExtents: Vec3; quaternion: [number, number, number, number];
} | {
  kind: 'convex'; brush: number; contents: number; vertices: Float64Array;
} | {
  /** Convex hull whose front faces are exactly the listed authored triangles
   * (within SOURCE_COLLISION_TOLERANCE_METRES), extruded behind the surface. */
  kind: 'displacement-prism'; face: number; vertices: Float64Array; triangles: number; thicknessMetres: 0.15;
} | {
  kind: 'entity-brush'; entity: number; model: number; brush: number; contents: number; vertices: Float64Array;
};
export interface SourceModelCollision {
  /** Model-local metres (Source axes); apply the entity placement once. */
  hulls: { brush: number; contents: number; vertices: Float64Array }[];
  skippedDegenerateBrushes: number[];
}
export interface SourceWorld {
  bsp: SourceBsp;
  frame: SourceFrame;
  surfaces: SourceSurface[];
  collision: SourceCollision[];
  reachableBrushes: Uint32Array;
  reachableLeaves: Uint32Array;
  /** Blocking admission requirements found while decoding the world model (spawn, collision modes). */
  requirements: SourceLightingRequirement[];
  limitations: readonly string[];
  skippedDegenerateBrushes: number[];
  /** Native model-local metres and Source-axis normals; apply its entity placement once. */
  decodeModelSurfaces(modelIndex: number, signal?: AbortSignal): Promise<SourceSurface[]>;
  /** Colliding brushes reachable from a brush model's own headnode. */
  decodeModelCollision(modelIndex: number, signal?: AbortSignal): Promise<SourceModelCollision>;
}

class Table {
  readonly view: DataView;
  readonly count: number;
  constructor(readonly bytes: Uint8Array, readonly stride: number, readonly name: string) {
    if (bytes.length % stride) throw new Error(`Malformed ${name}: record remainder`);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.count = bytes.length / stride;
  }
  offset(index: number, field = 0): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.count || field < 0 || field >= this.stride) throw new Error(`${this.name} index out of range: ${index}`);
    return index * this.stride + field;
  }
  i(index: number, field = 0): number { return this.view.getInt32(this.offset(index, field), true); }
  u(index: number, field = 0): number { return this.view.getUint32(this.offset(index, field), true); }
  s(index: number, field = 0): number { return this.view.getInt16(this.offset(index, field), true); }
  h(index: number, field = 0): number { return this.view.getUint16(this.offset(index, field), true); }
  b(index: number, field = 0): number { return this.view.getUint8(this.offset(index, field)); }
  f(index: number, field = 0): number {
    const value = this.view.getFloat32(this.offset(index, field), true);
    if (!Number.isFinite(value)) throw new Error(`Nonfinite ${this.name} float`);
    return value;
  }
}
function range(first: number, count: number, total: number, name: string): void {
  if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0 || first > total || count > total - first) throw new Error(`${name} range out of bounds`);
}
function normal(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  if (length < 1e-20) return [0, 0, 0];
  return [x / length, y / length, z / length];
}
function quaternion(x: Vec3, y: Vec3, z: Vec3): [number, number, number, number] {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    return [s / 4, (y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    return [(y[2] - z[1]) / s, s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s];
  }
  if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    return [(z[0] - x[2]) / s, (y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s];
  }
  const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
  return [(x[1] - y[0]) / s, (z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4];
}

async function sourcePhase(signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
  sourceAbort(signal);
}

export async function buildSourceWorld(bsp: SourceBsp, options: SourceWorldOptions = {}): Promise<SourceWorld> {
  const signal = options.signal;
  sourceAbort(signal);
  const load = async (index: number, stride: number, name: string, versions: readonly number[] = [0]) => {
    const bytes = await bsp.getLump(index, signal);
    if (bytes.length && !versions.includes(bsp.lumps[index].version)) throw new Error(`Unsupported ${name} lump version ${bsp.lumps[index].version}`);
    return new Table(bytes, stride, name);
  };
  // Keep the relevant unknown/branch-specific lumps as raw Blobs on bsp. Parsing
  // a known record with an unknown version is never a compatibility fallback.
  const planes = await load(1, 20, 'planes'), texdata = await load(2, 32, 'texdata');
  const verts = await load(3, 12, 'vertices'), nodes = await load(5, 32, 'nodes');
  const texinfo = await load(6, 72, 'texinfo');
  const hdr = bsp.lumps[53].length > 0;
  const faceLump = hdr && bsp.lumps[58].length ? 58 : 7;
  const faces = await load(faceLump, 56, 'faces', [1]);
  const lighting = await bsp.getLump(hdr ? 53 : 8, signal);
  if (lighting.length && bsp.lumps[hdr ? 53 : 8].version !== 1) throw new Error('Unsupported lighting lump version');
  const leafVersion = bsp.lumps[10].version;
  const leaves = await load(10, leafVersion === 0 ? 56 : 32, 'leaves', [0, 1]);
  const edges = await load(12, 4, 'edges'), surfedges = await load(13, 4, 'surfedges');
  const models = await load(14, 48, 'models'), leafbrushes = await load(17, 2, 'leafbrushes');
  const brushes = await load(18, 12, 'brushes'), sides = await load(19, 8, 'brushsides');
  const dispinfo = await load(26, 176, 'dispinfo'), normals = await load(30, 12, 'normals');
  const normalIndices = await load(31, 2, 'normal indices');
  const dispverts = await load(33, 20, 'displacement vertices');
  const primitives = await load(37, bsp.version === 22 ? 16 : 10, 'primitives');
  const primindices = await load(39, 2, 'primitive indices');
  const strings = await bsp.getLump(43, signal), stringTable = await load(44, 4, 'texture string table');
  const dispTags = await load(48, 2, 'displacement triangle tags');
  if (models.count === 0) throw new Error('BSP has no worldmodel 0');
  const normalStarts = new Uint32Array(faces.count + 1);
  for (let i = 0; i < faces.count; i++) {
    const count = faces.s(i, 8);
    if (count < 0) throw new Error('Negative face edge count');
    normalStarts[i + 1] = normalStarts[i] + count;
  }
  if (normalIndices.count && normalStarts[faces.count] !== normalIndices.count) throw new Error('Authored corner-normal count differs from face order');
  const materialCache = new Map<number, string>();
  const material = (td: number): string => {
    const cached = materialCache.get(td);
    if (cached !== undefined) return cached;
    const nameId = texdata.i(td, 12), offset = stringTable.i(nameId);
    range(offset, 1, strings.length, 'Texture name');
    const end = strings.indexOf(0, offset);
    if (end < 0) throw new Error('Unterminated texture name');
    const value = new TextDecoder().decode(strings.subarray(offset, end));
    materialCache.set(td, value);
    return value;
  };
  const decodeRawModelSurfaces = async (modelIndex: number, signal?: AbortSignal): Promise<SourceSurface[]> => {
    const firstFace = models.i(modelIndex, 40), faceCount = models.i(modelIndex, 44);
    range(firstFace, faceCount, faces.count, 'Model faces');
    const surfaces: SourceSurface[] = [];
    for (let fi = firstFace; fi < firstFace + faceCount; fi++) {
      if ((fi & 127) === 0) await sourcePhase(signal);
      const edgeCount = faces.s(fi, 8), firstEdge = faces.i(fi, 4), ti = faces.s(fi, 10), di = faces.s(fi, 12);
      range(firstEdge, edgeCount, surfedges.count, 'Face surfedges');
      if (edgeCount < 3 || ti < 0) continue;
      texinfo.offset(ti);
      const td = texinfo.i(ti, 68), flags = texinfo.i(ti, 64);
      if (td < 0) throw new Error(`Face ${fi} has no texture data`);
      const name = material(td), width = texdata.i(td, 16), height = texdata.i(td, 20);
      if (width <= 0 || height <= 0) throw new Error('Invalid texture dimensions');
      const vectors = new Float64Array(16);
      for (let k = 0; k < 16; k++) vectors[k] = texinfo.f(ti, k * 4);
      const corners = new Float64Array(edgeCount * 3);
      for (let j = 0; j < edgeCount; j++) {
        const se = surfedges.i(firstEdge + j), vi = edges.h(Math.abs(se), se < 0 ? 2 : 0);
        for (let k = 0; k < 3; k++) corners[j * 3 + k] = verts.f(vi, k * 4);
      }
      const front = normal(
        -((corners[4] - corners[1]) * (corners[8] - corners[2]) - (corners[5] - corners[2]) * (corners[7] - corners[1])),
        -((corners[5] - corners[2]) * (corners[6] - corners[0]) - (corners[3] - corners[0]) * (corners[8] - corners[2])),
        -((corners[3] - corners[0]) * (corners[7] - corners[1]) - (corners[4] - corners[1]) * (corners[6] - corners[0])));
      let points = corners, base: Float64Array | undefined, alpha: Float32Array | undefined, gridSide: number | undefined;
      let indices: Uint32Array, triangleTags: Uint16Array | undefined, displacementCollision: SourceSurface['displacementCollision'];
      if (di >= 0) {
        if (edgeCount !== 4) throw new Error('Displacement base is not a quad');
        const power = dispinfo.i(di, 20);
        if (power < 2 || power > 4) throw new Error(`Unsupported displacement power ${power}`);
        gridSide = (1 << power) + 1;
        const count = gridSide * gridSide, start = dispinfo.i(di, 12);
        range(start, count, dispverts.count, 'Displacement vertices');
        let closest = 0, distance = Infinity;
        for (let j = 0; j < 4; j++) {
          const d = Math.hypot(corners[j * 3] - dispinfo.f(di, 0), corners[j * 3 + 1] - dispinfo.f(di, 4), corners[j * 3 + 2] - dispinfo.f(di, 8));
          if (d < distance) { distance = d; closest = j; }
        }
        points = new Float64Array(count * 3); base = new Float64Array(count * 3); alpha = new Float32Array(count);
        const rowStart = new Float64Array(3), rowDelta = new Float64Array(3), inverse = 1 / (gridSide - 1);
        for (let y = 0; y < gridSide; y++) {
          for (let k = 0; k < 3; k++) {
            rowStart[k] = corners[closest * 3 + k] + (corners[((closest + 1) % 4) * 3 + k] - corners[closest * 3 + k]) * y * inverse;
            const other = corners[((closest + 3) % 4) * 3 + k] + (corners[((closest + 2) % 4) * 3 + k] - corners[((closest + 3) % 4) * 3 + k]) * y * inverse;
            rowDelta[k] = other - rowStart[k];
          }
          for (let x = 0; x < gridSide; x++) {
            const v = y * gridSide + x, distance = dispverts.f(start + v, 12);
            for (let k = 0; k < 3; k++) {
              base[v * 3 + k] = rowStart[k] + rowDelta[k] * x * inverse;
              points[v * 3 + k] = base[v * 3 + k] + dispverts.f(start + v, k * 4) * distance;
            }
            alpha[v] = dispverts.f(start + v, 16) / 255;
          }
        }
        indices = new Uint32Array((gridSide - 1) ** 2 * 6);
        for (let y = 0, out = 0; y < gridSide - 1; y++) for (let x = 0; x < gridSide - 1; x++) {
          const a = y * gridSide + x, w = gridSide;
          // CCoreDispInfo::GenerateCollisionSurface alternates the cell diagonal by
          // vertex-index parity; the triangle tags follow this order. Native Source
          // is clockwise, so each triangle is reversed for glTF/Three front faces.
          if (a % 2 === 1) {
            indices[out++] = a; indices[out++] = a + 1; indices[out++] = a + w;
            indices[out++] = a + 1; indices[out++] = a + w + 1; indices[out++] = a + w;
          } else {
            indices[out++] = a; indices[out++] = a + w + 1; indices[out++] = a + w;
            indices[out++] = a; indices[out++] = a + 1; indices[out++] = a + w + 1;
          }
        }
        // builddisp.cpp InitDispInfo: a set high bit means minTess carries SURF_* flags.
        const minTess = dispinfo.i(di, 24);
        displacementCollision = { contents: dispinfo.i(di, 32), flags: minTess < 0 ? minTess & 0x7fffffff : 0 };
        const first = dispinfo.i(di, 16), countTags = indices.length / 3;
        if (dispTags.count) {
          range(first, countTags, dispTags.count, 'Displacement triangle tags');
          triangleTags = new Uint16Array(countTags);
          for (let j = 0; j < countTags; j++) triangleTags[j] = dispTags.h(first + j);
        }
      } else {
        const primitiveCount = faces.h(fi, 48) & 0x7fff;
        indices = new Uint32Array((edgeCount - 2) * 3);
        if (primitiveCount) {
          if (primitiveCount !== 1) throw new Error('Unsupported multiple face primitives');
          const p = faces.h(fi, 50), wide = bsp.version === 22;
          const first = wide ? primitives.u(p, 4) : primitives.h(p, 2), count = wide ? primitives.u(p, 8) : primitives.h(p, 4);
          if (primitives.h(p, wide ? 14 : 8)) throw new Error('Dynamic Source primitives require a different geometry path');
          if (primitives.b(p) !== 0 || count !== indices.length) throw new Error('Unsupported static primitive topology');
          range(first, count, primindices.count, 'Primitive indices');
          for (let j = 0; j < count; j += 3) {
            indices[j] = primindices.h(first + j); indices[j + 1] = primindices.h(first + j + 2); indices[j + 2] = primindices.h(first + j + 1);
          }
        } else for (let j = 0; j < edgeCount - 2; j++) { indices[j * 3] = 0; indices[j * 3 + 1] = j + 2; indices[j * 3 + 2] = j + 1; }
        for (const index of indices) if (index >= edgeCount) throw new Error('Primitive references a vertex outside its face');
      }
      const count = points.length / 3, outNormals = new Float32Array(points.length);
      if (gridSide) {
        for (let y = 0; y < gridSide - 1; y++) for (let x = 0; x < gridSide - 1; x++) {
          const a = y * gridSide + x, b = a + 1, c = a + gridSide, d = c + 1;
          const abx = points[b * 3] - points[a * 3], aby = points[b * 3 + 1] - points[a * 3 + 1], abz = points[b * 3 + 2] - points[a * 3 + 2];
          const acx = points[c * 3] - points[a * 3], acy = points[c * 3 + 1] - points[a * 3 + 1], acz = points[c * 3 + 2] - points[a * 3 + 2];
          const bdx = points[d * 3] - points[b * 3], bdy = points[d * 3 + 1] - points[b * 3 + 1], bdz = points[d * 3 + 2] - points[b * 3 + 2];
          const bcx = points[c * 3] - points[b * 3], bcy = points[c * 3 + 1] - points[b * 3 + 1], bcz = points[c * 3 + 2] - points[b * 3 + 2];
          let n1x = aby * acz - abz * acy, n1y = abz * acx - abx * acz, n1z = abx * acy - aby * acx;
          let n2x = bdy * bcz - bdz * bcy, n2y = bdz * bcx - bdx * bcz, n2z = bdx * bcy - bdy * bcx;
          const length1 = Math.max(Math.hypot(n1x, n1y, n1z), 1e-20), length2 = Math.max(Math.hypot(n2x, n2y, n2z), 1e-20);
          n1x /= length1; n1y /= length1; n1z /= length1;
          n2x /= length2; n2y /= length2; n2z /= length2;
          for (let corner = 0; corner < 4; corner++) {
            const v = corner === 0 ? a : corner === 1 ? b : corner === 2 ? c : d;
            outNormals[v * 3] += n1x + n2x; outNormals[v * 3 + 1] += n1y + n2y; outNormals[v * 3 + 2] += n1z + n2z;
          }
        }
      } else for (let j = 0; j < count; j++) {
        if (normalIndices.count) {
          const ni = normalIndices.h(normalStarts[fi] + j);
          for (let k = 0; k < 3; k++) outNormals[j * 3 + k] = normals.f(ni, k * 4);
        } else outNormals.set(front, j * 3);
      }
      const uv = new Float32Array(count * 2), luxels = new Float32Array(count * 2), tangents = new Float32Array(count * 4);
      const lmWidth = faces.i(fi, 36) + 1, lmHeight = faces.i(fi, 40) + 1, mins: [number, number] = [faces.i(fi, 28), faces.i(fi, 32)];
      const styles = Uint8Array.of(faces.b(fi, 16), faces.b(fi, 17), faces.b(fi, 18), faces.b(fi, 19));
      let styleCount = 0;
      while (styleCount < 4 && styles[styleCount] !== 255) styleCount++;
      const layers = flags & 0x800 ? 4 : 1, lightOffset = faces.i(fi, 20);
      let samples: Uint8Array = new Uint8Array(0);
      if (lightOffset >= 0) {
        if (lmWidth <= 0 || lmHeight <= 0) throw new Error('Invalid face lightmap dimensions');
        const size = lmWidth * lmHeight * layers * styleCount * 4;
        range(lightOffset, size, lighting.length, 'Face lightmap samples');
        samples = lighting.subarray(lightOffset, lightOffset + size);
      }
      const planeId = faces.h(fi, 0), tx = vectors[4], ty = vectors[5], tz = vectors[6];
      const sx = vectors[0], sy = vectors[1], sz = vectors[2], mapping = base ?? points;
      const crossx = sy * tz - sz * ty, crossy = sz * tx - sx * tz, crossz = sx * ty - sy * tx;
      const tangentSign = planes.f(planeId) * crossx + planes.f(planeId, 4) * crossy + planes.f(planeId, 8) * crossz > 0 ? -1 : 1;
      for (let j = 0; j < count; j++) {
        const nx = outNormals[j * 3], ny = outNormals[j * 3 + 1], nz = outNormals[j * 3 + 2], length = Math.max(Math.hypot(nx, ny, nz), 1e-20);
        outNormals[j * 3] = nx / length; outNormals[j * 3 + 1] = ny / length; outNormals[j * 3 + 2] = nz / length;
        const tangentX = ny * tz - nz * ty, tangentY = nz * tx - nx * tz, tangentZ = nx * ty - ny * tx;
        const tangentLength = Math.max(Math.hypot(tangentX, tangentY, tangentZ), 1e-20);
        tangents[j * 4] = tangentX / tangentLength * tangentSign; tangents[j * 4 + 1] = tangentY / tangentLength * tangentSign; tangents[j * 4 + 2] = tangentZ / tangentLength * tangentSign; tangents[j * 4 + 3] = -tangentSign;
        for (let axis = 0; axis < 2; axis++) {
          const offset = axis * 4;
          const v = mapping[j * 3] * vectors[offset] + mapping[j * 3 + 1] * vectors[offset + 1] + mapping[j * 3 + 2] * vectors[offset + 2] + vectors[offset + 3];
          uv[j * 2 + axis] = v / (axis === 0 ? width : height);
          luxels[j * 2 + axis] = gridSide ? (axis === 0 ? j % gridSide : Math.floor(j / gridSide)) / (gridSide - 1) * ((axis === 0 ? lmWidth : lmHeight) - 1) + 0.5 :
            points[j * 3] * vectors[8 + offset] + points[j * 3 + 1] * vectors[9 + offset] + points[j * 3 + 2] * vectors[10 + offset] + vectors[11 + offset] - mins[axis] + 0.5;
        }
      }
      surfaces.push({ face: fi, sourceFrontNormal: front, material: name, texinfo: ti, flags, visible: !(flags & 0x3c6) && !name.toLowerCase().startsWith('tools/'), displacement: di,
        sourcePositions: points, positions: new Float32Array(points.length), normals: outNormals, tangents, indices, uv, lightmapLuxels: luxels,
        lightmap: { width: lmWidth, height: lmHeight, mins, styles, layersPerStyle: layers, offset: lightOffset, samples, hdr },
        alpha, basePositions: base, gridSide, displacementTriangleTags: triangleTags, displacementCollision });
    }
    return surfaces;
  };
  const decodeModelSurfaces = async (modelIndex: number, requestedSignal?: AbortSignal): Promise<SourceSurface[]> => {
    const activeSignal = requestedSignal ?? signal;
    sourceAbort(activeSignal);
    const result = await decodeRawModelSurfaces(modelIndex, activeSignal);
    for (let si = 0; si < result.length; si++) {
      if ((si & 127) === 0) await sourcePhase(activeSignal);
      const surface = result[si];
      for (let j = 0; j < surface.sourcePositions.length; j++) surface.positions[j] = surface.sourcePositions[j] * 0.0254;
    }
    return result;
  };
  const surfaces = await decodeRawModelSurfaces(0, signal);
  const frame = await chooseFrame(bsp, models, surfaces, options);
  const theta = -frame.yaw * Math.PI / 180, cos = Math.cos(theta), sin = Math.sin(theta), scale = 0.0254;
  for (let si = 0; si < surfaces.length; si++) {
    if ((si & 127) === 0) await sourcePhase(signal);
    const surface = surfaces[si];
    for (let j = 0; j < surface.sourcePositions.length; j += 3) {
      const x = surface.sourcePositions[j] - frame.origin[0], y = surface.sourcePositions[j + 1] - frame.origin[1];
      surface.positions[j] = scale * (cos * x - sin * y); surface.positions[j + 1] = scale * (sin * x + cos * y); surface.positions[j + 2] = scale * (surface.sourcePositions[j + 2] - frame.origin[2]);
      const nx = surface.normals[j], ny = surface.normals[j + 1];
      surface.normals[j] = cos * nx - sin * ny; surface.normals[j + 1] = sin * nx + cos * ny;
      const t = j / 3 * 4, tx = surface.tangents[t], ty = surface.tangents[t + 1];
      surface.tangents[t] = cos * tx - sin * ty; surface.tangents[t + 1] = sin * tx + cos * ty;
    }
  }
  const reachable = reachableWorld(nodes, leaves, leafbrushes, brushes.count, models.i(0, 36), signal);
  const collision: SourceCollision[] = [], skippedDegenerateBrushes: number[] = [], requirements: SourceLightingRequirement[] = [];
  if (frame.spawnClass === 'map centre') requirements.push({ code: 'spawn-unresolved', blocking: true,
    detail: 'No player spawn (info_player_attacker, info_player_defender, info_player_start or info_player_deathmatch) has a floor within 64 units below it and 64 units of headroom. Choose a map with a reachable spawn.' });
  for (let at = 0; at < reachable.brushes.length; at++) {
    if ((at & 31) === 0) await sourcePhase(signal);
    const bi = reachable.brushes[at], contents = brushes.i(bi, 8);
    if (!(contents & SOURCE_COLLISION_CONTENTS)) continue;
    const firstSide = brushes.i(bi), sideCount = brushes.i(bi, 4);
    const hull = await brushHull(planes, sides, firstSide, sideCount, signal);
    if (!hull) { skippedDegenerateBrushes.push(bi); continue; }
    let axial = true, nonBevel = 0;
    for (let j = 0; j < sideCount; j++) {
      if (sides.s(firstSide + j, 6)) continue;
      nonBevel++;
      const pi = sides.h(firstSide + j), nx = Math.abs(planes.f(pi)), ny = Math.abs(planes.f(pi, 4)), nz = Math.abs(planes.f(pi, 8));
      const largest = Math.max(nx, ny, nz);
      if (Math.abs(largest - 1) >= 1e-4 || nx + ny + nz - largest >= 1e-4) axial = false;
    }
    if (axial && nonBevel === 6) {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let j = 0; j < hull.length; j += 3) {
        minX = Math.min(minX, hull[j]); minY = Math.min(minY, hull[j + 1]); minZ = Math.min(minZ, hull[j + 2]);
        maxX = Math.max(maxX, hull[j]); maxY = Math.max(maxY, hull[j + 1]); maxZ = Math.max(maxZ, hull[j + 2]);
      }
      const x = (minX + maxX) / 2 - frame.origin[0], y = (minY + maxY) / 2 - frame.origin[1];
      collision.push({ kind: 'box', brush: bi, contents,
        position: [scale * (cos * x - sin * y), scale * (sin * x + cos * y), scale * ((minZ + maxZ) / 2 - frame.origin[2])],
        halfExtents: [scale * (maxX - minX) / 2, scale * (maxY - minY) / 2, scale * (maxZ - minZ) / 2],
        quaternion: [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)] });
      continue;
    }
    for (let j = 0; j < hull.length; j += 3) {
      const x = hull[j] - frame.origin[0], y = hull[j + 1] - frame.origin[1];
      hull[j] = scale * (cos * x - sin * y); hull[j + 1] = scale * (sin * x + cos * y); hull[j + 2] = scale * (hull[j + 2] - frame.origin[2]);
    }
    collision.push({ kind: 'convex', brush: bi, contents, vertices: hull });
  }
  for (const surface of surfaces) {
    if (!surface.gridSide) continue;
    await sourcePhase(signal);
    const { contents, flags } = surface.displacementCollision!;
    // SDK public/builddisp.h names SURF_NOPHYSICS_COLL (2), SURF_NOHULL_COLL (4) and SURF_NORAY_COLL (8);
    // public/dispcoll_common.cpp keeps the surface contents and skips hull/ray traces for those flags.
    if (!(contents & SOURCE_COLLISION_CONTENTS)) continue;
    const physics = !(flags & 2), hull = !(flags & 4), ray = !(flags & 8);
    if (physics !== hull || hull !== ray) {
      requirements.push({ code: 'displacement-collision-mode', blocking: true, face: surface.face,
        detail: `This displacement enables ${[physics && 'physics', hull && 'player', ray && 'ray'].filter(Boolean).join('/')} collision only; one shared collision surface cannot separate physics, player and ray collision.` });
      continue;
    }
    if (physics) appendDisplacementCollision(surface, frame, cos, sin, collision);
  }
  const decodeModelCollision = async (modelIndex: number, requestedSignal?: AbortSignal): Promise<SourceModelCollision> => {
    const activeSignal = requestedSignal ?? signal;
    if (!Number.isSafeInteger(modelIndex) || modelIndex < 1 || modelIndex >= models.count) throw new Error(`Brush model *${modelIndex} is not an entity model`);
    const reachableModel = reachableWorld(nodes, leaves, leafbrushes, brushes.count, models.i(modelIndex, 36), activeSignal);
    const result: SourceModelCollision = { hulls: [], skippedDegenerateBrushes: [] };
    for (let at = 0; at < reachableModel.brushes.length; at++) {
      if ((at & 31) === 0) await sourcePhase(activeSignal);
      const bi = reachableModel.brushes[at], contents = brushes.i(bi, 8);
      if (!(contents & SOURCE_COLLISION_CONTENTS)) continue;
      const vertices = await brushHull(planes, sides, brushes.i(bi), brushes.i(bi, 4), activeSignal);
      if (!vertices) { result.skippedDegenerateBrushes.push(bi); continue; }
      for (let j = 0; j < vertices.length; j++) vertices[j] *= scale;
      result.hulls.push({ brush: bi, contents, vertices });
    }
    return result;
  };
  return { bsp, frame, surfaces, collision, decodeModelSurfaces, decodeModelCollision, reachableBrushes: Uint32Array.from(reachable.brushes), reachableLeaves: Uint32Array.from(reachable.leaves),
    requirements, skippedDegenerateBrushes,
    limitations: [
      'World-model collision only; brush-entity collision is assembled from entities by raw-source-collision, and studio-prop collision other than documented non-solid placements is refused there.',
      'Displacement collision follows dispinfo contents and SURF_NOPHYSICS/NOHULL/NORAY flags with the native alternating triangulation; triangle tags (walkable/buildable/surfprop) are retained, not simulated.',
      'Spawn floor probing does not establish robot clearance against invisible clip brushes or props.',
      'Geometry alone does not resolve materials, props, overlays, lighting atlases, PVS or certify complete raw-map support.'
    ] };
}

function reachableWorld(nodes: Table, leaves: Table, leafbrushes: Table, brushCount: number, head: number, signal?: AbortSignal) {
  if (head < -leaves.count || head >= nodes.count) throw new Error('World headnode out of bounds');
  const stack = [head], state = new Uint8Array(nodes.count), leafSeen = new Uint8Array(leaves.count), selected = new Uint8Array(brushCount);
  const brushIds: number[] = [], leafIds: number[] = [];
  // Exit markers distinguish actual cycles from legal repeated references.
  while (stack.length) {
    sourceAbort(signal);
    const item = stack.pop()!;
    if (item >= 0 && item >= nodes.count) throw new Error('World node index out of bounds');
    if (item < -leaves.count) {
      const node = -item - leaves.count - 1;
      if (node < 0 || node >= nodes.count) throw new Error('World leaf index out of bounds');
      state[node] = 2; continue;
    }
    if (item < 0) {
      const leaf = -item - 1;
      leaves.offset(leaf);
      if (leafSeen[leaf]) continue;
      leafSeen[leaf] = 1; leafIds.push(leaf);
      const first = leaves.h(leaf, 24), count = leaves.h(leaf, 26);
      range(first, count, leafbrushes.count, 'Leaf brushes');
      for (let j = 0; j < count; j++) {
        const bi = leafbrushes.h(first + j);
        if (bi >= brushCount) throw new Error('Leaf references missing brush');
        if (!selected[bi]) { selected[bi] = 1; brushIds.push(bi); }
      }
    } else {
      if (state[item] === 1) throw new Error('Cycle in BSP world nodes');
      if (state[item] === 2) continue;
      state[item] = 1;
      const a = nodes.i(item, 4), b = nodes.i(item, 8);
      if (a < -leaves.count || b < -leaves.count) throw new Error('World leaf index out of bounds');
      stack.push(-item - leaves.count - 1, b, a);
    }
  }
  brushIds.sort((a, b) => a - b); leafIds.sort((a, b) => a - b);
  return { brushes: brushIds, leaves: leafIds };
}

async function brushHull(planes: Table, sides: Table, first: number, count: number, signal?: AbortSignal): Promise<Float64Array | undefined> {
  range(first, count, sides.count, 'Brush sides');
  if (count < 4) return undefined;
  // Match VBSP's MAX_BRUSH_SIDES before cubic plane-triple enumeration.
  if (count > 128) throw new Error('Source brush exceeds the 128-side VBSP hull limit');
  const p = new Float64Array(count * 4);
  for (let j = 0; j < count; j++) for (let k = 0; k < 4; k++) p[j * 4 + k] = planes.f(sides.h(first + j), k * 4);
  const points: number[] = [], seen = new Set<string>();
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let a = 0; a < count - 2; a++) {
    if (a > 0 && (a & 7) === 0) await sourcePhase(signal);
    sourceAbort(signal);
    for (let b = a + 1; b < count - 1; b++) for (let c = b + 1; c < count; c++) {
      const i = a * 4, j = b * 4, k = c * 4;
      const cx = p[j + 1] * p[k + 2] - p[j + 2] * p[k + 1], cy = p[j + 2] * p[k] - p[j] * p[k + 2], cz = p[j] * p[k + 1] - p[j + 1] * p[k];
      const det = p[i] * cx + p[i + 1] * cy + p[i + 2] * cz;
      if (Math.abs(det) <= 1e-6) continue;
      let x = (p[i + 3] * cx + p[j + 3] * (p[k + 1] * p[i + 2] - p[k + 2] * p[i + 1]) + p[k + 3] * (p[i + 1] * p[j + 2] - p[i + 2] * p[j + 1])) / det;
      let y = (p[i + 3] * cy + p[j + 3] * (p[k + 2] * p[i] - p[k] * p[i + 2]) + p[k + 3] * (p[i + 2] * p[j] - p[i] * p[j + 2])) / det;
      let z = (p[i + 3] * cz + p[j + 3] * (p[k] * p[i + 1] - p[k + 1] * p[i]) + p[k + 3] * (p[i] * p[j + 1] - p[i + 1] * p[j])) / det;
      let inside = true;
      for (let n = 0; n < count; n++) if (p[n * 4] * x + p[n * 4 + 1] * y + p[n * 4 + 2] * z > p[n * 4 + 3] + 0.05) { inside = false; break; }
      if (!inside) continue;
      x = Math.round(x * 1000) / 1000; y = Math.round(y * 1000) / 1000; z = Math.round(z * 1000) / 1000;
      const key = `${x},${y},${z}`;
      if (seen.has(key)) continue;
      seen.add(key); points.push(x, y, z);
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
  }
  if (points.length < 12 || Math.min(maxX - minX, maxY - minY, maxZ - minZ) < 0.5) return undefined;
  return Float64Array.from(points);
}

async function chooseFrame(bsp: SourceBsp, models: Table, surfaces: SourceSurface[], options: SourceWorldOptions): Promise<SourceFrame> {
  const common = { metresPerUnit: 0.0254 as const, up: 'Z' as const };
  if (options.spawn) {
    if (options.spawn.origin.length !== 3 || options.spawn.origin.some(v => !Number.isFinite(v)) || !Number.isFinite(options.spawn.yaw)) throw new Error('Invalid explicit Source spawn');
    return { ...common, origin: [...options.spawn.origin], yaw: options.spawn.yaw, spawnClass: 'explicit', floorFound: false };
  }
  for (const cls of ['info_player_attacker', 'info_player_defender', 'info_player_start', 'info_player_deathmatch']) {
    for (const entity of bsp.entities) {
      if (entity.values.classname !== cls || !entity.values.origin) continue;
      await sourcePhase(options.signal);
      const origin = entity.values.origin.trim().split(/\s+/).map(Number);
      if (origin.length !== 3 || origin.some(v => !Number.isFinite(v))) throw new Error('Malformed Source player spawn origin');
      const hits: number[] = [];
      for (const surface of surfaces) {
        if (surface.flags & 6) continue;
        const p = surface.sourcePositions, indices = surface.indices;
        for (let j = 0; j < indices.length; j += 3) {
          const a = indices[j] * 3, b = indices[j + 1] * 3, c = indices[j + 2] * 3;
          const ux = p[c] - p[a], uy = p[c + 1] - p[a + 1], vx = p[b] - p[a], vy = p[b + 1] - p[a + 1];
          const dx = origin[0] - p[a], dy = origin[1] - p[a + 1], det = ux * vy - vx * uy;
          if (Math.abs(det) < 1e-9) continue;
          const u = (dx * vy - vx * dy) / det, v = (ux * dy - dx * uy) / det;
          if (u >= 0 && v >= 0 && u + v <= 1) hits.push(p[a + 2] + u * (p[c + 2] - p[a + 2]) + v * (p[b + 2] - p[a + 2]));
        }
      }
      let floor = -Infinity;
      for (const h of hits) if (h <= origin[2] + 16 && h >= origin[2] - 64) floor = Math.max(floor, h);
      if (!Number.isFinite(floor) || hits.some(h => h > floor + 4 && h < floor + 64)) continue;
      const angles = entity.values.angles?.trim().split(/\s+/).map(Number);
      const yaw = angles ? angles[1] : 0;
      if (!Number.isFinite(yaw)) throw new Error('Malformed Source player spawn angles');
      return { ...common, origin: [origin[0], origin[1], floor], yaw, spawnClass: cls, floorFound: true };
    }
  }
  return { ...common, origin: [(models.f(0) + models.f(0, 12)) / 2, (models.f(0, 4) + models.f(0, 16)) / 2, (models.f(0, 8) + models.f(0, 20)) / 2], yaw: 0, spawnClass: 'map centre', floorFound: false };
}

function appendDisplacementCollision(surface: SourceSurface, frame: SourceFrame, cos: number, sin: number, output: SourceCollision[]): void {
  const side = surface.gridSide!, tolerance = SOURCE_COLLISION_TOLERANCE_METRES;
  const framed = (source: Float64Array) => {
    const out = new Float64Array(source.length);
    for (let j = 0; j < out.length; j += 3) {
      const x = source[j] - frame.origin[0], y = source[j + 1] - frame.origin[1];
      out[j] = 0.0254 * (cos * x - sin * y); out[j + 1] = 0.0254 * (sin * x + cos * y); out[j + 2] = 0.0254 * (source[j + 2] - frame.origin[2]);
    }
    return out;
  };
  // Double-precision framed points; the Float32 render positions are not a collision source.
  const base = framed(surface.basePositions!), points = framed(surface.sourcePositions);
  const row = (side - 1) * side * 3, column = (side - 1) * 3, opposite = (side * side - 1) * 3;
  const e1: Vec3 = [base[row] - base[0], base[row + 1] - base[1], base[row + 2] - base[2]];
  const e2: Vec3 = [base[column] - base[0], base[column + 1] - base[1], base[column + 2] - base[2]];
  const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
  const rectangleError = Math.hypot(base[0] + e1[0] + e2[0] - base[opposite], base[1] + e1[1] + e2[1] - base[opposite + 1], base[2] + e1[2] + e2[2] - base[opposite + 2]);
  let x = normal(...e2), y = normal(...e1);
  let z = normal(x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]);
  const authored = surface.sourceFrontNormal;
  const front: Vec3 = [cos * authored[0] - sin * authored[1], sin * authored[0] + cos * authored[1], authored[2]];
  const swap = z[0] * front[0] + z[1] * front[1] + z[2] * front[2] < 0;
  if (swap) { const oldX = x; x = y; y = oldX; z = [-z[0], -z[1], -z[2]]; }
  if (l1 >= 0.001 && l2 >= 0.001 && Math.abs(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (l1 * l2) <= 0.03 && rectangleError <= 0.03 * Math.max(l1, l2)) {
    // A MuJoCo heightfield is exact only when every authored vertex sits on its
    // regular grid and every cell is planar (its fixed diagonal then matches
    // Source's alternating one). Otherwise the exact convex path below is used.
    y = normal(z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]);
    const center: Vec3 = [base[0] + (e1[0] + e2[0]) / 2, base[1] + (e1[1] + e2[1]) / 2, base[2] + (e1[2] + e2[2]) / 2];
    const elevations = new Float32Array(side * side);
    let lo = Infinity, hi = -Infinity, lateral = 0, planarity = 0;
    const width = swap ? l1 : l2, height = swap ? l2 : l1;
    for (let row = 0; row < side; row++) for (let col = 0; col < side; col++) {
      const v = (swap ? col * side + row : row * side + col) * 3;
      const dx = points[v] - center[0], dy = points[v + 1] - center[1], dz = points[v + 2] - center[2];
      const h = dx * z[0] + dy * z[1] + dz * z[2];
      elevations[(side - 1 - row) * side + col] = h;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      const targetX = (col / (side - 1) - 0.5) * width, targetY = (row / (side - 1) - 0.5) * height;
      lateral = Math.max(lateral, Math.hypot(dx * x[0] + dy * x[1] + dz * x[2] - targetX, dx * y[0] + dy * y[1] + dz * y[2] - targetY));
    }
    for (let r = 0; r < side - 1; r++) for (let c = 0; c < side - 1; c++) {
      const a = r * side + c;
      planarity = Math.max(planarity, cellPlanarity(points, a, a + 1, a + side, a + side + 1));
    }
    if (lateral <= tolerance && planarity <= tolerance) {
      const span = Math.max(hi - lo, 0.001);
      for (let i = 0; i < elevations.length; i++) elevations[i] = Math.max(0, Math.min(1, (elevations[i] - lo) / span));
      output.push({ kind: 'heightfield', face: surface.face, rows: side, columns: side, size: [width / 2, height / 2, span, 0.1], position: [center[0] + z[0] * lo, center[1] + z[1] * lo, center[2] + z[2] * lo], quaternion: quaternion(x, y, z), elevations,
        approximation: { maxLateralErrorMetres: lateral, baseRectangleErrorMetres: rectangleError, maxCellPlanarityErrorMetres: planarity } });
      return;
    }
  }
  // Exact convex decomposition of the authored triangles: a 2x2-cell patch or a
  // cell becomes one hull only when every one of its triangles is a front hull
  // face; otherwise each triangle becomes its own prism behind its plane.
  const indices = surface.indices, cells = side - 1, thickness = DISPLACEMENT_THICKNESS_METRES;
  const cellTriangles = (r: number, c: number) => [(r * cells + c) * 6, (r * cells + c) * 6 + 3];
  const group = (triangles: readonly number[], loop: readonly number[]) => {
    const ids = new Set<number>();
    for (const t of triangles) for (let k = 0; k < 3; k++) ids.add(indices[t + k]);
    if (!exactDisplacementGroup(points, indices, triangles, loop, ids, front)) return false;
    const vertices = new Float64Array(ids.size * 6);
    let at = 0;
    for (const id of ids) {
      for (let k = 0; k < 3; k++) { vertices[at + k] = points[id * 3 + k]; vertices[ids.size * 3 + at + k] = points[id * 3 + k] - front[k] * thickness; }
      at += 3;
    }
    output.push({ kind: 'displacement-prism', face: surface.face, vertices, triangles: triangles.length, thicknessMetres: thickness });
    return true;
  };
  for (let r = 0; r < cells; r += 2) for (let c = 0; c < cells; c += 2) {
    const id = (rr: number, cc: number) => rr * side + cc;
    const patch = [...cellTriangles(r, c), ...cellTriangles(r, c + 1), ...cellTriangles(r + 1, c), ...cellTriangles(r + 1, c + 1)];
    if (group(patch, [id(r, c), id(r, c + 1), id(r, c + 2), id(r + 1, c + 2), id(r + 2, c + 2), id(r + 2, c + 1), id(r + 2, c), id(r + 1, c)])) continue;
    for (const [cr, cc] of [[r, c], [r, c + 1], [r + 1, c], [r + 1, c + 1]]) {
      const triangles = cellTriangles(cr, cc);
      if (group(triangles, [id(cr, cc), id(cr, cc + 1), id(cr + 1, cc + 1), id(cr + 1, cc)])) continue;
      for (const t of triangles) {
        const n = triangleNormal(points, indices[t], indices[t + 1], indices[t + 2]);
        if (!n) continue;
        const vertices = new Float64Array(18);
        for (let k = 0; k < 3; k++) for (let axis = 0; axis < 3; axis++) {
          const value = points[indices[t + k] * 3 + axis];
          vertices[k * 3 + axis] = value; vertices[9 + k * 3 + axis] = value - n[axis] * thickness;
        }
        output.push({ kind: 'displacement-prism', face: surface.face, vertices, triangles: 1, thicknessMetres: thickness });
      }
    }
  }
}

/** Unit front normal of a glTF-ordered (counter-clockwise) triangle; undefined when degenerate. */
function triangleNormal(points: Float64Array, i0: number, i1: number, i2: number): Vec3 | undefined {
  const ax = points[i1 * 3] - points[i0 * 3], ay = points[i1 * 3 + 1] - points[i0 * 3 + 1], az = points[i1 * 3 + 2] - points[i0 * 3 + 2];
  const bx = points[i2 * 3] - points[i0 * 3], by = points[i2 * 3 + 1] - points[i0 * 3 + 1], bz = points[i2 * 3 + 2] - points[i0 * 3 + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, length = Math.hypot(nx, ny, nz);
  return length < 1e-12 ? undefined : [nx / length, ny / length, nz / length];
}

/** Distance of the fourth cell corner from the plane of the other three. */
function cellPlanarity(points: Float64Array, a: number, b: number, c: number, d: number): number {
  let n = triangleNormal(points, a, b, c), origin = a, point = d;
  if (!n) { n = triangleNormal(points, b, d, c); origin = b; point = a; }
  if (!n) return 0;
  return Math.abs(n[0] * (points[point * 3] - points[origin * 3]) + n[1] * (points[point * 3 + 1] - points[origin * 3 + 1])
    + n[2] * (points[point * 3 + 2] - points[origin * 3 + 2]));
}

/** True when the convex hull of the group's points, extruded along -front, has
 * exactly the authored triangles as its front surface (within tolerance). */
function exactDisplacementGroup(points: Float64Array, indices: Uint32Array, triangles: readonly number[], loop: readonly number[], ids: ReadonlySet<number>, front: Vec3): boolean {
  const tolerance = SOURCE_COLLISION_TOLERANCE_METRES;
  for (const t of triangles) {
    const n = triangleNormal(points, indices[t], indices[t + 1], indices[t + 2]);
    if (!n) continue;
    if (n[0] * front[0] + n[1] * front[1] + n[2] * front[2] <= 1e-6) return false;
    const o = indices[t] * 3;
    for (const id of ids) {
      const p = id * 3;
      if (n[0] * (points[p] - points[o]) + n[1] * (points[p + 1] - points[o + 1]) + n[2] * (points[p + 2] - points[o + 2]) > tolerance) return false;
    }
  }
  // The projected outline must be convex, or the hull bridges past the surface edge.
  let positive = false, negative = false;
  const edge = (i: number): Vec3 => {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    const e: Vec3 = [points[b] - points[a], points[b + 1] - points[a + 1], points[b + 2] - points[a + 2]];
    const along = e[0] * front[0] + e[1] * front[1] + e[2] * front[2];
    return [e[0] - along * front[0], e[1] - along * front[1], e[2] - along * front[2]];
  };
  for (let i = 0; i < loop.length; i++) {
    const u = edge(i), v = edge((i + 1) % loop.length);
    const turn = front[0] * (u[1] * v[2] - u[2] * v[1]) + front[1] * (u[2] * v[0] - u[0] * v[2]) + front[2] * (u[0] * v[1] - u[1] * v[0]);
    const limit = tolerance * Math.max(Math.hypot(...u), Math.hypot(...v));
    if (turn > limit) positive = true;
    else if (turn < -limit) negative = true;
  }
  return !(positive && negative);
}
