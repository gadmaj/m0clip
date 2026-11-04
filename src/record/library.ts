/** Completed takes with independently owned browser-local track and scene buffers. */
import { Take, type RecordedTake, type TakeMeta, type TakeEvent } from './take';
import { PlayerTake, validPlayerMeta, type PlayerTables, type PlayerTakeEvent, type PlayerTakeMeta, type PlayerTracks } from './player-take';
import { validShotCamera, validTakeRange, type TakeRange } from './track';
import type { Shot } from './shot';
import type { RenderModel } from '../sim/protocol';
import type { SceneMode } from '../player/types';
import { GeometryTrack, validGeometryData, type GeometryData } from '../core/geometry';
import { packModel } from './model-pack';
import { connect, transact, invalid, object, integer, date, validMeta, sameIdentity, validModel, validTracks, validPlayback,
  validEvents, sceneFor, rememberScene, clearDraft, collectScene, readInfo, readRobotModel, putPlayerScenes, readPlayerScenes,
  SCENE_STORES, type TrackData, type SceneRecord } from './storage';

export interface SavedShotInfo {
  id: string; name: string; created: string; updated: string; mode: SceneMode; robot: string | null; terrain: string;
  duration: number; frames: number; bytes: number; thumbnail: Blob | null;
  range?: TakeRange;
}
/** `model` is the Robot take's model, or a Player take's first epoch model (every epoch carries its own). */
export interface SavedShot { info: SavedShotInfo; take: RecordedTake; model: RenderModel }
interface RobotShotRecord { id: string; mode?: 'robot'; info: SavedShotInfo; meta: TakeMeta; events: TakeEvent[]; shot?: Shot; sceneId: string }
interface PlayerShotRecord {
  id: string; mode: 'player'; info: SavedShotInfo; meta: PlayerTakeMeta; events: PlayerTakeEvent[]; tables: PlayerTables; shot?: Shot;
  sceneIds: string[]; epochs: { start: number; sceneId: string }[];
}
type ShotRecord = RobotShotRecord | PlayerShotRecord;
interface PlayerTrackRecord { id: string; mode: 'player'; tracks: PlayerTracks; epochs: { geometry: GeometryData; qpos: Float32Array }[] }

function validInfo(info: SavedShotInfo): boolean {
  return object(info) && typeof info.id === 'string' && !!info.id && typeof info.name === 'string' && date(info.created) && date(info.updated)
    && (info.mode === 'robot' ? typeof info.robot === 'string' && !!info.robot : info.mode === 'player' && info.robot === null)
    && typeof info.terrain === 'string' && Number.isFinite(info.duration) && info.duration > 0
    && integer(info.frames) && info.frames >= 2 && integer(info.bytes) && (info.thumbnail === null || info.thumbnail instanceof Blob)
    && (info.range === undefined || validTakeRange(info.range, info.duration));
}
function playerBytes(take: PlayerTake): number {
  let bytes = 0;
  for (const value of Object.values(take.tracks)) bytes += ArrayBuffer.isView(value) ? value.byteLength : value.counts.byteLength + value.values.byteLength;
  for (const epoch of take.epochs) bytes += epoch.geometry.fixedIds.byteLength + epoch.geometry.values.byteLength + epoch.qpos.byteLength;
  return bytes;
}

export class ShotLibrary {
  /** `model` is ignored for a Player take: its epochs carry the actual recorded models. */
  async save(input: { id: string; name: string; take: RecordedTake; model: RenderModel; thumbnail: Blob | null }): Promise<SavedShotInfo> {
    return input.take instanceof PlayerTake ? this.savePlayer({ ...input, take: input.take }) : this.saveRobot({ ...input, take: input.take });
  }

