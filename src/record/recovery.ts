/** Incremental, exclusively owned recording prefixes. Completed takes use ShotLibrary's atomic promotion. */
import { Take, type RecordedTake, type TakeRecorder, type TakeMeta, type RecordingSnapshot } from './take';
import { PlayerTakeAssembler, raggedTotals, validPlayerEvents, validPlayerMeta, validPlayerTables, validPlayerTracks,
  type PlayerRecordingSnapshot, type PlayerTakeRecorder, type PlayerTracks } from './player-take';
import { ShotLibrary, type SavedShot } from './library';
import type { RenderModel } from '../sim/protocol';
import { GEOM_STRIDE, GeometryTrack, validGeometryPartition, type GeometryPartition } from '../core/geometry';
import { packModel } from './model-pack';
import { connect, transact, invalid, object, integer, date, validMeta, sameIdentity, validModel, validTrackSpan,
  validPlaybackSpan, validEvents, sceneFor, rememberScene, chunkRange, collectScene, storageErrorMessage, readInfo, readRobotModel,
  putPlayerScenes, readPlayerScenes, SCENE_STORES,
  type AnyRecordingDraft, type PlayerRecordingDraft, type RecordingDraft, type RecordingRecoveryInfo, type SceneRecord,
  type TrackData, type TrackSpanData } from './storage';

export type { RecordingRecoveryInfo } from './storage';
export interface RecordingCheckpointStatus { saving: boolean; frames: number; duration: number; error?: string }
type Tracks = Omit<TrackData, 'id' | 'camOrientation'> & { camOrientation: Float32Array };
interface RecordingChunk extends TrackSpanData { recordingId: string; from: number; camOrientation: Float32Array }
interface PlayerChunk { recordingId: string; from: number; tracks: PlayerTracks; geom: Float32Array; qpos: Float32Array }
interface Committed { frames: number; duration: number; bytes: number }
type Ragged = PlayerRecordingDraft['ragged'];
const lockName = (id: string) => `m0clip-recording:${id}`;

// Fixed geometry belongs to the draft once; only moving rows grow with the seven-track frame spans.
function bytesFor(meta: TakeMeta, frames: number, geometry: GeometryPartition): number {
  return geometry.fixedIds.byteLength + geometry.fixed.byteLength
    + frames * (8 + 4 * ((meta.ngeom - geometry.fixedIds.length) * 7 + meta.nq + 3 + 7 + 3 + 4));
}
function validInfoBase(info: RecordingRecoveryInfo, id: string, created: string, terrain: string): boolean {
  return object(info) && info.id === id && typeof info.name === 'string' && date(info.created) && date(info.updated)
    && info.created === created && info.terrain === terrain && integer(info.frames) && info.frames >= 2
    && Number.isFinite(info.duration) && info.duration > 0 && integer(info.bytes) && info.thumbnail === null;
}
function validRobotDraft(draft: RecordingDraft): boolean {
  if (!object(draft) || typeof draft.id !== 'string' || !draft.id || typeof draft.sceneId !== 'string' || !draft.sceneId
    || !object(draft.info) || !validMeta(draft.meta) || !validGeometryPartition(draft.geometry, draft.meta.ngeom)
    || !draft.geometry.fixed.every(Number.isFinite)) return false;
  const info = readInfo(draft.info);
  return validInfoBase(info, draft.id, draft.meta.created, draft.meta.terrain) && info.mode === 'robot' && info.robot === draft.meta.robot
    && info.bytes === bytesFor(draft.meta, info.frames, draft.geometry) && validEvents(draft.events, info.duration);
}
function validPlayerDraft(draft: PlayerRecordingDraft): boolean {
  if (!object(draft) || typeof draft.id !== 'string' || !draft.id || !object(draft.info) || !validPlayerMeta(draft.meta)
    || !validPlayerTables(draft.tables) || !Array.isArray(draft.epochs) || !draft.epochs.length || !Array.isArray(draft.sceneIds)
    || !object(draft.ragged) || !Object.values(draft.ragged).every(integer)) return false;
  const info = draft.info;
  return validInfoBase(info, draft.id, draft.meta.created, draft.meta.terrain) && info.mode === 'player' && info.robot === null
    && validPlayerEvents(draft.events, info.duration)
    && draft.epochs.every((e, k) => object(e) && integer(e.start) && e.start < info.frames && (k ? e.start > draft.epochs[k - 1].start : e.start === 0)
      && typeof e.sceneId === 'string' && draft.sceneIds.includes(e.sceneId) && validGeometryPartition(e.layout, Number.MAX_SAFE_INTEGER)
      && e.layout.fixed.every(Number.isFinite))
    && draft.sceneIds.every(id => draft.epochs.some(e => e.sceneId === id));
}
function validDraft(draft: AnyRecordingDraft): boolean {
  return object(draft) && (draft.mode === 'player' ? validPlayerDraft(draft) : validRobotDraft(draft));
}
function recoveryLocks(): LockManager {
  if (!navigator.locks) throw new Error('Recording recovery needs browser Web Locks. Keep this tab open and save the take or its ZIP.');
  return navigator.locks;
}
async function exclusively<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (typeof id !== 'string' || !id) throw invalid();
  return recoveryLocks().request(lockName(id), { mode: 'exclusive', ifAvailable: true }, lock => {
    if (!lock) throw new Error('This recording is still active in another tab. Stop it or close that tab before opening, saving, or deleting its recovery.');
    return work();
  });
}

