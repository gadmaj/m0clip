// Adapted from noclip.website SourceEngine/Studio.ts (Copyright 2018 Jasper
// St. Pierre, MIT; see LICENSE.noclip) and scripts/source_models.py.
import { canonicalSourcePath, type SourceFileSystem } from './raw-source-files';
import { sourceAbort } from './raw-source-lzma';
import { SourceModelBinary as Binary, sourceModelMultiply, type SourceModelVector } from './raw-source-model-binary';

export interface SourceStudioOptions {
  signal?: AbortSignal;
  /** Decode one actual VTX LOD, retaining all bodygroups and skin families. */
  lod?: number;
  maxFileBytes?: number;
  maxVertices?: number;
  /** Import-wide unique retained resource bytes; defaults to 512 MiB. */
  maxInputBytes?: number;
  /** Cumulative copied input and decoded metadata/scratch ownership, charged
   * conservatively before allocation; defaults to 256 MiB. Geometry payload
   * remains bounded separately by maxVertices. Charges are not recycled. */
  maxMetadataBytes?: number;
  /** Metadata records, strings, arrays and buffer objects; defaults to 1,000,000. */
  maxMetadataObjects?: number;
  /** Independent family/reference cardinality caps; each defaults to 65,536. */
  maxSkinFamilies?: number;
  maxSkinReferences?: number;
  /** Unique animation-owning MDLs, including roots; defaults to 1,024. */
  maxIncludedModels?: number;
  /** Longest ordered include-model ownership chain; defaults to 64. */
  maxIncludeDepth?: number;
}
export class SourceStudioMissingResourceError extends Error {
  constructor(readonly paths: readonly string[]) { super(`Missing Source studio resources: ${paths.join(', ')}`); this.name = 'SourceStudioMissingResourceError'; }
}
export interface SourceStudioMaterial {
  name: string;
  /** Canonical materials/...vmt path if present; never an error material. */
  path?: string;
  candidates: readonly string[];
}
export interface SourceStudioBone {
  name: string; parent: number;
  /** All translations below are Source units, including inverse-bind translation. */
  position: SourceModelVector; quaternion: [number, number, number, number];
  rotation: SourceModelVector; positionScale: SourceModelVector; rotationScale: SourceModelVector;
  localMatrix: Float64Array; defaultWorldMatrix: Float64Array; inverseBindMatrix: Float64Array;
  flags: number; proceduralType: number;
}
export interface SourceStudioMesh {
  bodypart: number; submodel: number; bodyBase: number; bodyCount: number;
  name: string; lod: number; switchPoint: number; skinref: number;
  materialBySkin: readonly SourceStudioMaterial[];
  /** Model-local bind-pose Source units/Z-up. No bone or map transform is baked. */
  positions: Float32Array; normals: Float32Array; tangents: Float32Array; uv: Float32Array;
  /** glTF CCW front winding; tangent basis already converted to glTF. */
  indices: Uint32Array;
  /** Global MDL bone indices, NOT VTX hardware palette indices. Four slots/vertex. */
  joints: Uint16Array; weights: Float32Array;
  flexCount: number; materialType: number; materialParameter: number;
}
export interface SourceStudioAnimation {
  name: string; descriptorOffset: number; fps: number; flags: number; frames: number;
  block: number; index: number; sectionOffset: number; sectionFrames: number;
  /** Exact 100-byte descriptor; encoded channels remain in owning raw MDL/ANI. */
  raw: Blob;
}
export interface SourceStudioSequence {
  name: string; activity: string; flags: number; descriptorOffset: number;
  groupSize: [number, number]; animationIndices: Uint16Array; raw: Blob;
}
export interface SourceStudioCompanion {
  path: string; kind: 'animation' | 'include-model'; blob?: Blob;
}
export interface SourceStudioNativeAnimation {
  animations: readonly SourceStudioAnimation[]; sequences: readonly SourceStudioSequence[];
  blocks: readonly { start: number; end: number }[];
  companions: readonly SourceStudioCompanion[];
  /** Included MDLs and their transitive companions, without requiring nonexistent VVDs. */
  includedModels: readonly { path: string; rawBlob: Blob; animation: SourceStudioNativeAnimation }[];
  temporalSupport: 'encoded-data-preserved-not-sampled';
}
export interface SourceStudioModel {
  path: string; name: string; version: number; checksum: number; flags: number;
  units: 'source-units'; up: 'Z'; pose: 'bind';
  illuminationPosition: SourceModelVector; bounds: [SourceModelVector, SourceModelVector];
  /** Source render bounds prefer nonzero view bounds; collision keeps the hull. */
  renderBounds: [SourceModelVector, SourceModelVector];
  materials: readonly SourceStudioMaterial[]; skins: readonly Uint16Array[];
  bodyparts: readonly { name: string; base: number; models: readonly string[] }[];
  lod: number; lodVertexCounts: readonly number[]; meshes: readonly SourceStudioMesh[];
  bones: readonly SourceStudioBone[]; animation: SourceStudioNativeAnimation;
  rawBlob: Blob; vvdBlob: Blob; vtxBlob: Blob;
  requiredCompanions: readonly string[]; missingResources: readonly string[];
  limitations: readonly string[];
}

