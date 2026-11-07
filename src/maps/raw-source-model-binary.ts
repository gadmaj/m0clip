// Source studio/placement algorithms adapted from noclip.website (Copyright
// 2018 Jasper St. Pierre, MIT; see LICENSE.noclip) and scripts/source_models.py.
export type SourceModelVector = [number, number, number];
export class SourceModelBinary {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array, readonly name: string) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  range(offset: number, count: number, stride = 1): number {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || !Number.isSafeInteger(stride) || offset < 0 || count < 0 || stride < 1 || offset > this.bytes.length || count > Math.floor((this.bytes.length - offset) / stride)) throw new Error(`${this.name}: out-of-bounds range ${offset}+${count}*${stride}`);
    return offset;
  }
  u(p: number): number { return this.view.getUint32(this.range(p, 4), true); }
  i(p: number): number { return this.view.getInt32(this.range(p, 4), true); }
  h(p: number): number { return this.view.getUint16(this.range(p, 2), true); }
  b(p: number): number { return this.view.getUint8(this.range(p, 1)); }
  f(p: number): number {
    const value = this.view.getFloat32(this.range(p, 4), true);
    if (!Number.isFinite(value)) throw new Error(`${this.name}: nonfinite float at ${p}`);
    return value;
  }
  vec(p: number): SourceModelVector { return [this.f(p), this.f(p + 4), this.f(p + 8)]; }
  string(p: number, maximum = this.bytes.length - p): string {
    this.range(p, maximum);
    const end = this.bytes.indexOf(0, p);
    if (end < p || end >= p + maximum) throw new Error(`${this.name}: unterminated string at ${p}`);
    // Studio strings are byte strings, not UTF-8 URL paths.
    let result = '';
    for (let i = p; i < end; i++) result += String.fromCharCode(this.bytes[i]);
    return result;
  }
  relativeString(base: number, field: number): string { return this.string(base + this.i(base + field)); }
  table(header: number, stride: number): { offset: number; count: number } {
    const count = this.u(header), offset = this.u(header + 4);
    this.range(offset, count, stride);
    return { offset, count };
  }
}
export function sourceModelPath(value: string): string {
  const path = value.replace(/\\/g, '/').toLowerCase();
  if (!path || /^(?:\/|[a-z]:)/.test(path) || /[\0\r\n]/.test(path) || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error(`Unsafe Source model resource path: ${value}`);
  return path;
}
/** Column-major Source QAngle Rz(yaw)*Ry(pitch)*Rx(roll), not XYZ Euler. */
export function sourceQAngle(angles: readonly number[]): Float64Array {
  const [p, y, r] = angles.map(v => v * Math.PI / 180);
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(r), cr = Math.cos(r);
  return new Float64Array([cp*cy, cp*sy, -sp, 0, sp*sr*cy-cr*sy, sp*sr*sy+cr*cy, sr*cp, 0, sp*cr*cy+sr*sy, sp*cr*sy-sr*cy, cr*cp, 0, 0, 0, 0, 1]);
}
export function sourceModelMultiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c*4+r] += a[k*4+r]*b[c*4+k];
  return out;
}
export function sourceModelPoint(matrix: Float64Array, p: readonly number[]): SourceModelVector {
  return [matrix[0]*p[0]+matrix[4]*p[1]+matrix[8]*p[2]+matrix[12], matrix[1]*p[0]+matrix[5]*p[1]+matrix[9]*p[2]+matrix[13], matrix[2]*p[0]+matrix[6]*p[1]+matrix[10]*p[2]+matrix[14]];
}
