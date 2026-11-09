/** Player takes (take format v3): a recorded stretch of a Player world.
 *
 * One global clock runs through the whole take, carrying the viewport camera, the player's input,
 * the worker's PlayerSimFrame and the displayed PlayerPresentation. Scene geometry is split into
 * EPOCHS: every native recompile (a robot spawned or removed) starts a new epoch holding the actual
 * immutable RenderModel and its fixed geometry layout. Geom and qpos rows are only meaningful inside
 * their epoch, so playback never blends across a layout boundary. Entity identity is the stable
 * entity id, which survives epochs while raw geom and qpos addresses do not. */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { RenderModel } from '../sim/protocol';
import type { SceneEntity } from '../sim/entities';
import { GEOM_STRIDE, GeometryTrack, matToQuat, nlerp, quatToMat, validGeometryData, validGeometryPartition,
  type GeometryPartition } from '../core/geometry';
import { PLAYER_BUTTON, type PlayerAnimationLayer, type PlayerAnimationPose, type PlayerEntityState,
  type PlayerGrabState, type PlayerInputFrame, type PlayerPresentation, type PlayerSimFrame, type PlayerTool } from '../player/types';
import { sourceToAppPoint } from '../player/source-frame';
import type { LocalGameContent } from '../player/assets/local-content';
import { validLocalMap, type LocalMapIdentity } from '../maps/source';
import type { Appearance } from '../render/scene';
import { validDisplay, type SceneDisplay } from '../render/display';
import { validSourceTime } from '../render/source-clock';
import type { LookState } from '../ui/look';
import { validAppearance } from '../ui/view-appearance';
import { validLook, validShotEdits, validShotLights, type ShotEdits, type ShotLight } from './post';
import type { Shot } from './shot';
import { SPECS } from '../robots';
import { CAM_STRIDE, cameraAt, locateTime, type CamPose, type TakeRange } from './track';

export const PLAYER_TOOLS: readonly PlayerTool[] = ['none', 'physgun', 'spawn', 'knife'];

/** One local game file the recorded scene displayed: canonical Source path, size and SHA-256.
 * Takes never carry the file itself; the user reattaches matching local files after a reload. */
export interface PlayerContentRequirement { path: string; bytes: number; sha256: string }

export interface PlayerTakeMeta {
  mode: 'player';
  terrain: string;
  localMap?: LocalMapIdentity;
  /** Local game content needed to show this take again. */
  content: PlayerContentRequirement[];
  /** Canonical Source paths of the displayed player body and per-tool view models. */
  models?: { body?: string; view?: Partial<Record<PlayerTool, string>> };
  sourceTime?: number;
  appearance?: Appearance;
  look?: LookState;
  display?: SceneDisplay;
  flashlight?: boolean;
  lights?: ShotLight[];
  edits?: ShotEdits;
  created: string;
  /** The worker's Player clock at the first frame; take seconds are measured from it. */
  clockStart?: number;
}

export type PlayerTakeEventKind = 'scene' | 'tool' | 'view' | 'spawn' | 'remove' | 'hit' | 'ragdoll' | 'grab' | 'release';
export interface PlayerTakeEvent { t: number; kind: PlayerTakeEventKind; label: string; entity?: string }

/** Per-frame values with a variable count (pose parameters, animation layers). */
export interface PlayerRagged { counts: Uint32Array; values: Float32Array }

/** Every per-frame column of a Player take, or of a contiguous span of one. */
export interface PlayerTracks {
  t: Float64Array;              // n · 1   seconds from the first frame, one clock for the whole take
  cam: Float32Array;            // n · 7   viewport camera: position, look-at target, vertical fov
  camOrientation: Float32Array; // n · 4   viewport camera quaternion xyzw
  input: Float32Array;          // n · 4   forward, side, yaw, pitch of the last input sent
  inputBits: Uint32Array;       // n · 4   sequence, held buttons, pressed buttons, flags (INPUT_*)
  motion: Float64Array;         // n · 6   player origin xyz, velocity xyz (Source inches)
  state: Float32Array;          // n · 10  yaw, pitch, duck fraction, eye height, grab point xyz, grab target xyz
  stateBits: Int32Array;        // n · 6   ground geom, collider body, flags (STATE_*), tool, grab entity, grab body
  pose: Float32Array;           // n · 11  body yaw, body cycle, view cycle, view position xyz, view orientation (4), view fov
  poseBits: Int32Array;         // n · 3   flags (POSE_*), body sequence, view sequence
  bodyParams: PlayerRagged;     // pose parameters of the displayed body
  bodyLayers: PlayerRagged;     // sequence, cycle, weight per body layer
  viewParams: PlayerRagged;
  viewLayers: PlayerRagged;
  entityIndex: Uint32Array;     // n · 1   row of PlayerTables.entityStates
}
/** Deduplicated values that the per-frame columns index. */
export interface PlayerTables { entityStates: PlayerEntityState[][]; grabEntities: string[] }
export interface PlayerEpoch { start: number; model: RenderModel; geometry: GeometryTrack; qpos: Float32Array }

/** Older takes set INPUT_LEGACY_WHEEL_JUMP for a knife wheel jump; it reads back as a pressed jump. */
const INPUT_LEGACY_WHEEL_JUMP = 1, INPUT_THIRD_PERSON = 2, INPUT_PRESENT = 4, INPUT_RESET = 8;
const STATE_GROUNDED = 1, STATE_DUCKED = 2, STATE_THIRD_PERSON = 4;
const POSE_THIRD_PERSON = 1, POSE_VIEW = 2, POSE_VIEW_POSITION = 4, POSE_VIEW_ORIENTATION = 8, POSE_VIEW_FOV = 16;

type FixedKey = Exclude<keyof PlayerTracks, RaggedKey>;
type RaggedKey = 'bodyParams' | 'bodyLayers' | 'viewParams' | 'viewLayers';
type Typed = Float32Array | Float64Array | Int32Array | Uint32Array;
type TypedConstructor = Float32ArrayConstructor | Float64ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor;
const FIXED: readonly (readonly [FixedKey, number, TypedConstructor])[] = [
  ['t', 1, Float64Array], ['cam', CAM_STRIDE, Float32Array], ['camOrientation', 4, Float32Array],
  ['input', 4, Float32Array], ['inputBits', 4, Uint32Array], ['motion', 6, Float64Array], ['state', 10, Float32Array],
  ['stateBits', 6, Int32Array], ['pose', 11, Float32Array], ['poseBits', 3, Int32Array], ['entityIndex', 1, Uint32Array],
];
const RAGGED: readonly (readonly [RaggedKey, number])[] = [['bodyParams', 1], ['bodyLayers', 3], ['viewParams', 1], ['viewLayers', 3]];

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const finite3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
/** Shortest-arc blend of two angles in degrees. */
const lerpDegrees = (a: number, b: number, f: number) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;

// ---- validation -------------------------------------------------------------

export function validContentRequirements(v: unknown): v is PlayerContentRequirement[] {
  if (!Array.isArray(v)) return false;
  const paths = new Set<string>();
  for (const item of v) {
    if (!object(item) || typeof item.path !== 'string' || !item.path || item.path.length > 1024 || paths.has(item.path)
      || item.path !== item.path.toLowerCase() || item.path.includes('\\') || item.path.startsWith('/') || item.path.split('/').includes('..')
      || !integer(item.bytes) || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) return false;
    paths.add(item.path);
  }
  return true;
}

/** The canonical identity of every local game file this session actually read (paths, sizes, SHA-256),
 * sorted by path. Session ids, selected folder names and file bodies are never part of it. */
