/** Source VTF 7.0–7.5 header and image layout. Layout follows noclip.website SourceEngine/VTF.ts
 * (Copyright (c) 2018 Jasper St. Pierre, MIT; LICENSE.noclip) and the field order of the VTF 7.x
 * header (packed: low-res size at 61/62, depth at 63, resource count at 68, resources at 80).
 *
 * Image data runs from the smallest mip to the largest; inside each mip come every frame, then
 * every face, then every depth slice. Rows are stored top first, so pixel row 0 is texture v = 0 in
 * Source's UV convention. Every authored mip level is kept; nothing is regenerated, resampled,
 * flipped or converted here. Volume textures and formats outside SUPPORTED_VTF_FORMATS are refused
 * by name, as are headers or offsets that don't fit the file. */

export class SourceVtfError extends Error {
  constructor(readonly path: string, readonly detail: string, readonly unsupported = false) {
    super(`Source texture ${path}: ${detail}`);
    this.name = 'SourceVtfError';
  }
}

/** Source ImageFormat numbers, names and storage (bytes per pixel, or bytes per 4×4 block). */
const formats: readonly (readonly [name: string, bytes: number, block: boolean])[] = [
  ['RGBA8888', 4, false], ['ABGR8888', 4, false], ['RGB888', 3, false], ['BGR888', 3, false], ['RGB565', 2, false],
  ['I8', 1, false], ['IA88', 2, false], ['P8', 1, false], ['A8', 1, false], ['RGB888_BLUESCREEN', 3, false],
  ['BGR888_BLUESCREEN', 3, false], ['ARGB8888', 4, false], ['BGRA8888', 4, false], ['DXT1', 8, true], ['DXT3', 16, true],
  ['DXT5', 16, true], ['BGRX8888', 4, false], ['BGR565', 2, false], ['BGRX5551', 2, false], ['BGRA4444', 2, false],
  ['DXT1_ONEBITALPHA', 8, true], ['BGRA5551', 2, false], ['UV88', 2, false], ['UVWQ8888', 4, false],
  ['RGBA16161616F', 8, false], ['RGBA16161616', 8, false], ['UVLX8888', 4, false],
];

/** Formats whose texels decode exactly, either as WebGL S3TC blocks or into RGBA8. */
export const SUPPORTED_VTF_FORMATS: ReadonlySet<number> = new Set([0, 1, 2, 3, 5, 6, 8, 11, 12, 13, 14, 15, 16, 20]);
export const VTF_BLOCK_FORMATS: ReadonlySet<number> = new Set([13, 14, 15, 20]);

export const VtfFlags = Object.freeze({
  POINTSAMPLE: 0x1, TRILINEAR: 0x2, CLAMPS: 0x4, CLAMPT: 0x8, ANISOTROPIC: 0x10, HINT_DXT5: 0x20, NOCOMPRESS: 0x40,
  NORMAL: 0x80, NOMIP: 0x100, NOLOD: 0x200, MINMIP: 0x400, PROCEDURAL: 0x800, ONEBITALPHA: 0x1000, EIGHTBITALPHA: 0x2000,
  ENVMAP: 0x4000, RENDERTARGET: 0x8000, DEPTHRENDERTARGET: 0x10000, NODEBUGOVERRIDE: 0x20000, SINGLECOPY: 0x40000,
  ONEOVERMIPLEVELINALPHA: 0x80000, PREMULTCOLORBYONEOVERMIPLEVEL: 0x100000, NORMALTODUDV: 0x200000,
  ALPHATESTMIPGENERATION: 0x400000, NODEPTHBUFFER: 0x800000, NICEFILTERED: 0x1000000, CLAMPU: 0x2000000,
});

export function vtfFormatName(format: number): string {
  return formats[format]?.[0] ?? (format === 0xffffffff ? 'NONE' : `unknown format ${format}`);
}

export function vtfFlagNames(flags: number): string[] {
  const names: string[] = [];
  let known = 0;
  for (const [name, bit] of Object.entries(VtfFlags)) { known |= bit; if (flags & bit) names.push(name); }
  const rest = (flags & ~known) >>> 0;
  if (rest) names.push(`0x${rest.toString(16)}`);
  return names;
}