async function append(id: string, name: string, snapshot: RecordingSnapshot, previous: Committed,
  scene: { id: string; terrain: string }, model: RenderModel | undefined): Promise<Committed> {
  const { from, meta, events, geometry, ...tracks } = snapshot;
  const count = tracks.t.length, frames = from + count;
  const duration = count ? tracks.t[count - 1] : previous.duration;
  if (!integer(from) || from !== previous.frames || frames < 2 || !validMeta(meta)
    || from === 0 && (!validGeometryPartition(geometry, meta.ngeom) || !geometry.fixed.every(Number.isFinite))
    || from !== 0 && geometry !== undefined
    || scene.terrain !== meta.terrain || !validEvents(events, duration)) throw invalid();
  let committed: Committed;
  const db = await connect();
  try {
    await transact<void>(db, ['drafts', 'chunks', 'scenes'], 'readwrite', (tx, request, result) => {
      const drafts = tx.objectStore('drafts');
      request(drafts.get(id), (stored: AnyRecordingDraft | undefined) => {
        let layout: GeometryPartition;
        if (from === 0) {
          if (stored || !model || !geometry || !validModel(model, meta)) throw invalid();
          layout = geometry;
          const scenes = tx.objectStore('scenes');
          request(scenes.getKey(scene.id), key => {
            if (key === undefined) scenes.add({ id: scene.id, terrain: scene.terrain, model } satisfies SceneRecord);
          });
        } else {
          if (!stored || stored.mode === 'player' || !validRobotDraft(stored) || stored.id !== id || stored.sceneId !== scene.id
            || !sameIdentity(stored.meta, meta) || stored.meta.created !== meta.created
            || stored.info.frames !== from || stored.info.duration !== previous.duration || stored.info.bytes !== previous.bytes) throw invalid();
          layout = stored.geometry;
        }
        if (!(tracks.camOrientation instanceof Float32Array)
          || !validTrackSpan(tracks, meta, count, count * (meta.ngeom - layout.fixedIds.length) * 7, from === 0 ? 2 : 0)
          || !validPlaybackSpan(tracks, from === 0) || count > 0 && from > 0 && tracks.t[0] <= previous.duration
          || !Number.isSafeInteger(bytesFor(meta, frames, layout))) throw invalid();
        committed = { frames, duration, bytes: bytesFor(meta, frames, layout) };
        const info: RecordingRecoveryInfo = { id, name, created: meta.created, updated: new Date().toISOString(), mode: 'robot', robot: meta.robot,
          terrain: meta.terrain, ...committed, thumbnail: null };
        const draft: RecordingDraft = { id, mode: 'robot', info, meta, events, sceneId: scene.id, geometry: layout };
        if (from === 0) drafts.add(draft); else drafts.put(draft);
        // add, not put: a duplicate span aborts without replacing any committed prefix.
        if (count) tx.objectStore('chunks').add({ recordingId: id, from, ...tracks } satisfies RecordingChunk);
        result();
      });
    });
    return committed!;
  } finally { db.close(); }
}