function boneMatrix(position: SourceModelVector, q: readonly number[]): Float64Array {
  const [x,y,z,w] = q, n = Math.hypot(x,y,z,w);
  if (Math.abs(n - 1) > 0.02) throw new Error('Invalid Source default bone quaternion');
  const xx=x/n, yy=y/n, zz=z/n, ww=w/n;
  return new Float64Array([1-2*(yy*yy+zz*zz),2*(xx*yy+zz*ww),2*(xx*zz-yy*ww),0,2*(xx*yy-zz*ww),1-2*(xx*xx+zz*zz),2*(yy*zz+xx*ww),0,2*(xx*zz+yy*ww),2*(yy*zz-xx*ww),1-2*(xx*xx+yy*yy),0,...position,1]);
}
function validateMdl(m: Binary): number {
  m.range(0, 0x198);
  if (m.u(0) !== 0x54534449 || ![44,45,46,47,48,49].includes(m.u(4))) throw new Error(`${m.name}: unsupported IDST version`);
  if (m.u(76) !== m.bytes.length) throw new Error(`${m.name}: MDL declared length mismatch`);
  return m.u(4);
}

interface StudioContext {
  options: SourceStudioOptions;
  vertexMaximum: number; skinMaximum: number; skinReferenceMaximum: number;
  includeMaximum: number; depthMaximum: number;
  animations: Map<string, { path: string; rawBlob: Blob; animation: SourceStudioNativeAnimation }>;
  depths: Map<string, number>;
  reserve(bytes: number, objects: number): void;
  read(path: string): Promise<Blob | undefined>;
  binary(blob: Blob, path: string): Promise<Binary>;
  string(binary: Binary, offset: number, maximum?: number): string;
  relativeString(binary: Binary, base: number, field: number): string;
  checkpoint(index: number): Promise<void> | undefined;
}

/** One explicit import owns all cached bodies and decoded include metadata.
 * Unique extractions are queued: the complete remaining byte allowance is
 * reserved before entering the VFS, never offered to two in-flight reads.
 * Root loads are queued too, so shared include promises cannot deadlock on
 * opposing include cycles. No state survives this import instance. */
export class SourceStudioImport {
  private readonly context: StudioContext;
  private readonly models = new Map<string, Promise<SourceStudioModel>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(filesystem: Pick<SourceFileSystem, 'readFile'>, options: SourceStudioOptions = {}) {
    options = { ...options };
    const maximum = options.maxFileBytes ?? 128 * 1024 ** 2, vertexMaximum = options.maxVertices ?? 4_000_000;
    const inputMaximum = options.maxInputBytes ?? 512 * 1024 ** 2, metadataMaximum = options.maxMetadataBytes ?? 256 * 1024 ** 2;
    const objectMaximum = options.maxMetadataObjects ?? 1_000_000, skinMaximum = options.maxSkinFamilies ?? 65_536, skinReferenceMaximum = options.maxSkinReferences ?? 65_536;
    const includeMaximum = options.maxIncludedModels ?? 1024, depthMaximum = options.maxIncludeDepth ?? 64;
    if (![maximum, vertexMaximum, inputMaximum, metadataMaximum, objectMaximum, skinMaximum, skinReferenceMaximum, includeMaximum, depthMaximum].every(n => Number.isSafeInteger(n) && n > 0) || maximum < 408) throw new Error('Invalid Source studio allocation limits');
    let inputBytes = 0, metadataBytes = 0, objects = 0, reads: Promise<unknown> = Promise.resolve();
    const blobs = new Map<string, Promise<Blob | undefined>>(), binaries = new Map<string, Promise<Binary>>();
    const reserve = (bytes: number, count: number) => {
      sourceAbort(options.signal);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(count) || count < 0 || bytes > metadataMaximum - metadataBytes || count > objectMaximum - objects) throw new Error('Source studio decoded metadata allocation limit');
      metadataBytes += bytes; objects += count;
    };
    const string = (binary: Binary, offset: number, maximum = binary.bytes.length - offset): string => {
      binary.range(offset, maximum);
      const end = binary.bytes.indexOf(0, offset);
      if (end < offset || end >= offset + maximum) throw new Error(`${binary.name}: unterminated string at ${offset}`);
      const length=end-offset;
      if(length<=8192){
        reserve(length*2+64,2);
        return String.fromCharCode(...binary.bytes.subarray(offset,end));
      }
      const count=Math.ceil(length/8192);
      reserve(length*4+count*96+64,count*2+2);
      const chunks:string[]=[];
      // Preserve Studio's byte-string code points; TextDecoder('latin1')
      // instead substitutes Windows-1252 characters in the 0x80–0x9f range.
      for(let p=offset;p<end;p+=8192)chunks.push(String.fromCharCode(...binary.bytes.subarray(p,Math.min(p+8192,end))));
      return chunks.join('');
    };
    this.context = {
      options, vertexMaximum, skinMaximum, skinReferenceMaximum, includeMaximum, depthMaximum, animations: new Map(), depths: new Map(), reserve, string,
      relativeString: (binary, base, field) => string(binary, base + binary.i(base + field)),
      checkpoint(index) {
        sourceAbort(options.signal);
        if (index && (index & 255) === 0) return new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => sourceAbort(options.signal));
      },
      read(path) {
        path = canonicalSourcePath(path);
        const cached = blobs.get(path); if (cached) return cached;
        reserve(path.length * 2 + 160, 3);
        const pending = reads.then(async () => {
          sourceAbort(options.signal);
          const allowance = Math.min(maximum, inputMaximum - inputBytes);
          const blob = await filesystem.readFile(path, options.signal, allowance);
          sourceAbort(options.signal);
          if (blob && blob.size > allowance) throw new Error(`${path}: file exceeds studio input allocation limit`);
          if (blob) inputBytes += blob.size;
          return blob;
        });
        // A failed read poisons this import's queue; no partially failed import
        // may restart extraction with already-retained ownership unaccounted.
        reads = pending; blobs.set(path, pending); return pending;
      },
      binary(blob, path) {
        const cached = binaries.get(path); if (cached) return cached;
        reserve(blob.size + 256, 4);
        const pending = blob.arrayBuffer().then(buffer => { sourceAbort(options.signal); return new Binary(new Uint8Array(buffer), path); });
        binaries.set(path, pending); return pending;
      },
    };
  }
  readModel(path: string): Promise<SourceStudioModel> {
    path = canonicalSourcePath(path);
    const cached = this.models.get(path); if (cached) return cached;
    this.context.reserve(path.length * 2 + 128, 2);
    const pending = this.queue.then(() => readStudioModel(this.context, path));
    this.models.set(path, pending); this.queue = pending.catch(() => undefined); return pending;
  }
}

