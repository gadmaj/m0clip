/** Native studio keyframes, in local Source units/Z-up. Format references:
 * Valve public/studio.h, studio.cpp::pAnim, bone_setup.cpp::CalcBone*, and
 * mathlib/compressed_vector.h; noclip SourceEngine/Studio.ts (LICENSE.noclip).
 * This is isolated sequence sampling, not gameplay/IK/flex or scene playback. */
import type { SourceStudioModel, SourceStudioNativeAnimation, SourceStudioSequence, SourceStudioBone } from './raw-source-studio';
import type { SourceLightingRequirement } from './raw-source-lighting';
import { SourceModelBinary as Binary } from './raw-source-model-binary';
import { SourceGlb, type SourcePlayback } from './raw-source-gltf';
import { sourceAbort } from './raw-source-lzma';

export interface SourceStudioSampleOptions {
  signal?: AbortSignal;
  maxFrames: number;
  /** Aggregate bone-frame samples, each containing three positions and four quaternion scalars. */
  maxSamples: number;
  /** Aggregate unique owned MDL/ANI bytes in the include graph, before decoding. */
  maxInputBytes: number;
}
export interface SourceStudioSample {
  name: string;
  times: Float32Array;
  duration: number;
  loop: boolean;
  tracks: { bone: number; positions: Float32Array; quaternions: Float32Array }[];
  /** A successfully evaluated constant sequence pose; one transform per bone, no time keys. */
  pose?: SourceStudioSample['tracks'];
  requirements: SourceLightingRequirement[];
  /** Borrowed original graph; no filesystem lookup, copy, rewrite or ownership transfer. */
  original: SourceStudioModel;
  /** Sequence/weight/default-pose ownership can differ from channel ownership. */
  owner?: { path: string; rawBlob: Blob; animation: SourceStudioNativeAnimation; sequence: number; nativeIndex: number };
  animationOwner?: { path: string; rawBlob: Blob; animation: SourceStudioNativeAnimation; descriptor: number; nativeIndex: number };
  units: 'source-units';
  up: 'Z';
}
interface Owner { path: string; rawBlob: Blob; animation: SourceStudioNativeAnimation }
interface NativeBone {
  name: string; parent: number; position: readonly number[]; quaternion: readonly number[];
  rotation: readonly number[]; positionScale: readonly number[]; rotationScale: readonly number[];
  proceduralType: number;
}
interface Channel { binary: Binary; offset: number; end: number; flags: number }
class UnsupportedAnimation extends Error {
  constructor(readonly code: string, detail: string) { super(detail); }
}
function unsupported(code: string, detail: string): never { throw new UnsupportedAnimation(code, detail); }
function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Nonfinite native studio animation value');
  return value;
}
function half(value: number): number {
  const exponent = (value >>> 10) & 31, mantissa = value & 1023;
  return finite((value & 0x8000 ? -1 : 1) * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exponent - 15)));
}
function checked(binary: Binary, offset: number, bytes: number, end: number): number {
  binary.range(offset, bytes);
  if (offset + bytes > end) throw new Error(`${binary.name}: animation channel crosses its owned range`);
  return offset;
}
/** Expand each RLE component once, rather than rescanning all runs per frame. */
function rle(binary: Binary, pointer: number, axis: number, count: number, end: number, output: Float32Array, stride: number, start: number): void {
  checked(binary, pointer, 6, end);
  const relative = binary.view.getInt16(pointer + axis * 2, true);
  // Valve pAnimvalue treats nonpositive signed offsets as absent.
  if (relative <= 0) return;
  let cursor = pointer + relative, frame = 0;
  while (frame < count) {
    checked(binary, cursor, 2, end);
    const valid = binary.b(cursor), total = binary.b(cursor + 1);
    if (!valid || !total || valid > total) throw new Error(`${binary.name}: invalid studio animation RLE run`);
    checked(binary, cursor + 2, valid * 2, end);
    for (let i = 0; i < total && frame < count; i++, frame++)
      output[start + frame * stride] = binary.view.getInt16(cursor + 2 + Math.min(i, valid - 1) * 2, true);
    cursor += 2 + valid * 2;
  }
}
function quaternion(binary: Binary, p: number, wide: boolean, end: number, target: Float32Array): void {
  checked(binary, p, wide ? 8 : 6, end);
  let x: number, y: number, z: number, sign: number;
  if (wide) {
    const lo = binary.u(p), hi = binary.u(p + 4);
    // Valve uses 1048576.5, NOT noclip/old Python's 1048576 denominator.
    x = ((lo & 0x1fffff) - 1048576) / 1048576.5;
    y = ((((hi & 1023) << 11) | (lo >>> 21)) - 1048576) / 1048576.5;
    z = (((hi >>> 10) & 0x1fffff) - 1048576) / 1048576.5;
    sign = hi & 0x80000000 ? -1 : 1;
  } else {
    x = (binary.h(p) - 32768) / 32768; y = (binary.h(p + 2) - 32768) / 32768;
    z = ((binary.h(p + 4) & 32767) - 16384) / 16384; sign = binary.h(p + 4) & 32768 ? -1 : 1;
  }
  const square = 1 - x*x - y*y - z*z;
  if (square < -1e-6) throw new Error(`${binary.name}: invalid packed studio quaternion`);
  target[0] = x; target[1] = y; target[2] = z; target[3] = sign * Math.sqrt(Math.max(0, square));
}
/** Valve RadianEuler is roll,pitch,yaw radians, not camera QAngle degrees. */
function euler(x: number, y: number, z: number, out: Float32Array, p: number): void {
  const sx=Math.sin(x/2),cx=Math.cos(x/2),sy=Math.sin(y/2),cy=Math.cos(y/2),sz=Math.sin(z/2),cz=Math.cos(z/2);
  out[p]=sx*cy*cz-cx*sy*sz; out[p+1]=cx*sy*cz+sx*cy*sz;
  out[p+2]=cx*cy*sz-sx*sy*cz; out[p+3]=cx*cy*cz+sx*sy*sz;
}
function bones(binary: Binary): NativeBone[] {
  const table = binary.table(0x9c, 216);
  if (table.count > 256) throw new Error('Too many native animation bones');
  const result: NativeBone[] = [];
  for (let i=0;i<table.count;i++) {
    const p=table.offset+i*216,parent=binary.i(p+4);
    if (parent < -1 || parent >= i) throw new Error('Invalid native animation bone hierarchy');
    result.push({name:binary.relativeString(p,0),parent,position:binary.vec(p+32),quaternion:[...binary.vec(p+44),binary.f(p+56)],rotation:binary.vec(p+60),positionScale:binary.vec(p+72),rotationScale:binary.vec(p+84),proceduralType:binary.u(p+164)});
  }
  return result;
}
function channelList(binary: Binary, offset: number, end: number, boneCount: number): Map<number, Channel> {
  const channels = new Map<number, Channel>();
  for (let p=offset;;) {
    checked(binary,p,4,end);
    const bone=binary.b(p),flags=binary.b(p+1),next=binary.view.getInt16(p+2,true);
    if (bone === 255) break;
    if (bone >= boneCount || channels.has(bone)) throw new Error('Invalid or duplicate native animation bone channel');
    if (flags & ~63) unsupported('studio-animation-channel-flags',`Unsupported native channel flags ${flags}`);
    if (flags & 16) unsupported('studio-animation-delta','Additive/delta channels require an explicit authored base; no bind-base guess is made.');
    if ([2,8,32].filter(flag=>flags&flag).length>1 || (flags&1 && flags&4)) throw new Error('Conflicting native animation channel encodings');
    // Valve raw and animated layouts overlap. Mixed encodings can be valid:
    // pPosV depends ONLY on ANIMROT, pPos ONLY on RAWROT/RAWROT2.
    const localEnd=next ? p+next : end;
    if (next && (next<4 || localEnd>end)) throw new Error('Invalid native animation linked offset');
    channels.set(bone,{binary,offset:p+4,end,flags});
    if (!next) break;
    p=localEnd;
  }
  return channels;
}
function readChannels(channel: Channel | undefined, bone: NativeBone, count: number, positions: Float32Array, quaternions: Float32Array, first: number): void {
  const flags=channel?.flags ?? 0, rawQ=new Float32Array(4);
  const angles=flags&8 ? new Float32Array(count*3) : undefined;
  if (channel) {
    const {binary,offset,end}=channel;
    if (flags&2 || flags&32) quaternion(binary,offset,!!(flags&32),end,rawQ);
    if (angles) for(let axis=0;axis<3;axis++)rle(binary,offset,axis,count,end,angles,3,axis);
    if(flags&4) {
      const pointer=offset+(flags&8?6:0);
      // Absent RLE components are zero deltas, not prefilled sequence defaults.
      positions.fill(0,first*3,(first+count)*3);
      for(let axis=0;axis<3;axis++)rle(binary,pointer,axis,count,end,positions,3,first*3+axis);
    }
    if(flags&1) {
      const p=offset+(flags&2?6:0)+(flags&32?8:0);checked(binary,p,6,end);
      for(let axis=0;axis<3;axis++) for(let frame=0;frame<count;frame++)positions[(first+frame)*3+axis]=half(binary.h(p+axis*2));
    }
  }
  for(let frame=0;frame<count;frame++) {
    const p=(first+frame)*3,q=(first+frame)*4;
    for(let axis=0;axis<3;axis++) {
      if(flags&4)positions[p+axis]=finite(positions[p+axis]*bone.positionScale[axis]+bone.position[axis]);
      else if(!(flags&1))positions[p+axis]=bone.position[axis];
    }
    if(angles)euler(angles[frame*3]*bone.rotationScale[0]+bone.rotation[0],angles[frame*3+1]*bone.rotationScale[1]+bone.rotation[1],angles[frame*3+2]*bone.rotationScale[2]+bone.rotation[2],quaternions,q);
    else for(let axis=0;axis<4;axis++)quaternions[q+axis]=flags&(2|32)?rawQ[axis]:bone.quaternion[axis];
  }
}
function defaultTracks(target: readonly (SourceStudioBone | NativeBone)[], sequence: readonly NativeBone[],
  remap: readonly number[], count: number): SourceStudioSample['tracks'] {
  const selected: (SourceStudioBone | NativeBone)[] = target.slice();
  for (let i = 0; i < sequence.length; i++) if (remap[i] >= 0) selected[remap[i]] = sequence[i];
  return selected.map((bone, index) => {
    const positions = new Float32Array(count * 3), quaternions = new Float32Array(count * 4);
    for (let frame = 0; frame < count; frame++) {
      positions.set(bone.position, frame * 3); quaternions.set(bone.quaternion, frame * 4);
    }
    return { bone: index, positions, quaternions };
  });
}
/** Both sequence defaults and animation channels require real parent mappings.
 * An absent source parent is not interchangeable with a genuine target root. */
