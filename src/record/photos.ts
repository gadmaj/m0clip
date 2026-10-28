/** Original PNG captures, stored independently from motion and scene records. */
import { connect, transact, object, integer, date } from './storage';

export interface SavedPhotoInfo {
  id: string; name: string; created: string; updated: string; robot: string; terrain: string;
  width: number; height: number; bytes: number; thumbnail: Blob | null;
}
export interface SavedPhoto { info: SavedPhotoInfo; png: Blob }
interface PhotoRecord { id: string; info: SavedPhotoInfo }
interface PhotoData { id: string; png: Blob }
const invalid = () => new Error('Saved PNG data is invalid.');

function validInfo(info: SavedPhotoInfo): boolean {
  return object(info) && typeof info.id === 'string' && !!info.id && typeof info.name === 'string'
    && date(info.created) && date(info.updated) && typeof info.robot === 'string' && typeof info.terrain === 'string'
    && integer(info.width) && info.width > 0 && integer(info.height) && info.height > 0 && integer(info.bytes) && info.bytes > 0
    && (info.thumbnail === null || info.thumbnail instanceof Blob && info.thumbnail.type === 'image/png');
}

/** Check the encoded format as well as the browser decoder; a renamed JPEG is not a PNG capture. */
async function decode(png: Blob): Promise<ImageBitmap> {
  if (!(png instanceof Blob) || png.type !== 'image/png' || png.size < 33) throw invalid();
  const header = new DataView(await png.slice(0, 33).arrayBuffer());
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
    || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) throw invalid();
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw invalid();
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(png, { imageOrientation: 'none' }); }
  catch { throw new Error('PNG capture could not be decoded.'); }
  if (bitmap.width !== width || bitmap.height !== height) { bitmap.close(); throw invalid(); }
  return bitmap;
}

async function preview(bitmap: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, 320 / bitmap.width, 200 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG preview could not be drawn.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { promise, resolve, reject } = Promise.withResolvers<Blob>();
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG preview could not be encoded.')), 'image/png');
    return await promise;
  } finally { canvas.width = 0; canvas.height = 0; }
}

export class PhotoLibrary {
  async save(input: { id: string; name: string; created: string; robot: string; terrain: string; png: Blob }): Promise<SavedPhotoInfo> {
    // Strings and immutable Blob ownership are captured before the first await. Never re-encode the original.
    const { id, name, created, robot, terrain, png } = input;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !date(created)
      || typeof robot !== 'string' || typeof terrain !== 'string') throw invalid();
    const bitmap = await decode(png);
    let info: SavedPhotoInfo;
    try {
      info = { id, name, created, updated: new Date().toISOString(), robot, terrain, width: bitmap.width, height: bitmap.height,
        bytes: png.size, thumbnail: await preview(bitmap) };
    } finally { bitmap.close(); }
    const db = await connect();
    try {
      return await transact<SavedPhotoInfo>(db, ['photos', 'photoData'], 'readwrite', (tx, _request, result) => {
        tx.objectStore('photos').add({ id, info } satisfies PhotoRecord);
        tx.objectStore('photoData').add({ id, png } satisfies PhotoData);
        result(info);
      });
    } finally { db.close(); }
  }

  async list(): Promise<SavedPhotoInfo[]> {
    const db = await connect();
    try {
      return await transact<SavedPhotoInfo[]>(db, ['photos'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('photos').getAll(), (records: PhotoRecord[]) => {
          if (!records.every(record => object(record) && validInfo(record.info) && record.id === record.info.id)) throw invalid();
          result(records.map(record => record.info).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)));
        });
      });
    } finally { db.close(); }
  }

  async open(id: string): Promise<SavedPhoto> {
    const db = await connect();
    let stored: { record: PhotoRecord; data: PhotoData };
    try {
      stored = await transact(db, ['photos', 'photoData'], 'readonly', (tx, request, result) => {
        request(tx.objectStore('photos').get(id), (record: PhotoRecord | undefined) => {
          if (!record) throw new Error('Saved PNG no longer exists.');
          request(tx.objectStore('photoData').get(id), (data: PhotoData) => { result({ record, data }); });
        });
      });
    } finally { db.close(); }
    const { record, data } = stored;
    if (!validInfo(record.info) || record.id !== id || record.info.id !== id || !object(data) || data.id !== id
      || !(data.png instanceof Blob) || data.png.size !== record.info.bytes) throw invalid();
    const bitmap = await decode(data.png);
    try { if (bitmap.width !== record.info.width || bitmap.height !== record.info.height) throw invalid(); }
    finally { bitmap.close(); }
    return { info: record.info, png: data.png };
  }

  /** Name-only edit: the original PNG record is never read or rewritten. */
  async rename(id: string, name: string): Promise<SavedPhotoInfo> {
    if (typeof id !== 'string' || !id) throw invalid();
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label) throw new Error('Name is empty. Enter a name.');
    const db = await connect();
    try {
      return await transact<SavedPhotoInfo>(db, ['photos'], 'readwrite', (tx, request, result) => {
        const store = tx.objectStore('photos');
        request(store.get(id), (record: PhotoRecord | undefined) => {
          if (!record) throw new Error('Saved PNG no longer exists.');
          if (!object(record) || record.id !== id || !validInfo(record.info) || record.info.id !== id) throw invalid();
          record.info.name = label; record.info.updated = new Date().toISOString();
          store.put(record); result(record.info);
        });
      });
    } finally { db.close(); }
  }

  async remove(id: string): Promise<void> {
    const db = await connect();
    try {
      await transact<void>(db, ['photos', 'photoData'], 'readwrite', (tx, _request, result) => {
        tx.objectStore('photos').delete(id); tx.objectStore('photoData').delete(id); result();
      });
    } finally { db.close(); }
  }
}
