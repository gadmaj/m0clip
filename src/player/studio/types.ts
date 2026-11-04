/** Decoded Source Studio model (MDL v44-v49 with VVD v4 and .dx90.vtx v7) as CPU data.
 *
 * Units and axes stay native: positions are inches in Source model space (+Z up, +X forward),
 * quaternions are (x, y, z, w), UVs are Source (U, V) with V growing downward, and triangle
 * indices keep the authored winding. Converting to the renderer's frame is the caller's job.
 * Matrices are row-major 3x4 (12 floats, m[row*4 + col]), as in matrix3x4_t. */

/** One file read for the model, as reported by the local content session. */
export interface StudioSourceFile {
  readonly path: string;
  readonly role: 'mdl' | 'vvd' | 'vtx' | 'ani';
  /** Index into StudioModelData.groups. */
  readonly group: number;
  readonly bytes: number;
}

/** The model itself (group 0) and every $includemodel it pulls in, in Source's merge order. */
export interface StudioGroup {
  readonly path: string;
  readonly name: string;
  readonly version: number;
  readonly checksum: number;
  readonly boneCount: number;
  /** Group bone index -> model bone index (matched by name), or -1. */
  readonly masterBone: Int32Array;
  /** Model bone index -> group bone index, or -1. */
  readonly boneMap: Int32Array;
  readonly animationBlockPath: string | null;
}

/** Skeleton of the model (group 0). Struct-of-arrays, n = count. */
export interface StudioSkeleton {
  readonly count: number;
  readonly names: readonly string[];
  readonly parent: Int32Array;
  readonly flags: Uint32Array;
  /** Authored local rest translation, 3n. */
  readonly position: Float32Array;
  /** Authored local rest rotation, 4n (x, y, z, w). */
  readonly quaternion: Float32Array;
  /** Authored local rest rotation as RadianEuler, 3n; animation deltas add to it. */
  readonly euler: Float32Array;
  readonly positionScale: Float32Array;
  readonly rotationScale: Float32Array;
  /** Authored poseToBone (model space -> bone space; the inverse bind), 12n. */
  readonly poseToBone: Float32Array;
  readonly alignment: Float32Array;
  readonly procedural: readonly (StudioProceduralBone | null)[];
  readonly physicsBone: Int32Array;
  readonly surfaceProp: readonly string[];
  readonly contents: Uint32Array;
  /** Six controller indices per bone (-1 none). */
  readonly boneController: Int32Array;
}

export interface StudioAxisInterpBone {
  readonly type: 'axisinterp';
  readonly control: number;
  readonly axis: number;
  /** pos[6] (X+, X-, Y+, Y-, Z+, Z-), 18 floats. */
  readonly position: Float32Array;
  /** quat[6], 24 floats. */
  readonly quaternion: Float32Array;
}
export interface StudioQuatInterpTrigger {
  readonly inverseTolerance: number;
  readonly trigger: Float32Array;
  readonly position: Float32Array;
  readonly quaternion: Float32Array;
}
export interface StudioQuatInterpBone {
  readonly type: 'quatinterp';
  readonly control: number;
  readonly triggers: readonly StudioQuatInterpTrigger[];
}
export type StudioProceduralBone = StudioAxisInterpBone | StudioQuatInterpBone;

export interface StudioBoneController {
  readonly bone: number;
  /** STUDIO_X..STUDIO_ZR | STUDIO_RLOOP bits. */
  readonly type: number;
  readonly start: number;
  readonly end: number;
  readonly rest: number;
  /** 0-3 user controllers, 4 mouth. */
  readonly inputField: number;
}

export interface StudioAttachment {
  readonly name: string;
  readonly flags: number;
  /** Model bone index. */
  readonly bone: number;
  /** Bone-local 3x4 transform. */
  readonly local: Float32Array;
}

export interface StudioHitbox {
  readonly bone: number;
  readonly group: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly name: string;
}
export interface StudioHitboxSet { readonly name: string; readonly hitboxes: readonly StudioHitbox[] }

export interface StudioPoseParameter {
  readonly name: string;
  readonly flags: number;
  readonly start: number;
  readonly end: number;
  /** Looping range (360 for rotations), 0 when not looping. */
  readonly loop: number;
}

export interface StudioEvent {
  readonly cycle: number;
  readonly event: number;
  readonly type: number;
  readonly options: string;
  /** Named event (AE_*), when the file stores one. */
  readonly name: string;
}