export function contentRequirements(content: Pick<LocalGameContent, 'readClosure'>): PlayerContentRequirement[] {
  return content.readClosure().map(read => ({ path: read.path, bytes: read.bytes, sha256: read.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Read every required file from reattached local content and compare its bytes. Throws, naming the
 * files that are missing or different; nothing is downloaded or substituted. */
export async function verifyPlayerContent(meta: PlayerTakeMeta, content: Pick<LocalGameContent, 'read'>, signal?: AbortSignal): Promise<void> {
  const problems: string[] = [];
  for (const need of meta.content) {
    signal?.throwIfAborted();
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = await content.read(need.path, signal); }
    catch (error) { if (signal?.aborted) throw error; problems.push(`${need.path} (missing)`); continue; }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let hex = '';
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
    if (bytes.byteLength !== need.bytes || hex !== need.sha256) problems.push(`${need.path} (different file)`);
  }
  if (problems.length) throw new Error(`This take needs the same local game files it was recorded with. Reattach them: ${problems.join(', ')}.`);
}

export function validSourceFrame(v: unknown): boolean {
  return object(v) && finite3(v.origin) && Number.isFinite(v.yawDeg);
}

/** Composed-scene entity records within a model's own index ranges. */
export function validSceneEntities(v: unknown, model: Pick<RenderModel, 'ngeom' | 'nq' | 'bodyNames'>): v is SceneEntity[] {
  if (!Array.isArray(v)) return false;
  const ids = new Set<string>(), within = (a: unknown, b: unknown, n: number) => integer(a) && integer(b) && a <= b && b <= n;
  for (const e of v) {
    if (!object(e) || typeof e.id !== 'string' || !e.id || ids.has(e.id) || typeof e.robot !== 'string' || !e.robot
      || typeof e.prefix !== 'string' || typeof e.rootBodyName !== 'string' || !object(e.ignoredOptions)
      || !within(e.bodyStart, e.bodyEnd, model.bodyNames.length) || !within(e.geomStart, e.geomEnd, model.ngeom)
      || !within(e.qposStart, e.qposEnd, model.nq) || !within(e.jointStart, e.jointEnd, Number.MAX_SAFE_INTEGER)
      || !within(e.dofStart, e.dofEnd, Number.MAX_SAFE_INTEGER) || !integer(e.freeJoint) || !integer(e.rootDof)
      || !integer(e.rootBody) || e.rootBody < (e.bodyStart as number) || e.rootBody >= (e.bodyEnd as number)
      || !integer(e.rootQpos) || e.rootQpos < (e.qposStart as number) || e.rootQpos + 7 > (e.qposEnd as number)) return false;
    ids.add(e.id);
  }
  return true;
}

export function validPlayerTables(v: unknown): v is PlayerTables {
  if (!object(v) || !Array.isArray(v.entityStates) || !v.entityStates.length || !Array.isArray(v.grabEntities)
    || !v.grabEntities.every(id => typeof id === 'string' && !!id) || new Set(v.grabEntities).size !== v.grabEntities.length) return false;
  return v.entityStates.every(list => Array.isArray(list) && new Set(list.map(e => object(e) ? e.id : null)).size === list.length
    && list.every(e => object(e) && typeof e.id === 'string' && !!e.id && (e.state === 'alive' || e.state === 'ragdoll') && integer(e.hits)));
}

/** Columns of `frames` rows. A span (recovery chunk) may continue an earlier clock. */
export function validPlayerTracks(v: unknown, frames: number, tables: PlayerTables, startsAtZero: boolean): v is PlayerTracks {
  if (!object(v) || !integer(frames)) return false;
  const tracks = v as unknown as PlayerTracks;
  for (const [key, stride, Ctor] of FIXED) {
    const column = tracks[key];
    if (!(column instanceof Ctor) || column.length !== frames * stride) return false;
  }
  for (const [key, stride] of RAGGED) {
    const ragged = tracks[key];
    if (!object(ragged) || !(ragged.counts instanceof Uint32Array) || ragged.counts.length !== frames || !(ragged.values instanceof Float32Array)) return false;
    let total = 0;
    for (const count of ragged.counts) total += count;
    if (ragged.values.length !== total * stride || !ragged.values.every(Number.isFinite)) return false;
  }
  const { t, cam, camOrientation, input, inputBits, motion, state, stateBits, pose, poseBits, entityIndex } = tracks;
  if (startsAtZero && frames && t[0] !== 0) return false;
  for (let i = 0; i < frames; i++) {
    if (!Number.isFinite(t[i]) || i > 0 && t[i] <= t[i - 1]) return false;
    const q = i * 4;
    if (Math.hypot(camOrientation[q], camOrientation[q + 1], camOrientation[q + 2], camOrientation[q + 3]) < 1e-8) return false;
    if (inputBits[q + 3] & ~(INPUT_LEGACY_WHEEL_JUMP | INPUT_THIRD_PERSON | INPUT_PRESENT | INPUT_RESET)) return false;
    const s = i * 10, b = i * 6, grab = stateBits[b + 4];
    for (let k = 0; k < 4; k++) if (!Number.isFinite(state[s + k])) return false;
    if (grab < -1 || grab >= tables.grabEntities.length || stateBits[b + 3] < 0 || stateBits[b + 3] >= PLAYER_TOOLS.length
      || stateBits[b + 2] & ~(STATE_GROUNDED | STATE_DUCKED | STATE_THIRD_PERSON)) return false;
    for (let k = 4; k < 10; k++) if (grab >= 0 ? !Number.isFinite(state[s + k]) : !Number.isNaN(state[s + k])) return false;
    if (grab < 0 && stateBits[b + 5] !== -1) return false;
    const p = i * 11, flags = poseBits[i * 3];
    if (flags & ~31 || !Number.isFinite(pose[p]) || !Number.isFinite(pose[p + 1])) return false;
    const present = [flags & POSE_VIEW, flags & POSE_VIEW, flags & POSE_VIEW, flags & POSE_VIEW_POSITION, flags & POSE_VIEW_POSITION, flags & POSE_VIEW_POSITION,
      flags & POSE_VIEW_ORIENTATION, flags & POSE_VIEW_ORIENTATION, flags & POSE_VIEW_ORIENTATION, flags & POSE_VIEW_ORIENTATION, flags & POSE_VIEW_FOV];
    for (let k = 2; k < 11; k++) if (present[k] ? !Number.isFinite(pose[p + k]) : !Number.isNaN(pose[p + k])) return false;
    if (!(flags & POSE_VIEW) && (poseBits[i * 3 + 2] !== -1 || tracks.viewParams.counts[i] || tracks.viewLayers.counts[i]
      || flags & (POSE_VIEW_POSITION | POSE_VIEW_ORIENTATION | POSE_VIEW_FOV))) return false;
    if (entityIndex[i] >= tables.entityStates.length) return false;
  }
  return cam.every(Number.isFinite) && camOrientation.every(Number.isFinite) && input.every(Number.isFinite) && motion.every(Number.isFinite);
}

/** A recorded Player epoch model: the actual compiled no-robot world plus its entities. */
export function validPlayerModelIdentity(model: RenderModel): boolean {
  return model.mode === 'player' && (model.robot === null || typeof model.robot === 'string' && !!model.robot)
    && validSourceFrame(model.sourceFrame) && (model.entities === undefined || validSceneEntities(model.entities, model));
}

export function validPlayerMeta(v: unknown): v is PlayerTakeMeta {
  return object(v) && v.mode === 'player' && typeof v.terrain === 'string' && !!v.terrain && typeof v.created === 'string'
    && Number.isFinite(Date.parse(v.created)) && validContentRequirements(v.content)
    && (v.models === undefined || object(v.models) && (v.models.body === undefined || typeof v.models.body === 'string')
      && (v.models.view === undefined || object(v.models.view) && Object.entries(v.models.view)
        .every(([tool, path]) => PLAYER_TOOLS.includes(tool as PlayerTool) && typeof path === 'string')))
    && (v.sourceTime === undefined || validSourceTime(v.sourceTime)) && (v.clockStart === undefined || Number.isFinite(v.clockStart))
    && (!(v.terrain.startsWith('map:local-') || v.localMap !== undefined) || validLocalMap(v.localMap, v.terrain))
    && (v.appearance === undefined || validAppearance(v.appearance) && (v.appearance.sourceBody === undefined || v.appearance.sourceBody === 'stock'))
    && (v.display === undefined || validDisplay(v.display)) && (v.flashlight === undefined || typeof v.flashlight === 'boolean')
    && (v.lights === undefined || validShotLights(v.lights)) && (v.look === undefined || validLook(v.look))
    && (v.edits === undefined || validShotEdits(v.edits, null));
}

const EVENT_KINDS = new Set<string>(['scene', 'tool', 'view', 'spawn', 'remove', 'hit', 'ragdoll', 'grab', 'release']);
export function validPlayerEvents(v: unknown, duration: number): v is PlayerTakeEvent[] {
  return Array.isArray(v) && v.every(e => object(e) && Number.isFinite(e.t) && (e.t as number) >= 0 && (e.t as number) <= duration
    && EVENT_KINDS.has(e.kind as string) && typeof e.label === 'string' && (e.entity === undefined || typeof e.entity === 'string'));
}

// ---- the take ----------------------------------------------------------------

/** Borrowed playback state; every field is overwritten by the next poseAt call. */
export interface PlayerPose {
  epoch: number;
  model: RenderModel;
  /** Nearest recorded frame; discrete values come from it. */
  frame: number;
  /** Full original-ID geometry of this epoch's model. */
  xpos: Float32Array;
  xmat: Float32Array;
  qpos: Float64Array;
  player: PlayerSimFrame;
  presentation: PlayerPresentation;
  input: PlayerInputFrame | null;
  entities: readonly PlayerEntityState[];
}

export interface PlayerEntityLifetime { id: string; robot: string; from: number; to: number }

type MutablePose = { sequence: number; cycle: number; poseParameters: Float32Array; layers: PlayerAnimationLayer[] };
type Writable<T> = { -readonly [K in keyof T]: T[K] };
interface EpochBuffers { xpos: Float32Array; xmat: Float32Array; qpos: Float64Array; fixedDone: boolean }

export class PlayerTake {
  readonly mode = 'player' as const;
  shot?: Shot;
  range?: TakeRange;
  private readonly starts: Uint32Array;
  private readonly offsets: Record<RaggedKey, Uint32Array>;
  private readonly buffers: (EpochBuffers | undefined)[];
  private readonly quatTmp = new Float32Array(4);
  private readonly pointTmp = new Float64Array(3);
  private readonly paramBuffers: [Map<number, Float32Array>, Map<number, Float32Array>] = [new Map(), new Map()];
  private readonly out: PlayerPose;
  private readonly bodyPose: MutablePose = { sequence: 0, cycle: 0, poseParameters: new Float32Array(0), layers: [] };
  private readonly viewPose: MutablePose = { sequence: 0, cycle: 0, poseParameters: new Float32Array(0), layers: [] };
  private readonly viewPosition: [number, number, number] = [0, 0, 0];
  private readonly viewOrientation: [number, number, number, number] = [0, 0, 0, 1];
  private readonly grab: { entity: string; body: number; point: Float64Array; target: Float64Array } =
    { entity: '', body: 0, point: new Float64Array(3), target: new Float64Array(3) };
  private readonly inputOut: PlayerInputFrame = { sequence: 0, yaw: 0, pitch: 0, forward: 0, side: 0, held: 0, pressed: 0, reset: false, thirdPerson: false };

  constructor(readonly meta: PlayerTakeMeta, readonly tracks: PlayerTracks, readonly tables: PlayerTables,
              readonly epochs: readonly PlayerEpoch[], readonly events: PlayerTakeEvent[]) {
    const n = tracks.t.length;
    if (n < 2 || !validPlayerMeta(meta) || !validPlayerTables(tables) || !validPlayerTracks(tracks, n, tables, true)
      || !epochs.length || epochs[0].start !== 0 || !validPlayerEvents(events, tracks.t[n - 1])) throw new Error('Invalid Player take.');
    this.starts = new Uint32Array(epochs.length);
    epochs.forEach((epoch, k) => {
      const end = k + 1 < epochs.length ? epochs[k + 1].start : n;
      if (!integer(epoch.start) || epoch.start >= end || k && epoch.start <= epochs[k - 1].start || !validPlayerModelIdentity(epoch.model)
        || epoch.geometry.ngeom !== epoch.model.ngeom || epoch.geometry.frames !== end - epoch.start
        || !(epoch.qpos instanceof Float32Array) || epoch.qpos.length !== (end - epoch.start) * epoch.model.nq) throw new Error('Invalid Player take epoch.');
      this.starts[k] = epoch.start;
    });
    this.buffers = epochs.map(() => undefined);
    const offsets = {} as Record<RaggedKey, Uint32Array>;
    for (const [key] of RAGGED) {
      const counts = tracks[key].counts, starts = new Uint32Array(n + 1);
      for (let i = 0; i < n; i++) starts[i + 1] = starts[i] + counts[i];
      offsets[key] = starts;
    }
    this.offsets = offsets;
    const presentation: PlayerPresentation = { thirdPerson: false, bodyYaw: 0, body: this.bodyPose };
    this.out = { epoch: 0, model: epochs[0].model, frame: 0, xpos: new Float32Array(0), xmat: new Float32Array(0), qpos: new Float64Array(0),
      player: { origin: new Float64Array(3), velocity: new Float64Array(3), yaw: 0, pitch: 0, grounded: false, groundGeom: -1, ducked: false,
        duckFraction: 0, eyeHeight: 0, colliderBody: -1, thirdPerson: false, tool: 'none', grab: null, entities: tables.entityStates[0] },
      presentation, input: null, entities: tables.entityStates[0] };
  }

  get t(): Float64Array { return this.tracks.t; }
  get cam(): Float32Array { return this.tracks.cam; }
  get camOrientation(): Float32Array { return this.tracks.camOrientation; }
  get n(): number { return this.tracks.t.length; }
  get duration(): number { return this.tracks.t[this.n - 1]; }
  /** Mean frame interval. */
  get dt(): number { return this.duration / (this.n - 1); }

  /** Bracketing frame and blend on the global clock (cameras and timelines). */
  locate(time: number): [number, number] { return locateTime(this.tracks.t, time); }
  frameAt(time: number): number {
    const [i, f] = this.locate(time);
    return f >= 0.5 ? Math.min(i + 1, this.n - 1) : i;
  }
  epochOf(frame: number): number {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= frame) lo = mid; else hi = mid - 1; }
    return lo;
  }
  /** Bracket inside one epoch: the last frame before a layout boundary holds, never blends. */
  private locateScene(time: number): [number, number, number] {
    const [i, f] = this.locate(time), epoch = this.epochOf(i);
    if (f > 0 && this.epochOf(i + 1) !== epoch) return [i, 0, epoch];
    return [i, f, epoch];
  }
  epochAt(time: number): number { return this.locateScene(time)[2]; }

  camAt(time: number): CamPose { return cameraAt(this.tracks.t, this.tracks.cam, this.tracks.camOrientation, time); }

  /** Player origin (feet) in app metres at frame i, for shot cameras and lighting. */
  baseAtFrame(i: number, out: Float64Array, o = 0): void {
    const frame = this.epochs[this.epochOf(i)].model.sourceFrame!, m = this.tracks.motion;
    const p = this.pointTmp;
    p[0] = m[i * 6]; p[1] = m[i * 6 + 1]; p[2] = m[i * 6 + 2];
    sourceToAppPoint(frame, p, p);
    out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2];
  }
  basePosAt(time: number): [number, number, number] {
    const [i, f] = this.locate(time), j = Math.min(i + 1, this.n - 1), a = new Float64Array(6);
    this.baseAtFrame(i, a, 0); this.baseAtFrame(j, a, 3);
    return [a[0] + (a[3] - a[0]) * f, a[1] + (a[4] - a[1]) * f, a[2] + (a[5] - a[2]) * f];
  }

  private epochBuffers(epoch: number): EpochBuffers {
    const model = this.epochs[epoch].model;
    return this.buffers[epoch] ??= { xpos: new Float32Array(model.ngeom * 3), xmat: new Float32Array(model.ngeom * 9),
      qpos: new Float64Array(model.nq), fixedDone: false };
  }

  /** Interpolated qpos inside one epoch; base and entity root quaternions are nlerped. */
  qposAt(time: number): { epoch: number; model: RenderModel; qpos: Float64Array } {
    const [i, f, epoch] = this.locateScene(time);
    const qpos = this.fillQpos(i, f, epoch);
    return { epoch, model: this.epochs[epoch].model, qpos };
  }
  private fillQpos(i: number, f: number, epoch: number): Float64Array {
    const { model, qpos: Q, start } = this.epochs[epoch], out = this.epochBuffers(epoch).qpos, nq = model.nq;
    const local = i - start, next = f > 0 ? local + 1 : local, a = local * nq, b = next * nq;
    for (let k = 0; k < nq; k++) out[k] = Q[a + k] + (Q[b + k] - Q[a + k]) * f;
    if (model.baseQadr >= 0) nlerp(Q, a + model.baseQadr + 3, b + model.baseQadr + 3, f, out, model.baseQadr + 3);
    for (const entity of model.entities ?? []) if (entity.rootQpos !== model.baseQadr)
      nlerp(Q, a + entity.rootQpos + 3, b + entity.rootQpos + 3, f, out, entity.rootQpos + 3);
    return out;
  }

  /** The complete recorded state at `time`. The result and its arrays are reused by the next call. */
  poseAt(time: number): PlayerPose {
    const [i, f, epoch] = this.locateScene(time), j = f > 0 ? i + 1 : i, near = f >= 0.5 ? j : i;
    const { model, geometry, start } = this.epochs[epoch], buffers = this.epochBuffers(epoch), G = geometry.values, q = this.quatTmp;
    if (!buffers.fixedDone) {
      for (let row = 0; row < geometry.fixedIds.length; row++) {
        const g = geometry.fixedIds[row], a = row * GEOM_STRIDE;
        for (let k = 0; k < 3; k++) buffers.xpos[g * 3 + k] = G[a + k];
        nlerp(G, a + 3, a + 3, 0, q, 0);
        quatToMat(q[0], q[1], q[2], q[3], buffers.xmat, g * 9);
      }
      buffers.fixedDone = true;
    }
    const count = geometry.movingCount, fixed = geometry.fixedIds.length, li = i - start, lj = j - start;
    for (let row = 0; row < count; row++) {
      const g = geometry.movingGeom(row), a = (fixed + li * count + row) * GEOM_STRIDE, b = (fixed + lj * count + row) * GEOM_STRIDE;
      for (let k = 0; k < 3; k++) buffers.xpos[g * 3 + k] = G[a + k] + (G[b + k] - G[a + k]) * f;
      nlerp(G, a + 3, b + 3, f, q, 0);
      quatToMat(q[0], q[1], q[2], q[3], buffers.xmat, g * 9);
    }
    const out = this.out;
    out.epoch = epoch; out.model = model; out.frame = near;
    out.xpos = buffers.xpos; out.xmat = buffers.xmat; out.qpos = this.fillQpos(i, f, epoch);
    this.fillPlayer(i, j, f, near);
    this.fillPresentation(i, j, f, near);
    this.fillInput(near);
    out.entities = out.player.entities;
    return out;
  }

  private fillPlayer(i: number, j: number, f: number, near: number): void {
    const { motion: M, state: S, stateBits: B, entityIndex } = this.tracks, p = this.out.player as Writable<PlayerSimFrame>;
    for (let k = 0; k < 3; k++) {
      p.origin[k] = M[i * 6 + k] + (M[j * 6 + k] - M[i * 6 + k]) * f;
      p.velocity[k] = M[i * 6 + 3 + k] + (M[j * 6 + 3 + k] - M[i * 6 + 3 + k]) * f;
    }
    p.yaw = lerpDegrees(S[i * 10], S[j * 10], f);
    p.pitch = S[i * 10 + 1] + (S[j * 10 + 1] - S[i * 10 + 1]) * f;
    p.duckFraction = S[i * 10 + 2] + (S[j * 10 + 2] - S[i * 10 + 2]) * f;
    p.eyeHeight = S[i * 10 + 3] + (S[j * 10 + 3] - S[i * 10 + 3]) * f;
    const b = near * 6, flags = B[b + 2];
    p.groundGeom = B[b]; p.colliderBody = B[b + 1];
    p.grounded = !!(flags & STATE_GROUNDED); p.ducked = !!(flags & STATE_DUCKED); p.thirdPerson = !!(flags & STATE_THIRD_PERSON);
    p.tool = PLAYER_TOOLS[B[b + 3]];
    const grab = B[b + 4];
    if (grab < 0) p.grab = null;
    else {
      const g = this.grab, blend = B[i * 6 + 4] === grab && B[j * 6 + 4] === grab ? f : 0, from = blend ? i : near, to = blend ? j : near;
      g.entity = this.tables.grabEntities[grab]; g.body = B[b + 5];
      for (let k = 0; k < 3; k++) {
        g.point[k] = S[from * 10 + 4 + k] + (S[to * 10 + 4 + k] - S[from * 10 + 4 + k]) * blend;
        g.target[k] = S[from * 10 + 7 + k] + (S[to * 10 + 7 + k] - S[from * 10 + 7 + k]) * blend;
      }
      p.grab = g as PlayerGrabState;
    }
    p.entities = this.tables.entityStates[entityIndex[near]];
  }

  private fillAnimation(target: MutablePose, view: 0 | 1, i: number, j: number, f: number, near: number): void {
    const { pose: P, poseBits: B } = this.tracks, params = this.tracks[view ? 'viewParams' : 'bodyParams'], layers = this.tracks[view ? 'viewLayers' : 'bodyLayers'];
    const paramStarts = this.offsets[view ? 'viewParams' : 'bodyParams'], layerStarts = this.offsets[view ? 'viewLayers' : 'bodyLayers'];
    const sequence = B[near * 3 + 1 + view], same = B[i * 3 + 1 + view] === B[j * 3 + 1 + view];
    const ci = P[i * 11 + 1 + view], cj = P[j * 11 + 1 + view];
    target.sequence = sequence;
    // Cycles blend only inside one sequence and away from its wrap; anything else is the nearest frame.
    target.cycle = same && Math.abs(cj - ci) < 0.5 ? ci + (cj - ci) * f : P[near * 11 + 1 + view];
    const count = params.counts[near], blend = same && params.counts[i] === count && params.counts[j] === count ? f : 0;
    const cache = this.paramBuffers[view];
    let out = cache.get(count);
    if (!out) { out = new Float32Array(count); cache.set(count, out); }
    const a = paramStarts[blend ? i : near], b = paramStarts[blend ? j : near];
    for (let k = 0; k < count; k++) out[k] = params.values[a + k] + (params.values[b + k] - params.values[a + k]) * blend;
    target.poseParameters = out;
    const layerCount = layers.counts[near], base = layerStarts[near] * 3, list = target.layers;
    while (list.length < layerCount) list.push({ sequence: 0, cycle: 0, weight: 0 });
    list.length = layerCount;
    for (let k = 0; k < layerCount; k++) {
      list[k].sequence = layers.values[base + k * 3]; list[k].cycle = layers.values[base + k * 3 + 1]; list[k].weight = layers.values[base + k * 3 + 2];
    }
  }

  private fillPresentation(i: number, j: number, f: number, near: number): void {
    const { pose: P, poseBits: B } = this.tracks, out = this.out.presentation as Writable<PlayerPresentation>;
    const flags = B[near * 3];
    out.thirdPerson = !!(flags & POSE_THIRD_PERSON);
    out.bodyYaw = lerpDegrees(P[i * 11], P[j * 11], f);
    this.fillAnimation(this.bodyPose, 0, i, j, f, near);
    if (!(flags & POSE_VIEW)) {
      delete out.viewModel; delete out.viewModelPosition; delete out.viewModelOrientation; delete out.viewModelFov;
      return;
    }
    this.fillAnimation(this.viewPose, 1, i, j, f, near);
    out.viewModel = this.viewPose as PlayerAnimationPose;
    const both = (bit: number) => (B[i * 3] & bit) && (B[j * 3] & bit) ? f : 0;
    if (flags & POSE_VIEW_POSITION) {
      const w = both(POSE_VIEW_POSITION), a = (w ? i : near) * 11, b = (w ? j : near) * 11;
      for (let k = 0; k < 3; k++) this.viewPosition[k] = P[a + 3 + k] + (P[b + 3 + k] - P[a + 3 + k]) * w;
      out.viewModelPosition = this.viewPosition;
    } else delete out.viewModelPosition;
    if (flags & POSE_VIEW_ORIENTATION) {
      const w = both(POSE_VIEW_ORIENTATION), a = (w ? i : near) * 11 + 6, b = (w ? j : near) * 11 + 6;
      const sign = P[a] * P[b] + P[a + 1] * P[b + 1] + P[a + 2] * P[b + 2] + P[a + 3] * P[b + 3] < 0 ? -1 : 1;
      let norm = 0;
      for (let k = 0; k < 4; k++) { this.viewOrientation[k] = P[a + k] + (sign * P[b + k] - P[a + k]) * w; norm += this.viewOrientation[k] ** 2; }
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < 4; k++) this.viewOrientation[k] /= norm;
      out.viewModelOrientation = this.viewOrientation;
    } else delete out.viewModelOrientation;
    if (flags & POSE_VIEW_FOV) {
      const w = both(POSE_VIEW_FOV), a = (w ? i : near) * 11 + 10, b = (w ? j : near) * 11 + 10;
      out.viewModelFov = P[a] + (P[b] - P[a]) * w;
    } else delete out.viewModelFov;
  }

  private fillInput(near: number): void {
    const { input: I, inputBits: B } = this.tracks, flags = B[near * 4 + 3];
    if (!(flags & INPUT_PRESENT)) { this.out.input = null; return; }
    const out = this.inputOut;
    out.forward = I[near * 4]; out.side = I[near * 4 + 1]; out.yaw = I[near * 4 + 2]; out.pitch = I[near * 4 + 3];
    out.sequence = B[near * 4]; out.held = B[near * 4 + 1];
    out.pressed = B[near * 4 + 2] | (flags & INPUT_LEGACY_WHEEL_JUMP ? PLAYER_BUTTON.jump : 0);
    out.reset = !!(flags & INPUT_RESET); out.thirdPerson = !!(flags & INPUT_THIRD_PERSON);
    this.out.input = out;
  }

  /** Spans of frames over which each entity is compiled into the scene, by stable id. */
  entityLifetimes(): PlayerEntityLifetime[] {
    const out: PlayerEntityLifetime[] = [], open = new Map<string, PlayerEntityLifetime>();
    this.epochs.forEach((epoch, k) => {
      const end = (k + 1 < this.epochs.length ? this.epochs[k + 1].start : this.n) - 1, present = new Set<string>();
      for (const entity of epoch.model.entities ?? []) {
        present.add(entity.id);
        const span = open.get(entity.id);
        if (span && span.robot === entity.robot && span.to === epoch.start - 1) span.to = end;
        else { const next = { id: entity.id, robot: entity.robot, from: epoch.start, to: end }; out.push(next); open.set(entity.id, next); }
      }
      for (const id of [...open.keys()]) if (!present.has(id)) open.delete(id);
    });
    return out;
  }
}

