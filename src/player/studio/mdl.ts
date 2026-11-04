/** Version-aware MDL (studiohdr_t) reader for IDST v44-v49. Field offsets follow the published
 * Source SDK layouts (v44 2004, v48 2007, v49 2013) and the MIT noclip Studio reader
 * (LICENSE.noclip, Copyright (c) 2018 Jasper St. Pierre); no SDK code is copied. Every table is
 * range-checked; fields this decoder can't interpret raise StudioUnsupportedError. */
import { BinaryFile, StudioUnsupportedError } from './binary';
import type {
  StudioAttachment, StudioBoneController, StudioEvent, StudioEyeball, StudioHitboxSet, StudioMovement,
  StudioPoseParameter, StudioProceduralBone, StudioQuatInterpTrigger, StudioTexture,
} from './types';

export const STUDIO_HEADER_BYTES = 0x198;

/** studiohdr_t flags. */
export const STUDIOHDR_STATIC_PROP = 1 << 4;
export const STUDIOHDR_EXTRA_VERTEX_DATA = 1 << 26;

/** mstudiobone_t flags. */
export const BONE_PHYSICALLY_SIMULATED = 0x01;
export const BONE_PHYSICS_PROCEDURAL = 0x02;
export const BONE_ALWAYS_PROCEDURAL = 0x04;
export const BONE_SCREEN_ALIGN_SPHERE = 0x08;
export const BONE_SCREEN_ALIGN_CYLINDER = 0x10;
export const BONE_FIXED_ALIGNMENT = 0x00100000;

export const STUDIO_PROC_AXISINTERP = 1;
export const STUDIO_PROC_QUATINTERP = 2;

/** Sequence / animation flags. */
export const STUDIO_LOOPING = 0x0001;
export const STUDIO_DELTA = 0x0004;
export const STUDIO_AUTOPLAY = 0x0008;
export const STUDIO_POST = 0x0010;
export const STUDIO_ALLZEROS = 0x0020;
/** v48+: cycle comes from a pose parameter. (v44 used the bit only for autolayers.) */
export const STUDIO_CYCLEPOSE = 0x0080;
export const STUDIO_REALTIME = 0x0100;
/** v48+: local context sequence. */
export const STUDIO_LOCAL = 0x0200;
export const STUDIO_OVERRIDE = 0x0800;
/** v48+: blends in world space. */
export const STUDIO_WORLD = 0x4000;

/** Autolayer flags. */
export const STUDIO_AL_SPLINE = 0x0040;
export const STUDIO_AL_XFADE = 0x0080;
export const STUDIO_AL_NOBLEND = 0x0200;
export const STUDIO_AL_LOCAL = 0x1000;
export const STUDIO_AL_POSE = 0x4000;

/** Bone controller types. */
export const STUDIO_X = 0x01, STUDIO_Y = 0x02, STUDIO_Z = 0x04;
export const STUDIO_XR = 0x08, STUDIO_YR = 0x10, STUDIO_ZR = 0x20;
export const STUDIO_TYPES = 0x0003ffff;

export interface MdlBones {
  readonly count: number;
  readonly names: string[];
  readonly parent: Int32Array;
  readonly flags: Uint32Array;
  readonly position: Float32Array;
  readonly quaternion: Float32Array;
  readonly euler: Float32Array;
  readonly positionScale: Float32Array;
  readonly rotationScale: Float32Array;
  readonly poseToBone: Float32Array;
  readonly alignment: Float32Array;
  readonly procedural: (StudioProceduralBone | null)[];
  readonly physicsBone: Int32Array;
  readonly surfaceProp: string[];
  readonly contents: Uint32Array;
  readonly boneController: Int32Array;
}

export interface MdlAnimSection {
  /** 0 = in the MDL relative to the anim desc; >0 = .ani block. */
  readonly block: number;
  readonly index: number;
}

export interface MdlAnimDesc {
  readonly offset: number;
  readonly name: string;
  readonly fps: number;
  readonly flags: number;
  readonly frameCount: number;
  readonly movements: StudioMovement[];
  readonly ikRuleCount: number;
  /** 0 when the frames aren't sectioned. */
  readonly sectionFrames: number;
  /** One entry when unsectioned, else floor(frameCount/sectionFrames)+2 entries. */
  readonly sections: MdlAnimSection[];
  readonly localHierarchyCount: number;
}