export interface StudioAutoLayer {
  /** Model sequence index. */
  readonly sequence: number;
  /** Model pose parameter index for STUDIO_AL_POSE layers, else -1. */
  readonly pose: number;
  readonly flags: number;
  readonly start: number;
  readonly peak: number;
  readonly tail: number;
  readonly end: number;
}

export interface StudioMovement {
  readonly endFrame: number;
  readonly motionFlags: number;
  readonly v0: number;
  readonly v1: number;
  readonly angle: number;
  readonly vector: Float32Array;
  readonly position: Float32Array;
}

export interface StudioAnimation {
  readonly name: string;
  readonly fps: number;
  readonly flags: number;
  readonly frameCount: number;
  /** Group whose skeleton the authored tracks are relative to. */
  readonly group: number;
  readonly movements: readonly StudioMovement[];
  /** Authored IK rules; m0clip samples forward kinematics and doesn't solve them. */
  readonly ikRuleCount: number;
  /** Sections the frames are split into (1 when unsectioned). */
  readonly sectionCount: number;
  /** Where each section's tracks live: 'mdl' or the .ani path ('' for sections Source never reads). */
  readonly storage: readonly string[];
  /** Why this animation can't be sampled (an authored feature this decoder doesn't evaluate), or
   * null. Sequences that use it are refused with the same reason. */
  readonly unsupported: string | null;
}

export interface StudioSequence {
  readonly label: string;
  readonly activityName: string;
  readonly activityWeight: number;
  readonly flags: number;
  readonly group: number;
  readonly events: readonly StudioEvent[];
  readonly min: Float32Array;
  readonly max: Float32Array;
  /** Blend grid size along the two pose parameters; animations has gx*gy entries, x fastest. */
  readonly groupSize: readonly [number, number];
  /** Model animation index of each blend cell. */
  readonly animations: Int32Array;
  /** Model pose parameter index driving each blend axis, or -1. */
  readonly blendPose: readonly [number, number];
  readonly paramStart: readonly [number, number];
  readonly paramEnd: readonly [number, number];
  readonly paramParent: number;
  /** Explicit pose keys (groupSize[0] per axis, 2 axes) or null. */
  readonly poseKeys: Float32Array | null;
  readonly fadeInTime: number;
  readonly fadeOutTime: number;
  /** 1-based model transition node, 0 when none. */
  readonly entryNode: number;
  readonly exitNode: number;
  readonly nodeFlags: number;
  readonly entryPhase: number;
  readonly exitPhase: number;
  readonly lastFrame: number;
  /** Model sequence index, or -1. */
  readonly nextSequence: number;
  readonly pose: number;
  readonly layers: readonly StudioAutoLayer[];
  /** Per model bone: the sequence's authored bone weight (0 for bones its group lacks). */
  readonly boneWeight: Float32Array;
  readonly ikRuleCount: number;
  readonly ikLockCount: number;
  readonly keyValues: string;
  /** STUDIO_CYCLEPOSE source as a model pose parameter, or -1. */
  readonly cyclePose: number;
  readonly activityModifiers: readonly string[];
  /** Why sampling this sequence is refused (unsupported authored feature, or a layer or
   * animation that is refused), or null. The sampler throws StudioUnsupportedError for it. */
  readonly unsupported: string | null;
}

export interface StudioEyeball {
  readonly name: string;
  readonly bone: number;
  readonly origin: Float32Array;
  readonly zOffset: number;
  readonly radius: number;
  readonly up: Float32Array;
  readonly forward: Float32Array;
  readonly texture: number;
  readonly irisScale: number;
}

export interface StudioStripGroup {
  /** VTX strip group flags (1 flexed, 2 hardware skinned, 4 delta flexed). */
  readonly flags: number;
  readonly vertexStart: number;
  readonly vertexCount: number;
  readonly indexStart: number;
  readonly indexCount: number;
}