// ---- recording ----------------------------------------------------------------

class Column<T extends Typed> {
  buf: T;
  len = 0;
  constructor(private readonly make: (n: number) => T, cap: number) { this.buf = make(cap); }
  reserve(k: number): number {
    if (this.len + k > this.buf.length) {
      const next = this.make(Math.max(this.buf.length * 2, this.len + k));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    const at = this.len;
    this.len += k;
    return at;
  }
  slice(from: number, to = this.len): T { return this.buf.slice(from, to) as T; }
  /** Reserve first: a grown buffer replaces `buf`, so the index must exist before the write target is read. */
  append(value: number): void {
    const at = this.reserve(1);
    (this.buf as Typed)[at] = value;
  }
}
const f32 = (n: number) => new Float32Array(n), f64 = (n: number) => new Float64Array(n);
const i32 = (n: number) => new Int32Array(n), u32 = (n: number) => new Uint32Array(n);

export interface PlayerRecFrame { clock: number; xpos: Float32Array; xmat: Float32Array; qpos: Float64Array; player?: PlayerSimFrame }

interface RecEpoch { start: number; model: RenderModel; layout: GeometryPartition; movingIds: Uint32Array; geomBase: number; qposBase: number }

/** Independently owned new rows since `from`; epochs and models are shared immutable references. */
export interface PlayerRecordingSnapshot {
  from: number;
  meta: PlayerTakeMeta;
  events: PlayerTakeEvent[];
  tables: PlayerTables;
  epochs: readonly { start: number; model: RenderModel; layout: GeometryPartition }[];
  tracks: PlayerTracks;
  /** Moving geometry rows (7 per geom) and qpos of the snapshot frames, concatenated in frame order;
   * each frame's row count is that of its epoch. */
  geom: Float32Array;
  qpos: Float32Array;
}

const finiteAll = (v: ArrayLike<number>, n = v.length) => { for (let k = 0; k < n; k++) if (!Number.isFinite(v[k])) return false; return v.length >= n; };
function finiteAnimation(a: PlayerAnimationPose): boolean {
  return Number.isSafeInteger(a.sequence) && Number.isFinite(a.cycle) && a.poseParameters instanceof Float32Array && finiteAll(a.poseParameters)
    && a.layers.every(l => Number.isFinite(l.sequence) && Number.isFinite(l.cycle) && Number.isFinite(l.weight));
}
/** Checked before any column is written, so a bad frame never corrupts the recorded take. */
function finiteFrame(p: PlayerSimFrame, v: PlayerPresentation, cam: CamPose): boolean {
  if (!finiteAll(p.origin, 3) || !finiteAll(p.velocity, 3) || !Number.isFinite(p.yaw) || !Number.isFinite(p.pitch)
    || !Number.isFinite(p.duckFraction) || !Number.isFinite(p.eyeHeight)) return false;
  for (let k = 0; k < p.entities.length; k++) {
    const e = p.entities[k];
    if (typeof e.id !== 'string' || !e.id || e.state !== 'alive' && e.state !== 'ragdoll' || !integer(e.hits)) return false;
    for (let m = 0; m < k; m++) if (p.entities[m].id === e.id) return false;
  }
  return Number.isSafeInteger(p.groundGeom) && Number.isSafeInteger(p.colliderBody)
    && (!p.grab || typeof p.grab.entity === 'string' && !!p.grab.entity && Number.isSafeInteger(p.grab.body) && finiteAll(p.grab.point, 3) && finiteAll(p.grab.target, 3))
    && Number.isFinite(v.bodyYaw) && finiteAnimation(v.body) && (!v.viewModel || finiteAnimation(v.viewModel)
      && (!v.viewModelPosition || finiteAll(v.viewModelPosition, 3)) && (!v.viewModelOrientation || finiteAll(v.viewModelOrientation, 4))
      && (v.viewModelFov === undefined || Number.isFinite(v.viewModelFov)))
    && finiteAll(cam.pos, 3) && finiteAll(cam.target, 3) && Number.isFinite(cam.fov) && (!cam.orientation || finiteAll(cam.orientation, 4)
      && cam.orientation[0] ** 2 + cam.orientation[1] ** 2 + cam.orientation[2] ** 2 + cam.orientation[3] ** 2 >= 1e-16);
}

function movingIdsOf(layout: GeometryPartition, ngeom: number): Uint32Array {
  const ids = new Uint32Array(ngeom - layout.fixedIds.length);
  let fixed = 0, moving = 0;
  for (let g = 0; g < ngeom; g++) {
    if (fixed < layout.fixedIds.length && layout.fixedIds[fixed] === g) fixed++;
    else ids[moving++] = g;
  }
  return ids;
}

/** Accumulates one Player take across scene rebuilds. `changeScene` starts an epoch; the take never stops for it. */
export class PlayerTakeRecorder {
  private readonly epochs: RecEpoch[] = [];
  private readonly fixed: { [K in FixedKey]: Column<PlayerTracks[K]> } = {
    t: new Column(f64, 4096), cam: new Column(f32, 4096 * 7), camOrientation: new Column(f32, 4096 * 4),
    input: new Column(f32, 4096 * 4), inputBits: new Column(u32, 4096 * 4), motion: new Column(f64, 4096 * 6),
    state: new Column(f32, 4096 * 10), stateBits: new Column(i32, 4096 * 6), pose: new Column(f32, 4096 * 11),
    poseBits: new Column(i32, 4096 * 3), entityIndex: new Column(u32, 4096),
  };
  private readonly ragged: Record<RaggedKey, { counts: Column<Uint32Array>; starts: Column<Uint32Array>; values: Column<Float32Array> }> = {
    bodyParams: { counts: new Column(u32, 4096), starts: new Column(u32, 4096), values: new Column(f32, 4096 * 8) },
    bodyLayers: { counts: new Column(u32, 4096), starts: new Column(u32, 4096), values: new Column(f32, 4096 * 6) },
    viewParams: { counts: new Column(u32, 4096), starts: new Column(u32, 4096), values: new Column(f32, 4096 * 4) },
    viewLayers: { counts: new Column(u32, 4096), starts: new Column(u32, 4096), values: new Column(f32, 4096 * 6) },
  };
  private readonly geom = new Column(f32, 1 << 16);
  private readonly qpos = new Column(f32, 1 << 14);
  private readonly events: PlayerTakeEvent[] = [];
  private readonly tables: PlayerTables = { entityStates: [], grabEntities: [] };
  private lastClock = NaN;
  private sceneChanged = false;
  /** Robot spec of every entity seen in any epoch, so removal events still name what left. */
  private readonly specs = new Map<string, string>();
  private previous: { tool: PlayerTool; thirdPerson: boolean; grab: number; entities: number } | null = null;