function remapBones(source: readonly NativeBone[], target: readonly (SourceStudioBone | NativeBone)[], names: ReadonlyMap<string, number>): { remap: number[]; mapped: Set<number> } {
  const remap=source.map(b=>names.get(b.name.toLowerCase())??-1),mapped=new Set<number>();
  for(let i=0;i<source.length;i++) {
    const destination=remap[i];if(destination<0)continue;
    if(mapped.has(destination))throw new Error('Duplicate included native bone name');mapped.add(destination);
    const parent=source[i].parent;
    if((parent>=0&&remap[parent]<0)||(parent<0?-1:remap[parent])!==target[destination].parent)
      unsupported('studio-animation-include-skeleton',`Incompatible included bone hierarchy at ${source[i].name}.`);
  }
  return {remap,mapped};
}

function sequenceGraph(model: SourceStudioModel, signal?: AbortSignal) {
  const owners: Owner[] = [], seen = new Set<string>();
  const visit = (owner: Owner, depth: number) => {
    sourceAbort(signal);
    if (seen.has(owner.path)) return;
    if (depth > 64 || seen.size >= 1024) throw new Error('Native animation include graph exceeds limit');
    seen.add(owner.path); owners.push(owner);
    for (const include of owner.animation.includedModels) visit(include, depth + 1);
  };
  visit(model, 0);
  const entries: { owner: Owner; sequence: SourceStudioSequence; index: number }[] = [];
  // Valve studio_virtualmodel.cpp::AppendSequences: preserve the first name
  // slot, replacing STUDIO_OVERRIDE declarations in place across groups only.
  const sequenceNames = new Map<string, number>();
  for (const owner of owners) {
    const previousCount = entries.length;
    for (let index = 0; index < owner.animation.sequences.length; index++) {
      const sequence = owner.animation.sequences[index], key = sequence.name.toLowerCase(), existing = sequenceNames.get(key);
      if (existing === undefined || existing >= previousCount) {
        if (existing === undefined) sequenceNames.set(key, entries.length);
        entries.push({ owner, sequence, index });
      } else if (entries[existing].sequence.flags & 0x800) entries[existing] = { owner, sequence, index };
    }
  }
  return { owners, entries, sequenceNames };
}