export interface MdlLayer {
  readonly sequence: number;
  readonly pose: number;
  readonly flags: number;
  readonly start: number;
  readonly peak: number;
  readonly tail: number;
  readonly end: number;
}

export interface MdlSeqDesc {
  readonly label: string;
  readonly activityName: string;
  readonly flags: number;
  readonly activityWeight: number;
  readonly events: StudioEvent[];
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly groupSize: [number, number];
  /** Group-local animation index per blend cell. */
  readonly animations: Int32Array;
  /** Group-local pose parameter per axis, or -1. */
  readonly paramIndex: [number, number];
  readonly paramStart: [number, number];
  readonly paramEnd: [number, number];
  readonly paramParent: number;
  readonly fadeInTime: number;
  readonly fadeOutTime: number;
  readonly entryNode: number;
  readonly exitNode: number;
  readonly nodeFlags: number;
  readonly entryPhase: number;
  readonly exitPhase: number;
  readonly lastFrame: number;
  readonly nextSequence: number;
  readonly pose: number;
  readonly ikRuleCount: number;
  readonly layers: MdlLayer[];
  /** Group-local bone weights. */
  readonly boneWeight: Float32Array;
  readonly poseKeys: Float32Array | null;
  readonly ikLockCount: number;
  readonly keyValues: string;
  readonly cyclePose: number;
  readonly activityModifiers: string[];
}

export interface MdlMesh {
  readonly skinRef: number;
  readonly vertexCount: number;
  readonly vertexOffset: number;
  readonly flexCount: number;
  readonly materialType: number;
  readonly materialParam: number;
  readonly meshId: number;
  readonly center: Float32Array;
}

export interface MdlModel {
  readonly name: string;
  readonly boundingRadius: number;
  readonly vertexCount: number;
  /** First vertex in the VVD vertex block (vertexindex / 48). */
  readonly firstVertex: number;
  /** First tangent (tangentsindex / 16). */
  readonly firstTangent: number;
  readonly meshes: MdlMesh[];
  readonly eyeballs: StudioEyeball[];
}

export interface MdlBodyPart {
  readonly name: string;
  readonly base: number;
  readonly models: MdlModel[];
}

export interface MdlFile {
  readonly file: BinaryFile;
  readonly version: number;
  readonly checksum: number;
  readonly name: string;
  readonly length: number;
  readonly eyePosition: Float32Array;
  readonly illumPosition: Float32Array;
  readonly hullMin: Float32Array;
  readonly hullMax: Float32Array;
  readonly viewMin: Float32Array;
  readonly viewMax: Float32Array;
  readonly flags: number;
  readonly bones: MdlBones;
  readonly boneControllers: StudioBoneController[];
  readonly hitboxSets: StudioHitboxSet[];
  readonly anims: MdlAnimDesc[];
  readonly seqs: MdlSeqDesc[];
  readonly textures: StudioTexture[];
  readonly searchDirectories: string[];
  readonly skinReferenceCount: number;
  readonly skinFamilies: Uint16Array[];
  readonly bodyParts: MdlBodyPart[];
  readonly attachments: StudioAttachment[];
  readonly nodes: string[];
  readonly flexDescCount: number;
  readonly flexControllerCount: number;
  readonly flexRuleCount: number;
  readonly ikChainCount: number;
  readonly mouthCount: number;
  readonly poseParameters: StudioPoseParameter[];
  readonly surfaceProp: string;
  readonly keyValues: string;
  readonly ikAutoplayLockCount: number;
  readonly mass: number;
  readonly contents: number;
  readonly includeModels: string[];
  readonly animBlockName: string;
  /** [datastart, dataend) per block; block 0 is the MDL itself and unused. */
  readonly animBlocks: Int32Array;
  readonly rootLod: number;
  readonly sourceBoneTransformCount: number;
  readonly flexControllerUiCount: number;
}

function unsupported(file: BinaryFile, feature: string): never { throw new StudioUnsupportedError(file.path, feature); }

function count(file: BinaryFile, o: number, what: string): number {
  const n = file.i32(o);
  if (n < 0) file.fail(`${what} count is negative (${n})`);
  return n;
}