  readonly meta: PlayerTakeMeta;
  constructor(meta: PlayerTakeMeta, model: RenderModel, layout: GeometryPartition) {
    if (!validPlayerMeta(meta) || meta.clockStart !== undefined) throw new Error('Invalid Player take metadata.');
    this.meta = structuredClone(meta);
    this.addEpoch(model, layout);
  }

  /** Start a new layout epoch with the newly compiled model; later frames must belong to it. */
  changeScene(model: RenderModel, layout: GeometryPartition): void {
    const last = this.epochs[this.epochs.length - 1];
    if (last.start === this.frames) this.epochs.pop();   // replaced before any frame arrived
    this.addEpoch(model, layout);
    if (this.frames) this.sceneChanged = true;
  }

  private addEpoch(model: RenderModel, layout: GeometryPartition): void {
    if (!validPlayerModelIdentity(model) || !validGeometryPartition(layout, model.ngeom)) throw new Error('Invalid Player scene for recording.');
    const copy = { fixedIds: layout.fixedIds.slice(), fixed: layout.fixed.slice() };
    this.epochs.push({ start: this.frames, model, layout: copy, movingIds: movingIdsOf(copy, model.ngeom), geomBase: this.geom.len, qposBase: this.qpos.len });
    for (const entity of model.entities ?? []) this.specs.set(entity.id, entity.robot);
  }

