/** Incremental, exclusively owned recording prefixes. Completed takes use ShotLibrary's atomic promotion. */
import { Take, type TakeRecorder, type TakeMeta, type RecordingSnapshot } from './take';
import { ShotLibrary, type SavedShot } from './library';
import type { RenderModel } from '../sim/protocol';
import { GeometryTrack, validGeometryPartition, type GeometryPartition } from '../core/geometry';
import { connect, transact, invalid, object, integer, date, validMeta, sameIdentity, validModel, validTrackSpan,
  validPlaybackSpan, validEvents, sceneFor, rememberScene, chunkRange, collectScene, storageErrorMessage,
  type RecordingDraft, type RecordingRecoveryInfo, type SceneRecord, type TrackData, type TrackSpanData } from './storage';

export type { RecordingRecoveryInfo } from './storage';
export interface RecordingCheckpointStatus { saving: boolean; frames: number; duration: number; error?: string }
type Tracks = Omit<TrackData, 'id' | 'camOrientation'> & { camOrientation: Float32Array };
interface RecordingChunk extends TrackSpanData { recordingId: string; from: number; camOrientation: Float32Array }
interface Committed { frames: number; duration: number; bytes: number }
const lockName = (id: string) => `m0clip-recording:${id}`;

// Fixed geometry belongs to the draft once; only moving rows grow with the seven-track frame spans.
function bytesFor(meta: TakeMeta, frames: number, geometry: GeometryPartition): number {
  return geometry.fixedIds.byteLength + geometry.fixed.byteLength
    + frames * (8 + 4 * ((meta.ngeom - geometry.fixedIds.length) * 7 + meta.nq + 3 + 7 + 3 + 4));
}
function validDraft(draft: RecordingDraft): boolean {
  if (!object(draft) || typeof draft.id !== 'string' || !draft.id || typeof draft.sceneId !== 'string' || !draft.sceneId
    || !object(draft.info) || !validMeta(draft.meta) || !validGeometryPartition(draft.geometry, draft.meta.ngeom)
    || !draft.geometry.fixed.every(Number.isFinite)) return false;
  const info = draft.info;
  return info.id === draft.id && typeof info.name === 'string' && date(info.created) && date(info.updated)
    && info.created === draft.meta.created && info.robot === draft.meta.robot && info.terrain === draft.meta.terrain
    && integer(info.frames) && info.frames >= 2 && Number.isFinite(info.duration) && info.duration > 0
    && integer(info.bytes) && info.bytes === bytesFor(draft.meta, info.frames, draft.geometry) && info.thumbnail === null
    && validEvents(draft.events, info.duration);
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
      request(drafts.get(id), (stored: RecordingDraft | undefined) => {
        let layout: GeometryPartition;
        if (from === 0) {
          if (stored || !model || !geometry || !validModel(model, meta)) throw invalid();
          layout = geometry;
          const scenes = tx.objectStore('scenes');
          request(scenes.getKey(scene.id), key => {
            if (key === undefined) scenes.add({ id: scene.id, terrain: scene.terrain, model } satisfies SceneRecord);
          });
        } else {
          if (!stored || !validDraft(stored) || stored.id !== id || stored.sceneId !== scene.id
            || !sameIdentity(stored.meta, meta) || stored.meta.created !== meta.created
            || stored.info.frames !== from || stored.info.duration !== previous.duration || stored.info.bytes !== previous.bytes) throw invalid();
          layout = stored.geometry;
        }
        if (!(tracks.camOrientation instanceof Float32Array)
          || !validTrackSpan(tracks, meta, count, count * (meta.ngeom - layout.fixedIds.length) * 7, from === 0 ? 2 : 0)
          || !validPlaybackSpan(tracks, from === 0) || count > 0 && from > 0 && tracks.t[0] <= previous.duration
          || !Number.isSafeInteger(bytesFor(meta, frames, layout))) throw invalid();
        committed = { frames, duration, bytes: bytesFor(meta, frames, layout) };
        const info: RecordingRecoveryInfo = { id, name, created: meta.created, updated: new Date().toISOString(), robot: meta.robot,
          terrain: meta.terrain, ...committed, thumbnail: null };
        const draft: RecordingDraft = { id, info, meta, events, sceneId: scene.id, geometry: layout };
        if (from === 0) drafts.add(draft); else drafts.put(draft);
        // add, not put: a duplicate span aborts without replacing any committed prefix.
        if (count) tx.objectStore('chunks').add({ recordingId: id, from, ...tracks } satisfies RecordingChunk);
        result();
      });
    });
    return committed!;
  } finally { db.close(); }
}

export class RecordingCheckpointWriter {
  readonly id = crypto.randomUUID();
  private recorder: TakeRecorder | undefined;
  private model: RenderModel | undefined;
  private identity: TakeMeta | undefined;
  private scene: { id: string; terrain: string } | undefined;
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