function readBones(file: BinaryFile, version: number): MdlBones {
  const n = count(file, 0x9c, 'bone');
  const base = file.table(file.i32(0xa0), n, 0xd8, 'bones');
  const bones: MdlBones = {
    count: n, names: [], parent: new Int32Array(n), flags: new Uint32Array(n),
    position: new Float32Array(n*3), quaternion: new Float32Array(n*4), euler: new Float32Array(n*3),
    positionScale: new Float32Array(n*3), rotationScale: new Float32Array(n*3), poseToBone: new Float32Array(n*12),
    alignment: new Float32Array(n*4), procedural: [], physicsBone: new Int32Array(n), surfaceProp: [],
    contents: new Uint32Array(n), boneController: new Int32Array(n*6),
  };
  for (let i = 0; i < n; i++) {
    const b = base + i*0xd8;
    const name = file.relString(b, file.i32(b), `bone ${i} name`);
    bones.names.push(name);
    const parent = file.i32(b + 0x04);
    if (parent < -1 || parent >= i) file.fail(`bone ${name} has parent ${parent}; parents must precede children`);
    bones.parent[i] = parent;
    for (let k = 0; k < 6; k++) bones.boneController[i*6 + k] = file.i32(b + 0x08 + k*4);
    for (let k = 0; k < 3; k++) {
      bones.position[i*3 + k] = file.f32(b + 0x20 + k*4);
      bones.euler[i*3 + k] = file.f32(b + 0x3c + k*4);
      bones.positionScale[i*3 + k] = file.f32(b + 0x48 + k*4);
      bones.rotationScale[i*3 + k] = file.f32(b + 0x54 + k*4);
    }
    for (let k = 0; k < 4; k++) {
      bones.quaternion[i*4 + k] = file.f32(b + 0x2c + k*4);
      bones.alignment[i*4 + k] = file.f32(b + 0x90 + k*4);
    }
    for (let k = 0; k < 12; k++) bones.poseToBone[i*12 + k] = file.f32(b + 0x60 + k*4);
    const flags = file.u32(b + 0xa0);
    bones.flags[i] = flags;
    const procType = file.i32(b + 0xa4), procIndex = file.i32(b + 0xa8);
    bones.physicsBone[i] = file.i32(b + 0xac);
    bones.surfaceProp.push(file.relString(b, file.i32(b + 0xb0), `bone ${name} surface property`, true));
    bones.contents[i] = file.u32(b + 0xb4);
    if (flags & (BONE_SCREEN_ALIGN_SPHERE | BONE_SCREEN_ALIGN_CYLINDER)) unsupported(file, `screen-aligned bone ${name}`);
    bones.procedural.push(procIndex === 0 ? null : readProcedural(file, version, b + procIndex, procType, name, i));
    if (bones.procedural[i] && !(flags & BONE_ALWAYS_PROCEDURAL))
      unsupported(file, `procedural bone ${name} without BONE_ALWAYS_PROCEDURAL (physics-dependent rule)`);
  }
  return bones;
}

function readProcedural(file: BinaryFile, version: number, o: number, type: number, name: string, bone: number): StudioProceduralBone {
  if (type === STUDIO_PROC_AXISINTERP) {
    file.range(o, 0xb0, `axis-interp rule of ${name}`);
    const control = file.i32(o), axis = file.i32(o + 4);
    if (control < 0 || control >= bone) unsupported(file, `axis-interp bone ${name} controlled by bone ${control}, which isn't evaluated before it`);
    if (axis < 0 || axis > 2) file.fail(`axis-interp bone ${name} has axis ${axis}`);
    return { type: 'axisinterp', control, axis, position: file.floats(o + 8, 18, 'axis-interp positions'), quaternion: file.floats(o + 8 + 72, 24, 'axis-interp quaternions') };
  }
  if (type === STUDIO_PROC_QUATINTERP) {
    const control = file.i32(o), n = file.i32(o + 4), index = file.i32(o + 8);
    if (control < 0 || control >= bone) unsupported(file, `quat-interp bone ${name} controlled by bone ${control}, which isn't evaluated before it`);
    if (n <= 0 || n > 32) file.fail(`quat-interp bone ${name} has ${n} triggers`);
    const t0 = file.table(o + index, n, 48, `quat-interp triggers of ${name}`);
    const triggers: StudioQuatInterpTrigger[] = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + i*48;
      triggers.push({ inverseTolerance: file.f32(t), trigger: file.floats(t + 4, 4, 'trigger'), position: file.floats(t + 20, 3, 'trigger position'), quaternion: file.floats(t + 32, 4, 'trigger quaternion') });
    }
    return { type: 'quatinterp', control, triggers };
  }
  return unsupported(file, `procedural bone type ${type} on ${name} (MDL v${version})`);
}