  get frames(): number { return this.fixed.t.len; }
  /** Seconds recorded so far. */
  get elapsed(): number { return this.frames ? this.fixed.t.buf[this.frames - 1] : 0; }
  /** Rough memory held, bytes. */
  get bytes(): number {
    let total = 4 * (this.geom.len + this.qpos.len);
    for (const [key] of FIXED) total += this.fixed[key].len * this.fixed[key].buf.BYTES_PER_ELEMENT;
    for (const [key] of RAGGED) total += 4 * (this.ragged[key].values.len + 2 * this.ragged[key].counts.len);
    for (const epoch of this.epochs) total += epoch.layout.fixed.byteLength + epoch.layout.fixedIds.byteLength;
    return total;
  }

  /** Log a user input at the current end of the take. */
  mark(kind: PlayerTakeEventKind, label: string, entity?: string): void {
    this.events.push({ t: this.elapsed, kind, label, ...(entity === undefined ? {} : { entity }) });
  }

  /** Record one worker frame with the input last sent, the viewport camera and what was displayed.
   * Geometry may be the worker's moving rows or dense original-ID arrays. Take time is the worker's
   * single Player clock minus its first recorded value. A frame that does not fit the current epoch,
   * carries no player state or does not advance the clock throws: it is never reshaped or retimed. */
  push(frame: PlayerRecFrame, input: PlayerInputFrame | null, cam: CamPose, presentation: PlayerPresentation): void {
    const epoch = this.epochs[this.epochs.length - 1], { model, movingIds } = epoch, p = frame.player;
    const dense = frame.xpos.length === model.ngeom * 3 && frame.xmat.length === model.ngeom * 9;
    if (!p) throw new Error('Player recording frame has no player state.');
    if (frame.qpos.length !== model.nq || !dense && (frame.xpos.length !== movingIds.length * 3 || frame.xmat.length !== movingIds.length * 9))
      throw new Error(`Player recording frame does not match scene epoch ${this.epochs.length} (${model.ngeom} geoms, ${model.nq} qpos).`);
    if (!Number.isFinite(frame.clock) || frame.clock <= this.lastClock)
      throw new Error(`Player recording clock did not advance (${frame.clock} after ${this.lastClock}).`);
    const tool = PLAYER_TOOLS.indexOf(p.tool);
    if (tool < 0 || !finiteFrame(p, presentation, cam)) throw new Error('Player recording frame has invalid player, presentation or camera values.');
    if (Number.isNaN(this.lastClock)) this.meta.clockStart = frame.clock;
    this.lastClock = frame.clock;
    const t = frame.clock - this.meta.clockStart!;
    const c = this.fixed;
    c.t.append(t);
    let o = c.cam.reserve(7);
    c.cam.buf.set(cam.pos, o); c.cam.buf.set(cam.target, o + 3); c.cam.buf[o + 6] = cam.fov;
    o = c.camOrientation.reserve(4);
    if (cam.orientation) c.camOrientation.buf.set(cam.orientation, o);
    else {
      const look = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3(...cam.pos), new Vector3(...cam.target), new Vector3(0, 0, 1)));
      c.camOrientation.buf[o] = look.x; c.camOrientation.buf[o + 1] = look.y; c.camOrientation.buf[o + 2] = look.z; c.camOrientation.buf[o + 3] = look.w;
    }
    o = c.input.reserve(4);
    const bits = c.inputBits.reserve(4), I = c.input.buf, IB = c.inputBits.buf;
    if (input) {
      I[o] = input.forward; I[o + 1] = input.side; I[o + 2] = input.yaw; I[o + 3] = input.pitch;
      IB[bits] = input.sequence; IB[bits + 1] = input.held; IB[bits + 2] = input.pressed;
      IB[bits + 3] = INPUT_PRESENT | (input.reset ? INPUT_RESET : 0) | (input.thirdPerson ? INPUT_THIRD_PERSON : 0);
    } else { I.fill(0, o, o + 4); IB.fill(0, bits, bits + 4); }
    o = c.motion.reserve(6);
    const M = c.motion.buf;
    for (let k = 0; k < 3; k++) { M[o + k] = p.origin[k]; M[o + 3 + k] = p.velocity[k]; }
    o = c.state.reserve(10);
    const S = c.state.buf, grab = p.grab ? this.grabIndex(p.grab.entity) : -1;
    S[o] = p.yaw; S[o + 1] = p.pitch; S[o + 2] = p.duckFraction; S[o + 3] = p.eyeHeight;
    if (p.grab) for (let k = 0; k < 3; k++) { S[o + 4 + k] = p.grab.point[k]; S[o + 7 + k] = p.grab.target[k]; }
    else S.fill(NaN, o + 4, o + 10);
    o = c.stateBits.reserve(6);
    const SB = c.stateBits.buf;
    SB[o] = p.groundGeom; SB[o + 1] = p.colliderBody;
    SB[o + 2] = (p.grounded ? STATE_GROUNDED : 0) | (p.ducked ? STATE_DUCKED : 0) | (p.thirdPerson ? STATE_THIRD_PERSON : 0);
    SB[o + 3] = tool; SB[o + 4] = grab; SB[o + 5] = p.grab ? p.grab.body : -1;
    this.pushPresentation(presentation);
    const entities = this.entityIndex(p.entities);
    c.entityIndex.append(entities);
    o = this.geom.reserve(movingIds.length * GEOM_STRIDE);
    const G = this.geom.buf;
    for (let row = 0; row < movingIds.length; row++) {
      const src = dense ? movingIds[row] : row, k = o + row * GEOM_STRIDE;
      G[k] = frame.xpos[3 * src]; G[k + 1] = frame.xpos[3 * src + 1]; G[k + 2] = frame.xpos[3 * src + 2];
      matToQuat(frame.xmat, 9 * src, G, k + 3);
    }
    o = this.qpos.reserve(model.nq);
    this.qpos.buf.set(frame.qpos, o);
    this.derive(t, p, tool, grab, entities, model);
  }

  private pushPresentation(v: PlayerPresentation): void {
    const c = this.fixed, o = c.pose.reserve(11), P = c.pose.buf, b = c.poseBits.reserve(3), B = c.poseBits.buf, vm = v.viewModel;
    P.fill(NaN, o, o + 11);
    P[o] = v.bodyYaw; P[o + 1] = v.body.cycle;
    let flags = (v.thirdPerson ? POSE_THIRD_PERSON : 0) | (vm ? POSE_VIEW : 0);
    if (vm) {
      P[o + 2] = vm.cycle;
      if (v.viewModelPosition) { flags |= POSE_VIEW_POSITION; P.set(v.viewModelPosition, o + 3); }
      if (v.viewModelOrientation) { flags |= POSE_VIEW_ORIENTATION; P.set(v.viewModelOrientation, o + 6); }
      if (v.viewModelFov !== undefined) { flags |= POSE_VIEW_FOV; P[o + 10] = v.viewModelFov; }
    }
    B[b] = flags; B[b + 1] = v.body.sequence; B[b + 2] = vm ? vm.sequence : -1;
    this.pushRagged('bodyParams', v.body.poseParameters, null);
    this.pushRagged('bodyLayers', null, v.body.layers);
    this.pushRagged('viewParams', vm?.poseParameters ?? null, null);
    this.pushRagged('viewLayers', null, vm?.layers ?? null);
  }

  private pushRagged(key: RaggedKey, params: Float32Array | null, layers: readonly PlayerAnimationLayer[] | null): void {
    const r = this.ragged[key], count = params ? params.length : layers ? layers.length : 0;
    r.counts.append(count);
    r.starts.append(r.values.len);
    if (params) { const at = r.values.reserve(count); r.values.buf.set(params, at); }
    else if (layers) {
      const o = r.values.reserve(count * 3), V = r.values.buf;
      for (let k = 0; k < count; k++) { V[o + k * 3] = layers[k].sequence; V[o + k * 3 + 1] = layers[k].cycle; V[o + k * 3 + 2] = layers[k].weight; }
    }
  }

  private grabIndex(entity: string): number {
    const index = this.tables.grabEntities.indexOf(entity);
    return index >= 0 ? index : this.tables.grabEntities.push(entity) - 1;
  }

  /** Entity state lists change rarely: consecutive identical lists share one table row. */
  private entityIndex(next: readonly PlayerEntityState[]): number {
    const table = this.tables.entityStates, last = table.length - 1, list = table[last];
    if (list && list.length === next.length && list.every((e, k) => e.id === next[k].id && e.state === next[k].state && e.hits === next[k].hits)) return last;
    table.push(next.map(e => ({ id: e.id, state: e.state, hits: e.hits })));
    return last + 1;
  }

  private entityLabel(id: string): string {
    const spec = this.specs.get(id);
    return spec ? `${spec} · ${id}` : id;
  }

  private derive(t: number, p: PlayerSimFrame, tool: number, grab: number, entities: number, model: RenderModel): void {
    const previous = this.previous;
    if (this.sceneChanged) {
      this.sceneChanged = false;
      const robots = model.entities?.length ?? 0;
      this.events.push({ t, kind: 'scene', label: `Scene rebuilt · ${robots} ${robots === 1 ? 'robot' : 'robots'}` });
    }
    if (previous) {
      if (previous.tool !== p.tool) this.events.push({ t, kind: 'tool', label: TOOL_LABEL[PLAYER_TOOLS[tool]] });
      if (previous.thirdPerson !== p.thirdPerson) this.events.push({ t, kind: 'view', label: p.thirdPerson ? 'Third person' : 'First person' });
      if (previous.grab !== grab) {
        if (previous.grab >= 0) { const id = this.tables.grabEntities[previous.grab]; this.events.push({ t, kind: 'release', label: this.entityLabel(id), entity: id }); }
        if (grab >= 0) { const id = this.tables.grabEntities[grab]; this.events.push({ t, kind: 'grab', label: this.entityLabel(id), entity: id }); }
      }
      if (previous.entities !== entities) {
        const before = new Map(this.tables.entityStates[previous.entities].map(e => [e.id, e]));
        for (const e of p.entities) {
          const old = before.get(e.id);
          if (!old) { this.events.push({ t, kind: 'spawn', label: this.entityLabel(e.id), entity: e.id }); continue; }
          before.delete(e.id);
          if (old.state !== e.state) this.events.push({ t, kind: 'ragdoll', label: `${this.entityLabel(e.id)} · ${e.state === 'ragdoll' ? 'Ragdoll' : 'Recovered'}`, entity: e.id });
          if (e.hits > old.hits) this.events.push({ t, kind: 'hit', label: `${this.entityLabel(e.id)} · ${e.hits} ${e.hits === 1 ? 'hit' : 'hits'}`, entity: e.id });
        }
        for (const id of before.keys()) this.events.push({ t, kind: 'remove', label: this.entityLabel(id), entity: id });
      }
    }
    this.previous = { tool: p.tool, thirdPerson: p.thirdPerson, grab, entities };
  }

  private epochFor(frame: number): RecEpoch {
    let k = this.epochs.length - 1;
    while (k > 0 && this.epochs[k].start > frame) k--;
    return this.epochs[k];
  }
  private geomOffset(frame: number): number {
    if (frame >= this.frames) return this.geom.len;
    const epoch = this.epochFor(frame);
    return epoch.geomBase + (frame - epoch.start) * epoch.movingIds.length * GEOM_STRIDE;
  }
  private qposOffset(frame: number): number {
    if (frame >= this.frames) return this.qpos.len;
    const epoch = this.epochFor(frame);
    return epoch.qposBase + (frame - epoch.start) * epoch.model.nq;
  }

  private tracksFrom(from: number): PlayerTracks {
    const tracks = {} as Record<string, unknown>;
    for (const [key, stride] of FIXED) tracks[key] = this.fixed[key].slice(from * stride, this.frames * stride);
    for (const [key] of RAGGED) {
      const r = this.ragged[key], start = from < this.frames ? r.starts.buf[from] : r.values.len;
      tracks[key] = { counts: r.counts.slice(from), values: r.values.slice(start) } satisfies PlayerRagged;
    }
    return tracks as unknown as PlayerTracks;
  }

  /** Copy only the uncommitted span, never a growing prefix or the compiled models. */
  snapshot(from: number): PlayerRecordingSnapshot {
    if (!Number.isSafeInteger(from) || from < 0 || from > this.frames) throw new RangeError('Invalid recording snapshot frame.');
    const { meta, events, tables } = structuredClone({ meta: this.meta, events: this.events, tables: this.tables });
    return { from, meta, events, tables, epochs: this.epochs.filter(e => e.start < this.frames || e.start === 0).map(({ start, model, layout }) => ({ start, model, layout })),
      tracks: this.tracksFrom(from), geom: this.geom.slice(this.geomOffset(from)), qpos: this.qpos.slice(this.qposOffset(from)) };
  }

  /** The take, or null when fewer than two frames arrived. */
  stop(): PlayerTake | null {
    if (this.frames < 2) return null;
    const epochs = this.epochs.filter(e => e.start < this.frames).map((e, k, all) => {
      const end = k + 1 < all.length ? all[k + 1].start : this.frames, frames = end - e.start, moving = e.movingIds.length * GEOM_STRIDE;
      const values = new Float32Array(e.layout.fixed.length + frames * moving);
      values.set(e.layout.fixed); values.set(this.geom.buf.subarray(e.geomBase, e.geomBase + frames * moving), e.layout.fixed.length);
      return { start: e.start, model: e.model, geometry: new GeometryTrack(e.model.ngeom, frames, { fixedIds: e.layout.fixedIds, values }),
        qpos: this.qpos.slice(e.qposBase, e.qposBase + frames * e.model.nq) } satisfies PlayerEpoch;
    });
    const { meta, events, tables } = structuredClone({ meta: this.meta, events: this.events, tables: this.tables });
    return new PlayerTake(meta, this.tracksFrom(0), tables, epochs, events);
  }
}

