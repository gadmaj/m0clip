/** Browser-local capture transactions and shared scene ownership. */
import type { TakeMeta, TakeEvent } from './take';
import type { PlayerTables, PlayerTakeEvent, PlayerTakeMeta } from './player-take';
import { validPlayerModelIdentity } from './player-take';
import { validLook, validShotEdits, validShotLights } from './post';
import { validDisplay } from '../render/display';
import type { RenderModel, SceneIdentity } from '../sim/protocol';
import type { SceneMode } from '../player/types';
import { denseGeometryPartition, validGeometryData, type GeometryData, type GeometryPartition } from '../core/geometry';
import { validLocalMap } from '../maps/source';
import { unpackModel, type MeshBody, type PackedModel, type PackedScene } from './model-pack';

export interface TrackSpanData {
  t: Float64Array; geom: Float32Array; qpos: Float32Array; cmd: Float32Array;
  cam: Float32Array; hoist: Float32Array; camOrientation?: Float32Array;
}
export interface TrackData extends Omit<TrackSpanData, 'geom'> {
  id: string; geom: GeometryData;
}
/** A Robot take's compiled model, stored whole as before. */
export interface SceneRecord { id: string; terrain: string; model: RenderModel }
/** A Player epoch model; mesh bodies live once each in the 'meshes' store. */
export interface PackedSceneRecord { id: string; terrain: string; model: PackedModel; meshIds: string[] }
export interface RecordingRecoveryInfo {
  id: string; name: string; created: string; updated: string; mode: SceneMode; robot: string | null; terrain: string;
  duration: number; frames: number; bytes: number; thumbnail: null;
}
export interface RecordingDraft {
  id: string; mode?: 'robot'; info: RecordingRecoveryInfo; meta: TakeMeta; events: TakeEvent[]; sceneId: string;
  geometry: GeometryPartition;
}
export interface PlayerEpochStored { start: number; sceneId: string; layout: GeometryPartition }
export interface PlayerRecordingDraft {
  id: string; mode: 'player'; info: RecordingRecoveryInfo; meta: PlayerTakeMeta; events: PlayerTakeEvent[]; tables: PlayerTables;
  sceneIds: string[]; epochs: PlayerEpochStored[]; ragged: { bodyParams: number; bodyLayers: number; viewParams: number; viewLayers: number };
}
export type AnyRecordingDraft = RecordingDraft | PlayerRecordingDraft;

// Compiled model identity, never a geometry serialization or hash.
const scenes = new WeakMap<RenderModel, { id: string; terrain: string }>();
export const invalid = () => new Error('Saved shot data is invalid.');
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
export const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
export const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const eventKinds = new Set(['state', 'policy', 'move', 'reset', 'hoist', 'clip', 'noclip']);