function readAnimDescs(file: BinaryFile, version: number): MdlAnimDesc[] {
  const n = count(file, 0xb4, 'animation');
  const base = file.table(file.i32(0xb8), n, 0x64, 'animation descriptions');
  const out: MdlAnimDesc[] = [];
  for (let i = 0; i < n; i++) {
    const a = base + i*0x64;
    const name = file.relString(a, file.i32(a + 0x04), `animation ${i} name`);
    const fps = file.f32(a + 0x08), flags = file.i32(a + 0x0c), frameCount = file.i32(a + 0x10);
    if (frameCount <= 0) file.fail(`animation ${name} has ${frameCount} frames`);
    const movementCount = count(file, a + 0x14, `animation ${name} movement`);
    const m0 = file.table(a + file.i32(a + 0x18), movementCount, 0x2c, `animation ${name} movements`);
    const movements: StudioMovement[] = [];
    for (let k = 0; k < movementCount; k++) {
      const m = m0 + k*0x2c;
      movements.push({ endFrame: file.i32(m), motionFlags: file.i32(m + 4), v0: file.f32(m + 8), v1: file.f32(m + 12), angle: file.f32(m + 16), vector: file.floats(m + 20, 3, 'movement vector'), position: file.floats(m + 32, 3, 'movement position') });
    }
    const block = file.i32(a + 0x34), index = file.i32(a + 0x38);
    const ikRuleCount = count(file, a + 0x3c, `animation ${name} IK rule`);
    // Fields past ikruleindex are unused[8] in v44 and real in v48+ (animblockikruleindex,
    // local hierarchy, sections, zero frames). v45-v47 must leave them zero to be readable.
    const tail = [0x44, 0x48, 0x4c, 0x50, 0x54, 0x58, 0x5c].map(o => file.i32(a + o));
    let sectionFrames = 0, localHierarchyCount = 0;
    if (version >= 48) {
      localHierarchyCount = count(file, a + 0x48, `animation ${name} local hierarchy`);
      sectionFrames = file.i32(a + 0x54);
      if (sectionFrames < 0) file.fail(`animation ${name} has ${sectionFrames} section frames`);
    } else if (tail.some(v => v !== 0)) {
      unsupported(file, `animation ${name} with non-zero v48 animation fields in an MDL v${version}`);
    }
    const sections: MdlAnimSection[] = [];
    if (sectionFrames === 0) sections.push({ block, index });
    else {
      const sectionCount = Math.floor(frameCount/sectionFrames) + 2;
      const s0 = file.table(a + file.i32(a + 0x50), sectionCount, 8, `animation ${name} sections`);
      for (let k = 0; k < sectionCount; k++) sections.push({ block: file.i32(s0 + k*8), index: file.i32(s0 + k*8 + 4) });
    }
    out.push({ offset: a, name, fps, flags, frameCount, movements, ikRuleCount, sectionFrames, sections, localHierarchyCount });
  }
  return out;
}

function readEvents(file: BinaryFile, s: number, label: string): StudioEvent[] {
  const n = count(file, s + 0x18, `sequence ${label} event`);
  const e0 = file.table(s + file.i32(s + 0x1c), n, 0x50, `sequence ${label} events`);
  const events: StudioEvent[] = [];
  for (let k = 0; k < n; k++) {
    const e = e0 + k*0x50;
    events.push({
      cycle: file.f32Authored(e), event: file.i32(e + 4), type: file.i32(e + 8),
      options: file.fixedString(e + 12, 64, 'event options'),
      name: file.relString(e, file.i32(e + 0x4c), 'event name', true),
    });
  }
  return events;
}