  constructor(recorder: TakeRecorder, model: RenderModel, private readonly name: string,
    private readonly onStatus: (status: RecordingCheckpointStatus) => void) {
    this.recorder = recorder; this.model = model;
    try {
      this.identity = structuredClone(recorder.meta);
      if (typeof name !== 'string' || !validMeta(this.identity) || !validModel(model, this.identity)) throw invalid();
      this.scene = sceneFor(model, this.identity.terrain);
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
      this.recorder = undefined; this.model = undefined; this.identity = undefined;
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
    const recorder = this.recorder;
    if (this.closed || this.failure || !this.owned || this.inflight || !recorder || recorder.frames < 2) return;
    if (!this.forced && recorder.frames - this.committed.frames < (this.committed.frames ? 128 : 2)) return;
    this.forced = false;
    let snapshot: RecordingSnapshot;
    try {
      snapshot = recorder.snapshot(this.committed.frames);
      if (!this.identity || !sameIdentity(snapshot.meta, this.identity) || snapshot.meta.created !== this.identity.created) throw invalid();
    } catch (error) { this.fail(error); return; }
    this.inflight = append(this.id, this.name, snapshot, this.committed, this.scene!, this.model)
      .then(committed => { this.committed = committed; this.model = undefined; })
      .catch(error => { this.fail(error); })
      .finally(() => { this.inflight = undefined; this.report(); this.pump(); });
    this.report();
  }
}

export class RecordingRecovery {
  constructor(private readonly library = new ShotLibrary()) {}

  record(recorder: TakeRecorder, model: RenderModel, name: string,
    onStatus: (status: RecordingCheckpointStatus) => void): RecordingCheckpointWriter {
    return new RecordingCheckpointWriter(recorder, model, name, onStatus);
  }
  async list(): Promise<RecordingRecoveryInfo[]> {
    const db = await connect();
    try {
      return await transact<RecordingRecoveryInfo[]>(db, ['drafts'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('drafts').getAll(), (drafts: RecordingDraft[]) => {
          if (!drafts.every(validDraft)) throw invalid();
          result(drafts.map(draft => draft.info).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)));
        });
      });
    } finally { db.close(); }
  }
  read(id: string): Promise<{ info: RecordingRecoveryInfo; take: Take; model: RenderModel }> {
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
        await transact<void>(db, ['drafts', 'chunks', 'scenes', 'shots'], 'readwrite', (tx, request, result) => {
          const drafts = tx.objectStore('drafts');
          request(drafts.get(id), (draft: RecordingDraft | undefined) => {
            if (!draft) { result(); return; }
            if (!validDraft(draft) || draft.id !== id) throw invalid();
            drafts.delete(id); tx.objectStore('chunks').delete(chunkRange(id));
            collectScene(tx, request, draft.sceneId); result();
          });
        });
      } finally { db.close(); }
    });
  }
  private async readUnlocked(id: string): Promise<{ info: RecordingRecoveryInfo; take: Take; model: RenderModel }> {
    const db = await connect();
    let restored: { draft: RecordingDraft; tracks: Tracks; scene: SceneRecord };
    try {
      restored = await transact(db, ['drafts', 'chunks', 'scenes'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('drafts').get(id), (draft: RecordingDraft | undefined) => {
          if (!draft) throw new Error('This recording recovery no longer exists. Open Shots to refresh the list.');
          if (!validDraft(draft) || draft.id !== id) throw invalid();
          const n = draft.info.frames, meta = draft.meta;
          // Allocate each final track exactly once, not a materialized archive plus concatenation.
          const fixed = draft.geometry.fixed, movingStride = (meta.ngeom - draft.geometry.fixedIds.length) * 7;
          const values = new Float32Array(fixed.length + n * movingStride);
          values.set(fixed);
          const tracks: Tracks = { t: new Float64Array(n), geom: { fixedIds: draft.geometry.fixedIds, values }, qpos: new Float32Array(n * meta.nq),
            cmd: new Float32Array(n * 3), cam: new Float32Array(n * 7), hoist: new Float32Array(n * 3), camOrientation: new Float32Array(n * 4) };
          let scene: SceneRecord, from = 0;
          request(tx.objectStore('scenes').get(draft.sceneId), (stored: SceneRecord) => {
            if (!stored || stored.id !== draft.sceneId || stored.terrain !== meta.terrain || !validModel(stored.model, meta)) throw invalid();
            scene = stored;
          });
          request(tx.objectStore('chunks').openCursor(chunkRange(id)), cursor => {
            if (!cursor) {
              if (from !== n || tracks.t[n - 1] !== draft.info.duration || !scene) throw invalid();
              result({ draft, tracks, scene }); return;
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
    const { draft, tracks, scene } = restored;
    rememberScene(scene);
    const take = new Take(draft.meta, tracks.t, new GeometryTrack(draft.meta.ngeom, draft.info.frames, tracks.geom), tracks.qpos, tracks.cmd, tracks.cam, tracks.hoist, draft.events, tracks.camOrientation);
    return { info: draft.info, take, model: scene.model };
  }
}
