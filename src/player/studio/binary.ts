/** Bounded little-endian reads over one Studio file (MDL, VVD, VTX or ANI). Every read checks its
 * range, so a truncated or corrupt file raises a StudioFormatError naming the file and the field
 * instead of returning garbage. */

export class StudioFormatError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`Studio model ${path}: ${detail}`);
    this.name = 'StudioFormatError';
  }
}

/** Raised for authored data this decoder does not evaluate. Nothing is replaced by a bind pose,
 * a default or a substitute; the model is refused and the feature named. */
export class StudioUnsupportedError extends Error {
  constructor(readonly path: string, readonly feature: string) {
    super(`Studio model ${path} uses ${feature}, which m0clip can't decode yet.`);
    this.name = 'StudioUnsupportedError';
  }
}

const latin1 = new TextDecoder('latin1');

export class BinaryFile {
  readonly view: DataView;
  readonly length: number;

  constructor(readonly path: string, readonly bytes: Uint8Array<ArrayBuffer>) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }

  fail(detail: string): never { throw new StudioFormatError(this.path, detail); }

  /** Refuses [offset, offset+size) unless it lies inside the file. */
  range(offset: number, size: number, what: string): number {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > this.length)
      this.fail(`${what} (${size} bytes at ${offset}) lies outside the ${this.length}-byte file`);
    return offset;
  }

  /** Array of count records of stride bytes at offset; count must be a sane non-negative int. */
  table(offset: number, count: number, stride: number, what: string): number {
    if (!Number.isSafeInteger(count) || count < 0) this.fail(`${what} has invalid count ${count}`);
    if (count === 0) return offset;
    return this.range(offset, count*stride, `${what} table of ${count}`);
  }

  u8(o: number): number { this.range(o, 1, 'byte'); return this.view.getUint8(o); }
  i8(o: number): number { this.range(o, 1, 'byte'); return this.view.getInt8(o); }
  u16(o: number): number { this.range(o, 2, 'u16'); return this.view.getUint16(o, true); }
  i16(o: number): number { this.range(o, 2, 'i16'); return this.view.getInt16(o, true); }
  u32(o: number): number { this.range(o, 4, 'u32'); return this.view.getUint32(o, true); }
  i32(o: number): number { this.range(o, 4, 'i32'); return this.view.getInt32(o, true); }
  f32(o: number): number {
    this.range(o, 4, 'float');
    const value = this.view.getFloat32(o, true);
    if (!Number.isFinite(value)) this.fail(`non-finite float at ${o}`);
    return value;
  }

  /** NUL-terminated string starting at o. */
  cstring(o: number, what: string): string {
    this.range(o, 1, what);
    const end = this.bytes.indexOf(0, o);
    if (end < 0) this.fail(`${what} at ${o} is not NUL-terminated`);
    return latin1.decode(this.bytes.subarray(o, end));
  }

  /** Float kept exactly as authored, NaN included (studiomdl writes NaN event cycles and layer
   * ramps for one-frame animations). */
  f32Authored(o: number): number { this.range(o, 4, 'float'); return this.view.getFloat32(o, true); }

  /** String at base+relative; a zero relative offset is the empty string when allowEmpty. */
  relString(base: number, relative: number, what: string, allowEmpty = false): string {
    if (relative === 0 && allowEmpty) return '';
    return this.cstring(base + relative, what);
  }

  /** Fixed-size char array; stops at the first NUL. */
  fixedString(o: number, size: number, what: string): string {
    this.range(o, size, what);
    const slice = this.bytes.subarray(o, o + size);
    const end = slice.indexOf(0);
    return latin1.decode(end < 0 ? slice : slice.subarray(0, end));
  }

  floats(o: number, count: number, what: string): Float32Array {
    this.range(o, count*4, what);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.f32(o + i*4);
    return out;
  }
}