interface PlayerCommitted extends Committed { epochs: number; ragged: Ragged }
const spanBytes = (tracks: PlayerTracks, geom: Float32Array, qpos: Float32Array) => {
  let bytes = geom.byteLength + qpos.byteLength;
  for (const value of Object.values(tracks)) bytes += ArrayBuffer.isView(value) ? value.byteLength : value.counts.byteLength + value.values.byteLength;
  return bytes;
};

async function appendPlayer(id: string, name: string, snapshot: PlayerRecordingSnapshot, previous: PlayerCommitted): Promise<PlayerCommitted> {
  const { from, meta, events, tables, epochs, tracks, geom, qpos } = snapshot;
  const count = tracks.t.length, frames = from + count, duration = count ? tracks.t[count - 1] : previous.duration;
  if (!integer(from) || from !== previous.frames || frames < 2 || !validPlayerMeta(meta) || !validPlayerTables(tables)
    || !validPlayerTracks(tracks, count, tables, from === 0) || count > 0 && from > 0 && tracks.t[0] <= previous.duration
    || !validPlayerEvents(events, duration) || epochs.length < previous.epochs || !epochs.length || epochs[0].start !== 0
    || !epochs.every((e, k) => e.start < frames && (!k || e.start > epochs[k - 1].start))) throw invalid();
  // Each frame carries its own epoch's moving rows and qpos.
  let geomLength = 0, qposLength = 0;
  for (let frame = from, k = 0; frame < frames; frame++) {
    while (k + 1 < epochs.length && epochs[k + 1].start <= frame) k++;
    geomLength += (epochs[k].model.ngeom - epochs[k].layout.fixedIds.length) * GEOM_STRIDE; qposLength += epochs[k].model.nq;
  }
  if (geom.length !== geomLength || qpos.length !== qposLength || !geom.every(Number.isFinite) || !qpos.every(Number.isFinite)) throw invalid();
  const added = epochs.slice(previous.epochs).map(e => ({ ...e, scene: sceneFor(e.model, meta.terrain) }));
  const packed = await Promise.all(added.map(e => packModel(e.model)));
  const span = raggedTotals(tracks), ragged: Ragged = { ...previous.ragged };
  for (const key of Object.keys(ragged) as (keyof Ragged)[]) ragged[key] += span[key];
  let bytes = previous.bytes + spanBytes(tracks, geom, qpos);
  for (const e of added) bytes += e.layout.fixed.byteLength + e.layout.fixedIds.byteLength;
  const committed: PlayerCommitted = { frames, duration, bytes, epochs: epochs.length, ragged };
  const db = await connect();
  try {
    await transact<void>(db, ['chunks', ...SCENE_STORES], 'readwrite', (tx, request, result) => {
      const drafts = tx.objectStore('drafts');
      request(drafts.get(id), (stored: AnyRecordingDraft | undefined) => {
        if (from === 0 ? stored !== undefined : !stored || stored.mode !== 'player' || !validPlayerDraft(stored)
          || stored.meta.created !== meta.created || stored.meta.terrain !== meta.terrain || stored.info.frames !== from
          || stored.info.duration !== previous.duration || stored.info.bytes !== previous.bytes || stored.epochs.length !== previous.epochs) throw invalid();
        const before = stored?.mode === 'player' ? stored.epochs : [];
        const all = [...before, ...added.map(e => ({ start: e.start, sceneId: e.scene.id, layout: e.layout }))];
        putPlayerScenes(tx, request, added.map((e, k) => ({ id: e.scene.id, terrain: meta.terrain, packed: packed[k] })));
        const info: RecordingRecoveryInfo = { id, name, created: meta.created, updated: new Date().toISOString(), mode: 'player', robot: null,
          terrain: meta.terrain, frames, duration, bytes, thumbnail: null };
        const draft: PlayerRecordingDraft = { id, mode: 'player', info, meta, events, tables, epochs: all,
          sceneIds: [...new Set(all.map(e => e.sceneId))], ragged };
        if (from === 0) drafts.add(draft); else drafts.put(draft);
        if (count) tx.objectStore('chunks').add({ recordingId: id, from, tracks, geom, qpos } satisfies PlayerChunk);
        result();
      });
    });
    return committed;
  } finally { db.close(); }
}

/** One recording kind's incremental writes. */
interface CheckpointSource {
  readonly frames: number;
  /** Write frames from `committed.frames`; resolves to the new committed state. */
  write(id: string, name: string): Promise<Committed>;
  /** Drop references to the recorder and models once writing stops. */
  close(): void;
}