  private async saveRobot(input: { id: string; name: string; take: Take; model: RenderModel; thumbnail: Blob | null }): Promise<SavedShotInfo> {
    const { id, name, take, model, thumbnail } = input;
    // Only small mutable data is copied here, before the first await. IDB clones the finished buffers once.
    const snapshot = structuredClone({ meta: take.meta, events: take.events, shot: take.shot, range: take.range });
    if (!id || typeof id !== 'string' || typeof name !== 'string' || !validMeta(snapshot.meta) || !validModel(model, snapshot.meta)
      || snapshot.shot !== undefined && !validShotCamera(snapshot.shot) || thumbnail !== null && !(thumbnail instanceof Blob)) throw invalid();
    const tracks: TrackData = { id, t: take.t, geom: take.geom.toData(), qpos: take.qpos, cmd: take.cmd, cam: take.cam, hoist: take.hoist, camOrientation: take.camOrientation };
    if (!validTracks(tracks, snapshot.meta, take.n) || !validEvents(snapshot.events, take.duration)
      || snapshot.range !== undefined && !validTakeRange(snapshot.range, take.duration)) throw invalid();
    const sceneIdentity = sceneFor(model, snapshot.meta.terrain);
    const info: SavedShotInfo = { id, name, created: snapshot.meta.created, updated: new Date().toISOString(), mode: 'robot', robot: snapshot.meta.robot,
      terrain: snapshot.meta.terrain, duration: take.duration, frames: take.n,
      bytes: take.t.byteLength + tracks.geom.fixedIds.byteLength + tracks.geom.values.byteLength + take.qpos.byteLength + take.cmd.byteLength + take.cam.byteLength + take.hoist.byteLength + (take.camOrientation?.byteLength ?? 0), thumbnail,
      ...(snapshot.range === undefined ? {} : { range: snapshot.range }) };
    const record: RobotShotRecord = { id, mode: 'robot', info, meta: snapshot.meta, events: snapshot.events, shot: snapshot.shot, sceneId: sceneIdentity.id };
    const db = await connect();
    try {
      return await transact<SavedShotInfo>(db, ['tracks', 'chunks', ...SCENE_STORES], 'readwrite', (tx, request, result) => {
        tx.objectStore('shots').add(record);
        tx.objectStore('tracks').add(tracks);
        const store = tx.objectStore('scenes');
        request(store.getKey(sceneIdentity.id), key => { if (key === undefined) store.add({ id: sceneIdentity.id, terrain: sceneIdentity.terrain, model } satisfies SceneRecord); });
        clearDraft(tx, request, id);
        result(info);
      });
    } finally { db.close(); }
  }

  private async savePlayer(input: { id: string; name: string; take: PlayerTake; thumbnail: Blob | null }): Promise<SavedShotInfo> {
    const { id, name, take, thumbnail } = input;
    const snapshot = structuredClone({ meta: take.meta, events: take.events, tables: take.tables, shot: take.shot, range: take.range });
    if (!id || typeof id !== 'string' || typeof name !== 'string' || !validPlayerMeta(snapshot.meta)
      || snapshot.shot !== undefined && !validShotCamera(snapshot.shot) || thumbnail !== null && !(thumbnail instanceof Blob)
      || snapshot.range !== undefined && !validTakeRange(snapshot.range, take.duration)) throw invalid();
    const terrain = snapshot.meta.terrain;
    const scenes = take.epochs.map(epoch => ({ ...sceneFor(epoch.model, terrain), model: epoch.model }));
    // Mesh digests are computed before the transaction: IDB transactions cannot span other awaits.
    const packed = await Promise.all(scenes.map(scene => packModel(scene.model)));
    const sceneIds = [...new Set(scenes.map(scene => scene.id))];
    const info: SavedShotInfo = { id, name, created: snapshot.meta.created, updated: new Date().toISOString(), mode: 'player', robot: null,
      terrain, duration: take.duration, frames: take.n, bytes: playerBytes(take), thumbnail,
      ...(snapshot.range === undefined ? {} : { range: snapshot.range }) };
    const record: PlayerShotRecord = { id, mode: 'player', info, meta: snapshot.meta, events: snapshot.events, tables: snapshot.tables,
      shot: snapshot.shot, sceneIds, epochs: take.epochs.map((epoch, k) => ({ start: epoch.start, sceneId: scenes[k].id })) };
    const tracks: PlayerTrackRecord = { id, mode: 'player', tracks: take.tracks,
      epochs: take.epochs.map(epoch => ({ geometry: epoch.geometry.toData(), qpos: epoch.qpos })) };
    const db = await connect();
    try {
      return await transact<SavedShotInfo>(db, ['tracks', 'chunks', ...SCENE_STORES], 'readwrite', (tx, request, result) => {
        tx.objectStore('shots').add(record);
        tx.objectStore('tracks').add(tracks);
        putPlayerScenes(tx, request, scenes.map((scene, k) => ({ id: scene.id, terrain, packed: packed[k] })));
        clearDraft(tx, request, id);
        result(info);
      });
    } finally { db.close(); }
  }