/** Read only explicitly mounted resources. No fetch, game scanning or cross-import cache. */
export async function readSourceStudioModel(filesystem: Pick<SourceFileSystem, 'readFile'>, path: string, options: SourceStudioOptions = {}): Promise<SourceStudioModel> {
  return new SourceStudioImport(filesystem, options).readModel(path);
}

async function readStudioModel(context: StudioContext, path: string): Promise<SourceStudioModel> {
  const { options, vertexMaximum, reserve } = context, signal = options.signal;
  sourceAbort(signal);
  if (!path.endsWith('.mdl')) throw new Error('Source studio path must end in .mdl');
  if(!context.animations.has(path)&&context.animations.size>=context.includeMaximum)throw new Error('Source include-model graph exceeds resource limit');
  const base = path.slice(0, -4), paths = [path, `${base}.vvd`, `${base}.dx90.vtx`];
  const blobs = await Promise.all(paths.map(p => context.read(p)));
  sourceAbort(signal);
  const missing = paths.filter((_, i) => !blobs[i]);
  if (missing.length) throw new SourceStudioMissingResourceError(missing);
  const [mdlBlob, vvdBlob, vtxBlob] = blobs as [Blob, Blob, Blob];
  const [m,v,t] = await Promise.all([context.binary(mdlBlob,path),context.binary(vvdBlob,paths[1]),context.binary(vtxBlob,paths[2])]);
  const version = validateMdl(m), checksum = m.u(8);
  const textureTable=m.table(0xcc,64), skinRefs=m.u(0xdc), skinFamilies=m.u(0xe0), skinStart=m.u(0xe4);
  if ((skinRefs===0)!==(skinFamilies===0) || (skinRefs>0&&!textureTable.count) || skinRefs>context.skinReferenceMaximum || skinFamilies>context.skinMaximum) throw new Error(`${path}: inconsistent or excessive skin family/reference counts`);
  m.range(skinStart,skinFamilies*skinRefs,2);
  reserve(skinFamilies * (skinRefs * 2 + 144) + 64, skinFamilies * 2 + 1);
  v.range(0,64); t.range(0,36);
  if (v.u(0) !== 0x56534449 || v.u(4) !== 4 || t.u(0) !== 7) throw new Error(`${path}: unsupported VVD/VTX version`);
  if (v.u(8) !== checksum || t.u(16) !== checksum) throw new Error(`${path}: MDL/VVD/VTX checksum mismatch`);
  const lodCount = v.u(12), lod = options.lod ?? 0;
  if (lodCount < 1 || lodCount > 8 || t.u(20) !== lodCount || !Number.isInteger(lod) || lod < 0 || lod >= lodCount) throw new Error(`${path}: invalid or mismatched studio LOD`);
  reserve(64 + lodCount * 8, 1);
  const lodVertexCounts = Array.from({length:lodCount}, (_,i) => v.u(16+i*4));
  const totalVertices = lodVertexCounts[0], vertexStart = v.u(56), tangentStart = v.u(60);
  if (totalVertices > vertexMaximum || lodVertexCounts.some((n,i) => n > totalVertices || (i > 0 && n > lodVertexCounts[i-1]))) throw new Error(`${path}: invalid VVD LOD vertex counts`);
  v.range(vertexStart,totalVertices,48); v.range(tangentStart,totalVertices,16);
  if (vertexStart < 64 || tangentStart < vertexStart+totalVertices*48) throw new Error(`${path}: overlapping VVD vertex/tangent data`);
  // MDL offsets and VTX origMeshVertIDs address the reconstructed LOD0 stream,
  // even when drawing a lower LOD. Filtering fixups by selected LOD here is wrong.
  const fixupCount=v.u(48),fixupStart=v.u(52);
  v.range(fixupStart,fixupCount,12);
  if(fixupCount&&(fixupStart<64||fixupStart+fixupCount*12>vertexStart))throw new Error(`${path}: VVD fixup table overlaps header or vertices`);
  if(fixupCount)reserve(totalVertices*5+256,4);
  const remap=fixupCount?new Uint32Array(totalVertices):undefined;
  if (remap) {
    let dst = 0; const seen = new Uint8Array(totalVertices);
    for (let i=0;i<fixupCount;i++) {
      const pause=context.checkpoint(i);if(pause)await pause;
      const p=fixupStart+i*12, level=v.u(p), src=v.u(p+4), count=v.u(p+8);
      if (level >= lodCount || src > totalVertices || count > totalVertices-src || count > totalVertices-dst) throw new Error(`${path}: invalid VVD fixup`);
      for (let j=0;j<count;j++) { if((j&16383)===0){const pause=context.checkpoint(j>>6);if(pause)await pause;} if (seen[src+j]) throw new Error(`${path}: overlapping VVD fixups`); seen[src+j]=1; remap[dst++]=src+j; }
    }
    if (dst !== totalVertices) throw new Error(`${path}: incomplete VVD fixups`);
    for (let level=1;level<lodCount;level++) {
      let count=0; for(let i=0;i<fixupCount;i++) if(v.u(fixupStart+i*12)>=level) count+=v.u(fixupStart+i*12+8);
      if(count!==lodVertexCounts[level]) throw new Error(`${path}: VVD fixup/LOD count mismatch`);
    }
  }
  const bones: SourceStudioBone[] = [], boneTable=m.table(0x9c,216);
  if (boneTable.count > 256) throw new Error(`${path}: too many MDL bones`);
  reserve(64+boneTable.count*2048,1+boneTable.count*16);
  for (let i=0;i<boneTable.count;i++) {
    const pause=context.checkpoint(i);if(pause)await pause;
    const p=boneTable.offset+i*216, parent=m.i(p+4);
    if(parent < -1 || parent >= i) throw new Error(`${path}: cyclic/out-of-order bone parent`);
    const position=m.vec(p+32), quaternion: [number,number,number,number]=[...m.vec(p+44),m.f(p+56)];
    const localMatrix=boneMatrix(position,quaternion), inverse=new Float64Array(16); inverse[15]=1;
    for(let r=0;r<3;r++) for(let c=0;c<4;c++) inverse[c*4+r]=m.f(p+96+r*16+c*4);
    bones.push({name:context.relativeString(m,p,0),parent,position,quaternion,rotation:m.vec(p+60),positionScale:m.vec(p+72),rotationScale:m.vec(p+84),localMatrix,defaultWorldMatrix:parent<0?localMatrix:sourceModelMultiply(bones[parent].defaultWorldMatrix,localMatrix),inverseBindMatrix:inverse,flags:m.u(p+160),proceduralType:m.u(p+164)});
  }
  const directories: string[] = [], dirs=m.table(0xd4,4);
  reserve(64+dirs.count*8,1);
  for(let i=0;i<dirs.count;i++){const pause=context.checkpoint(i);if(pause)await pause;const value=context.string(m,m.u(dirs.offset+i*4));reserve(value.length*6+96,3);directories.push(value.replace(/\\/g,'/').replace(/^materials\//i,'').replace(/\/$/,''));}
  const materialCache=new Map<string,Promise<SourceStudioMaterial>>();
  const resolveMaterial=(name:string):Promise<SourceStudioMaterial> => {
    const cached=materialCache.get(name); if(cached) return cached;
    reserve(name.length*6+224,5);
    const pending=(async()=>{
      const clean=name.replace(/\\/g,'/').replace(/^materials\//i,'').replace(/\.vmt$/i,'');
      let candidateBytes=(clean.length+14)*2+64;
      for(const directory of directories)candidateBytes+=(directory.length+clean.length+15)*2+64;
      reserve(candidateBytes*3+(directories.length+1)*48,3*(directories.length+1)+4);
      const candidates=[...new Set([...directories.map(d=>`${d?`${d}/`:''}${clean}`),clean].map(n=>canonicalSourcePath(`materials/${n}.vmt`)))];
      for(const candidate of candidates) { sourceAbort(signal); if(await context.read(candidate)) return {name:clean,path:candidate,candidates}; }
      return {name:clean,candidates};
    })(); materialCache.set(name,pending); return pending;
  };
  const materials: SourceStudioMaterial[] = [];
  reserve(128+textureTable.count*16,2);
  for(let i=0;i<textureTable.count;i++){const pause=context.checkpoint(i);if(pause)await pause;materials.push(await resolveMaterial(context.relativeString(m,textureTable.offset+i*64,0)));}
  const skins: Uint16Array[]=[];
  for(let s=0;s<skinFamilies;s++) {
    const pause=context.checkpoint(s);if(pause)await pause;
    const family=new Uint16Array(skinRefs);
    for(let i=0;i<skinRefs;i++) { if((i&16383)===0){const pause=context.checkpoint(i>>6);if(pause)await pause;} family[i]=m.h(skinStart+(s*skinRefs+i)*2); if(family[i]>=materials.length) throw new Error(`${path}: skin material out of range`); }
    skins.push(family);
  }
  reserve(64+materials.length*8,1);
  const lodMaterials=materials.slice(), replacementStart=t.u(24);
  if(replacementStart) {
    t.range(replacementStart,lodCount,8); const p=replacementStart+lod*8, count=t.u(p), start=p+t.i(p+4); t.range(start,count,6);
    for(let i=0;i<count;i++) { const pause=context.checkpoint(i);if(pause)await pause;const r=start+i*6,id=t.h(r); if(id>=materials.length) throw new Error(`${path}: LOD material replacement out of range`); lodMaterials[id]=await resolveMaterial(context.relativeString(t,r,2)); }
  }
  const bodyparts: {name:string;base:number;models:string[]}[]=[], meshes: SourceStudioMesh[]=[], bodies=m.table(0xe8,16);
  if(t.u(28)!==bodies.count) throw new Error(`${path}: MDL/VTX bodypart mismatch`);
  const vbodyStart=t.u(32); t.range(vbodyStart,bodies.count,8);
  reserve(128+bodies.count*160,2+bodies.count*2);
  let decodedVertices=0;
  for(let b=0;b<bodies.count;b++) {
    sourceAbort(signal);
    const p=bodies.offset+b*16, vp=vbodyStart+b*8, count=m.u(p+4), bodyBase=m.u(p+8), modelsStart=p+m.u(p+12), vmStart=vp+t.u(vp+4);
    m.range(modelsStart,count,148); t.range(vmStart,count,8);
    if(t.u(vp)!==count || !count) throw new Error(`${path}: invalid bodygroup model count`);
    reserve(count*8,0);
    const body={name:context.relativeString(m,p,0),base:bodyBase,models:[] as string[]}; bodyparts.push(body);
    for(let s=0;s<count;s++) {
      const pause=context.checkpoint(s);if(pause)await pause;
      const mp=modelsStart+s*148, vmp=vmStart+s*8, modelName=context.string(m,mp,64), modelVertices=m.u(mp+80), firstVertex=m.u(mp+84)/48, firstTangent=m.u(mp+88)/16;
      body.models.push(modelName);
      if(!Number.isInteger(firstVertex)||!Number.isInteger(firstTangent)||firstVertex>totalVertices||modelVertices>totalVertices-firstVertex) throw new Error(`${path}: MDL model vertex range`);
      if(t.u(vmp)!==lodCount) throw new Error(`${path}: VTX submodel LOD mismatch`);
      const lodStart=vmp+t.u(vmp+4); t.range(lodStart,lodCount,12); const lp=lodStart+lod*12, meshCount=m.u(mp+72), meshStart=mp+m.u(mp+76), vmeshStart=lp+t.u(lp+4);
      m.range(meshStart,meshCount,116); t.range(vmeshStart,meshCount,9);
      if(t.u(lp)!==meshCount) throw new Error(`${path}: MDL/VTX mesh mismatch`);
      reserve(meshCount*(1536+skinFamilies*8),meshCount*20);
      for(let mi=0;mi<meshCount;mi++) {
        const pause=context.checkpoint(mi);if(pause)await pause;
        const mm=meshStart+mi*116, vm=vmeshStart+mi*9, skinref=m.u(mm), meshVertexCount=m.u(mm+8), meshVertexBase=m.u(mm+12);
        if(skinref>=skinRefs||!skins.length||meshVertexBase>modelVertices||meshVertexCount>modelVertices-meshVertexBase) throw new Error(`${path}: MDL mesh vertex/skin range`);
        const groupStride=version>=49?33:25, stripStride=version>=49?35:27, groupCount=t.u(vm), groupStart=vm+t.u(vm+4);
        t.range(groupStart,groupCount,groupStride);
        let meshVertices=0, maximumIndices=0;
        for(let gi=0;gi<groupCount;gi++) {
          const pause=context.checkpoint(gi);if(pause)await pause;
          const g=groupStart+gi*groupStride,nv=t.u(g),ni=t.u(g+8),ns=t.u(g+16),ss=g+t.u(g+20);
          meshVertices+=nv;
          t.range(g+t.u(g+4),nv,9);t.range(g+t.u(g+12),ni,2);t.range(ss,ns,stripStride);
          if(version>=49)t.range(g+t.u(g+29),t.u(g+25),2);
          for(let si=0;si<ns;si++) {
            const st=ss+si*stripStride,n=t.u(st),start=t.u(st+4),flags=t.b(st+18);
            if(start>ni||n>ni-start)throw new Error(`${path}: VTX strip index range out of bounds`);
            if(version>=49&&(flags&6))throw new Error(`${path}: unsupported VTX subdivision topology flags ${flags}`);
            if(flags===1){if(n%3)throw new Error(`${path}: incomplete VTX triangle list`);maximumIndices+=n;}
            else if(flags===2)maximumIndices+=Math.max(n-2,0)*3;
            else throw new Error(`${path}: unsupported VTX strip flags ${flags}`);
          }
        }
        decodedVertices+=meshVertices;
        if(decodedVertices>vertexMaximum||maximumIndices>vertexMaximum*12)throw new Error(`${path}: decoded studio allocation limit`);
        const positions=new Float32Array(meshVertices*3),normals=new Float32Array(meshVertices*3),tangents=new Float32Array(meshVertices*4),uv=new Float32Array(meshVertices*2),joints=new Uint16Array(meshVertices*4),weights=new Float32Array(meshVertices*4),indexStorage=new Uint32Array(maximumIndices);
        let vertexCursor=0,indexCursor=0;
        for(let gi=0;gi<groupCount;gi++) {
          const g=groupStart+gi*groupStride,nv=t.u(g),vs=g+t.u(g+4),ni=t.u(g+8),ix=g+t.u(g+12),ns=t.u(g+16),ss=g+t.u(g+20),baseVertex=vertexCursor;
          for(let vi=0;vi<nv;vi++,vertexCursor++) {
            if((vi&16383)===0){if(vi)await new Promise<void>(resolve=>setTimeout(resolve,0));sourceAbort(signal);}
            const vr=vs+vi*9,id=t.h(vr+4);
            if(id>=meshVertexCount) throw new Error(`${path}: VTX origMeshVertID out of range`);
            const logical=firstVertex+meshVertexBase+id, tangentLogical=firstTangent+meshVertexBase+id;
            if(logical>=totalVertices||tangentLogical>=totalVertices) throw new Error(`${path}: VTX/VVD vertex index out of range`);
            const row=vertexStart+(remap?remap[logical]:logical)*48,tr=tangentStart+(remap?remap[tangentLogical]:tangentLogical)*16;
            for(let k=0;k<3;k++){positions[vertexCursor*3+k]=v.f(row+16+k*4);normals[vertexCursor*3+k]=v.f(row+28+k*4);}
            uv[vertexCursor*2]=v.f(row+40);uv[vertexCursor*2+1]=v.f(row+44);
            const tw=v.f(tr+12); if(tw!==1&&tw!==-1&&tw!==0) throw new Error(`${path}: invalid VVD tangent sign`);
            for(let k=0;k<3;k++)tangents[vertexCursor*4+k]=v.f(tr+k*4)*tw;
            tangents[vertexCursor*4+3]=-tw;
            // VVD contains global bone IDs. VTX IDs are strip-specific hardware
            // slots, so using them directly would reverse/misplace articulated limbs.
            const nb=v.b(row+15); if(nb>3||t.b(vr+3)>3) throw new Error(`${path}: invalid studio bone influence count`);
            let sum=0;for(let k=0;k<nb;k++) { const w=v.f(row+k*4);if(w<0)throw new Error(`${path}: negative bone weight`);sum+=w; }
            if(nb&&sum<=0) throw new Error(`${path}: zero bone weight sum`);
            for(let k=0;k<nb;k++) { const joint=v.b(row+12+k);if(joint>=bones.length)throw new Error(`${path}: VVD bone index out of range`);joints[vertexCursor*4+k]=joint;weights[vertexCursor*4+k]=v.f(row+k*4)/sum; }
          }
          for(let si=0;si<ns;si++) {
            const st=ss+si*stripStride,n=t.u(st),start=t.u(st+4),nverts=t.u(st+8),first=t.u(st+12),flags=t.b(st+18);
            if(start>ni||n>ni-start||first>nv||nverts>nv-first) throw new Error(`${path}: VTX strip range out of bounds`);
            if(version>=49)t.range(st+t.u(st+31),t.u(st+27),2);
            const changes=t.u(st+19);t.range(st+t.u(st+23),changes,8);
            for(let ci=0;ci<changes;ci++){const change=st+t.u(st+23)+ci*8;if(t.u(change+4)>=bones.length)throw new Error(`${path}: VTX bone state out of range`);}
            const get=(j:number)=>{const index=t.h(ix+(start+j)*2);if(index>=nv||index<first||index>=first+nverts)throw new Error(`${path}: VTX strip index out of range`);return baseVertex+index;};
            if(flags===1)for(let j=0;j<n;j++)indexStorage[indexCursor++]=get(j);
            else for(let j=0;j+2<n;j++){const a=get(j),b=get(j+1),c=get(j+2);if(a===b||b===c||a===c)continue;indexStorage[indexCursor++]=j%2?b:a;indexStorage[indexCursor++]=j%2?a:b;indexStorage[indexCursor++]=c;}
          }
        }
        const indices=indexStorage.subarray(0,indexCursor);
        // Match the native converter: choose front winding against authored normals
        // once per mesh, not a negative scale or a per-triangle normal rewrite.
        let agreement=0;
        for(let i=0;i<indices.length;i+=3){const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;const x=positions[b]-positions[a],y=positions[b+1]-positions[a+1],z=positions[b+2]-positions[a+2],u=positions[c]-positions[a],v=positions[c+1]-positions[a+1],w=positions[c+2]-positions[a+2];agreement+=(y*w-z*v)*(normals[a]+normals[b]+normals[c])+(z*u-x*w)*(normals[a+1]+normals[b+1]+normals[c+1])+(x*v-y*u)*(normals[a+2]+normals[b+2]+normals[c+2]);}
        if(agreement<0)for(let i=0;i<indices.length;i+=3){const a=indices[i];indices[i]=indices[i+2];indices[i+2]=a;}
        meshes.push({bodypart:b,submodel:s,bodyBase,bodyCount:count,name:modelName,lod,switchPoint:t.f(lp+8),skinref,materialBySkin:skins.map(f=>lodMaterials[f[skinref]]),positions,normals,tangents,uv,indices,joints,weights,flexCount:m.u(mm+16),materialType:m.u(mm+24),materialParameter:m.u(mm+28)});
      }
    }
    // Yield between bodyparts so worker cancellation can be delivered.
    await new Promise<void>(resolve=>setTimeout(resolve,0));sourceAbort(signal);
  }
  const active=new Set<string>(),animationCache=context.animations;
  const nativeAnimation=async(binary:Binary,blob:Blob,owner:string):Promise<SourceStudioNativeAnimation>=>{
    sourceAbort(signal);
    if(active.has(owner))throw new Error(`Source include-model cycle: ${owner}`);
    const previous=animationCache.get(owner);
    if(previous){
      if(active.size+(context.depths.get(owner)??1)>context.depthMaximum)throw new Error('Source include-model graph exceeds depth limit');
      return previous.animation;
    }
    if(active.size>=context.depthMaximum||animationCache.size+active.size>=context.includeMaximum)throw new Error('Source include-model graph exceeds resource limit');
    reserve(640,10);active.add(owner);
    const animations:SourceStudioAnimation[]=[],sequences:SourceStudioSequence[]=[],companions:SourceStudioCompanion[]=[],includedModels:SourceStudioNativeAnimation['includedModels'][number][]=[],blocks:{start:number;end:number}[]=[];
    const a=binary.table(0xb4,100);
    reserve(a.count*320,a.count*3);
    for(let i=0;i<a.count;i++){
      const pause=context.checkpoint(i);if(pause)await pause;
      const p=a.offset+i*100;animations.push({name:context.relativeString(binary,p,4),descriptorOffset:p,fps:binary.f(p+8),flags:binary.u(p+12),frames:binary.u(p+16),block:binary.u(p+52),index:binary.u(p+56),sectionOffset:binary.u(p+80),sectionFrames:binary.u(p+84),raw:blob.slice(p,p+100)});
    }
    const seq=binary.table(0xbc,212);
    reserve(seq.count*448,seq.count*4);
    for(let i=0;i<seq.count;i++){
      const pause=context.checkpoint(i);if(pause)await pause;
      const p=seq.offset+i*212,x=binary.u(p+68),y=binary.u(p+72),start=p+binary.u(p+60),count=x*y;
      binary.range(start,count,2);
      // Aliased on-disk grids still own separate decoded arrays. Charge every
      // descriptor before allocating, not just each distinct source range.
      reserve(count*2+64,1);
      const animationIndices=new Uint16Array(count);
      for(let j=0;j<count;j++){if((j&16383)===0){const pause=context.checkpoint(j>>6);if(pause)await pause;}animationIndices[j]=binary.h(start+j*2);}
      sequences.push({name:context.relativeString(binary,p,4),activity:context.relativeString(binary,p,8),flags:binary.u(p+12),descriptorOffset:p,groupSize:[x,y],animationIndices,raw:blob.slice(p,p+212)});
    }
    const blockTable=binary.table(0x160,8);
    reserve(blockTable.count*64,blockTable.count);
    for(let i=0;i<blockTable.count;i++){const pause=context.checkpoint(i);if(pause)await pause;const p=blockTable.offset+i*8,start=binary.u(p),end=binary.u(p+4);if(end<start)throw new Error(`${owner}: invalid animation block range`);blocks.push({start,end});}
    let externalBlockUsed=false;
    for(let ai=0;ai<animations.length;ai++){
      const pause=context.checkpoint(ai);if(pause)await pause;
      const animation=animations[ai];
      if(animation.fps<0)throw new Error(`${owner}: negative animation frame rate`);
      const validateTrack=(block:number,index:number)=>{
        if(block===0){if(index)binary.range(animation.descriptorOffset+index,4);}
        else if(block>=blocks.length||index>blocks[block].end-blocks[block].start)throw new Error(`${owner}: animation block/index out of bounds`);
        if(block>0)externalBlockUsed=true;
      };
      if(animation.sectionFrames){
        const sectionCount=Math.ceil(animation.frames/animation.sectionFrames),start=animation.descriptorOffset+animation.sectionOffset;
        binary.range(start,sectionCount,8);
        for(let i=0;i<sectionCount;i++){const pause=context.checkpoint(i);if(pause)await pause;validateTrack(binary.u(start+i*8),binary.u(start+i*8+4));}
      }else validateTrack(animation.block,animation.index);
    }
    const aniName=binary.u(0x15c)?context.string(binary,binary.u(0x15c)):'';
    if(aniName){
      reserve(aniName.length*6+192,4);
      const normalized=canonicalSourcePath(aniName),aniPath=normalized.endsWith('.ani')?normalized:`${normalized}.ani`;
      const ani=await context.read(aniPath);sourceAbort(signal);
      if(ani)for(let i=0;i<blocks.length;i++){const pause=context.checkpoint(i);if(pause)await pause;if(blocks[i].end>ani.size)throw new Error(`${aniPath}: animation block exceeds file`);}
      companions.push({path:aniPath,kind:'animation',blob:ani});
    }else if(externalBlockUsed)throw new Error(`${owner}: external animation block has no ANI resource name`);
    const includes=binary.table(0x150,8);
    reserve(includes.count*192,includes.count*2);
    let depth=1;
    for(let i=0;i<includes.count;i++){
      const pause=context.checkpoint(i);if(pause)await pause;
      const p=includes.offset+i*8,value=context.relativeString(binary,p,4);
      reserve(value.length*6+64,2);
      const name=canonicalSourcePath(value),include=name.endsWith('.mdl')?name:`${name}.mdl`;
      if(active.has(include))throw new Error(`Source include-model cycle: ${include}`);
      const previous=animationCache.get(include);
      if(previous){if(active.size+context.depths.get(include)!>context.depthMaximum)throw new Error('Source include-model graph exceeds depth limit');}
      else if(active.size>=context.depthMaximum||animationCache.size+active.size>=context.includeMaximum)throw new Error('Source include-model graph exceeds resource limit');
      const raw=await context.read(include);
      companions.push({path:include,kind:'include-model',blob:raw});
      if(!raw)continue;
      const ib=await context.binary(raw,include);validateMdl(ib);
      await nativeAnimation(ib,raw,include);
      const cached=animationCache.get(include)!;
      depth=Math.max(depth,1+context.depths.get(include)!);
      includedModels.push(cached);
    }
    const animation:SourceStudioNativeAnimation={animations,sequences,blocks,companions,includedModels,temporalSupport:'encoded-data-preserved-not-sampled'};
    context.depths.set(owner,depth);animationCache.set(owner,{path:owner,rawBlob:blob,animation});
    active.delete(owner);return animation;
  };
  const animation=await nativeAnimation(m,mdlBlob,path);
  reserve(1728,19);
  const requiredCompanions=new Set(paths),missingResources=new Set<string>(),visited=new Set<SourceStudioNativeAnimation>(),pending=[animation];
  for(let i=0;pending.length;i++){
    const pause=context.checkpoint(i);if(pause)await pause;
    const node=pending.pop()!;if(visited.has(node))continue;
    reserve(64+node.companions.length*64+node.includedModels.length*8,1);
    visited.add(node);
    for(const companion of node.companions){requiredCompanions.add(companion.path);if(!companion.blob)missingResources.add(companion.path);}
    for(const included of node.includedModels)pending.push(included.animation);
  }
  const bounds: [SourceModelVector, SourceModelVector] = [m.vec(104), m.vec(116)];
  const viewBounds: [SourceModelVector, SourceModelVector] = [m.vec(128), m.vec(140)];
  const renderBounds = viewBounds.some(vector => vector.some(value => value !== 0)) ? viewBounds : bounds;
  return {path,name:context.string(m,12,64),version,checksum,flags:m.u(152),units:'source-units',up:'Z',pose:'bind',illuminationPosition:m.vec(92),bounds,renderBounds,materials,skins,bodyparts,lod,lodVertexCounts,meshes,bones,animation,rawBlob:mdlBlob,vvdBlob,vtxBlob,requiredCompanions:[...requiredCompanions],missingResources:[...missingResources],limitations:['Bind-pose geometry only; encoded animation, sequence, flex, procedural-bone and include-model data are preserved, not temporally evaluated.','No Source gameplay, ragdoll, physics, Lua, particles or eye/flex shader simulation.']};
}

export function selectSourceStudioMeshes(model: SourceStudioModel, body = 0): readonly SourceStudioMesh[] {
  if(!Number.isSafeInteger(body)||body<0)throw new Error('Invalid Source bodygroup value');
  return model.meshes.filter(mesh=>mesh.submodel===Math.floor(body/Math.max(mesh.bodyBase,1))%mesh.bodyCount);
}
export function sourceStudioMeshMaterial(mesh: SourceStudioMesh, skin = 0): SourceStudioMaterial {
  return mesh.materialBySkin[Number.isInteger(skin)&&skin>=0&&skin<mesh.materialBySkin.length?skin:0];
}
