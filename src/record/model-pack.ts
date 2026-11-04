/** Binary-safe packing for recorded scenes. Typed arrays travel as raw little-endian files beside a
 * small JSON document, never as JSON number lists. Mesh bodies are content-addressed (SHA-256 of the
 * vertex and face bytes), so the epochs of one Player take, and different takes on the same map,
 * store each repeated body once. */
import type { RenderModel } from '../sim/protocol';

type Typed = Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array;
const ARRAYS = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u32: Uint32Array, u8: Uint8Array } as const;
type ArrayKind = keyof typeof ARRAYS;
interface ArrayRef { $array: ArrayKind; file: string; length: number }

function kindOf(value: unknown): ArrayKind | null {
  if (value instanceof Float32Array) return 'f32';
  if (value instanceof Float64Array) return 'f64';
  if (value instanceof Int32Array) return 'i32';
  if (value instanceof Uint32Array) return 'u32';
  if (value instanceof Uint8Array) return 'u8';
  return null;
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Replace every typed array below `value` with a file reference. The bytes are views, not copies. */
export function encodeBinary(value: unknown, path: string, files: Record<string, Uint8Array>): unknown {
  const kind = kindOf(value);
  if (kind) {
    const array = value as Typed, file = `${path}.${kind}`;
    if (files[file]) throw new Error(`Take file: duplicate binary member ${file}.`);
    files[file] = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    return { $array: kind, file, length: array.length } satisfies ArrayRef;
  }
  if (ArrayBuffer.isView(value)) throw new Error(`Take file: unsupported binary member at ${path}.`);
  if (Array.isArray(value)) return value.map((item, i) => encodeBinary(item, `${path}/${i}`, files));
  if (plain(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = encodeBinary(item, `${path}/${key}`, files);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Take file: non-finite number at ${path}.`);
  return value;
}

/** Inverse of encodeBinary. Each array gets its own aligned buffer; missing or resized members throw. */
export function decodeBinary(value: unknown, files: Record<string, Uint8Array>): unknown {
  if (Array.isArray(value)) return value.map(item => decodeBinary(item, files));
  if (!plain(value)) return value;
  if ('$array' in value) {
    const ref = value as unknown as ArrayRef, Ctor = ARRAYS[ref.$array], bytes = files[ref.file];
    if (!Ctor || typeof ref.file !== 'string' || !Number.isSafeInteger(ref.length) || ref.length < 0 || !bytes
      || bytes.byteLength !== ref.length * Ctor.BYTES_PER_ELEMENT) throw new Error('Take file: invalid binary member.');
    return new Ctor(bytes.slice().buffer);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Take file: invalid member name.');
    out[key] = decodeBinary(item, files);
  }
  return out;
}

export interface PackedMesh { name: string; pos: [number, number, number]; quat: [number, number, number, number]; body: string }
export type PackedModel = Omit<RenderModel, 'meshes'> & { meshes: Record<number, PackedMesh> };
export interface MeshBody { id: string; vert: Float32Array; face: Uint32Array }
export interface PackedScene { model: PackedModel; bodies: MeshBody[] }

async function sha256(view: ArrayBufferView<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

// Recorded models are immutable, so one digest pass per model object serves every later save.
const packed = new WeakMap<RenderModel, Promise<PackedScene>>();
export function packModel(model: RenderModel): Promise<PackedScene> {
  let result = packed.get(model);
  if (!result) {
    result = (async () => {
      const bodies = new Map<string, MeshBody>(), meshes: Record<number, PackedMesh> = {};
      for (const [key, mesh] of Object.entries(model.meshes)) {
        const vert = mesh.vert as Float32Array<ArrayBuffer>, face = mesh.face as Uint32Array<ArrayBuffer>;
        const id = `${await sha256(vert)}-${await sha256(face)}`;
        if (!bodies.has(id)) bodies.set(id, { id, vert, face });
        meshes[Number(key)] = { name: mesh.name, pos: [...mesh.pos], quat: [...mesh.quat], body: id };
      }
      return { model: { ...model, meshes }, bodies: [...bodies.values()] };
    })();
    packed.set(model, result);
    result.catch(() => packed.delete(model));
  }
  return result;
}

/** Rebuild a RenderModel; bodies shared by several meshes or epochs stay one buffer. */
export function unpackModel(model: PackedModel, bodies: ReadonlyMap<string, MeshBody>): RenderModel {
  if (!plain(model) || !plain(model.meshes)) throw new Error('Recorded scene model is invalid.');
  const meshes: RenderModel['meshes'] = {};
  for (const [key, mesh] of Object.entries(model.meshes)) {
    const body = plain(mesh) && typeof mesh.body === 'string' ? bodies.get(mesh.body) : undefined;
    if (!body || !(body.vert instanceof Float32Array) || !(body.face instanceof Uint32Array))
      throw new Error('Recorded scene model is missing a mesh body.');
    meshes[Number(key)] = { name: mesh.name, pos: mesh.pos, quat: mesh.quat, vert: body.vert, face: body.face };
  }
  return { ...model, meshes };
}