function levelBytes(format: number, width: number, height: number): number {
  const entry = formats[format];
  if (!entry) return -1;
  return entry[2] ? Math.ceil(width / 4) * Math.ceil(height / 4) * entry[1] : width * height * entry[1];
}

export interface SourceVtfResource {
  /** Three-byte tag as text ("\x01\0\0" low-res, "0\0\0" image, "CRC", "LOD", "TSO", "KVD"…). */
  readonly tag: string;
  readonly flags: number;
  /** Byte offset of the resource data, or its inline value when flags has bit 0x2. */
  readonly data: number;
}

export interface SourceVtfHeader {
  readonly version: readonly [7, number];
  readonly headerSize: number;
  readonly width: number;
  readonly height: number;
  readonly flags: number;
  readonly flagNames: readonly string[];
  readonly frames: number;
  readonly firstFrame: number;
  readonly reflectivity: readonly [number, number, number];
  readonly bumpScale: number;
  readonly format: number;
  readonly formatName: string;
  /** Authored mip levels, largest first, as stored. */
  readonly mipCount: number;
  readonly lowRes: Readonly<{ format: number; formatName: string; width: number; height: number; offset: number; bytes: number }> | null;
  readonly depth: number;
  /** Faces the material system uses: 6 for cube maps, else 1. */
  readonly faces: number;
  /** Faces stored per frame: a seventh sphere-map face for cube maps before 7.5 (unless firstFrame is 0xffff). */
  readonly storedFaces: number;
  readonly resources: readonly SourceVtfResource[];
  readonly imageOffset: number;
  readonly imageBytes: number;
  readonly fileBytes: number;
}

export interface SourceVtfLevel { readonly width: number; readonly height: number; readonly data: Uint8Array }

export interface SourceVtf {
  readonly path: string;
  readonly header: SourceVtfHeader;
  /** Levels of one frame and face, largest first. Views into the file bytes, not copies. */
  levels(frame: number, face: number): SourceVtfLevel[];
}

