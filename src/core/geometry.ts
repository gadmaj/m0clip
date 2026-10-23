export const GEOM_STRIDE = 7;
export interface GeometryPartition { readonly fixedIds: Uint32Array; readonly fixed: Float32Array }
export interface GeometryData { readonly fixedIds: Uint32Array; readonly values: Float32Array }
export function denseGeometryPartition(): GeometryPartition { return { fixedIds: new Uint32Array(0), fixed: new Float32Array(0) }; }
function validIds(ids: unknown, ngeom: number): ids is Uint32Array {
  if (!(ids instanceof Uint32Array) || !Number.isSafeInteger(ngeom) || ngeom < 0 || ids.length > ngeom) return false;
  for (let i = 0; i < ids.length; i++) if (ids[i] >= ngeom || (i > 0 && ids[i] <= ids[i - 1])) return false;
  return true;
}
export function validGeometryPartition(value: unknown, ngeom: number): value is GeometryPartition {
  if (!value || typeof value !== 'object') return false;
  const v = value as GeometryPartition;
  return validIds(v.fixedIds, ngeom) && v.fixed instanceof Float32Array && v.fixed.length === v.fixedIds.length * GEOM_STRIDE;
}
export function validGeometryData(value: unknown, ngeom: number, frames: number): value is GeometryData {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(frames) || frames < 0) return false;
  const v = value as GeometryData;
  return validIds(v.fixedIds, ngeom) && v.values instanceof Float32Array
    && v.values.length === GEOM_STRIDE * (v.fixedIds.length + frames * (ngeom - v.fixedIds.length));
}
export class GeometryTrack {
  readonly fixedIds: Uint32Array;
  readonly values: Float32Array;
  readonly movingCount: number;
  private rows?: Int32Array;
  private movingIds?: Uint32Array;
  constructor(readonly ngeom: number, readonly frames: number, data: GeometryData) {
    if (!validGeometryData(data, ngeom, frames)) throw new Error('Invalid geometry data');
    this.fixedIds = data.fixedIds; this.values = data.values; this.movingCount = ngeom - data.fixedIds.length;
  }
  private indexRows(): Int32Array {
    if (!this.rows) {
      this.rows = new Int32Array(this.ngeom);
      this.movingIds = new Uint32Array(this.movingCount);
      let fixed = 0, moving = 0;
      for (let g = 0; g < this.ngeom; g++) {
        if (fixed < this.fixedIds.length && this.fixedIds[fixed] === g) this.rows[g] = -(++fixed);
        else { this.rows[g] = moving; this.movingIds[moving++] = g; }
      }
    }
    return this.rows;
  }
  movingGeom(row: number): number {
    if (!this.fixedIds.length) return row;
    this.indexRows();
    return this.movingIds![row];
  }
  offset(frame: number, geom: number): number {
    if (!this.fixedIds.length) return (frame * this.ngeom + geom) * GEOM_STRIDE;
    const row = this.indexRows()[geom];
    return (row < 0 ? -row - 1 : this.fixedIds.length + frame * this.movingCount + row) * GEOM_STRIDE;
  }
  isFixed(geom: number): boolean { return this.fixedIds.length > 0 && this.indexRows()[geom] < 0; }
  toData(): GeometryData { return { fixedIds: this.fixedIds, values: this.values }; }
  static dense(ngeom: number, frames: number, values: Float32Array): GeometryTrack {
    return new GeometryTrack(ngeom, frames, { fixedIds: new Uint32Array(0), values });
  }
}
/** Row-major 3x3 → unit wxyz quaternion (Shepperd), written to out[o..o+3]. */
export function matToQuat(m: ArrayLike<number>, mo: number, out: Float32Array, o: number) {
  const m00 = m[mo], m01 = m[mo + 1], m02 = m[mo + 2];
  const m10 = m[mo + 3], m11 = m[mo + 4], m12 = m[mo + 5];
  const m20 = m[mo + 6], m21 = m[mo + 7], m22 = m[mo + 8];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  out[o] = w / n; out[o + 1] = x / n; out[o + 2] = y / n; out[o + 3] = z / n;
}

/** Unit wxyz quaternion → row-major 3x3 at out[o..o+8]. */
export function quatToMat(w: number, x: number, y: number, z: number, out: Float32Array, o: number) {
  out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y - z * w); out[o + 2] = 2 * (x * z + y * w);
  out[o + 3] = 2 * (x * y + z * w); out[o + 4] = 1 - 2 * (x * x + z * z); out[o + 5] = 2 * (y * z - x * w);
  out[o + 6] = 2 * (x * z - y * w); out[o + 7] = 2 * (y * z + x * w); out[o + 8] = 1 - 2 * (x * x + y * y);
}

/** Short-arc normalized lerp of two wxyz quaternions (frames are 20 ms apart: as good as slerp). */
export function nlerp(q: ArrayLike<number>, a: number, b: number, f: number, out: Float32Array | Float64Array, o: number) {
  const s = q[a] * q[b] + q[a + 1] * q[b + 1] + q[a + 2] * q[b + 2] + q[a + 3] * q[b + 3] < 0 ? -1 : 1;
  const w = q[a] + (s * q[b] - q[a]) * f, x = q[a + 1] + (s * q[b + 1] - q[a + 1]) * f;
  const y = q[a + 2] + (s * q[b + 2] - q[a + 2]) * f, z = q[a + 3] + (s * q[b + 3] - q[a + 3]) * f;
  const n = Math.hypot(w, x, y, z) || 1;
  out[o] = w / n; out[o + 1] = x / n; out[o + 2] = y / n; out[o + 3] = z / n;
}
