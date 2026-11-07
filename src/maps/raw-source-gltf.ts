// Like the native importers, this writer preserves the caller's Z-up coordinates.
// It only owns binary packaging; scene, material and transform choices belong to the caller.
import { encodeSourceJson, type SourceJsonOptions } from './raw-source-json';
type Extras = { name?: string; extras?: Record<string, unknown>; extensions?: Record<string, unknown> };
type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';
type BufferTarget = 34962 | 34963;
type AccessorArray = Float32Array | Uint8Array | Uint16Array | Uint32Array;
interface TextureInfo { index: number; texCoord?: number; extensions?: Record<string, unknown> }
/** Native cycle is normalized sequence phase; rate scales absolute Source time.
 * The scene owner activates each clip only on its own loaded GLTF root. */
export interface SourcePlayback {
  version: 1;
  loop: boolean;
  cycle: number;
  rate: number;
}
export interface SourceGltfRoot {
  asset: { version: '2.0'; generator?: string };
  scene: number;
  scenes: (Extras & { nodes: number[] })[];
  nodes: (Extras & { mesh?: number; skin?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; weights?: number[] })[];
  meshes: (Extras & { primitives: (Extras & { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: Record<string, number>[] })[]; weights?: number[] })[];
  materials: (Extras & {
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: TextureInfo; metallicFactor?: number; roughnessFactor?: number; metallicRoughnessTexture?: TextureInfo };
    normalTexture?: TextureInfo & { scale?: number }; occlusionTexture?: TextureInfo & { strength?: number };
    emissiveTexture?: TextureInfo; emissiveFactor?: number[]; alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'; alphaCutoff?: number; doubleSided?: boolean;
  })[];
  accessors: (Extras & { bufferView: number; byteOffset?: number; componentType: 5121 | 5123 | 5125 | 5126; count: number; type: AccessorType; normalized?: boolean; min?: number[]; max?: number[] })[];
  bufferViews: (Extras & { buffer: number; byteOffset: number; byteLength: number; target?: BufferTarget; byteStride?: number })[];
  buffers: { byteLength: number }[];
  images: (Extras & { bufferView: number; mimeType: string })[];
  textures: (Extras & { sampler?: number; source?: number })[];
  samplers: (Extras & { wrapS?: number; wrapT?: number; magFilter?: number; minFilter?: number })[];
  skins?: (Extras & { inverseBindMatrices?: number; skeleton?: number; joints: number[] })[];
  animations?: (Omit<Extras, 'extras'> & {
    extras?: Record<string, unknown> & { sourcePlayback?: SourcePlayback };
    samplers: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
    channels: { sampler: number; target: { node: number; path: 'translation' | 'rotation' | 'scale' | 'weights' } }[];
  })[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
  extras?: Record<string, unknown>;
}
const COMPONENTS: Record<AccessorType, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ZERO_PAD = new Uint8Array(3);
const SPACE_PAD = new Uint8Array([32, 32, 32]);
const aligned = (length: number) => Math.ceil(length / 4) * 4;
function targetValid(target?: BufferTarget): void {
  if (target !== undefined && target !== 34962 && target !== 34963) throw new RangeError('Invalid glTF buffer target');
}