function readSeqDescs(file: BinaryFile, version: number, boneCount: number, poseCount: number): MdlSeqDesc[] {
  const n = count(file, 0xbc, 'sequence');
  const base = file.table(file.i32(0xc0), n, 0xd4, 'sequence descriptions');
  const out: MdlSeqDesc[] = [];
  for (let i = 0; i < n; i++) {
    const s = base + i*0xd4;
    const label = file.relString(s, file.i32(s + 0x04), `sequence ${i} label`);
    const activityName = file.relString(s, file.i32(s + 0x08), `sequence ${label} activity`, true);
    const flags = file.i32(s + 0x0c);
    const gx = file.i32(s + 0x44), gy = file.i32(s + 0x48);
    // A forward-declared (STUDIO_OVERRIDE) sequence has no blend grid until an include defines it.
    const empty = gx === 0 && gy === 0 && (flags & STUDIO_OVERRIDE) !== 0;
    if (!empty && (gx <= 0 || gy <= 0 || gx*gy > 4096)) file.fail(`sequence ${label} has blend grid ${gx}x${gy}`);
    const a0 = file.table(s + file.i32(s + 0x3c), gx*gy, 2, `sequence ${label} blend animations`);
    const animations = new Int32Array(gx*gy);
    for (let k = 0; k < gx*gy; k++) animations[k] = file.i16(a0 + k*2);
    const paramIndex: [number, number] = [file.i32(s + 0x4c), file.i32(s + 0x50)];
    for (const p of paramIndex) if (p < -1 || p >= poseCount) file.fail(`sequence ${label} blends on pose parameter ${p} of ${poseCount}`);
    const layerCount = count(file, s + 0x94, `sequence ${label} layer`);
    const l0 = file.table(s + file.i32(s + 0x98), layerCount, 24, `sequence ${label} layers`);
    const layers: MdlLayer[] = [];
    for (let k = 0; k < layerCount; k++) {
      const l = l0 + k*24;
      // v44 stores int iSequence; v48 splits it into short iSequence, short iPose.
      const sequence = version >= 48 ? file.i16(l) : file.i32(l);
      const pose = version >= 48 ? file.i16(l + 2) : -1;
      layers.push({ sequence, pose, flags: file.i32(l + 4), start: file.f32Authored(l + 8), peak: file.f32Authored(l + 12), tail: file.f32Authored(l + 16), end: file.f32Authored(l + 20) });
    }
    const w0 = file.table(s + file.i32(s + 0x9c), boneCount, 4, `sequence ${label} bone weights`);
    const boneWeight = new Float32Array(boneCount);
    for (let k = 0; k < boneCount; k++) boneWeight[k] = file.f32(w0 + k*4);
    const poseKeyIndex = file.i32(s + 0xa0);
    const poseKeys = poseKeyIndex === 0 ? null : file.floats(s + poseKeyIndex, gx + gy, `sequence ${label} pose keys`);
    const keyValueSize = count(file, s + 0xb0, `sequence ${label} key value`);
    const keyValues = keyValueSize === 0 ? '' : file.fixedString(s + file.i32(s + 0xac), keyValueSize, `sequence ${label} key values`);
    let cyclePose = -1;
    const activityModifiers: string[] = [];
    if (version >= 48) cyclePose = file.i32(s + 0xb4);
    if (version >= 49) {
      const mCount = count(file, s + 0xbc, `sequence ${label} activity modifier`);
      const m0 = file.table(s + file.i32(s + 0xb8), mCount, 4, `sequence ${label} activity modifiers`);
      for (let k = 0; k < mCount; k++) activityModifiers.push(file.relString(m0 + k*4, file.i32(m0 + k*4), 'activity modifier'));
    }
    out.push({
      label, activityName, flags, activityWeight: file.i32(s + 0x14),
      events: readEvents(file, s, label),
      min: file.floats(s + 0x20, 3, 'sequence bbox'), max: file.floats(s + 0x2c, 3, 'sequence bbox'),
      groupSize: [gx, gy], animations, paramIndex,
      paramStart: [file.f32(s + 0x54), file.f32(s + 0x58)], paramEnd: [file.f32(s + 0x5c), file.f32(s + 0x60)],
      paramParent: file.i32(s + 0x64), fadeInTime: file.f32(s + 0x68), fadeOutTime: file.f32(s + 0x6c),
      entryNode: file.i32(s + 0x70), exitNode: file.i32(s + 0x74), nodeFlags: file.i32(s + 0x78),
      entryPhase: file.f32(s + 0x7c), exitPhase: file.f32(s + 0x80), lastFrame: file.f32(s + 0x84),
      nextSequence: file.i32(s + 0x88), pose: file.i32(s + 0x8c), ikRuleCount: count(file, s + 0x90, `sequence ${label} IK rule`),
      layers, boneWeight, poseKeys, ikLockCount: count(file, s + 0xa4, `sequence ${label} IK lock`), keyValues,
      cyclePose, activityModifiers,
    });
  }
  return out;
}

/** Printable ASCII name at o (NUL-terminated, at most 128 bytes), or null. */
function printableName(file: BinaryFile, o: number): string | null {
  if (o < 0 || o >= file.length) return null;
  const end = file.bytes.indexOf(0, o);
  if (end < 0 || end - o > 128) return null;
  for (let i = o; i < end; i++) if (file.bytes[i] < 0x20 || file.bytes[i] > 0x7e) return null;
  return file.cstring(o, 'hitbox name');
}