export interface StudioMesh {
  /** Skin reference (index into a skin family row). */
  readonly skinRef: number;
  /** 1 for eyeball meshes, whose materialParam names the eyeball. */
  readonly materialType: number;
  readonly materialParam: number;
  readonly meshId: number;
  readonly center: Float32Array;
  /** VTX mesh flags (1 teeth, 2 eyes). */
  readonly flags: number;
  readonly vertexCount: number;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  /** VVD tangentS (xyz + sign). */
  readonly tangent: Float32Array;
  /** Source U, V. */
  readonly uv: Float32Array;
  /** Model bone index per influence, 3 per vertex; unused slots 0 with weight 0. */
  readonly boneIndex: Uint8Array;
  readonly boneWeight: Float32Array;
  readonly boneCount: Uint8Array;
  /** Mesh-relative VVD vertex of each output vertex (for flex data). */
  readonly sourceVertex: Uint16Array;
  /** Triangle list, native winding. */
  readonly index: Uint16Array | Uint32Array;
  readonly stripGroups: readonly StudioStripGroup[];
  /** Authored flex (vertex animation) count; m0clip draws the neutral shape. */
  readonly flexCount: number;
}

export interface StudioSubmodel {
  readonly name: string;
  readonly boundingRadius: number;
  /** Empty for the blank choice of a bodygroup. */
  readonly meshes: readonly StudioMesh[];
  readonly eyeballs: readonly StudioEyeball[];
}

export interface StudioBodyPart {
  readonly name: string;
  readonly base: number;
  readonly models: readonly StudioSubmodel[];
}

export interface StudioTexture { readonly name: string; readonly flags: number }

export interface StudioMaterials {
  /** mstudiotexture_t names as authored (no extension). */
  readonly textures: readonly StudioTexture[];
  /** $cdmaterials directories as authored, searched in order under materials/. */
  readonly searchDirectories: readonly string[];
  /** skinFamilies[family][skinRef] = texture index. */
  readonly skinFamilies: readonly Uint16Array[];
  readonly skinReferenceCount: number;
  /** Root LOD material replacements from the VTX (texture index -> authored name). */
  readonly replacements: ReadonlyMap<number, string>;
}

export interface StudioModelData {
  readonly path: string;
  readonly name: string;
  readonly version: number;
  readonly checksum: number;
  readonly flags: number;
  readonly eyePosition: Float32Array;
  readonly illumPosition: Float32Array;
  readonly hullMin: Float32Array;
  readonly hullMax: Float32Array;
  readonly viewMin: Float32Array;
  readonly viewMax: Float32Array;
  readonly mass: number;
  readonly contents: number;
  readonly surfaceProp: string;
  readonly keyValues: string;
  readonly groups: readonly StudioGroup[];
  readonly files: readonly StudioSourceFile[];
  readonly skeleton: StudioSkeleton;
  readonly boneControllers: readonly StudioBoneController[];
  readonly attachments: readonly StudioAttachment[];
  readonly hitboxSets: readonly StudioHitboxSet[];
  readonly poseParameters: readonly StudioPoseParameter[];
  readonly animations: readonly StudioAnimation[];
  readonly sequences: readonly StudioSequence[];
  /** Model transition node names. */
  readonly nodes: readonly string[];
  readonly bodyParts: readonly StudioBodyPart[];
  readonly materials: StudioMaterials;
  readonly lodCount: number;
  readonly ikChainCount: number;
  readonly ikAutoplayLockCount: number;
  readonly flexControllerCount: number;
  /** Authored data present in the files that this module returns but doesn't evaluate, e.g.
   * IK rules, IK locks and flex animation. Each entry names the data and where it is. */
  readonly notEvaluated: readonly string[];
}

/** Local-space pose written by the sampler, one entry per model bone. */
export interface StudioPose {
  readonly boneCount: number;
  /** 3n local translations (inches). */
  readonly position: Float32Array;
  /** 4n local rotations (x, y, z, w). */
  readonly quaternion: Float32Array;
  /** IK rules and locks in the sequences that contributed to the last sample. They are not solved;
   * a non-zero value means Source would additionally run IK on this pose. */
  unsolvedIk: number;
}

export interface StudioLayerRequest {
  sequence: number;
  cycle: number;
  /** 0..1 */
  weight: number;
}

export interface StudioPoseRequest {
  sequence: number;
  cycle: number;
  /** Encoded 0..1 pose parameter values (see encodeStudioPoseParameter), one per model pose
   * parameter. */
  poseParameters: Float32Array;
  /** Seconds; drives STUDIO_REALTIME and STUDIO_AUTOPLAY sequences. */
  time: number;
  /** Overlay layers accumulated after the main sequence, in order. */
  layers?: readonly StudioLayerRequest[];
  /** Encoded 0..1 bone controller inputs, indexed by inputField. Required when the model has
   * bone controllers. */
  controllers?: Float32Array;
}