  async update(id: string, input: { meta: TakeMeta | PlayerTakeMeta; shot: Shot | undefined; range: TakeRange | undefined; thumbnail?: Blob | null }): Promise<SavedShotInfo> {
    const snapshot = structuredClone({ meta: input.meta, shot: input.shot, range: input.range });
    const thumbnail = input.thumbnail, meta = snapshot.meta;
    if (('mode' in meta ? !validPlayerMeta(meta) : !validMeta(meta))
      || snapshot.shot !== undefined && !validShotCamera(snapshot.shot)
      || thumbnail !== undefined && thumbnail !== null && !(thumbnail instanceof Blob)) throw invalid();
    const db = await connect();
    try {
      return await transact<SavedShotInfo>(db, ['shots'], 'readwrite', (tx, request, result) => {
        const store = tx.objectStore('shots');
        request(store.get(id), (record: ShotRecord | undefined) => {
          if (!record) throw new Error('Saved shot no longer exists.');
          readInfo(record.info);
          if (!validInfo(record.info) || record.meta.created !== meta.created
            || snapshot.range !== undefined && !validTakeRange(snapshot.range, record.info.duration)) throw invalid();
          if (record.mode === 'player') {
            if (!('mode' in meta) || !validPlayerMeta(record.meta) || record.meta.terrain !== meta.terrain) throw invalid();
            record.meta = meta;
          } else {
            if ('mode' in meta || !validMeta(record.meta) || !sameIdentity(record.meta, meta)) throw invalid();
            record.meta = meta;
          }
          record.shot = snapshot.shot;
          record.info.updated = new Date().toISOString();
          if (snapshot.range === undefined) delete record.info.range;
          else record.info.range = snapshot.range;
          if (thumbnail !== undefined) record.info.thumbnail = thumbnail;
          store.put(record); result(record.info);
        });
      });
    } finally { db.close(); }
  }