function readHitboxSets(file: BinaryFile, version: number, boneCount: number): StudioHitboxSet[] {
  const n = count(file, 0xac, 'hitbox set');
  const base = file.table(file.i32(0xb0), n, 12, 'hitbox sets');
  const sets: { name: string; boxes: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const h = base + i*12;
    const name = file.relString(h, file.i32(h), `hitbox set ${i} name`);
    const boxCount = count(file, h + 4, `hitbox set ${name} box`);
    const b0 = file.table(h + file.i32(h + 8), boxCount, 0x44, `hitbox set ${name} boxes`);
    sets.push({ name, boxes: Array.from({ length: boxCount }, (_, k) => b0 + k*0x44) });
  }
  // Hitbox names are box-relative from v48. Installed v44-v46 files use either box- or
  // header-relative offsets (studiomdl builds differ); a file must read cleanly one way.
  const boxes = sets.flatMap(set => set.boxes).filter(b => file.i32(b + 0x20) !== 0);
  const readable = (boxRelative: boolean) => boxes.every(b => printableName(file, (boxRelative ? b : 0) + file.i32(b + 0x20)) !== null);
  const named = (boxRelative: boolean) => boxes.filter(b => printableName(file, (boxRelative ? b : 0) + file.i32(b + 0x20))).length;
  let boxRelative = readable(true);
  if (version < 48 && readable(false) && (!boxRelative || named(false) > named(true))) boxRelative = false;
  if (boxes.length && !(boxRelative || (version < 48 && readable(false))))
    file.fail(version < 48 ? 'has hitbox names that read neither box- nor header-relative' : 'has hitbox names outside the file');
  return sets.map(({ name, boxes: offsets }) => ({
    name,
    hitboxes: offsets.map((b, k) => {
      const bone = file.i32(b);
      if (bone < 0 || bone >= boneCount) file.fail(`hitbox ${k} of ${name} uses bone ${bone}`);
      const nameIndex = file.i32(b + 0x20);
      return {
        bone, group: file.i32(b + 4), min: file.floats(b + 8, 3, 'hitbox min'), max: file.floats(b + 20, 3, 'hitbox max'),
        name: nameIndex === 0 ? '' : file.cstring((boxRelative ? b : 0) + nameIndex, 'hitbox name'),
      };
    }),
  }));
}

function readBodyParts(file: BinaryFile): MdlBodyPart[] {
  const n = count(file, 0xe8, 'body part');
  const base = file.table(file.i32(0xec), n, 0x10, 'body parts');
  const parts: MdlBodyPart[] = [];
  for (let i = 0; i < n; i++) {
    const p = base + i*0x10;
    const name = file.relString(p, file.i32(p), `body part ${i} name`);
    const modelCount = count(file, p + 4, `body part ${name} model`);
    const partBase = file.i32(p + 8);
    if (modelCount <= 0 || partBase <= 0) file.fail(`body part ${name} has ${modelCount} models and base ${partBase}`);
    const m0 = file.table(p + file.i32(p + 0x0c), modelCount, 0x94, `body part ${name} models`);
    const models: MdlModel[] = [];
    for (let k = 0; k < modelCount; k++) {
      const m = m0 + k*0x94;
      const vertexIndex = file.i32(m + 0x54), tangentIndex = file.i32(m + 0x58);
      if (vertexIndex % 0x30 || tangentIndex % 0x10 || vertexIndex < 0 || tangentIndex < 0)
        file.fail(`model ${k} of body part ${name} has vertex index ${vertexIndex} and tangent index ${tangentIndex}`);
      const meshCount = count(file, m + 0x48, 'mesh');
      const me0 = file.table(m + file.i32(m + 0x4c), meshCount, 0x74, 'meshes');
      const meshes: MdlMesh[] = [];
      for (let j = 0; j < meshCount; j++) {
        const me = me0 + j*0x74;
        meshes.push({
          skinRef: file.i32(me), vertexCount: count(file, me + 0x08, 'mesh vertex'), vertexOffset: file.i32(me + 0x0c),
          flexCount: count(file, me + 0x10, 'mesh flex'), materialType: file.i32(me + 0x18), materialParam: file.i32(me + 0x1c),
          meshId: file.i32(me + 0x20), center: file.floats(me + 0x24, 3, 'mesh center'),
        });
      }
      const eyeCount = count(file, m + 0x64, 'eyeball');
      const e0 = file.table(m + file.i32(m + 0x68), eyeCount, 0xac, 'eyeballs');
      const eyeballs: StudioEyeball[] = [];
      for (let j = 0; j < eyeCount; j++) {
        const e = e0 + j*0xac;
        eyeballs.push({
          name: file.relString(e, file.i32(e), 'eyeball name'), bone: file.i32(e + 4), origin: file.floats(e + 8, 3, 'eyeball origin'),
          zOffset: file.f32(e + 0x14), radius: file.f32(e + 0x18), up: file.floats(e + 0x1c, 3, 'eyeball up'),
          forward: file.floats(e + 0x28, 3, 'eyeball forward'), texture: file.i32(e + 0x34), irisScale: file.f32(e + 0x3c),
        });
      }
      models.push({
        name: file.fixedString(m, 64, 'model name'), boundingRadius: file.f32(m + 0x44),
        vertexCount: count(file, m + 0x50, 'model vertex'), firstVertex: vertexIndex/0x30, firstTangent: tangentIndex/0x10,
        meshes, eyeballs,
      });
    }
    parts.push({ name, base: partBase, models });
  }
  return parts;
}