class RobotSource implements CheckpointSource {
  private identity: TakeMeta;
  private scene: { id: string; terrain: string };
  private committed: Committed = { frames: 0, duration: 0, bytes: 0 };
  constructor(private recorder: TakeRecorder | undefined, private model: RenderModel | undefined) {
    this.identity = structuredClone(recorder!.meta);
    if (!validMeta(this.identity) || !validModel(model!, this.identity)) throw invalid();
    this.scene = sceneFor(model!, this.identity.terrain);
  }
  get frames(): number { return this.recorder?.frames ?? 0; }
  async write(id: string, name: string): Promise<Committed> {
    const snapshot = this.recorder!.snapshot(this.committed.frames);
    if (!sameIdentity(snapshot.meta, this.identity) || snapshot.meta.created !== this.identity.created) throw invalid();
    this.committed = await append(id, name, snapshot, this.committed, this.scene, this.model);
    this.model = undefined;
    return this.committed;
  }
  close(): void { this.recorder = undefined; this.model = undefined; }
}

class PlayerSource implements CheckpointSource {
  private readonly created: string;
  private committed: PlayerCommitted = { frames: 0, duration: 0, bytes: 0, epochs: 0, ragged: { bodyParams: 0, bodyLayers: 0, viewParams: 0, viewLayers: 0 } };
  constructor(private recorder: PlayerTakeRecorder | undefined) {
    if (!validPlayerMeta(recorder!.meta)) throw invalid();
    this.created = recorder!.meta.created;
  }
  get frames(): number { return this.recorder?.frames ?? 0; }
  async write(id: string, name: string): Promise<Committed> {
    const snapshot = this.recorder!.snapshot(this.committed.frames);
    if (snapshot.meta.created !== this.created) throw invalid();
    this.committed = await appendPlayer(id, name, snapshot, this.committed);
    return this.committed;
  }
  close(): void { this.recorder = undefined; }
}

export class RecordingCheckpointWriter {
  readonly id = crypto.randomUUID();
  private source: CheckpointSource | undefined;
  private committed: Committed = { frames: 0, duration: 0, bytes: 0 };
  private failure: string | undefined;
  private owned = false;
  private closed = false;
  private released = false;
  private forced = false;
  private inflight: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly acquired = Promise.withResolvers<void>();
  private readonly relinquish = Promise.withResolvers<void>();

  constructor(source: () => CheckpointSource, private readonly name: string,
    private readonly onStatus: (status: RecordingCheckpointStatus) => void) {
    try {
      if (typeof name !== 'string') throw invalid();
      this.source = source();
      // Never delay frame capture for IndexedDB or lock acquisition. The returned request is always handled.
      void recoveryLocks().request(lockName(this.id), { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) throw new Error('Another tab owns this recording. Save the take or its ZIP from this tab.');
        this.owned = true;
        this.acquired.resolve();
        this.pump();
        return this.relinquish.promise;
      }).catch(error => { this.fail(error); this.acquired.resolve(); });
    } catch (error) { this.fail(error); this.acquired.resolve(); }
  }

  get error(): string | undefined { return this.failure; }
  /** Constant-time call after each worker frame. Busy writers never copy a new snapshot. */
  changed(): void { this.pump(); }
  /** Best-effort lifecycle flush; no async browser API can guarantee a pagehide commit. */
  checkpoint(): void {
    if (this.closed || this.failure) return;
    this.forced = true;
    this.pump();
  }
  /** Close synchronously, then wait for acquisition and the already-started write. No final snapshot. */
  stop(): Promise<void> {
    this.closed = true; this.forced = false;
    return this.stopping ??= this.acquired.promise.then(async () => {
      await this.inflight;
      this.source?.close(); this.source = undefined;
    });
  }
  /** May be called repeatedly, including after failed acquisition or before stop has settled. */
  release(): void {
    if (this.released) return;
    this.released = true;
    void this.stop().then(() => { this.owned = false; this.relinquish.resolve(); });
  }
  private report(): void {
    const { frames, duration } = this.committed;
    // A status consumer must not stop capture or turn a committed write into a storage failure.
    try { this.onStatus({ saving: !!this.inflight, frames, duration, ...(this.failure ? { error: this.failure } : {}) }); }
    catch (error) { reportError(error); }
  }
  private fail(error: unknown): void {
    if (!this.failure) {
      this.failure = `Recording recovery stopped: ${storageErrorMessage(error)} Keep this tab open and save the take or its ZIP.`;
    }
    this.report();
  }
  private pump(): void {
    const source = this.source;
    if (this.closed || this.failure || !this.owned || this.inflight || !source || source.frames < 2) return;
    if (!this.forced && source.frames - this.committed.frames < (this.committed.frames ? 128 : 2)) return;
    this.forced = false;
    this.inflight = source.write(this.id, this.name)
      .then(committed => { this.committed = committed; })
      .catch(error => { this.fail(error); })
      .finally(() => { this.inflight = undefined; this.report(); this.pump(); });
    this.report();
  }
}