  async list(): Promise<SavedShotInfo[]> {
    const db = await connect();
    try {
      return await transact<SavedShotInfo[]>(db, ['shots'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('shots').getAll(), (records: ShotRecord[]) => {
          if (!records.every(record => validInfo(readInfo(record.info)) && record.id === record.info.id)) throw invalid();
          result(records.map(record => record.info).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)));
        });
      });
    } finally { db.close(); }
  }

  async open(id: string): Promise<SavedShot> {
    const db = await connect();
    type Stored = { kind: 'robot'; record: RobotShotRecord; tracks: TrackData; scene: SceneRecord }
      | { kind: 'player'; record: PlayerShotRecord; tracks: PlayerTrackRecord; models: RenderModel[] };
    let stored: Stored;
    try {
      stored = await transact<Stored>(db, ['shots', 'tracks', 'scenes', 'meshes'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('shots').get(id), (record: ShotRecord | undefined) => {
          if (!record) throw new Error('Saved shot no longer exists.');
          if (record.mode === 'player') {
            if (!Array.isArray(record.epochs) || !record.epochs.length || !record.epochs.every(e => object(e) && typeof e.sceneId === 'string')) throw invalid();
            let tracks: PlayerTrackRecord;
            request(tx.objectStore('tracks').get(id), value => { tracks = value; });
            readPlayerScenes(tx, request, record.epochs.map(e => e.sceneId), record.meta?.terrain, scenes => {
              result({ kind: 'player', record, tracks, models: scenes.map(scene => scene.model) });
            });
            return;
          }
          let tracks: TrackData;
          request(tx.objectStore('tracks').get(id), value => { tracks = value; });
          // IDB dispatches requests in insertion order, before transaction completion.
          request(tx.objectStore('scenes').get(record.sceneId), (scene: SceneRecord) => { result({ kind: 'robot', record, tracks, scene }); });
        });
      });
    } finally { db.close(); }
    if (stored.kind === 'player') return this.openPlayer(id, stored.record, stored.tracks, stored.models);
    const { record, tracks, scene } = stored;
    readInfo(record.info);
    if (scene) readRobotModel(scene.model);
    if (!validInfo(record.info) || record.info.mode !== 'robot' || record.id !== id || record.info.id !== id || !validMeta(record.meta)
      || record.info.robot !== record.meta.robot || record.info.terrain !== record.meta.terrain || record.info.created !== record.meta.created
      || !scene || scene.id !== record.sceneId || scene.terrain !== record.meta.terrain || !validModel(scene.model, record.meta)
      || !validTracks(tracks, record.meta, record.info.frames) || tracks.id !== id || tracks.t[tracks.t.length - 1] !== record.info.duration
      || !validPlayback(tracks) || !validEvents(record.events, record.info.duration)
      || record.shot !== undefined && !validShotCamera(record.shot)) throw invalid();
    rememberScene(scene);
    const take = new Take(record.meta, tracks.t, new GeometryTrack(record.meta.ngeom, record.info.frames, tracks.geom), tracks.qpos, tracks.cmd, tracks.cam, tracks.hoist, record.events, tracks.camOrientation);
    take.shot = record.shot;
    take.range = record.info.range === undefined ? undefined : [...record.info.range];
    return { info: record.info, take, model: scene.model };
  }

  private openPlayer(id: string, record: PlayerShotRecord, tracks: PlayerTrackRecord, models: RenderModel[]): SavedShot {
    if (!validInfo(record.info) || record.info.mode !== 'player' || record.id !== id || record.info.id !== id || !validPlayerMeta(record.meta)
      || record.info.terrain !== record.meta.terrain || record.info.created !== record.meta.created
      || !object(tracks) || tracks.id !== id || tracks.mode !== 'player' || !Array.isArray(tracks.epochs) || tracks.epochs.length !== record.epochs.length
      || record.shot !== undefined && !validShotCamera(record.shot)) throw invalid();
    let take: PlayerTake;
    try {
      const n = tracks.tracks?.t?.length ?? 0;
      const epochs = record.epochs.map((epoch, k) => {
        const end = k + 1 < record.epochs.length ? record.epochs[k + 1].start : n, data = tracks.epochs[k], model = models[k];
        if (!integer(epoch.start) || !integer(end) || end <= epoch.start || !object(data) || !validGeometryData(data.geometry, model.ngeom, end - epoch.start)) throw invalid();
        return { start: epoch.start, model, geometry: new GeometryTrack(model.ngeom, end - epoch.start, data.geometry), qpos: data.qpos };
      });
      take = new PlayerTake(record.meta, tracks.tracks, record.tables, epochs, record.events);
    } catch { throw invalid(); }
    if (take.n !== record.info.frames || take.duration !== record.info.duration) throw invalid();
    record.epochs.forEach((epoch, k) => rememberScene({ id: epoch.sceneId, terrain: record.meta.terrain, model: models[k] }));
    take.shot = record.shot;
    take.range = record.info.range === undefined ? undefined : [...record.info.range];
    return { info: record.info, take, model: take.epochs[0].model };
  }

  async remove(id: string): Promise<void> {
    const db = await connect();
    try {
      await transact<void>(db, ['tracks', ...SCENE_STORES], 'readwrite', (tx, request, result) => {
        const shots = tx.objectStore('shots');
        request(shots.get(id), (record: ShotRecord | undefined) => {
          if (!record) { result(); return; }
          shots.delete(id); tx.objectStore('tracks').delete(id);
          for (const sceneId of record.mode === 'player' ? record.sceneIds : [record.sceneId]) collectScene(tx, request, sceneId);
          result();
        });
      });
    } finally { db.close(); }
  }
}
