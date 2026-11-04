/** loadStudioModel: reads an MDL, its VVD/VTX, every $includemodel and .ani block through the
 * session-local game content, and merges them the way Source's virtual model does (sequences,
 * animations, pose parameters, attachments and nodes deduplicated by name; include skeletons
 * matched to the model's bones by name). Nothing is fetched elsewhere and nothing is substituted. */
import { canonicalSourcePath, type LocalGameContent } from '../assets/local-content';
import { readTrackSection, type TrackSection } from './animation';
import { BinaryFile, StudioFormatError, StudioUnsupportedError } from './binary';
import { decodeMeshes, type DecodedMeshes } from './mesh';
import {
  readMdl, STUDIO_AL_LOCAL, STUDIO_AL_POSE, STUDIO_AUTOPLAY, STUDIO_CYCLEPOSE, STUDIO_LOCAL, STUDIO_OVERRIDE, STUDIO_WORLD,
  type MdlAnimDesc, type MdlBones, type MdlFile, type MdlSeqDesc,
} from './mdl';
import type {
  StudioAnimation, StudioAttachment, StudioAutoLayer, StudioGroup, StudioModelData, StudioPoseParameter, StudioSequence,
  StudioSourceFile,
} from './types';

const MAX_GROUPS = 64;
const MAX_INCLUDE_DEPTH = 8;

export interface GroupRuntime {
  readonly mdl: MdlFile;
  readonly bones: MdlBones;
  readonly masterBone: Int32Array;
  readonly boneMap: Int32Array;
  readonly masterSeq: Int32Array;
  readonly masterAnim: Int32Array;
  readonly masterPose: Int32Array;
  readonly masterNode: Int32Array;
}

export interface AnimRuntime {
  readonly group: GroupRuntime;
  readonly desc: MdlAnimDesc;
  /** Indexed like desc.sections; null for sections Source never reads. */
  readonly sections: (TrackSection | null)[];
}

export interface SeqRuntime {
  readonly group: GroupRuntime;
  readonly desc: MdlSeqDesc;
  readonly data: StudioSequence;
}

export interface StudioRuntime {
  readonly groups: readonly GroupRuntime[];
  readonly anims: readonly AnimRuntime[];
  readonly seqs: readonly SeqRuntime[];
  readonly autoplay: readonly number[];
  /** Deepest autolayer nesting among sampleable sequences (0 = no layers). */
  readonly layerDepth: number;
}

const runtimes = new WeakMap<StudioModelData, StudioRuntime>();

export function studioRuntime(model: StudioModelData): StudioRuntime {
  const runtime = runtimes.get(model);
  if (!runtime) throw new Error(`Studio model ${model.path} wasn't produced by loadStudioModel.`);
  return runtime;
}

interface LoadedGroup { readonly path: string; readonly mdl: MdlFile }

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function readFile(content: LocalGameContent, path: string, role: StudioSourceFile['role'], group: number, files: StudioSourceFile[], signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await content.read(path, signal);
  files.push({ path, role, group, bytes: bytes.byteLength });
  return bytes;
}

/** Depth-first include order of Source's virtual model: the model, then each include followed by
 * its own includes. */
async function loadGroups(content: LocalGameContent, root: string, files: StudioSourceFile[], signal?: AbortSignal): Promise<LoadedGroup[]> {
  const groups: LoadedGroup[] = [];
  const visit = async (path: string, chain: string[]): Promise<void> => {
    if (chain.includes(path)) throw new StudioFormatError(root, `includes itself through ${[...chain, path].join(' -> ')}`);
    if (chain.length > MAX_INCLUDE_DEPTH) throw new StudioFormatError(root, `nests includes deeper than ${MAX_INCLUDE_DEPTH}`);
    if (groups.length >= MAX_GROUPS) throw new StudioFormatError(root, `pulls in more than ${MAX_GROUPS} models`);
    const index = groups.length;
    const mdl = readMdl(path, await readFile(content, path, 'mdl', index, files, signal));
    groups.push({ path, mdl });
    for (const include of mdl.includeModels) await visit(canonicalSourcePath(include), [...chain, path]);
  };
  await visit(root, []);
  return groups;
}

function framesNeeded(desc: MdlAnimDesc, section: number): number {
  const { frameCount: nf, sectionFrames: sf } = desc;
  if (sf === 0 || nf <= sf) return section === 0 ? nf : 0;
  const special = Math.floor(nf/sf) + 1;
  if (section === special) return 1;
  // Frames 0..nf-2 live in section frame/sf and interpolate toward the next frame.
  const first = section*sf;
  if (first > nf - 2) return 0;
  return Math.min(sf - 1, nf - 2 - first) + 2;
}