export class RecordingRecovery {
  constructor(private readonly library = new ShotLibrary()) {}

  record(recorder: TakeRecorder, model: RenderModel, name: string,
    onStatus: (status: RecordingCheckpointStatus) => void): RecordingCheckpointWriter {
    return new RecordingCheckpointWriter(() => new RobotSource(recorder, model), name, onStatus);
  }
  /** Player recordings checkpoint every epoch's model as it first appears; the recording never stops for a rebuild. */
  recordPlayer(recorder: PlayerTakeRecorder, name: string,
    onStatus: (status: RecordingCheckpointStatus) => void): RecordingCheckpointWriter {
    return new RecordingCheckpointWriter(() => new PlayerSource(recorder), name, onStatus);
  }
  async list(): Promise<RecordingRecoveryInfo[]> {
    const db = await connect();
    try {
      return await transact<RecordingRecoveryInfo[]>(db, ['drafts'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('drafts').getAll(), (drafts: AnyRecordingDraft[]) => {
          if (!drafts.every(validDraft)) throw invalid();
          result(drafts.map(draft => draft.info).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)));
        });
      });
    } finally { db.close(); }
  }
  read(id: string): Promise<{ info: RecordingRecoveryInfo; take: RecordedTake; model: RenderModel }> {
    return exclusively(id, () => this.readUnlocked(id));
  }
  recover(id: string): Promise<SavedShot> {
    return exclusively(id, async () => {
      const restored = await this.readUnlocked(id);
      const info = await this.library.save({ id, name: restored.info.name, take: restored.take, model: restored.model, thumbnail: null });
      return { ...restored, info };
    });
  }
  remove(id: string): Promise<void> {
    return exclusively(id, async () => {
      const db = await connect();
      try {
        await transact<void>(db, ['chunks', ...SCENE_STORES], 'readwrite', (tx, request, result) => {
          const drafts = tx.objectStore('drafts');
          request(drafts.get(id), (draft: AnyRecordingDraft | undefined) => {
            if (!draft) { result(); return; }
            if (!validDraft(draft) || draft.id !== id) throw invalid();
            drafts.delete(id); tx.objectStore('chunks').delete(chunkRange(id));
            for (const sceneId of draft.mode === 'player' ? draft.sceneIds : [draft.sceneId]) collectScene(tx, request, sceneId);
            result();
          });
        });
      } finally { db.close(); }
    });
  }
  private async readUnlocked(id: string): Promise<{ info: RecordingRecoveryInfo; take: RecordedTake; model: RenderModel }> {
    const db = await connect();
    let restored: { kind: 'robot'; draft: RecordingDraft; tracks: Tracks; scene: SceneRecord } | { kind: 'player'; draft: PlayerRecordingDraft; take: RecordedTake; models: RenderModel[] };
    try {
      restored = await transact(db, ['drafts', 'chunks', 'scenes', 'meshes'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('drafts').get(id), (draft: AnyRecordingDraft | undefined) => {
          if (!draft) throw new Error('This recording recovery no longer exists. Open Shots to refresh the list.');
          if (!validDraft(draft) || draft.id !== id) throw invalid();
          if (draft.mode === 'player') {
            readPlayerScenes(tx, request, draft.epochs.map(e => e.sceneId), draft.meta.terrain, scenes => {
              const models = scenes.map(scene => scene.model);
              const assembler = new PlayerTakeAssembler(draft.info.frames,
                draft.epochs.map((e, k) => ({ start: e.start, model: models[k], layout: e.layout })), draft.ragged);
              let from = 0, last = -Infinity;
              request(tx.objectStore('chunks').openCursor(chunkRange(id)), cursor => {
                if (!cursor) {
                  if (from !== draft.info.frames || last !== draft.info.duration) throw invalid();
                  let take: RecordedTake;
                  try { take = assembler.finish(draft.meta, draft.tables, draft.events); } catch { throw invalid(); }
                  result({ kind: 'player', draft, take, models });
                  return;
                }
                const chunk: PlayerChunk = cursor.value, count = chunk?.tracks?.t?.length;
                if (!object(chunk) || chunk.recordingId !== id || chunk.from !== from || !integer(count) || count < 1 || from + count > draft.info.frames
                  || !validPlayerTracks(chunk.tracks, count, draft.tables, from === 0) || chunk.tracks.t[0] <= last
                  || !(chunk.geom instanceof Float32Array) || !(chunk.qpos instanceof Float32Array)) throw invalid();
                const sizes = assembler.spanSizes(from, count);
                if (sizes.geom !== chunk.geom.length || sizes.qpos !== chunk.qpos.length) throw invalid();
                assembler.add(chunk.tracks, chunk.geom, chunk.qpos);
                from += count; last = chunk.tracks.t[count - 1];
                cursor.continue();
              });
            });
            return;
          }
          const n = draft.info.frames, meta = draft.meta;
          // Allocate each final track exactly once, not a materialized archive plus concatenation.
          const fixed = draft.geometry.fixed, movingStride = (meta.ngeom - draft.geometry.fixedIds.length) * 7;
          const values = new Float32Array(fixed.length + n * movingStride);
          values.set(fixed);
          const tracks: Tracks = { t: new Float64Array(n), geom: { fixedIds: draft.geometry.fixedIds, values }, qpos: new Float32Array(n * meta.nq),
            cmd: new Float32Array(n * 3), cam: new Float32Array(n * 7), hoist: new Float32Array(n * 3), camOrientation: new Float32Array(n * 4) };
          let scene: SceneRecord, from = 0;
          request(tx.objectStore('scenes').get(draft.sceneId), (stored: SceneRecord) => {
            if (stored) readRobotModel(stored.model);
            if (!stored || stored.id !== draft.sceneId || stored.terrain !== meta.terrain || !validModel(stored.model, meta)) throw invalid();
            scene = stored;
          });
          request(tx.objectStore('chunks').openCursor(chunkRange(id)), cursor => {
            if (!cursor) {
              if (from !== n || tracks.t[n - 1] !== draft.info.duration || !scene) throw invalid();
              result({ kind: 'robot', draft, tracks, scene }); return;
            }
            const chunk: RecordingChunk = cursor.value, count = chunk?.t?.length;
            if (!object(chunk) || chunk.recordingId !== id || chunk.from !== from || !integer(count) || count < 1 || from + count > n
              || !(chunk.camOrientation instanceof Float32Array) || !validTrackSpan(chunk, meta, count, count * movingStride, 1) || !validPlaybackSpan(chunk, from === 0)
              || from > 0 && chunk.t[0] <= tracks.t[from - 1]) throw invalid();
            tracks.t.set(chunk.t, from);
            tracks.geom.values.set(chunk.geom, fixed.length + from * movingStride); tracks.qpos.set(chunk.qpos, from * meta.nq);
            tracks.cmd.set(chunk.cmd, from * 3); tracks.cam.set(chunk.cam, from * 7); tracks.hoist.set(chunk.hoist, from * 3);
            tracks.camOrientation.set(chunk.camOrientation, from * 4);
            from += count;
            cursor.continue();
          });
        });
      });
    } finally { db.close(); }
    if (restored.kind === 'player') {
      const { draft, take, models } = restored;
      draft.epochs.forEach((e, k) => rememberScene({ id: e.sceneId, terrain: draft.meta.terrain, model: models[k] }));
      return { info: draft.info, take, model: models[0] };
    }
    const { draft, tracks, scene } = restored;
    rememberScene(scene);
    const take = new Take(draft.meta, tracks.t, new GeometryTrack(draft.meta.ngeom, draft.info.frames, tracks.geom), tracks.qpos, tracks.cmd, tracks.cam, tracks.hoist, draft.events, tracks.camOrientation);
    return { info: draft.info, take, model: scene.model };
  }
}