export const TOOL_LABEL: Record<PlayerTool, string> = { none: 'No tool', physgun: 'Physgun', spawn: 'Spawn tool', knife: 'Knife' };

// ---- assembling stored takes ---------------------------------------------------------

export interface PlayerEpochRecord { start: number; model: RenderModel; layout: GeometryPartition }

/** Allocate every final column once, then fill it from consecutive spans (recovery chunks). */
export class PlayerTakeAssembler {
  private readonly tracks: PlayerTracks;
  private readonly epochData: { geom: Float32Array; qpos: Float32Array; moving: number }[];
  private frame = 0;
  private readonly raggedAt: Record<RaggedKey, number> = { bodyParams: 0, bodyLayers: 0, viewParams: 0, viewLayers: 0 };

  constructor(private readonly frames: number, private readonly epochs: readonly PlayerEpochRecord[], raggedTotals: Record<RaggedKey, number>) {
    const tracks = {} as Record<string, unknown>;
    for (const [key, stride, Ctor] of FIXED) tracks[key] = new Ctor(frames * stride);
    for (const [key, stride] of RAGGED) tracks[key] = { counts: new Uint32Array(frames), values: new Float32Array(raggedTotals[key] * stride) };
    this.tracks = tracks as unknown as PlayerTracks;
    this.epochData = epochs.map((e, k) => {
      const end = k + 1 < epochs.length ? epochs[k + 1].start : frames, moving = (e.model.ngeom - e.layout.fixedIds.length) * GEOM_STRIDE;
      const geom = new Float32Array(e.layout.fixed.length + (end - e.start) * moving);
      geom.set(e.layout.fixed);
      return { geom, qpos: new Float32Array((end - e.start) * e.model.nq), moving };
    });
  }