export function storageErrorMessage(error: unknown): string {
  let detail = error instanceof Error
    ? error.message || (error.name === 'QuotaExceededError' ? 'Browser storage is full' : error.name)
    : String(error);
  detail = detail.trim() || 'Browser storage is unavailable';
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

/** Card and search text for a stored take or recovery: the robot, or Player for a no-robot world. */
export function subjectLabel(info: { mode: SceneMode; robot: string | null }): string {
  return info.mode === 'player' ? 'Player' : info.robot ?? '';
}

/** Rows written before Player mode have no `mode`; they are Robot rows with a robot id. Nothing else is filled in. */
export function readInfo<T extends { mode: SceneMode; robot: string | null }>(info: T): T {
  if (object(info) && info.mode === undefined && typeof info.robot === 'string') Object.assign(info, { mode: 'robot' });
  return info;
}
/** Robot scene models saved before Player mode carry no `mode`. Only a model with a robot id becomes Robot;
 * a Player model is never migrated and must be valid as stored. */
export function readRobotModel(model: RenderModel): RenderModel {
  if (object(model) && model.mode === undefined && typeof model.robot === 'string' && model.robot) model.mode = 'robot';
  return model;
}

export function sceneFor(model: RenderModel, terrain: string): { id: string; terrain: string } {
  let scene = scenes.get(model);
  if (scene && scene.terrain !== terrain) throw invalid();
  if (!scene) { scene = { id: crypto.randomUUID(), terrain }; scenes.set(model, scene); }
  return scene;
}
export function rememberScene(scene: { id: string; terrain: string; model: RenderModel }): void {
  scenes.set(scene.model, { id: scene.id, terrain: scene.terrain });
}
export function validMeta(meta: TakeMeta): boolean {
  return object(meta) && typeof meta.robot === 'string' && !!meta.robot && typeof meta.terrain === 'string' && !!meta.terrain
    && (!(meta.terrain.startsWith('map:local-') || meta.localMap !== undefined) || validLocalMap(meta.localMap,meta.terrain))
    && typeof meta.policy === 'string' && date(meta.created) && integer(meta.ngeom) && meta.ngeom > 0 && integer(meta.nq)
    && Number.isInteger(meta.baseQadr) && (meta.baseQadr === -1 || meta.baseQadr >= 0 && meta.baseQadr + 7 <= meta.nq)
    && Array.isArray(meta.hinges) && meta.hinges.every(h => object(h) && typeof h.name === 'string' && integer(h.qadr) && h.qadr < meta.nq)
    && (meta.sourceTime === undefined || Number.isFinite(meta.sourceTime))
    && (meta.display === undefined || validDisplay(meta.display))
    && (meta.flashlight === undefined || typeof meta.flashlight === 'boolean')
    && (meta.lights === undefined || validShotLights(meta.lights))
    && (meta.look === undefined || validLook(meta.look)) && (meta.edits === undefined || validShotEdits(meta.edits, meta.robot));
}
export function sameIdentity(a: TakeMeta, b: TakeMeta | SceneIdentity): boolean {
  return a.robot === b.robot && (b.terrain === undefined || a.terrain === b.terrain) && a.ngeom === b.ngeom && a.nq === b.nq
    && a.baseQadr === b.baseQadr && Array.isArray(b.hinges) && a.hinges.length === b.hinges.length
    && a.hinges.every((h, i) => h.name === b.hinges[i].name && h.qadr === b.hinges[i].qadr);
}
/** Array shapes of a compiled render model, for either scene mode. */
export function validModelShape(model: RenderModel): boolean {
  if (!object(model) || model.mode !== 'robot' && model.mode !== 'player' || !integer(model.ngeom) || !integer(model.nq)
    || model.terrain !== undefined && typeof model.terrain !== 'string'
    || !Array.isArray(model.bodyNames) || !model.bodyNames.every(n => typeof n === 'string')
    || !Number.isInteger(model.baseQadr) || model.baseQadr !== -1 && (model.baseQadr < 0 || model.baseQadr + 7 > model.nq)
    || !Array.isArray(model.hinges) || !model.hinges.every(h => object(h) && typeof h.name === 'string' && integer(h.qadr) && h.qadr < model.nq)) return false;
  const n = model.ngeom;
  if (!(model.type instanceof Int32Array) || model.type.length !== n || !(model.size instanceof Float64Array) || model.size.length !== n * 3
    || !(model.rgba instanceof Float32Array) || model.rgba.length !== n * 4) return false;
  for (const a of [model.group, model.contype, model.bodyid, model.dataid]) if (!(a instanceof Int32Array) || a.length !== n) return false;
  if (!object(model.meshes)) return false;
  for (const mesh of Object.values(model.meshes)) {
    if (!object(mesh) || typeof mesh.name !== 'string' || !(mesh.vert instanceof Float32Array) || mesh.vert.length % 3 !== 0
      || !(mesh.face instanceof Uint32Array) || mesh.face.length % 3 !== 0
      || !Array.isArray(mesh.pos) || mesh.pos.length !== 3 || !mesh.pos.every(Number.isFinite)
      || !Array.isArray(mesh.quat) || mesh.quat.length !== 4 || !mesh.quat.every(Number.isFinite)) return false;
  }
  if (model.bodyFrames && (!(model.bodyFrames.parent instanceof Int32Array) || model.bodyFrames.parent.length !== model.bodyNames.length
    || !(model.bodyFrames.pos instanceof Float64Array) || model.bodyFrames.pos.length !== model.bodyNames.length * 3
    || !(model.bodyFrames.quat instanceof Float64Array) || model.bodyFrames.quat.length !== model.bodyNames.length * 4)) return false;
  return !model.geomFrames || model.geomFrames.pos instanceof Float64Array && model.geomFrames.pos.length === n * 3
    && model.geomFrames.quat instanceof Float64Array && model.geomFrames.quat.length === n * 4;
}
/** The Robot model a Robot take was recorded on. */
export function validModel(model: RenderModel, meta: TakeMeta): boolean {
  return object(model) && model.mode === 'robot' && sameIdentity(meta, model) && validModelShape(model);
}
/** A recorded Player epoch model. */
export function validPlayerModel(model: RenderModel): boolean {
  return validModelShape(model) && validPlayerModelIdentity(model);
}
export function validTrackSpan(tracks: TrackSpanData, meta: TakeMeta, frames: number, geometryLength: number, minimumFrames = 2): boolean {
  if (!object(tracks) || !integer(frames) || frames < minimumFrames || !(tracks.t instanceof Float64Array) || tracks.t.length !== frames) return false;
  for (const [array, length] of [[tracks.geom, geometryLength], [tracks.qpos, frames * meta.nq], [tracks.cmd, frames * 3], [tracks.cam, frames * 7], [tracks.hoist, frames * 3],
    ...(tracks.camOrientation === undefined ? [] : [[tracks.camOrientation, frames * 4]])] as [Float32Array, number][]) {
    if (!(array instanceof Float32Array) || array.length !== length) return false;
  }
  return true;
}
export function validTracks(tracks: Omit<TrackData, 'id'>, meta: TakeMeta, frames: number, minimumFrames = 2): boolean {
  return object(tracks) && validGeometryData(tracks.geom, meta.ngeom, frames)
    && validTrackSpan({ ...tracks, geom: tracks.geom.values }, meta, frames, tracks.geom.values.length, minimumFrames);
}
export function validPlayback(tracks: Omit<TrackData, 'id'>, startsAtZero = true): boolean {
  return validPlaybackSpan({ ...tracks, geom: tracks.geom.values }, startsAtZero);
}
export function validPlaybackSpan(tracks: TrackSpanData, startsAtZero = true): boolean {
  if (startsAtZero && tracks.t[0] !== 0) return false;
  for (let i = 0; i < tracks.t.length; i++) {
    if (!Number.isFinite(tracks.t[i]) || i > 0 && tracks.t[i] <= tracks.t[i - 1]) return false;
    const h = i * 3, hx = tracks.hoist[h], hy = tracks.hoist[h + 1], hz = tracks.hoist[h + 2];
    if (!(Number.isFinite(hx) && Number.isFinite(hy) && Number.isFinite(hz))
      && !(Number.isNaN(hx) && Number.isNaN(hy) && Number.isNaN(hz))) return false;
    if (tracks.camOrientation) {
      const q = i * 4, x = tracks.camOrientation[q], y = tracks.camOrientation[q + 1], z = tracks.camOrientation[q + 2], w = tracks.camOrientation[q + 3];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w) || Math.hypot(x, y, z, w) < 1e-8) return false;
    }
  }
  return [tracks.geom, tracks.qpos, tracks.cmd, tracks.cam].every(a => a.every(Number.isFinite));
}
export function validEvents(events: TakeEvent[], duration: number): boolean {
  return Array.isArray(events) && events.every(e => object(e) && Number.isFinite(e.t) && e.t >= 0 && e.t <= duration
    && eventKinds.has(e.kind) && typeof e.label === 'string');
}

