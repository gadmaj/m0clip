/** Completed takes with independently owned browser-local track and scene buffers. */
import { Take, validShotCamera, validTakeRange, type TakeMeta, type TakeEvent, type TakeRange } from './take';
import type { Shot } from './shot';
import type { RenderModel } from '../sim/protocol';
import { GeometryTrack } from '../core/geometry';
import { connect, transact, invalid, object, integer, date, validMeta, sameIdentity, validModel, validTracks, validPlayback,
  validEvents, sceneFor, rememberScene, clearDraft, collectScene, type TrackData, type SceneRecord } from './storage';

export interface SavedShotInfo {
  id: string; name: string; created: string; updated: string; robot: string; terrain: string;
  duration: number; frames: number; bytes: number; thumbnail: Blob | null;
  range?: TakeRange;
}
export interface SavedShot { info: SavedShotInfo; take: Take; model: RenderModel }
interface ShotRecord { id: string; info: SavedShotInfo; meta: TakeMeta; events: TakeEvent[]; shot?: Shot; sceneId: string }
function validInfo(info: SavedShotInfo): boolean {
  return object(info) && typeof info.id === 'string' && !!info.id && typeof info.name === 'string' && date(info.created) && date(info.updated)
    && typeof info.robot === 'string' && typeof info.terrain === 'string' && Number.isFinite(info.duration) && info.duration > 0
    && integer(info.frames) && info.frames >= 2 && integer(info.bytes) && (info.thumbnail === null || info.thumbnail instanceof Blob)
    && (info.range === undefined || validTakeRange(info.range, info.duration));
}


export class ShotLibrary {
  async save(input: { id: string; name: string; take: Take; model: RenderModel; thumbnail: Blob | null }): Promise<SavedShotInfo> {
    const { id, name, take, model, thumbnail } = input;
    // Only small mutable data is copied here, before the first await. IDB clones the finished buffers once.
    const snapshot = structuredClone({ meta: take.meta, events: take.events, shot: take.shot, range: take.range });
    if (!id || typeof id !== 'string' || typeof name !== 'string' || !validMeta(snapshot.meta) || !validModel(model, snapshot.meta)
      || snapshot.shot !== undefined && !validShotCamera(snapshot.shot) || thumbnail !== null && !(thumbnail instanceof Blob)) throw invalid();
    const tracks: TrackData = { id, t: take.t, geom: take.geom.toData(), qpos: take.qpos, cmd: take.cmd, cam: take.cam, hoist: take.hoist, camOrientation: take.camOrientation };
    if (!validTracks(tracks, snapshot.meta, take.n) || !validEvents(snapshot.events, take.duration)
      || snapshot.range !== undefined && !validTakeRange(snapshot.range, take.duration)) throw invalid();
    const sceneIdentity = sceneFor(model, snapshot.meta.terrain);
    const info: SavedShotInfo = { id, name, created: snapshot.meta.created, updated: new Date().toISOString(), robot: snapshot.meta.robot,
      terrain: snapshot.meta.terrain, duration: take.duration, frames: take.n,
      bytes: take.t.byteLength + tracks.geom.fixedIds.byteLength + tracks.geom.values.byteLength + take.qpos.byteLength + take.cmd.byteLength + take.cam.byteLength + take.hoist.byteLength + (take.camOrientation?.byteLength ?? 0), thumbnail,
      ...(snapshot.range === undefined ? {} : { range: snapshot.range }) };
    const record: ShotRecord = { id, info, meta: snapshot.meta, events: snapshot.events, shot: snapshot.shot, sceneId: sceneIdentity.id };
    const db = await connect();
    try {
      return await transact<SavedShotInfo>(db, ['shots', 'tracks', 'scenes', 'drafts', 'chunks'], 'readwrite', (tx, request, result) => {
        tx.objectStore('shots').add(record);
        tx.objectStore('tracks').add(tracks);
        const store = tx.objectStore('scenes');
        request(store.getKey(sceneIdentity.id), key => { if (key === undefined) store.add({ id: sceneIdentity.id, terrain: sceneIdentity.terrain, model } satisfies SceneRecord); });
        clearDraft(tx, request, id);
        result(info);
      });
    } finally { db.close(); }
  }

  async update(id: string, input: { meta: TakeMeta; shot: Shot | undefined; range: TakeRange | undefined; thumbnail?: Blob | null }): Promise<SavedShotInfo> {
    const snapshot = structuredClone({ meta: input.meta, shot: input.shot, range: input.range });
    const thumbnail = input.thumbnail;
    if (!validMeta(snapshot.meta) || snapshot.shot !== undefined && !validShotCamera(snapshot.shot)
      || thumbnail !== undefined && thumbnail !== null && !(thumbnail instanceof Blob)) throw invalid();
    const db = await connect();
    try {
      return await transact<SavedShotInfo>(db, ['shots'], 'readwrite', (tx, request, result) => {
        const store = tx.objectStore('shots');
        request(store.get(id), (record: ShotRecord | undefined) => {
          if (!record) throw new Error('Saved shot no longer exists.');
          if (!validInfo(record.info) || !validMeta(record.meta) || !sameIdentity(record.meta, snapshot.meta) || record.meta.created !== snapshot.meta.created
            || snapshot.range !== undefined && !validTakeRange(snapshot.range, record.info.duration)) throw invalid();
          record.meta = snapshot.meta; record.shot = snapshot.shot;
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
          if (!records.every(record => validInfo(record.info) && record.id === record.info.id)) throw invalid();
          result(records.map(record => record.info).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)));
        });
      });
    } finally { db.close(); }
  }

  async open(id: string): Promise<SavedShot> {
    const db = await connect();
    let stored: { record: ShotRecord; tracks: TrackData; scene: SceneRecord };
    try {
      stored = await transact(db, ['shots', 'tracks', 'scenes'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('shots').get(id), (record: ShotRecord | undefined) => {
          if (!record) throw new Error('Saved shot no longer exists.');
          let tracks: TrackData;
          request(tx.objectStore('tracks').get(id), value => { tracks = value; });
          // IDB dispatches requests in insertion order, before transaction completion.
          request(tx.objectStore('scenes').get(record.sceneId), (scene: SceneRecord) => { result({ record, tracks, scene }); });
        });
      });
    } finally { db.close(); }
    const { record, tracks, scene } = stored;
    if (!validInfo(record.info) || record.id !== id || record.info.id !== id || !validMeta(record.meta)
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

  async remove(id: string): Promise<void> {
    const db = await connect();
    try {
      await transact<void>(db, ['shots', 'tracks', 'scenes', 'drafts'], 'readwrite', (tx, request, result) => {
        const shots = tx.objectStore('shots');
        request(shots.get(id), (record: ShotRecord | undefined) => {
          if (!record) { result(); return; }
          shots.delete(id); tx.objectStore('tracks').delete(id);
          collectScene(tx, request, record.sceneId); result();
        });
      });
    } finally { db.close(); }
  }
}