  /** Bytes of moving geometry and qpos a span of `count` frames starting at `from` must carry. */
  spanSizes(from: number, count: number): { geom: number; qpos: number } {
    let geom = 0, qpos = 0;
    for (let frame = from; frame < from + count; frame++) {
      const k = this.epochIndex(frame);
      geom += this.epochData[k].moving; qpos += this.epochs[k].model.nq;
    }
    return { geom, qpos };
  }
  private epochIndex(frame: number): number {
    let k = this.epochs.length - 1;
    while (k > 0 && this.epochs[k].start > frame) k--;
    return k;
  }

  add(span: PlayerTracks, geom: Float32Array, qpos: Float32Array): void {
    const count = span.t.length, from = this.frame;
    if (from + count > this.frames) throw new Error('Recorded Player span exceeds the take.');
    for (const [key, stride] of FIXED) (this.tracks[key] as Typed).set(span[key] as Typed, from * stride);
    for (const [key, stride] of RAGGED) {
      this.tracks[key].counts.set(span[key].counts, from);
      this.tracks[key].values.set(span[key].values, this.raggedAt[key] * stride);
      for (const c of span[key].counts) this.raggedAt[key] += c;
    }
    let g = 0, q = 0;
    for (let frame = from; frame < from + count; frame++) {
      const k = this.epochIndex(frame), data = this.epochData[k], local = frame - this.epochs[k].start, nq = this.epochs[k].model.nq;
      data.geom.set(geom.subarray(g, g + data.moving), this.epochs[k].layout.fixed.length + local * data.moving);
      data.qpos.set(qpos.subarray(q, q + nq), local * nq);
      g += data.moving; q += nq;
    }
    if (g !== geom.length || q !== qpos.length) throw new Error('Recorded Player span geometry does not match its epochs.');
    this.frame += count;
  }