/** Resolve native virtual indices before caching; numeric labels remain labels.
 * The caller decides whether an unavailable request permits native index-zero
 * fallback (CDynamicProp::PropSetAnim does; explicit sampler requests do not). */
export function sourceStudioSequenceIndex(model: SourceStudioModel, selection: string | number, signal?: AbortSignal): number | undefined {
  const { entries, sequenceNames } = sequenceGraph(model, signal);
  const index = typeof selection === 'number' ? selection : sequenceNames.get(selection.toLowerCase());
  return index !== undefined && Number.isSafeInteger(index) && index >= 0 && index < entries.length ? index : undefined;
}

export async function sampleSourceStudioSequence(model: SourceStudioModel, selection: string | number, options: SourceStudioSampleOptions): Promise<SourceStudioSample> {
  sourceAbort(options.signal);
  for(const value of [options.maxFrames,options.maxSamples,options.maxInputBytes])if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid native studio animation limits');
  const result:SourceStudioSample={name:typeof selection==='string'?selection:String(selection),times:new Float32Array(),duration:0,loop:false,tracks:[],requirements:[],original:model,units:'source-units',up:'Z'};
  let selectedOwner:Owner|undefined;
  try {
    const { owners, entries, sequenceNames } = sequenceGraph(model, options.signal), blobs = new Set<Blob>(); let inputBytes = 0;
    const addBlob = (blob: Blob) => { if (blobs.has(blob)) return; blobs.add(blob); inputBytes += blob.size; if (inputBytes > options.maxInputBytes) throw new Error('Native studio animation input byte limit exceeded'); };
    for (const owner of owners) {
      addBlob(owner.rawBlob);
      for (const companion of owner.animation.companions) if (companion.blob) addBlob(companion.blob);
    }
    // AppendAnimations has its own name table and NO sequence-style override.
    // iRelativeAnim maps each sequence group's local descriptor through it.
    const mergedAnimations:{owner:Owner;index:number}[]=[],animationNames=new Map<string,number>(),animationRoutes=new Map<Owner,number[]>();
    for(const owner of owners) {
      const previousCount=mergedAnimations.length,route:number[]=[];
      for(let index=0;index<owner.animation.animations.length;index++) {
        const key=owner.animation.animations[index].name.toLowerCase(),existing=animationNames.get(key);
        if(existing===undefined||existing>=previousCount) {
          route.push(mergedAnimations.length);
          if(existing===undefined)animationNames.set(key,mergedAnimations.length);
          mergedAnimations.push({owner,index});
        } else route.push(existing);
      }
      animationRoutes.set(owner,route);
    }
    const nativeIndex=typeof selection==='number'?selection:sequenceNames.get(selection.toLowerCase());
    const entry=nativeIndex!==undefined&&Number.isSafeInteger(nativeIndex)&&nativeIndex>=0?entries[nativeIndex]:undefined;
    if(!entry)unsupported('studio-animation-selection',`Native sequence ${selection} is not present in the owned model/include graph.`);
    const {owner,sequence,index}=entry;selectedOwner=owner;
    result.name=sequence.name;result.loop=!!(sequence.flags&1);result.owner={...owner,sequence:index,nativeIndex:nativeIndex!};
    const cache=new Map<Blob,Binary>();
    const read=async(blob:Blob,name:string)=>{let binary=cache.get(blob);if(!binary){sourceAbort(options.signal);binary=new Binary(new Uint8Array(await blob.arrayBuffer()),name);sourceAbort(options.signal);cache.set(blob,binary);}return binary;};
    const m=await read(owner.rawBlob,owner.path),root=owner.rawBlob===model.rawBlob?m:await read(model.rawBlob,model.path);
    m.range(sequence.descriptorOffset,212);
    const s=sequence.descriptorOffset;
    if(sequence.groupSize[0]!==1||sequence.groupSize[1]!==1||sequence.animationIndices.length!==1||m.u(s+56)!==1)
      unsupported('studio-animation-blend','Native blend grids require explicit pose-parameter evaluation.');
    if(sequence.flags&4)unsupported('studio-animation-delta','Additive/delta sequences require an explicit authored base.');
    if(sequence.flags&~(1|2|0x20))unsupported('studio-animation-sequence-flags',`Unsupported native sequence flags ${sequence.flags}.`);
    if(m.i(s+76)!==-1||m.i(s+80)!==-1)unsupported('studio-animation-pose-parameters','Native pose-parameter/cycle semantics are not evaluated.');
    if(m.u(s+144)||m.u(s+164))unsupported('studio-animation-ik','Native sequence IK rules/locks require evaluation.');
    if(m.u(s+148))unsupported('studio-animation-layers','Native autolayers require authored blend evaluation.');
    const nativeAnimationIndex=animationRoutes.get(owner)?.[sequence.animationIndices[0]];
    const animationEntry=nativeAnimationIndex===undefined?undefined:mergedAnimations[nativeAnimationIndex];
    if(!animationEntry)throw new Error('Native sequence animation index out of range');
    const animationOwner=animationEntry.owner,animation=animationOwner.animation.animations[animationEntry.index];
    const am=await read(animationOwner.rawBlob,animationOwner.path);
    result.animationOwner={...animationOwner,descriptor:animationEntry.index,nativeIndex:nativeAnimationIndex!};
    selectedOwner=animationOwner;
    for(const [binary,path] of [[root,model.path],[m,owner.path],[am,animationOwner.path]] as const) {
      if(binary.u(0xa4))unsupported('studio-animation-controllers',`${path}: native bone controllers require evaluation.`);
      if(binary.u(0x104)||binary.u(0x10c)||binary.u(0x114))unsupported('studio-animation-flex',`${path}: native flex/controller/rule semantics require evaluation.`);
    }
    if(model.meshes.some(mesh=>mesh.flexCount>0))unsupported('studio-animation-flex','Native flex vertices require evaluation.');
    const sequenceBones=bones(m),sourceBones=am===m?sequenceBones:bones(am),targetBones:readonly (SourceStudioBone|NativeBone)[]=model.bones;
    if(sequenceBones.some(b=>b.proceduralType)||sourceBones.some(b=>b.proceduralType)||targetBones.some(b=>b.proceduralType))unsupported('studio-animation-procedural','Native procedural bones require evaluation.');
    const names=new Map<string,number>();
    for(let i=0;i<targetBones.length;i++){const name=targetBones[i].name.toLowerCase();if(names.has(name))throw new Error('Duplicate target native bone name');names.set(name,i);}
    const sequenceMap=remapBones(sequenceBones,targetBones,names),{remap}=am===m?sequenceMap:remapBones(sourceBones,targetBones,names);
    const weightOffset=m.i(s+156);
    if(weightOffset<=0)throw new Error('Missing native sequence bone weight table');
    m.range(s+weightOffset,sequenceBones.length,4);
    for(let i=0;i<sequenceBones.length;i++)if(sequenceMap.remap[i]>=0&&m.f(s+weightOffset+i*4)!==1)unsupported('studio-animation-bone-weights','Masked/weighted sequences require an explicit blend base.');
    const a=animation.descriptorOffset;am.range(a,100);
    if(animation.flags&4)unsupported('studio-animation-delta','Native delta animation requires an explicit authored base.');
    if(animation.flags&~(1|2|0x20))unsupported('studio-animation-format',`Unsupported native animation flags ${animation.flags} (including frame-animation formats).`);
    if(am.u(a+20))unsupported('studio-animation-root-motion','Native movement extraction requires runtime root-motion policy.');
    if(am.u(a+60))unsupported('studio-animation-ik','Native animation IK rules require evaluation.');
    if(am.u(a+72))unsupported('studio-animation-local-hierarchy','Native animated local hierarchy requires evaluation.');
    const count=animation.frames,fps=animation.fps;
    if(!Number.isSafeInteger(count)||count<1||count>options.maxFrames)throw new Error('Native studio animation frame limit exceeded');
    if(!Number.isFinite(fps)||fps<=0)throw new Error('Invalid native studio animation fps');
    if(animation.flags&0x20||sequence.flags&0x20||(!animation.sectionFrames&&animation.block===0&&animation.index===0))unsupported('studio-animation-no-channels','The selected native sequence has no authored bone channels; no bind-pose motion clip is fabricated.');
    let tracks: SourceStudioSample['tracks'] | undefined;
    // MDL44 CalcVirtualAnimation applies sequence-group defaults even when a
    // valid 255-sentinel channel chain has no overrides. Allocate frame tracks
    // only when actual channels occur; otherwise export a single static pose.
    const sections=new Map<number,Map<number,Channel>>();
    for(let first=0;first<count;) {
      sourceAbort(options.signal);
      let section=0,local=first,block=animation.block,offset=animation.index,length=count-first;
      if(animation.sectionFrames) {
        const span=animation.sectionFrames;
        if(!Number.isSafeInteger(span)||span<1||!animation.sectionOffset)throw new Error('Invalid native animation section size/offset');
        const lastSpecial=count>span&&first===count-1;
        section=lastSpecial?Math.floor(count/span)+1:Math.floor(first/span);
        local=lastSpecial?0:first-section*span;
        length=lastSpecial?1:Math.min(span-local,count-first,count>span?count-1-first:count-first);
        const p=a+animation.sectionOffset+section*8;am.range(p,8);block=am.i(p);offset=am.i(p+4);
      }
      if(length<1)throw new Error('Invalid native animation section dispatch');
      let channels=sections.get(section);
      if(!channels) {
        if(block<0||offset<0)unsupported('studio-animation-unavailable-block','Native animation block requires recompilation or is unavailable.');
        let binary=am,start=a+offset,end=am.bytes.length;
        if(block>0) {
          const range=animationOwner.animation.blocks[block];
          if(!range)throw new Error('Native animation block index out of range');
          const external=animationOwner.animation.companions.filter(c=>c.kind==='animation');
          if(external.length!==1||!external[0].blob)unsupported('studio-animation-missing-resource','The selected owned native ANI companion is missing or ambiguous.');
          binary=await read(external[0].blob,external[0].path);start=range.start+offset;end=range.end;
          if(range.start<0||end<range.start||end>binary.bytes.length||start<range.start)throw new Error('Invalid native ANI block range');
        }
        channels=channelList(binary,start,end,sourceBones.length);sections.set(section,channels);
        for(const bone of channels.keys())if(remap[bone]<0)unsupported('studio-animation-include-skeleton',`Animated included bone ${sourceBones[bone].name} has no target bone.`);
      }
      // Sections always start on their native first frame; local offset is zero
      // except the nonsectioned path. No channel's RLE stream is rebased arbitrarily.
      if(local!==0)throw new Error('Invalid native animation sampling section origin');
      if(channels.size&&!tracks){
        if(count*targetBones.length>options.maxSamples)throw new Error('Native studio animation sample limit exceeded');
        tracks=defaultTracks(targetBones,sequenceBones,sequenceMap.remap,count);
      }
      if(tracks)for(const [bone,channel] of channels)if(sequenceMap.mapped.has(remap[bone])){const track=tracks[remap[bone]];readChannels(channel,sourceBones[bone],length,track.positions,track.quaternions,first);}
      first+=length;
      // Yield to deliver worker AbortSignal between bounded section work.
      await new Promise<void>(resolve=>setTimeout(resolve,0));sourceAbort(options.signal);
    }
    if(!tracks&&targetBones.length>options.maxSamples)throw new Error('Native studio constant pose sample limit exceeded');
    const output=tracks??defaultTracks(targetBones,sequenceBones,sequenceMap.remap,1);
    const frames=tracks?count:1;
    for(const track of output)for(let frame=0;frame<frames;frame++) {
      const p=frame*4,n=Math.hypot(track.quaternions[p],track.quaternions[p+1],track.quaternions[p+2],track.quaternions[p+3]);
      if(!Number.isFinite(n)||n<.98||n>1.02)throw new Error('Invalid native animation quaternion length');
      let sign=1;
      if(frame){let dot=0;for(let k=0;k<4;k++)dot+=track.quaternions[p+k]*track.quaternions[p-4+k];if(dot<0)sign=-1;}
      for(let k=0;k<4;k++)track.quaternions[p+k]=finite(track.quaternions[p+k]*sign/n);
      for(let k=0;k<3;k++)finite(track.positions[frame*3+k]);
    }
    if(tracks){
      const times=new Float32Array(count);
      for(let frame=0;frame<count;frame++){times[frame]=frame/fps;if(!Number.isFinite(times[frame])||(frame>0&&times[frame]<=times[frame-1]))throw new Error('Native animation times exceed float32 precision/range');}
      result.times=times;result.duration=times[count-1];result.tracks=tracks;
    }else result.pose=output;
  } catch(error) {
    sourceAbort(options.signal);
    if(!(error instanceof UnsupportedAnimation))throw error;
    result.requirements.push({code:error.code,detail:error.message,blocking:true,path:selectedOwner?.path??model.path});
    result.times=new Float32Array();result.duration=0;result.tracks=[];
  }
  return result;
}