export class SourceGlb {
  readonly json: SourceGltfRoot = {
    asset: { version: '2.0', generator: 'm0clip Source map assets' },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [],
    accessors: [], bufferViews: [], buffers: [], images: [], textures: [],
    samplers: [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }],
  };
  private readonly parts: Blob[] = [];
  private byteLength = 0;

  // The cap applies to the entire finished file, not merely its BIN payload.
  constructor(private readonly maxBytes = 1024 ** 3,
    private readonly jsonLimits: Omit<SourceJsonOptions, 'maxBytes' | 'signal'> = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 28 || maxBytes > 0xffffffff) throw new RangeError('Invalid GLB byte limit');
  }

  view(data: Blob | ArrayBuffer | ArrayBufferView, target?: BufferTarget): number {
    targetValid(target);
    let payload: Blob;
    const length = data instanceof Blob ? data.size : data.byteLength;
    const offset = aligned(this.byteLength);
    if (!Number.isSafeInteger(length) || length < 1 || offset + aligned(length) + 28 > this.maxBytes) throw new RangeError('GLB buffer view exceeds byte limit or is empty');
    if (data instanceof Blob) payload = data; // Immutable encoded assets stay shared.
    else if (data instanceof ArrayBuffer) payload = new Blob([data]);
    else if (ArrayBuffer.isView(data)) {
      if (typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer) throw new TypeError('Shared GLB input cannot be snapshotted atomically');
      // Blob snapshots exactly this slice once, including DataView/nonzero offsets.
      payload = new Blob([new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)]);
    } else throw new TypeError('Invalid GLB buffer view data');
    if (offset !== this.byteLength) this.parts.push(new Blob([ZERO_PAD.subarray(0, offset - this.byteLength)]));
    this.parts.push(payload);
    this.byteLength = offset + length;
    const index = this.json.bufferViews.length;
    this.json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: length, ...(target === undefined ? {} : { target }) });
    return index;
  }

  accessor(data: AccessorArray, type: AccessorType, options: { target?: BufferTarget; normalized?: boolean; bounds?: boolean } = {}): number {
    const size = COMPONENTS[type];
    if (!Object.hasOwn(COMPONENTS, type) || !size) throw new RangeError('Invalid glTF accessor shape');
    const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint8Array ? 5121 : data instanceof Uint16Array ? 5123 : data instanceof Uint32Array ? 5125 : undefined;
    if (componentType === undefined) throw new TypeError('Unsupported glTF accessor component type');
    if (!data.length || data.length % size !== 0) throw new RangeError('Invalid glTF accessor component count');
    if (!(data.buffer instanceof ArrayBuffer)) throw new TypeError('Shared GLB input cannot be snapshotted atomically');
    targetValid(options.target);
    if (options.normalized && componentType !== 5121 && componentType !== 5123) throw new RangeError('Only byte/short accessors can be normalized');
    if (options.target === 34963 && (type !== 'SCALAR' || componentType === 5126 || options.normalized)) throw new RangeError('Invalid glTF index accessor');
    const min = options.bounds ? new Array<number>(size).fill(Infinity) : undefined;
    const max = options.bounds ? new Array<number>(size).fill(-Infinity) : undefined;
    if (componentType === 5126 || options.bounds) {
      for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (!Number.isFinite(value)) throw new RangeError('Non-finite glTF accessor component');
        if (min && max) { const axis = i % size; min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }
      }
    }
    const elementBytes=size*data.BYTES_PER_ELEMENT,stride=options.target===34962?aligned(elementBytes):elementBytes;
    let bufferView:number;
    if(stride===elementBytes)bufferView=this.view(data,options.target);
    else{
      const count=data.length/size,length=stride*count;
      if(aligned(this.byteLength)+length+28>this.maxBytes)throw new RangeError('GLB vertex packing exceeds byte limit');
      const source=new Uint8Array(data.buffer,data.byteOffset,data.byteLength),packed=new Uint8Array(length);
      for(let i=0;i<count;i++)packed.set(source.subarray(i*elementBytes,(i+1)*elementBytes),i*stride);
      bufferView=this.view(packed,options.target);
      this.json.bufferViews[bufferView].byteStride=stride;
    }
    const index = this.json.accessors.length;
    this.json.accessors.push({ bufferView, componentType, count: data.length / size, type,
      ...(options.normalized === undefined ? {} : { normalized: options.normalized }), ...(min && max ? { min, max } : {}) });
    return index;
  }

  finish(signal?: AbortSignal): Blob {
    signal?.throwIfAborted();
    const binaryLength = aligned(this.byteLength);
    this.json.buffers = binaryLength ? [{ byteLength: binaryLength }] : [];
    const snapshot:Record<string,unknown>={...this.json};
    for(const [key,value] of Object.entries(snapshot))if(Array.isArray(value)&&value.length===0)delete snapshot[key];
    if(this.json.scenes.some(scene=>scene.nodes.length===0))snapshot.scenes=this.json.scenes.map(scene=>{
      if(scene.nodes.length)return scene;
      const record:Record<string,unknown>={...scene};delete record.nodes;return record;
    });
    const jsonBudget = Math.floor((this.maxBytes - 20 - (binaryLength ? 8 + binaryLength : 0)) / 4) * 4;
    if (jsonBudget < 0) throw new RangeError('GLB exceeds byte limit');
    const json = encodeSourceJson(snapshot, { ...this.jsonLimits, maxBytes: jsonBudget, signal });
    const jsonLength = aligned(json.byteLength);
    const total = 20 + jsonLength + (binaryLength ? 8 + binaryLength : 0);
    if (total > this.maxBytes || total > 0xffffffff) throw new RangeError('GLB exceeds byte limit');
    signal?.throwIfAborted();
    const header = new ArrayBuffer(20), words = new DataView(header);
    words.setUint32(0, 0x46546c67, true); words.setUint32(4, 2, true); words.setUint32(8, total, true);
    words.setUint32(12, jsonLength, true); words.setUint32(16, 0x4e4f534a, true);
    const parts: BlobPart[] = [header, json, SPACE_PAD.subarray(0, jsonLength - json.byteLength)];
    if (binaryLength) {
      const binHeader = new DataView(new ArrayBuffer(8));
      binHeader.setUint32(0, binaryLength, true); binHeader.setUint32(4, 0x004e4942, true);
      parts.push(binHeader.buffer);
      for (const part of this.parts) parts.push(part);
      parts.push(ZERO_PAD.subarray(0, binaryLength - this.byteLength));
    }
    return new Blob(parts, { type: 'model/gltf-binary' });
  }
}