export function readSourceVtf(path: string, bytes: Uint8Array<ArrayBuffer>): SourceVtf {
  const fail = (detail: string, unsupported = false): never => { throw new SourceVtfError(path, detail, unsupported); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.byteLength;
  if (size < 64) fail(`the file is ${size} bytes, shorter than a VTF header.`);
  if (view.getUint32(0, true) !== 0x00465456) fail('it doesn\'t start with the VTF signature.');
  const major = view.getUint32(4, true), minor = view.getUint32(8, true);
  if (major !== 7 || minor > 5) fail(`VTF version ${major}.${minor} isn't supported (7.0 to 7.5 are).`, true);
  const headerSize = view.getUint32(12, true);
  const minimum = minor >= 3 ? 80 : minor === 2 ? 80 : 64;
  if (size < minimum) fail(`the file is ${size} bytes, shorter than a 7.${minor} header.`);
  const width = view.getUint16(16, true), height = view.getUint16(18, true), flags = view.getUint32(20, true);
  const frames = view.getUint16(24, true), firstFrame = view.getUint16(26, true);
  const reflectivity = [view.getFloat32(32, true), view.getFloat32(36, true), view.getFloat32(40, true)] as const;
  const bumpScale = view.getFloat32(48, true), format = view.getUint32(52, true), mipCount = view.getUint8(56);
  const lowFormat = view.getUint32(57, true), lowWidth = view.getUint8(61), lowHeight = view.getUint8(62);
  const depth = minor >= 2 ? view.getUint16(63, true) : 1;
  const resourceCount = minor >= 3 ? view.getUint32(68, true) : 0;

  if (!width || !height) fail(`it is ${width}×${height}.`);
  if (!frames) fail('it has no frames.');
  if (!formats[format]) fail(`its image format ${format} isn't a Source format.`);
  if (depth > 1) fail(`it is a ${depth}-slice volume texture, which isn't supported.`, true);
  const chain = 1 + Math.floor(Math.log2(Math.max(width, height)));
  if (mipCount < 1 || mipCount > chain) fail(`it declares ${mipCount} mip levels; a ${width}×${height} texture has 1 to ${chain}.`);
  if (headerSize < minimum + resourceCount * 8 || headerSize > size)
    fail(`its header size ${headerSize} doesn't fit a 7.${minor} header with ${resourceCount} resources in ${size} bytes.`);

  const cube = !!(flags & VtfFlags.ENVMAP);
  const faces = cube ? 6 : 1;
  const storedFaces = cube && minor < 5 && firstFrame !== 0xffff ? 7 : faces;

  let lowRes: SourceVtfHeader['lowRes'] = null;
  const resources: SourceVtfResource[] = [];
  let imageOffset: number;
  if (minor >= 3) {
    let image = -1, low = -1;
    for (let i = 0; i < resourceCount; i++) {
      const at = 80 + i * 8;
      const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2]);
      const resource = Object.freeze({ tag, flags: bytes[at + 3], data: view.getUint32(at + 4, true) });
      resources.push(resource);
      if (resource.flags & 2) continue;
      if (tag === '0\0\0') { if (image >= 0) fail('it has two image resources.'); image = resource.data; }
      else if (tag === '\x01\0\0') { if (low >= 0) fail('it has two low-res image resources.'); low = resource.data; }
    }
    if (image < 0) fail('it has no image resource.');
    imageOffset = image;
    if (low >= 0 && lowFormat !== 0xffffffff) {
      const bytesLow = levelBytes(lowFormat, lowWidth, lowHeight);
      if (bytesLow < 0 || low + bytesLow > size) fail('its low-res image doesn\'t fit the file.');
      lowRes = Object.freeze({ format: lowFormat, formatName: vtfFormatName(lowFormat), width: lowWidth, height: lowHeight, offset: low, bytes: bytesLow });
    }
  } else {
    imageOffset = headerSize;
    if (lowFormat !== 0xffffffff) {
      const bytesLow = levelBytes(lowFormat, lowWidth, lowHeight);
      if (bytesLow < 0) fail(`its low-res image format ${lowFormat} isn't a Source format.`);
      lowRes = Object.freeze({ format: lowFormat, formatName: vtfFormatName(lowFormat), width: lowWidth, height: lowHeight, offset: headerSize, bytes: bytesLow });
      imageOffset += bytesLow;
    }
  }

  const per = frames * storedFaces;
  const offsets: number[] = new Array(mipCount);
  let cursor = imageOffset;
  for (let level = mipCount - 1; level >= 0; level--) {
    offsets[level] = cursor;
    cursor += levelBytes(format, Math.max(1, width >> level), Math.max(1, height >> level)) * per;
  }
  if (cursor > size) fail(`its image data needs ${cursor - imageOffset} bytes from offset ${imageOffset}, past the ${size}-byte file.`);

  const header: SourceVtfHeader = Object.freeze({
    version: Object.freeze([7, minor] as const), headerSize, width, height, flags, flagNames: Object.freeze(vtfFlagNames(flags)),
    frames, firstFrame, reflectivity: Object.freeze(reflectivity), bumpScale, format, formatName: vtfFormatName(format), mipCount,
    lowRes, depth: Math.max(depth, 1), faces, storedFaces, resources: Object.freeze(resources), imageOffset,
    imageBytes: cursor - imageOffset, fileBytes: size,
  });
  return Object.freeze({
    path, header,
    levels(frame: number, face: number): SourceVtfLevel[] {
      if (!Number.isInteger(frame) || frame < 0 || frame >= frames) fail(`frame ${frame} was asked for; it has ${frames}.`);
      if (!Number.isInteger(face) || face < 0 || face >= faces) fail(`face ${face} was asked for; it has ${faces}.`);
      const levels: SourceVtfLevel[] = new Array(mipCount);
      for (let level = 0; level < mipCount; level++) {
        const w = Math.max(1, width >> level), h = Math.max(1, height >> level), n = levelBytes(format, w, h);
        const at = offsets[level] + (frame * storedFaces + face) * n;
        levels[level] = { width: w, height: h, data: bytes.subarray(at, at + n) };
      }
      return levels;
    },
  });
}