async function buildAnims(content: LocalGameContent, loaded: LoadedGroup[], groups: GroupRuntime[], order: { group: number; index: number }[],
  files: StudioSourceFile[], signal?: AbortSignal): Promise<{ runtime: AnimRuntime[]; data: StudioAnimation[] }> {
  const ani = new Map<number, BinaryFile>();
  for (let g = 0; g < loaded.length; g++) {
    const mdl = loaded[g].mdl;
    if (!mdl.anims.some(a => a.sections.some(s => s.block > 0))) continue;
    if (!mdl.animBlockName) mdl.file.fail('stores animation in blocks but names no .ani file');
    const path = canonicalSourcePath(mdl.animBlockName);
    const file = new BinaryFile(path, await readFile(content, path, 'ani', g, files, signal));
    file.range(0, 0x50, 'ANI header');
    if (file.fixedString(0, 4, 'ANI ident') !== 'IDAG') file.fail('is not an IDAG animation block file');
    if (file.i32(0x4c) !== file.length) file.fail(`header length ${file.i32(0x4c)} differs from the ${file.length} bytes read`);
    for (let b = 1; b < mdl.animBlocks.length/2; b++) {
      const start = mdl.animBlocks[b*2], end = mdl.animBlocks[b*2 + 1];
      if (start < 0 || end < start || end > file.length) file.fail(`block ${b} spans ${start}..${end}`);
    }
    ani.set(g, file);
  }
  const runtime: AnimRuntime[] = [], data: StudioAnimation[] = [];
  for (const { group, index } of order) {
    const g = groups[group], mdl = g.mdl, desc = mdl.anims[index];
    const what = `animation ${desc.name}`;
    const sections: (TrackSection | null)[] = [];
    const storage: string[] = [];
    let unsupported: string | null = desc.localHierarchyCount > 0 ? `${what} uses a local hierarchy override` : null;
    for (let s = 0; s < desc.sections.length && !unsupported; s++) {
      const need = framesNeeded(desc, s);
      const { block, index: offset } = desc.sections[s];
      if (need === 0) { sections.push(null); storage.push(''); continue; }
      if (block < 0) { unsupported = `${what} section ${s} has no data block (model needs recompiling)`; break; }
      let file = mdl.file, start = desc.offset + offset;
      if (block > 0) {
        if (block >= mdl.animBlocks.length/2) mdl.file.fail(`${what} section ${s} uses block ${block} of ${mdl.animBlocks.length/2}`);
        file = ani.get(group)!;
        start = mdl.animBlocks[block*2] + offset;
        if (offset < 0 || start >= mdl.animBlocks[block*2 + 1]) file.fail(`${what} section ${s} starts outside block ${block}`);
      }
      try {
        sections.push(readTrackSection(file, start, need, g.bones, mdl.version, `${what} section ${s}`));
      } catch (error) {
        if (!(error instanceof StudioUnsupportedError)) throw error;
        unsupported = error.feature;
      }
      storage.push(block === 0 ? 'mdl' : file.path);
    }
    runtime.push({ group: g, desc, sections });
    data.push({
      name: desc.name, fps: desc.fps, flags: desc.flags, frameCount: desc.frameCount, group, movements: desc.movements,
      ikRuleCount: desc.ikRuleCount, sectionCount: desc.sections.length, storage, unsupported,
    });
  }
  return { runtime, data };
}

/** Merges by case-insensitive name, keeping the first; returns group-local -> model index. */
function appendNamed<T>(list: { group: number; index: number; item: T }[], group: number, items: readonly T[], name: (item: T) => string): Int32Array {
  const map = new Int32Array(items.length);
  items.forEach((item, index) => {
    let k = list.findIndex(entry => sameName(name(entry.item), name(item)));
    if (k < 0) k = list.push({ group, index, item }) - 1;
    map[index] = k;
  });
  return map;
}