export function readMdl(path: string, bytes: Uint8Array<ArrayBuffer>): MdlFile {
  const file = new BinaryFile(path, bytes);
  file.range(0, STUDIO_HEADER_BYTES, 'studio header');
  if (file.fixedString(0, 4, 'ident') !== 'IDST') file.fail('is not an IDST studio model');
  const version = file.i32(4);
  if (version < 44 || version > 49) unsupported(file, `MDL version ${version}`);
  const length = file.i32(0x4c);
  if (length !== file.length) file.fail(`header length ${length} differs from the ${file.length} bytes read`);
  const flags = file.u32(0x98);
  if (file.u32(0x158) !== 0 || file.u32(0x168) !== 0 || file.u32(0x170) !== 0 || file.u32(0x174) !== 0)
    file.fail('has runtime pointers stored in its header');
  const bones = readBones(file, version);

  const controllerCount = count(file, 0xa4, 'bone controller');
  const c0 = file.table(file.i32(0xa8), controllerCount, 0x38, 'bone controllers');
  const boneControllers: StudioBoneController[] = [];
  for (let i = 0; i < controllerCount; i++) {
    const c = c0 + i*0x38;
    const bone = file.i32(c);
    if (bone < 0 || bone >= bones.count) file.fail(`bone controller ${i} drives bone ${bone}`);
    boneControllers.push({ bone, type: file.i32(c + 4), start: file.f32(c + 8), end: file.f32(c + 12), rest: file.i32(c + 16), inputField: file.i32(c + 20) });
  }

  const poseCount = count(file, 0x12c, 'pose parameter');
  const pp0 = file.table(file.i32(0x130), poseCount, 0x14, 'pose parameters');
  const poseParameters: StudioPoseParameter[] = [];
  for (let i = 0; i < poseCount; i++) {
    const p = pp0 + i*0x14;
    poseParameters.push({ name: file.relString(p, file.i32(p), 'pose parameter name'), flags: file.i32(p + 4), start: file.f32(p + 8), end: file.f32(p + 12), loop: file.f32(p + 16) });
  }

  const textureCount = count(file, 0xcc, 'texture');
  const t0 = file.table(file.i32(0xd0), textureCount, 0x40, 'textures');
  const textures: StudioTexture[] = [];
  for (let i = 0; i < textureCount; i++) {
    const t = t0 + i*0x40;
    textures.push({ name: file.relString(t, file.i32(t), `texture ${i} name`), flags: file.i32(t + 4) });
  }
  const cdCount = count(file, 0xd4, 'material directory');
  const cd0 = file.table(file.i32(0xd8), cdCount, 4, 'material directories');
  const searchDirectories: string[] = [];
  for (let i = 0; i < cdCount; i++) searchDirectories.push(file.cstring(file.i32(cd0 + i*4), 'material directory'));
  const skinReferenceCount = count(file, 0xdc, 'skin reference');
  const familyCount = count(file, 0xe0, 'skin family');
  const sk0 = file.table(file.i32(0xe4), skinReferenceCount*familyCount, 2, 'skin table');
  const skinFamilies: Uint16Array[] = [];
  for (let f = 0; f < familyCount; f++) {
    const row = new Uint16Array(skinReferenceCount);
    for (let r = 0; r < skinReferenceCount; r++) {
      row[r] = file.i16(sk0 + (f*skinReferenceCount + r)*2);
      if (row[r] >= textureCount) file.fail(`skin family ${f} reference ${r} names texture ${row[r]} of ${textureCount}`);
    }
    skinFamilies.push(row);
  }

  const attachmentCount = count(file, 0xf0, 'attachment');
  const at0 = file.table(file.i32(0xf4), attachmentCount, 0x5c, 'attachments');
  const attachments: StudioAttachment[] = [];
  for (let i = 0; i < attachmentCount; i++) {
    const a = at0 + i*0x5c;
    const bone = file.i32(a + 8);
    if (bone < 0 || bone >= bones.count) file.fail(`attachment ${i} uses bone ${bone}`);
    attachments.push({ name: file.relString(a, file.i32(a), 'attachment name'), flags: file.u32(a + 4), bone, local: file.floats(a + 0x0c, 12, 'attachment matrix') });
  }

  const nodeCount = count(file, 0xf8, 'transition node');
  const nn0 = file.table(file.i32(0x100), nodeCount, 4, 'node names');
  const nodes: string[] = [];
  for (let i = 0; i < nodeCount; i++) nodes.push(file.cstring(file.i32(nn0 + i*4), 'node name'));

  const includeCount = count(file, 0x150, 'include model');
  const in0 = file.table(file.i32(0x154), includeCount, 8, 'include models');
  const includeModels: string[] = [];
  for (let i = 0; i < includeCount; i++) includeModels.push(file.relString(in0 + i*8, file.i32(in0 + i*8 + 4), 'include model name'));

  const animBlockCount = count(file, 0x160, 'animation block');
  const ab0 = file.table(file.i32(0x164), animBlockCount, 8, 'animation blocks');
  const animBlocks = new Int32Array(animBlockCount*2);
  for (let i = 0; i < animBlockCount*2; i++) animBlocks[i] = file.i32(ab0 + i*4);
  const animBlockName = animBlockCount > 0 ? file.relString(0, file.i32(0x15c), 'animation block name', true) : '';

  const keyValueSize = count(file, 0x13c, 'key value');
  let rootLod = 0, sourceBoneTransformCount = 0, flexControllerUiCount = 0;
  if (version >= 48) {
    rootLod = file.u8(0x179);
    flexControllerUiCount = count(file, 0x180, 'flex controller UI');
    const hdr2 = file.i32(0x190);
    if (hdr2 !== 0) {
      file.range(hdr2, 0x100, 'studiohdr2');
      sourceBoneTransformCount = count(file, hdr2, 'source bone transform');
    }
  }

  return {
    file, version, checksum: file.u32(8), name: file.fixedString(0x0c, 64, 'name'), length,
    eyePosition: file.floats(0x50, 3, 'eye position'), illumPosition: file.floats(0x5c, 3, 'illum position'),
    hullMin: file.floats(0x68, 3, 'hull'), hullMax: file.floats(0x74, 3, 'hull'),
    viewMin: file.floats(0x80, 3, 'view bbox'), viewMax: file.floats(0x8c, 3, 'view bbox'),
    flags, bones, boneControllers, hitboxSets: readHitboxSets(file, version, bones.count),
    anims: readAnimDescs(file, version), seqs: readSeqDescs(file, version, bones.count, poseCount),
    textures, searchDirectories, skinReferenceCount, skinFamilies, bodyParts: readBodyParts(file), attachments, nodes,
    flexDescCount: count(file, 0x104, 'flex description'), flexControllerCount: count(file, 0x10c, 'flex controller'),
    flexRuleCount: count(file, 0x114, 'flex rule'), ikChainCount: count(file, 0x11c, 'IK chain'), mouthCount: count(file, 0x124, 'mouth'),
    poseParameters, surfaceProp: file.relString(0, file.i32(0x134), 'surface property', true),
    keyValues: keyValueSize === 0 ? '' : file.fixedString(file.i32(0x138), keyValueSize, 'key values'),
    ikAutoplayLockCount: count(file, 0x140, 'IK autoplay lock'), mass: file.f32(0x148), contents: file.i32(0x14c),
    includeModels, animBlockName, animBlocks, rootLod, sourceBoneTransformCount, flexControllerUiCount,
  };
}