/** Import-owned encoder: clips have independent node targets but share the
 * immutable sampled channel/time accessors. No process-global GLB/sample cache. */
export class SourceStudioClipWriter {
  private readonly encoded = new WeakMap<SourceStudioSample, {
    input: number; tracks: { bone: number; translation: number; rotation: number }[];
  }>();
  constructor(private readonly glb: SourceGlb) {}

  /** Blocked samples emit neither a placeholder clip nor channel accessors.
   * Standalone API clips omit playback unless explicitly requested by caller. */
  append(sample: SourceStudioSample, boneNodes: readonly number[], options: {
    signal?: AbortSignal; name?: string; playback?: SourcePlayback;
  } = {}): number | undefined {
    const { glb } = this, { signal, playback } = options;
    sourceAbort(signal);
    if (sample.requirements.some(requirement => requirement.blocking)) return undefined;
    if (sample.pose) return undefined; // Constant poses are written to bone nodes, not motion clips.
    if (playback && (playback.version !== 1 || typeof playback.loop !== 'boolean' || !Number.isFinite(playback.cycle) || !Number.isFinite(playback.rate)))
      throw new Error('Invalid native Source playback metadata');
    if (sample.units !== 'source-units' || sample.up !== 'Z' || !sample.times.length || !sample.tracks.length) throw new Error('Invalid native studio clip sample');
    let encoded = this.encoded.get(sample);
    if (!encoded) {
      for (let i = 0; i < sample.times.length; i++) if (!Number.isFinite(sample.times[i]) || sample.times[i] < 0 || (i > 0 && sample.times[i] <= sample.times[i - 1])) throw new Error('Invalid native clip times');
    }
    const seen = new Set<number>();
    for (const track of sample.tracks) {
      sourceAbort(signal);
      const node = boneNodes[track.bone];
      if (!Number.isInteger(track.bone) || track.bone < 0 || !Number.isInteger(node) || node < 0 || node >= glb.json.nodes.length || seen.has(node)) throw new Error('Invalid actual native clip bone node mapping');
      if (glb.json.nodes[node].matrix) throw new Error('Native animation target must use bone TRS, not a matrix');
      seen.add(node);
      if (!encoded && (track.positions.length !== sample.times.length * 3 || track.quaternions.length !== sample.times.length * 4 || track.positions.some(v => !Number.isFinite(v)) || track.quaternions.some(v => !Number.isFinite(v)))) throw new Error('Invalid native clip track values');
    }
    if (!encoded) {
      const input = glb.accessor(sample.times, 'SCALAR', { bounds: true }), tracks = [];
      for (const track of sample.tracks) {
        sourceAbort(signal);
        const positions = new Float32Array(track.positions.length);
        for (let i = 0; i < positions.length; i++) {
          if ((i & 0x3fff) === 0) sourceAbort(signal);
          positions[i] = track.positions[i] * .0254;
        }
        tracks.push({ bone: track.bone, translation: glb.accessor(positions, 'VEC3'), rotation: glb.accessor(track.quaternions, 'VEC4') });
      }
      encoded = { input, tracks }; this.encoded.set(sample, encoded);
    }
    const clip: NonNullable<SourceGlb['json']['animations']>[number] = {
      name: options.name ?? sample.name,
      extras: {
        sourceStudioSequence: { path: sample.owner?.path, sequence: sample.owner?.sequence, nativeIndex: sample.owner?.nativeIndex,
          animationPath: sample.animationOwner?.path, animation: sample.animationOwner?.descriptor, animationNativeIndex: sample.animationOwner?.nativeIndex },
        ...(playback ? { sourcePlayback: { ...playback } } : {}),
      }, samplers: [], channels: [],
    };
    for (const track of encoded.tracks) {
      sourceAbort(signal);
      for (const [output, path] of [[track.translation, 'translation'], [track.rotation, 'rotation']] as const) {
        const sampler = clip.samplers.length;
        clip.samplers.push({ input: encoded.input, output, interpolation: 'LINEAR' });
        clip.channels.push({ sampler, target: { node: boneNodes[track.bone], path } });
      }
    }
    sourceAbort(signal);
    const animations = glb.json.animations ??= [], index = animations.length; animations.push(clip); return index;
  }
}