export async function loadStudioModel(content: LocalGameContent, modelPath: string, signal?: AbortSignal): Promise<StudioModelData> {
  const path = canonicalSourcePath(modelPath);
  if (!path.endsWith('.mdl')) throw new StudioFormatError(path, 'is not a .mdl path');
  const files: StudioSourceFile[] = [];
  const loaded = await loadGroups(content, path, files, signal);
  const root = loaded[0].mdl;
  if (root.rootLod !== 0) throw new StudioUnsupportedError(path, `root LOD ${root.rootLod}`);
  if (root.sourceBoneTransformCount) throw new StudioUnsupportedError(path, `${root.sourceBoneTransformCount} source bone transforms`);
  const hasVertices = root.bodyParts.some(p => p.models.some(m => m.meshes.some(me => me.vertexCount > 0)));
  let meshes: DecodedMeshes | null = null;
  if (hasVertices) {
    const base = path.slice(0, -4);
    const vvd = new BinaryFile(`${base}.vvd`, await readFile(content, `${base}.vvd`, 'vvd', 0, files, signal));
    const vtx = new BinaryFile(`${base}.dx90.vtx`, await readFile(content, `${base}.dx90.vtx`, 'vtx', 0, files, signal));
    meshes = decodeMeshes(root, vvd, vtx);
  }

  // Source virtual model merge (AppendSequences/Animations/Bonemap/Attachments/PoseParameters/Nodes).
  const masterBones = root.bones;
  const seqList: { group: number; index: number; item: MdlSeqDesc }[] = [];
  const animList: { group: number; index: number; item: MdlAnimDesc }[] = [];
  const poseList: { group: number; index: number; item: StudioPoseParameter }[] = [];
  const nodeList: { group: number; index: number; item: string }[] = [];
  const attachments: StudioAttachment[] = [];
  const groups: GroupRuntime[] = loaded.map(({ mdl }, g) => {
    const masterSeq = new Int32Array(mdl.seqs.length);
    mdl.seqs.forEach((seq, index) => {
      const k = seqList.findIndex(entry => sameName(entry.item.label, seq.label));
      if (k < 0) masterSeq[index] = seqList.push({ group: g, index, item: seq }) - 1;
      else {
        if (seqList[k].item.flags & STUDIO_OVERRIDE) seqList[k] = { group: g, index, item: seq };
        masterSeq[index] = k;
      }
    });
    const masterAnim = appendNamed(animList, g, mdl.anims, a => a.name);
    const masterBone = new Int32Array(mdl.bones.count).fill(-1), boneMap = new Int32Array(masterBones.count).fill(-1);
    for (let j = 0; j < mdl.bones.count; j++) {
      const k = g === 0 ? j : masterBones.names.findIndex(name => sameName(name, mdl.bones.names[j]));
      if (k >= 0) { masterBone[j] = k; boneMap[k] = j; }
    }
    for (const attachment of mdl.attachments) {
      const bone = masterBone[attachment.bone];
      if (bone < 0 || attachments.some(a => sameName(a.name, attachment.name))) continue;
      attachments.push({ ...attachment, bone });
    }
    const masterPose = appendNamed(poseList, g, mdl.poseParameters, p => p.name);
    const masterNode = appendNamed(nodeList, g, mdl.nodes, n => n);
    return { mdl, bones: mdl.bones, masterBone, boneMap, masterSeq, masterAnim, masterPose, masterNode };
  });

  for (let i = 0; i < masterBones.count; i++) {
    const rule = masterBones.procedural[i];
    if (rule && masterBones.parent[rule.control] < 0)
      throw new StudioUnsupportedError(path, `${rule.type} bone ${masterBones.names[i]} controlled by root bone ${masterBones.names[rule.control]} (needs the entity transform)`);
  }

  const { runtime: anims, data: animations } = await buildAnims(content, loaded, groups, animList, files, signal);

  // Sequences, then refusal propagation through layers and animations.
  const seqData = seqList.map(({ group, item: d }): Omit<StudioSequence, 'unsupported'> & { unsupported: string | null } => {
    const g = groups[group], mdl = g.mdl;
    const animationsOf = Int32Array.from(d.animations, a => {
      if (a < 0 || a >= g.masterAnim.length) mdl.file.fail(`sequence ${d.label} blends animation ${a} of ${g.masterAnim.length}`);
      return g.masterAnim[a];
    });
    const mapPose = (p: number) => p < 0 ? -1 : g.masterPose[p];
    const mapSeq = (s: number, what: string) => {
      if (s < 0 || s >= g.masterSeq.length) mdl.file.fail(`sequence ${d.label} ${what} ${s} of ${g.masterSeq.length}`);
      return g.masterSeq[s];
    };
    // A pose-driven layer resolves its pose parameter through the layered sequence's own model.
    const layers: StudioAutoLayer[] = d.layers.map(l => {
      const sequence = mapSeq(l.sequence, 'layers sequence');
      const target = groups[seqList[sequence].group];
      const pose = (l.flags & STUDIO_AL_POSE) && l.pose >= 0 && l.pose < target.masterPose.length ? target.masterPose[l.pose] : -1;
      return { sequence, pose, flags: l.flags, start: l.start, peak: l.peak, tail: l.tail, end: l.end };
    });
    const boneWeight = new Float32Array(masterBones.count);
    for (let i = 0; i < masterBones.count; i++) if (g.boneMap[i] >= 0) boneWeight[i] = d.boneWeight[g.boneMap[i]];
    const node = (n: number) => n <= 0 || n > g.masterNode.length ? n : g.masterNode[n - 1] + 1;
    let unsupported: string | null = null;
    const what = `sequence ${d.label}`;
    if (d.groupSize[0] === 0) unsupported = `${what} is forward-declared and never defined`;
    else if (d.flags & STUDIO_LOCAL) unsupported = `${what} is a local-context sequence`;
    else if (d.flags & STUDIO_WORLD) unsupported = `${what} blends in world space`;
    else if ((d.flags & STUDIO_CYCLEPOSE) && mdl.version < 48) unsupported = `${what} sets the cycle-pose bit in an MDL v${mdl.version}`;
    else if ((d.flags & STUDIO_CYCLEPOSE) && (d.cyclePose < 0 || d.cyclePose >= g.masterPose.length)) unsupported = `${what} takes its cycle from missing pose parameter ${d.cyclePose}`;
    else {
      for (const l of d.layers) {
        if (!(l.flags & STUDIO_AL_LOCAL) && ![l.start, l.peak, l.tail, l.end].every(Number.isFinite)) { unsupported = `${what} has an autolayer with a non-finite ramp`; break; }
        if ((l.flags & STUDIO_AL_POSE) && layers[d.layers.indexOf(l)].pose < 0) { unsupported = `${what} has a pose-driven autolayer without a pose parameter`; break; }
      }
      for (let k = 0; !unsupported && k < animationsOf.length; k++) unsupported = animations[animationsOf[k]].unsupported;
    }
    return {
      label: d.label, activityName: d.activityName, activityWeight: d.activityWeight, flags: d.flags, group,
      events: d.events, min: d.min, max: d.max, groupSize: d.groupSize, animations: animationsOf,
      blendPose: [mapPose(d.paramIndex[0]), mapPose(d.paramIndex[1])], paramStart: d.paramStart, paramEnd: d.paramEnd,
      paramParent: d.paramParent, poseKeys: d.poseKeys, fadeInTime: d.fadeInTime, fadeOutTime: d.fadeOutTime,
      entryNode: node(d.entryNode), exitNode: node(d.exitNode), nodeFlags: d.nodeFlags, entryPhase: d.entryPhase,
      exitPhase: d.exitPhase, lastFrame: d.lastFrame,
      nextSequence: d.nextSequence >= 0 && d.nextSequence < g.masterSeq.length ? g.masterSeq[d.nextSequence] : -1,
      pose: d.pose, layers, boneWeight, ikRuleCount: d.ikRuleCount, ikLockCount: d.ikLockCount, keyValues: d.keyValues,
      cyclePose: (d.flags & STUDIO_CYCLEPOSE) && d.cyclePose >= 0 && d.cyclePose < g.masterPose.length ? g.masterPose[d.cyclePose] : -1,
      activityModifiers: d.activityModifiers, unsupported,
    };
  });
  // Layer depth, and refusal of sequences whose (non-local) layers are refused or cyclic.
  const depth = new Int32Array(seqData.length).fill(-1);
  const visiting = new Uint8Array(seqData.length);
  const resolve = (s: number): number => {
    if (depth[s] >= 0) return depth[s];
    const seq = seqData[s];
    if (visiting[s]) { seq.unsupported ??= `sequence ${seq.label} layers itself`; return 0; }
    visiting[s] = 1;
    let d = 0;
    for (const l of seq.layers) {
      if (l.flags & STUDIO_AL_LOCAL) continue;
      d = Math.max(d, resolve(l.sequence) + 1);
      seq.unsupported ??= seqData[l.sequence].unsupported && `sequence ${seq.label} layers ${seqData[l.sequence].label}: ${seqData[l.sequence].unsupported}`;
    }
    visiting[s] = 0;
    return depth[s] = d;
  };
  let layerDepth = 0;
  for (let s = 0; s < seqData.length; s++) layerDepth = Math.max(layerDepth, resolve(s));
  const autoplay: number[] = [];
  seqData.forEach((seq, s) => {
    if (!(seq.flags & STUDIO_AUTOPLAY)) return;
    if (seq.unsupported) throw new StudioUnsupportedError(path, `autoplay ${seq.unsupported}`);
    autoplay.push(s);
  });

  const sequences: StudioSequence[] = seqData;
  const notEvaluated: string[] = [];
  const ikRules = animations.reduce((n, a) => n + a.ikRuleCount, 0);
  if (ikRules) notEvaluated.push(`${ikRules} animation IK rules (reported per sample in StudioPose.unsolvedIk)`);
  const ikLocks = sequences.reduce((n, s) => n + s.ikLockCount, 0);
  if (ikLocks) notEvaluated.push(`${ikLocks} sequence IK locks (reported per sample in StudioPose.unsolvedIk)`);
  const ikAutoplayLocks = loaded.reduce((n, l) => n + l.mdl.ikAutoplayLockCount, 0);
  if (ikAutoplayLocks) notEvaluated.push(`${ikAutoplayLocks} IK autoplay locks`);
  const flexMeshes = meshes ? meshes.bodyParts.reduce((n, p) => n + p.models.reduce((m, sub) => m + sub.meshes.filter(me => me.flexCount > 0).length, 0), 0) : 0;
  if (flexMeshes || root.flexControllerCount) notEvaluated.push(`flex animation (${root.flexControllerCount} controllers, ${root.flexRuleCount} rules, ${flexMeshes} flexed meshes): the neutral shape is returned`);
  const eyeballs = root.bodyParts.reduce((n, p) => n + p.models.reduce((m, sub) => m + sub.eyeballs.length, 0), 0);
  if (eyeballs) notEvaluated.push(`${eyeballs} eyeballs (eye shading projects its own UVs; materialType 1 meshes)`);
  const refused = sequences.filter(s => s.unsupported).length;
  if (refused) notEvaluated.push(`${refused} of ${sequences.length} sequences are refused for sampling (see StudioSequence.unsupported)`);
  if (animations.some(a => a.movements.length)) notEvaluated.push('piecewise movement (root motion) is returned per animation, not applied to the pose');

  const studioGroups: StudioGroup[] = loaded.map(({ path: groupPath, mdl }, g) => ({
    path: groupPath, name: mdl.name, version: mdl.version, checksum: mdl.checksum, boneCount: mdl.bones.count,
    masterBone: groups[g].masterBone, boneMap: groups[g].boneMap, animationBlockPath: mdl.animBlockName ? canonicalSourcePath(mdl.animBlockName) : null,
  }));
  const model: StudioModelData = {
    path, name: root.name, version: root.version, checksum: root.checksum, flags: root.flags,
    eyePosition: root.eyePosition, illumPosition: root.illumPosition, hullMin: root.hullMin, hullMax: root.hullMax,
    viewMin: root.viewMin, viewMax: root.viewMax, mass: root.mass, contents: root.contents, surfaceProp: root.surfaceProp,
    keyValues: root.keyValues, groups: studioGroups, files,
    skeleton: { ...masterBones },
    boneControllers: root.boneControllers, attachments, hitboxSets: root.hitboxSets,
    poseParameters: poseList.map(p => p.item), animations, sequences, nodes: nodeList.map(n => n.item),
    bodyParts: meshes ? meshes.bodyParts : root.bodyParts.map(p => ({ name: p.name, base: p.base, models: p.models.map(m => ({ name: m.name, boundingRadius: m.boundingRadius, meshes: [], eyeballs: m.eyeballs })) })),
    materials: {
      textures: root.textures, searchDirectories: root.searchDirectories, skinFamilies: root.skinFamilies,
      skinReferenceCount: root.skinReferenceCount, replacements: meshes ? meshes.replacements : new Map(),
    },
    lodCount: meshes ? meshes.lodCount : 0, ikChainCount: root.ikChainCount, ikAutoplayLockCount: ikAutoplayLocks,
    flexControllerCount: root.flexControllerCount, notEvaluated,
  };
  runtimes.set(model, {
    groups, anims, layerDepth, autoplay,
    seqs: seqList.map(({ group, item }, s) => ({ group: groups[group], desc: item, data: sequences[s] })),
  });
  return model;
}