export function connect(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  let request: IDBOpenDBRequest;
  try { request = indexedDB.open('m0clip-shots', 4); }
  catch (error) { reject(error); return promise; }
  let settled = false;
  request.onupgradeneeded = event => {
    const db = request.result, tx = request.transaction!;
    if (!db.objectStoreNames.contains('shots')) db.createObjectStore('shots', { keyPath: 'id' }).createIndex('sceneId', 'sceneId');
    for (const name of ['tracks', 'scenes', 'photos', 'photoData', 'meshes']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' }).createIndex('sceneId', 'sceneId');
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recordingId', 'from'] });
    // Player takes reference one scene per epoch; Player scenes reference shared mesh bodies.
    for (const name of ['shots', 'drafts']) {
      const store = tx.objectStore(name);
      if (!store.indexNames.contains('sceneIds')) store.createIndex('sceneIds', 'sceneIds', { multiEntry: true });
    }
    const sceneStore = tx.objectStore('scenes');
    if (!sceneStore.indexNames.contains('meshIds')) sceneStore.createIndex('meshIds', 'meshIds', { multiEntry: true });
    if (event.oldVersion > 0 && event.oldVersion < 3) {
      // Migration belongs to the versionchange transaction: abort leaves the old schema and bytes intact.
      const migrate = (name: string, update: (record: Record<string, unknown>) => void) => {
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const record = row.value;
          update(record);
          row.update(record);
          row.continue();
        };
      };
      migrate('tracks', record => {
        record.geom = { fixedIds: new Uint32Array(0), values: record.geom };
      });
      migrate('drafts', record => { record.geometry = denseGeometryPartition(); });
    }
  };
  request.onblocked = () => { settled = true; reject(new Error('Saved-shot storage is blocked by another tab. Close that tab and try again.')); };
  request.onerror = () => { settled = true; reject(request.error ?? new Error('Saved-shot storage could not open.')); };
  request.onsuccess = () => {
    const db = request.result;
    if (settled) { db.close(); return; }
    db.onversionchange = () => db.close();
    settled = true; resolve(db);
  };
  return promise;
}
export type RequestReceiver = <R>(req: IDBRequest<R>, receive: (value: R) => void) => void;
/** Request success is not a commit. Resolve only after durable transaction completion. */
export function transact<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, request: RequestReceiver, result: (value: T) => void) => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let tx: IDBTransaction;
  try { tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
  catch (error) { reject(error); return promise; }
  let value: T, failure: unknown;
  const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
  tx.oncomplete = () => resolve(value);
  tx.onabort = () => reject(failure ?? tx.error ?? new Error('Saved-shot transaction was aborted.'));
  tx.onerror = () => { failure ??= tx.error; };
  try {
    work(tx, (req, receive) => { req.onsuccess = () => { try { receive(req.result); } catch (error) { fail(error); } }; }, result => { value = result; });
  } catch (error) { fail(error); }
  return promise;
}
export function chunkRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}
/** Stores any transaction that may collect a scene must include. */
export const SCENE_STORES = ['shots', 'drafts', 'scenes', 'meshes'];
/** Both finished takes and recording checkpoints can own a compiled scene, Robot or Player. */
export function collectScene(tx: IDBTransaction, request: RequestReceiver, sceneId: string): void {
  const owners: [string, string][] = [['shots', 'sceneId'], ['shots', 'sceneIds'], ['drafts', 'sceneId'], ['drafts', 'sceneIds']];
  const next = (k: number) => {
    if (k === owners.length) {
      const store = tx.objectStore('scenes');
      request(store.get(sceneId), (scene: SceneRecord | PackedSceneRecord | undefined) => {
        if (!scene) return;
        store.delete(sceneId);
        // Requests run in order: each count already excludes the deleted scene.
        if ('meshIds' in scene && Array.isArray(scene.meshIds)) for (const meshId of scene.meshIds)
          request(store.index('meshIds').count(meshId), users => { if (!users) tx.objectStore('meshes').delete(meshId); });
      });
      return;
    }
    const [name, index] = owners[k];
    request(tx.objectStore(name).index(index).count(sceneId), count => { if (!count) next(k + 1); });
  };
  next(0);
}
/** Add Player epoch scenes and their mesh bodies unless already stored. */
export function putPlayerScenes(tx: IDBTransaction, request: RequestReceiver, list: { id: string; terrain: string; packed: PackedScene }[]): void {
  const sceneStore = tx.objectStore('scenes'), meshes = tx.objectStore('meshes');
  for (const { id, terrain, packed } of list) {
    request(sceneStore.getKey(id), key => {
      if (key !== undefined) return;
      sceneStore.add({ id, terrain, model: packed.model, meshIds: packed.bodies.map(b => b.id) } satisfies PackedSceneRecord);
      for (const body of packed.bodies) request(meshes.getKey(body.id), have => { if (have === undefined) meshes.add(body satisfies MeshBody); });
    });
  }
}
/** Read Player epoch scenes with their shared mesh bodies; `receive` gets them in `ids` order. */
export function readPlayerScenes(tx: IDBTransaction, request: RequestReceiver, ids: string[], terrain: string,
  receive: (scenes: { id: string; model: RenderModel }[]) => void): void {
  const records = new Map<string, PackedSceneRecord>(), bodies = new Map<string, MeshBody>();
  const unique = [...new Set(ids)];
  let pending = unique.length;
  const finish = () => {
    const models = new Map<string, RenderModel>();
    for (const [id, scene] of records) {
      const model = unpackModel(scene.model, bodies);
      if (!validPlayerModel(model)) throw invalid();
      models.set(id, model);
    }
    receive(ids.map(id => ({ id, model: models.get(id)! })));
  };
  if (!pending) { receive([]); return; }
  for (const id of unique) request(tx.objectStore('scenes').get(id), (scene: PackedSceneRecord | undefined) => {
    if (!scene || scene.id !== id || scene.terrain !== terrain || !Array.isArray(scene.meshIds)
      || !scene.meshIds.every(m => typeof m === 'string')) throw invalid();
    records.set(id, scene);
    const missing = scene.meshIds.filter(m => !bodies.has(m));
    let left = missing.length;
    if (!left && !--pending) finish();
    for (const meshId of missing) request(tx.objectStore('meshes').get(meshId), (body: MeshBody | undefined) => {
      if (!body || body.id !== meshId || !(body.vert instanceof Float32Array) || !(body.face instanceof Uint32Array)) throw invalid();
      bodies.set(meshId, body);
      if (!--left && !--pending) finish();
    });
  });
}
/** Used in the same transaction that commits a full take; abort retains the recovery. */
export function clearDraft(tx: IDBTransaction, request: RequestReceiver, id: string): void {
  request(tx.objectStore('drafts').get(id), (draft: AnyRecordingDraft | undefined) => {
    if (!draft) return;
    tx.objectStore('drafts').delete(id);
    tx.objectStore('chunks').delete(chunkRange(id));
    for (const sceneId of draft.mode === 'player' ? draft.sceneIds : [draft.sceneId]) collectScene(tx, request, sceneId);
  });
}