  finish(meta: PlayerTakeMeta, tables: PlayerTables, events: PlayerTakeEvent[]): PlayerTake {
    if (this.frame !== this.frames) throw new Error('Recorded Player take is incomplete.');
    const epochs = this.epochs.map((e, k) => {
      const frames = (k + 1 < this.epochs.length ? this.epochs[k + 1].start : this.frames) - e.start, data = { fixedIds: e.layout.fixedIds, values: this.epochData[k].geom };
      if (!validGeometryData(data, e.model.ngeom, frames)) throw new Error('Recorded Player epoch geometry is invalid.');
      return { start: e.start, model: e.model, geometry: new GeometryTrack(e.model.ngeom, frames, data), qpos: this.epochData[k].qpos };
    });
    return new PlayerTake(meta, this.tracks, tables, epochs, events);
  }
}

/** Ragged value totals of a span, for sizing an assembler. */
export function raggedTotals(span: PlayerTracks): Record<RaggedKey, number> {
  const out = { bodyParams: 0, bodyLayers: 0, viewParams: 0, viewLayers: 0 };
  for (const [key] of RAGGED) for (const c of span[key].counts) out[key] += c;
  return out;
}

// ---- motion CSV ------------------------------------------------------------------

const csvNumber = (x: number) => (Math.abs(x) < 5e-7 ? '0' : x.toFixed(6));
const sampleCount = (t0: number, t1: number, fps: number) => Math.max(1, Math.floor((t1 - t0) * fps + 1e-6) + 1);

/** The player's own motion, with a header row. Positions and speeds are Source inches; angles are degrees.
 * This is not a robot reference clip. */
export function playerMotionCsv(take: PlayerTake, fps: number, t0 = 0, t1 = take.duration): string {
  const rows = ['time_s,origin_x_in,origin_y_in,origin_z_in,velocity_x_in_s,velocity_y_in_s,velocity_z_in_s,yaw_deg,pitch_deg,' +
    'duck_fraction,eye_height_in,grounded,ducked,third_person,tool,body_sequence,body_cycle,body_yaw_deg'];
  const N = sampleCount(t0, t1, fps);
  for (let i = 0; i < N; i++) {
    const time = Math.min(t1, t0 + i / fps), { player: p, presentation: v } = take.poseAt(time);
    rows.push([time - t0, ...p.origin, ...p.velocity, p.yaw, p.pitch, p.duckFraction, p.eyeHeight].map(csvNumber).join(',')
      + `,${+p.grounded},${+p.ducked},${+p.thirdPerson},${p.tool},${v.body.sequence},${csvNumber(v.body.cycle)},${csvNumber(v.bodyYaw)}`);
  }
  return rows.join('\n') + '\n';
}

/** Joint order for one spawned robot: its spec's joints when the entity carries them all, else its hinges. */
export function entityJointNames(model: RenderModel, entity: SceneEntity): string[] {
  const own = model.hinges.filter(h => h.qadr >= entity.qposStart && h.qadr < entity.qposEnd)
    .map(h => h.name.startsWith(entity.prefix) ? h.name.slice(entity.prefix.length) : h.name);
  const spec = SPECS[entity.robot], have = new Set(own);
  return spec && spec.joint_names.every(n => have.has(n)) ? spec.joint_names : own;
}

/** One spawned robot's motion in the Reference clip layout (headerless: base position, base quaternion
 * x y z w, joint angles). Only the span where that entity exists is sampled, and only a continuous one. */
export function entityMotionCsv(take: PlayerTake, entityId: string, fps: number, t0 = 0, t1 = take.duration): { csv: string; robot: string; joints: string[]; from: number; to: number } {
  const spans = take.entityLifetimes().filter(s => s.id === entityId && take.t[s.to] >= t0 && take.t[s.from] <= t1);
  if (spans.length !== 1) throw new Error(spans.length ? `Robot ${entityId} left and re-entered the scene inside the range. Export a range where it stays.` : `Robot ${entityId} is not in this range.`);
  const span = spans[0], from = Math.max(t0, take.t[span.from]), to = Math.min(t1, take.t[span.to]);
  let joints: string[] | null = null;
  const rows: string[] = [], N = sampleCount(from, to, fps);
  for (let i = 0; i < N; i++) {
    const { model, qpos: q } = take.qposAt(Math.min(to, from + i / fps)), entity = model.entities?.find(e => e.id === entityId);
    if (!entity) throw new Error(`Robot ${entityId} is missing from a recorded scene.`);
    const names = entityJointNames(model, entity);
    if (!joints) joints = names;
    else if (names.length !== joints.length || names.some((n, k) => n !== joints![k])) throw new Error(`Robot ${entityId} changed joints during the range.`);
    const adr = names.map(n => model.hinges.find(h => h.name === entity.prefix + n && h.qadr >= entity.qposStart && h.qadr < entity.qposEnd)!.qadr);
    const b = entity.rootQpos;
    rows.push([q[b], q[b + 1], q[b + 2], q[b + 4], q[b + 5], q[b + 6], q[b + 3], ...adr.map(a => q[a])].map(csvNumber).join(','));
  }
  return { csv: rows.join('\n') + '\n', robot: span.robot, joints: joints ?? [], from, to };
}
