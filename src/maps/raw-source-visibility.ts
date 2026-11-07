/** Native visibility ABI shared by the Python exporter and SourcePVS/SourceSky3D.
 * Adapted from scripts/source_visibility.py and noclip.website BSPFile/Main.ts
 * (Copyright 2018 Jasper St. Pierre, MIT; see LICENSE.noclip). */
import type { SourceWorld } from './raw-source-geometry';
import type { SourceLightingRequirement } from './raw-source-lighting';
import type { SourceVisibilityData } from '../render/source-sky3d';
import { sourceAbort } from './raw-source-lzma';

export interface SourceVisibilityOptions {
  signal?: AbortSignal;
  maxRecords?: number;
  maxMemberships?: number;
  maxWork?: number;
  /** Actual selected decoded lump sizes, reserved before getLump. */
  maxInputBytes?: number;
  /** Conservative output/temporary object and numeric-slot ownership. */
  maxOutputBytes?: number;
  /** Runtime SourcePVS byte ownership, including its possible cached rows. */
  maxDecodedBytes?: number;
}
export interface SourceVisibilityResult {
  data: SourceVisibilityData | null;
  requirements: SourceLightingRequirement[];
  /** The same validated native tree also drives ambient lighting without PVS. */
  tree: { head: number; nodes: number[][]; leafClusters: number[] };
  /** Charged to the enclosing lighting import rather than resetting its limits. */
  usage: { records: number; work: number };
}
function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid Source visibility ${name} limit`);
  return result;
}
function range(first: number, count: number, total: number, name: string): void {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0 || first > total || count > total - first) throw new Error(`Source visibility ${name}: range out of bounds`);
}
async function phase(signal?: AbortSignal): Promise<void> {
  sourceAbort(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  sourceAbort(signal);
}
class Records {
  readonly count: number;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array, readonly stride: number) {
    if (bytes.length % stride) throw new Error('Source visibility truncated record');
    this.count = bytes.length / stride;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  i(index: number, field: number): number { return this.view.getInt32(index * this.stride + field, true); }
  u(index: number, field: number): number { return this.view.getUint16(index * this.stride + field, true); }
  f(index: number, field: number): number {
    const value = this.view.getFloat32(index * this.stride + field, true);
    if (!Number.isFinite(value)) throw new Error('Source visibility nonfinite plane');
    return value;
  }
}

export async function readSourceVisibility(world: SourceWorld, options: SourceVisibilityOptions = {}): Promise<SourceVisibilityResult> {
  const { bsp, frame } = world, signal = options.signal;
  sourceAbort(signal);
  const maxRecords = limit(options.maxRecords, 2_000_000, 'records');
  const maxMemberships = limit(options.maxMemberships, 8_000_000, 'memberships');
  const maxWork = limit(options.maxWork, 200_000_000, 'work');
  const maxInput = limit(options.maxInputBytes, 256 * 1024 * 1024, 'input');
  const maxOutput = limit(options.maxOutputBytes, 256 * 1024 * 1024, 'output');
  const maxDecoded = limit(options.maxDecodedBytes, 128 * 1024 * 1024, 'decoded');
  let records = 0, memberships = 0, work = 0, input = 0, output = 0;
  const spend = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > maxWork - work) throw new Error('Source visibility work limit exceeded');
    work += count;
  };
  const charge = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxOutput - output) throw new Error('Source visibility output limit exceeded');
    output += bytes;
  };
  const load = async (id: number, stride: number, versions: readonly number[] = [0]) => {
    const lump = bsp.lumps[id], size = lump.uncompressedSize || lump.length;
    if (size && !versions.includes(lump.version)) throw new Error(`Unsupported Source visibility lump ${id} version ${lump.version}`);
    if (size > maxInput - input) throw new Error('Source visibility input limit exceeded');
    if (size % stride) throw new Error('Source visibility truncated record');
    if (size / stride > maxRecords - records) throw new Error('Source visibility record limit exceeded');
    input += size; records += size / stride;
    return new Records(await bsp.getLump(id, signal), stride);
  };
  if (bsp.lumps[10].version !== 0 && bsp.lumps[10].version !== 1) throw new Error(`Unsupported Source visibility leaf version ${bsp.lumps[10].version}`);
  const planes = await load(1, 20), nativeNodes = await load(5, 32);
  const leafs = await load(10, bsp.lumps[10].version === 0 ? 56 : 32, [0, 1]);
  const models = await load(14, 48), faceLump = bsp.lumps[53].length && bsp.lumps[58].length ? 58 : 7;
  const faces = await load(faceLump, 56, [1]), leafFaces = await load(16, 2);
  if (!models.count || !leafs.count) throw new Error('Source visibility requires worldmodel and BSP leaves');
  if (frame.origin.length !== 3 || !frame.origin.every(Number.isFinite) || !Number.isFinite(frame.yaw)) throw new Error('Invalid Source visibility frame');
  const head = models.i(0, 36);
  range(head >= 0 ? head : -head - 1, 1, head >= 0 ? nativeNodes.count : leafs.count, 'world head');
  range(models.i(0, 40), models.i(0, 44), faces.count, 'world faces');
  charge(512 + nativeNodes.count * 192 + leafs.count * 16 + faces.count * 128);
  const nodes: number[][] = [], leafClusters: number[] = [];
  for (let i = 0; i < nativeNodes.count; i++) {
    if ((i & 1023) === 0) await phase(signal);
    spend(1);
    const p = nativeNodes.i(i, 0), a = nativeNodes.i(i, 4), b = nativeNodes.i(i, 8);
    range(p, 1, planes.count, 'node plane');
    range(a >= 0 ? a : -a - 1, 1, a >= 0 ? nativeNodes.count : leafs.count, 'node child');
    range(b >= 0 ? b : -b - 1, 1, b >= 0 ? nativeNodes.count : leafs.count, 'node child');
    nodes.push([planes.f(p, 0), planes.f(p, 4), planes.f(p, 8), planes.f(p, 12), a, b]);
  }
  // Iterative three-colour DFS bounds the stack by nodes, including disconnected
  // components, without allocating per-edge tuples or recursive JS frames.
  const state = new Uint8Array(nodes.length), stack = new Int32Array(nodes.length), edge = new Uint8Array(nodes.length);
  for (let root = 0; root < nodes.length; root++) {
    if (state[root]) continue;
    let depth = 1; stack[0] = root; edge[0] = 0; state[root] = 1;
    while (depth) {
      spend(1);
      if ((work & 8191) === 0) await phase(signal);
      const at = depth - 1, index = stack[at];
      if (edge[at] === 2) { state[index] = 2; depth--; continue; }
      const child = nodes[index][4 + edge[at]++];
      if (child < 0 || state[child] === 2) continue;
      if (state[child] === 1) throw new Error('Source visibility cyclic BSP tree');
      state[child] = 1; stack[depth] = child; edge[depth++] = 0;
    }
    if ((root & 1023) === 0) await phase(signal);
  }
  const faceClusters: Set<number>[] = Array.from({ length: faces.count }, () => new Set<number>());
  const add = (face: number, cluster: number) => {
    if (cluster === 65535 || faceClusters[face].has(cluster)) return;
    if (memberships >= maxMemberships) throw new Error('Source visibility membership limit exceeded');
    charge(96); memberships++; faceClusters[face].add(cluster);
  };
  for (let i = 0; i < leafs.count; i++) {
    if ((i & 511) === 0) await phase(signal);
    spend(1);
    const cluster = leafs.u(i, 4), first = leafs.u(i, 20), count = leafs.u(i, 22);
    leafClusters.push(cluster); range(first, count, leafFaces.count, 'leaf faces');
    for (let j = first; j < first + count; j++) {
      spend(1);
      if ((work & 8191) === 0) await phase(signal);
      const face = leafFaces.u(j, 0); range(face, 1, faces.count, 'leaf face'); add(face, cluster);
    }
  }
  // Python's visibility exporter multiplies the native float32 displacement
  // vector/distance as float32 before adding its float64 base grid. The geometry
  // decoder retains a double product in sourcePositions; its slightly different
  // extrema can miss leaves touched exactly by the authored float32 product.
  // Reconstruct that arithmetic from original records, not a bbox epsilon or a
  // metres/Float32 roundtrip, and leave all geometry/source bytes untouched.
  const displaced = new Set<number>();
  charge(world.surfaces.length * 48 + (nodes.length + 1) * 4);
  const intersect = new Int32Array(nodes.length + 1);
  let dispInfo: Records | undefined, dispVertices: Records | undefined;
  for (let surfaceIndex = 0; surfaceIndex < world.surfaces.length; surfaceIndex++) {
    if ((surfaceIndex & 511) === 0) await phase(signal);
    const surface = world.surfaces[surfaceIndex];
    spend(1);
    if (surface.displacement < 0) continue;
    range(surface.face, 1, faces.count, 'displacement face'); displaced.add(surface.face);
    if (!dispInfo || !dispVertices) {
      dispInfo = await load(26, 176); dispVertices = await load(33, 20);
    }
    range(surface.displacement, 1, dispInfo.count, 'displacement info');
    if (faces.view.getInt16(surface.face * 56 + 12, true) !== surface.displacement) throw new Error('Source displacement face/info identity mismatch');
    const firstVertex = dispInfo.i(surface.displacement, 12), power = dispInfo.i(surface.displacement, 20);
    if (power < 2 || power > 4) throw new Error('Unsupported Source visibility displacement power');
    const vertexCount = ((1 << power) + 1) ** 2;
    range(firstVertex, vertexCount, dispVertices.count, 'displacement vertices');
    const points = surface.sourcePositions, base = surface.basePositions;
    if (points.length !== vertexCount * 3 || !base || base.length !== points.length) throw new Error('Invalid Source displacement visibility vertices/base grid');
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      spend(3);
      if ((vertex & 1023) === 0) await phase(signal);
      const nativeVertex = firstVertex + vertex, distance = dispVertices.f(nativeVertex, 12);
      for (let axis = 0; axis < 3; axis++) {
        const j = vertex * 3 + axis, position = base[j] + Math.fround(dispVertices.f(nativeVertex, axis * 4) * distance);
        if (!Number.isFinite(points[j]) || !Number.isFinite(base[j]) || !Number.isFinite(position)) throw new Error('Nonfinite Source displacement visibility position');
        lo[axis] = Math.min(lo[axis], position); hi[axis] = Math.max(hi[axis], position);
      }
    }
    const centre = lo.map((v, k) => (v + hi[k]) / 2), half = lo.map((v, k) => (hi[k] - v) / 2);
    let depth = 1; intersect[0] = head;
    while (depth) {
      spend(1);
      if ((work & 8191) === 0) await phase(signal);
      const index = intersect[--depth];
      if (index < 0) add(surface.face, leafClusters[-index - 1]);
      else {
        const p = nodes[index], distance = centre[0] * p[0] + centre[1] * p[1] + centre[2] * p[2] - p[3];
        const radius = half[0] * Math.abs(p[0]) + half[1] * Math.abs(p[1]) + half[2] * Math.abs(p[2]);
        if (distance + radius >= 0) intersect[depth++] = p[4];
        if (distance - radius <= 0) intersect[depth++] = p[5];
      }
    }
    await phase(signal);
  }
  for (let i = 0; i < faces.count; i++) {
    spend(1);
    if ((i & 8191) === 0) await phase(signal);
    if (faces.view.getInt16(i * 56 + 12, true) >= 0 && !displaced.has(i)) throw new Error(`Source displacement face ${i} lacks decoded native vertices`);
  }
  let skyEntity: typeof bsp.entities[number] | undefined;
  for (let entityIndex = 0; entityIndex < bsp.entities.length; entityIndex++) {
    if ((entityIndex & 255) === 0) await phase(signal);
    const entity = bsp.entities[entityIndex];
    spend(1);
    let classname: string | undefined;
    for (let i = 0; i < entity.pairs.length; i++) {
      spend(1);
      if ((i & 1023) === 0) await phase(signal);
      const [key, value] = entity.pairs[i];
      if (key.length === 9 && key.toLowerCase() === 'classname') classname = value;
    }
    if (classname === 'sky_camera') { skyEntity = entity; break; }
  }
  let sky: SourceVisibilityData['sky'] = null;
  if (skyEntity) {
    let origin: string | undefined, scale: string | undefined;
    for (let i = 0; i < skyEntity.pairs.length; i++) {
      spend(1);
      if ((i & 1023) === 0) await phase(signal);
      const [key, value] = skyEntity.pairs[i];
      if (key.length === 6 && key.toLowerCase() === 'origin') origin = value;
      if (key.length === 5 && key.toLowerCase() === 'scale') scale = value;
    }
    // Bound vector tokenization before splitting an authored string.
    spend((origin?.length ?? 0) + (scale?.length ?? 0));
    charge((origin?.length ?? 0) * 40 + (scale?.length ?? 0) * 4 + 128);
    const position = (origin ?? '0 0 0').trim().split(/\s+/).map(Number), size = scale === undefined ? 16 : Number(scale);
    if (position.length !== 3 || !position.every(Number.isFinite) || !Number.isFinite(size) || size <= 0) throw new Error('Invalid Source sky camera origin/scale');
    sky = { origin: position, scale: size };
  }
  const tree = { head, nodes, leafClusters }, requirements: SourceLightingRequirement[] = [];
  const lump = bsp.lumps[4], byteLength = lump.uncompressedSize || lump.length;
  const withoutPvs = (): SourceVisibilityResult => {
    sourceAbort(signal);
    if (sky) requirements.push({ code: 'sky-without-pvs', blocking: true, detail: 'Authored sky_camera has no native PVS; the separate Source 3D sky view cannot select its native geometry.' });
    return { data: null, requirements, tree, usage: { records, work } };
  };
  if (!byteLength) return withoutPvs();
  if (lump.version !== 0 || byteLength < 4) throw new Error('Unsupported/truncated Source visibility');
  if (byteLength > maxInput - input) throw new Error('Source visibility input limit exceeded');
  const consumers = sky ? 2 : 1;
  if (byteLength * (1 + consumers) > maxDecoded) throw new Error('Source visibility decoded ownership limit exceeded');
  // Base64 assembly, JS strings, SourcePVS atob/input bytes and offset set.
  charge(byteLength * 12);
  const bytes = await bsp.getLump(4, signal), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true), rowBytes = Math.ceil(count / 8), tableEnd = 4 + count * 8;
  // A native zero-cluster header has no rows, even when authored leaves retain
  // non-sentinel cluster identities. Do not validate them against an empty table.
  if (count === 0) return withoutPvs();
  range(4, count * 8, bytes.length, 'visibility table');
  if (count > maxRecords - records || leafClusters.some(c => c !== 65535 && c >= count)) throw new Error('Source visibility cluster count mismatch/limit');
  if (count * rowBytes * consumers + bytes.length * (1 + consumers) > maxDecoded) throw new Error('Source visibility decoded ownership limit exceeded');
  charge(count * (160 + consumers * 64));
  const seen = new Set<number>();
  for (let i = 0; i < count * 2; i++) {
    spend(1);
    if ((i & 1023) === 0) await phase(signal);
    const offset = view.getUint32(4 + i * 4, true);
    if (offset === 0 || seen.has(offset)) continue; // Native zero offset means all-visible row; preserve, do not synthesize.
    range(offset, 1, bytes.length, 'PVS/PAS offset');
    if (offset < tableEnd) throw new Error('Source visibility row points into its table');
    seen.add(offset);
    let at = offset, out = 0;
    while (out < rowBytes) {
      spend(1);
      if ((work & 8191) === 0) await phase(signal);
      range(at, 1, bytes.length, 'PVS/PAS byte');
      if (bytes[at++]) out++;
      else {
        range(at, 1, bytes.length, 'PVS/PAS run');
        const run = bytes[at++];
        if (!run || run > rowBytes - out) throw new Error('Invalid Source PVS/PAS zero run');
        out += run;
      }
    }
  }
  const clusters: number[][] = [];
  for (const members of faceClusters) {
    spend(1 + members.size * Math.ceil(Math.log2(members.size + 1)));
    clusters.push([...members].sort((a, b) => a - b));
    if ((clusters.length & 1023) === 0) await phase(signal);
  }
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x6000) {
    spend(Math.min(0x6000, bytes.length - i));
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 0x6000))));
    if ((i & 0x1ffff) === 0) await phase(signal);
  }
  sourceAbort(signal);
  return { data: { version: 1, spawn: [...frame.origin], yaw: frame.yaw, ...tree, faceClusters: clusters, visibility: parts.join(''), sky }, requirements, tree, usage: { records: records + count, work } };
}
