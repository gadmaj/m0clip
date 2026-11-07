/**
 * CPU-only VTF 7.0–7.5 reader. Layout/format references: noclip.website
 * SourceEngine/VTF.ts, Copyright (c) 2018 Jasper St. Pierre (MIT; LICENSE.noclip),
 * and m0clip's source_assets.py / render/source-vtf.ts. No renderer or image encoder.
 * The file SRGB flag is only a hint: Source materials decide texture sampling space.
 * Supported formats: RGBA/ABGR/RGB/BGR888[8], I8, IA88, A8, ARGB/BGRA8888,
 * BGRX8888, DXT1/3/5, DXT1_ONEBITALPHA, BGRA5551, signed UV88 and RGBA16F.
 * Volume slices/mips retain their native storage order; volume/nonsquare cubemaps,
 * other image formats and unknown resource flag encodings fail explicitly.
 * Pixel output does not reconstruct normal Z, perform HDR tone mapping, rotate cube
 * faces, implement shader effects, decode thumbnails or interpret unknown resources.
 */
import { decodeSourceVtfPixels, sourceVtfSliceBytes, sourceVtfPixelKind } from './raw-source-vtf-codec';

export type SourceVtfColorSpace = 'srgb' | 'unspecified' | 'linear' | 'signed-normalized';
export interface SourceVtfSelection {
  /** Storage index, not the animation's firstFrame. Defaults to zero. */
  readonly frame?: number;
  /** Native face order; face 6 is the optional legacy spheremap. Defaults to zero. */
  readonly face?: number;
  /** Zero is the largest level. Defaults to zero. */
  readonly mip?: number;
  /** Slice within the selected mip's depth. Defaults to zero. */
  readonly z?: number;
}
export interface SourceVtfHeader {
  readonly versionMajor: 7;
  readonly versionMinor: number;
  readonly headerSize: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly flags: number;
  readonly frames: number;
  readonly firstFrame: number;
  readonly mipCount: number;
  readonly format: number;
  readonly faces: 1 | 6;
  readonly storedFaces: 1 | 6 | 7;
  readonly hasSpheremap: boolean;
  readonly reflectivity: readonly [number, number, number];
  readonly bumpScale: number;
  readonly lowResFormat: number;
  readonly lowResWidth: number;
  readonly lowResHeight: number;
  readonly srgbFlag: boolean;
  /** No gamma conversion is performed; unspecified requires material interpretation. */
  readonly colorSpace: SourceVtfColorSpace;
}
export interface SourceVtfResource {
  /** Three-byte tag, little-endian (image = 0x30, thumbnail = 0x01). */
  readonly tag: number;
  readonly flags: number;
  /** Inline four-byte resources have no data range. */
  readonly inlineValue?: number;
  /** Payload only; generic resource size prefixes are excluded. */
  readonly offset?: number;
  readonly byteLength?: number;
}
export interface SourceVtfMip {
  readonly mip: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly offset: number;
  /** One frame/face/z slice's encoded length. */
  readonly sliceBytes: number;
  readonly byteLength: number;
}
export interface SourceVtfEncoded {
  readonly frame: number;
  readonly face: number;
  readonly mip: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly sourceOffset: number;
  readonly sourceByteLength: number;
  /** Blob reads own this range; in-memory input borrows it without copying. */
  readonly data: Uint8Array;
}
export interface SourceVtfDecoded {
  readonly frame: number;
  readonly face: number;
  readonly mip: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly flags: number;
  readonly colorSpace: SourceVtfColorSpace;
  readonly sourceOffset: number;
  readonly sourceByteLength: number;
  /** Always interleaved RGBA. Float output preserves HDR and signed UV values. */
  readonly pixelType: 'rgba8' | 'rgba32f';
  readonly data: Uint8Array | Float32Array;
}
export interface SourceVtf {
  readonly header: Readonly<SourceVtfHeader>;
  readonly resources: readonly Readonly<SourceVtfResource>[];
  /** Largest first, unlike the file's smallest-first storage. */
  readonly levels: readonly Readonly<SourceVtfMip>[];
  encoded(selection?: SourceVtfSelection, signal?: AbortSignal): Promise<SourceVtfEncoded>;
  decode(selection?: SourceVtfSelection, signal?: AbortSignal): Promise<SourceVtfDecoded>;
}
function fail(message: string): never { throw new Error(`Source VTF: ${message}`); }
/** In-memory inputs are borrowed: callers must retain them and not mutate/detach them. */
export type SourceVtfInput = Blob | ArrayBuffer | Uint8Array;
function bounds(file: SourceVtfInput, offset: number, length: number, label: string) {
  const size = file instanceof Blob ? file.size : file.byteLength;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || !Number.isSafeInteger(offset + length) || offset + length > size) fail(`truncated/out-of-range ${label} (${offset}+${length}, file ${size})`);
}
async function read(file: SourceVtfInput, offset: number, length: number, label: string, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  bounds(file, offset, length, label);
  const bytes = file instanceof Blob ? new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
    : file instanceof Uint8Array ? file.subarray(offset, offset + length) : new Uint8Array(file, offset, length);
  signal?.throwIfAborted();
  if (bytes.byteLength !== length) fail(`truncated read of ${label}`);
  return bytes;
}
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function index(value: number, count: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value >= count) fail(`${name} ${value} out-of-range (count ${count})`);
}

/** Reads only headers/resource lengths now, and one exact encoded slice per decode call. */
export async function readSourceVtf(file: SourceVtfInput, signal?: AbortSignal): Promise<SourceVtf> {
  const base = view(await read(file, 0, 64, 'header', signal));
  if (base.getUint32(0, true) !== 0x00465456) fail('invalid VTF signature');
  const major = base.getUint32(4, true), minor = base.getUint32(8, true);
  if (major !== 7 || minor > 5) fail(`unsupported version ${major}.${minor}; expected 7.0–7.5`);
  const headerSize = base.getUint32(12, true), minimumHeader = minor >= 2 ? 80 : 64;
  if (headerSize < minimumHeader) fail(`header size ${headerSize} is smaller than ${minimumHeader}`);
  bounds(file, 0, headerSize, 'declared header');
  const extension = minor >= 2 ? view(await read(file, 64, 16, 'extended header', signal)) : undefined;
  const width = base.getUint16(16, true), height = base.getUint16(18, true), flags = base.getUint32(20, true);
  const frames = base.getUint16(24, true), firstFrame = base.getUint16(26, true);
  // Packed VTF7.2 depth spans the base/extension boundary at bytes63–64.
  const depth = extension ? base.getUint8(63) | extension.getUint8(0) << 8 : 1;
  const format = base.getInt32(52, true), mipCount = base.getUint8(56);
  const lowResFormat = base.getInt32(57, true), lowResWidth = base.getUint8(61), lowResHeight = base.getUint8(62);
  if (!width || !height || !depth || !frames) fail('zero texture dimension/depth/frame count');
  if (!mipCount || mipCount > 1 + Math.floor(Math.log2(Math.max(width, height, depth)))) fail('invalid mip count');
  if (firstFrame !== 0xffff && firstFrame >= frames) fail('animation firstFrame exceeds frame count');
  const faces = flags & 0x4000 ? 6 : 1;
  if (faces === 6 && (width !== height || depth !== 1)) fail('unsupported nonsquare or volume cubemap');
  // Before 7.5, firstFrame == 0xffff explicitly omits the seventh legacy sphere face.
  const hasSpheremap = faces === 6 && minor < 5 && firstFrame !== 0xffff;
  const storedFaces = hasSpheremap ? 7 : faces;
  const kind = sourceVtfPixelKind(format); // Unsupported formats fail before any image allocation.
  const colorSpace: SourceVtfColorSpace = kind === 'hdr' ? 'linear' : kind === 'uv' ? 'signed-normalized' : flags & 0x40 ? 'srgb' : 'unspecified';
  const reflectivity = Object.freeze([base.getFloat32(32, true), base.getFloat32(36, true), base.getFloat32(40, true)] as const);
  const bumpScale = base.getFloat32(48, true);
  if (!reflectivity.every(Number.isFinite) || !Number.isFinite(bumpScale)) fail('nonfinite reflectivity/bump scale');
  if (Boolean(lowResWidth) !== Boolean(lowResHeight)) fail('incomplete thumbnail dimensions');
  if (lowResWidth && lowResFormat === -1) fail('thumbnail dimensions without a format');
  const lowBytes = lowResWidth ? sourceVtfSliceBytes(lowResFormat, lowResWidth, lowResHeight) : 0;
  const numResources = minor >= 3 ? extension!.getUint32(4, true) : 0;
  // Valve's fixed resource dictionary capacity is 32 entries.
  if (numResources > 32 || (numResources > 0 && 80 + numResources * 8 > headerSize)) fail('invalid resource directory size');
  const directory = numResources ? view(await read(file, 80, numResources * 8, 'resource directory', signal)) : undefined;
  const entries: { tag: number; flags: number; value: number }[] = [];
  const tags = new Set<number>();
  for (let i = 0; i < numResources; i++) {
    const at = i * 8, tag = directory!.getUint8(at) | directory!.getUint8(at + 1) << 8 | directory!.getUint8(at + 2) << 16;
    const resourceFlags = directory!.getUint8(at + 3), value = directory!.getUint32(at + 4, true);
    if (tags.has(tag)) fail(`duplicate resource tag 0x${tag.toString(16)}`);
    if (resourceFlags & ~2) fail(`unsupported resource flags 0x${resourceFlags.toString(16)}`);
    if ((tag === 0x30 || tag === 1) && resourceFlags & 2) fail('image resource cannot be inline');
    tags.add(tag); entries.push({ tag, flags: resourceFlags, value });
  }
  const imageEntry = entries.find(entry => entry.tag === 0x30), lowEntry = entries.find(entry => entry.tag === 1);
  if (numResources && !imageEntry) fail('image resource is missing');
  if (numResources && Boolean(lowEntry) !== Boolean(lowBytes)) fail('thumbnail resource/header mismatch');
  const imageOffset = imageEntry?.value ?? headerSize + lowBytes;
  const levels: SourceVtfMip[] = Array(mipCount);
  let imageBytes = 0;
  for (let mip = mipCount - 1; mip >= 0; mip--) {
    const w = Math.max(1, width >>> mip), h = Math.max(1, height >>> mip), d = Math.max(1, depth >>> mip);
    const sliceBytes = sourceVtfSliceBytes(format, w, h), byteLength = sliceBytes * d * frames * storedFaces;
    bounds(file, imageOffset + imageBytes, byteLength, `image mip ${mip}`);
    levels[mip] = Object.freeze({ mip, width: w, height: h, depth: d, offset: imageOffset + imageBytes, sliceBytes, byteLength });
    imageBytes += byteLength;
  }
  const resources: SourceVtfResource[] = [];
  const spans: { offset: number; end: number; tag: number }[] = [];
  function span(tag: number, offset: number, length: number, prefix = 0) {
    if (offset < headerSize) fail(`resource 0x${tag.toString(16)} overlaps the header`);
    bounds(file, offset, length + prefix, `resource 0x${tag.toString(16)}`);
    spans.push({ offset, end: offset + prefix + length, tag });
    resources.push(Object.freeze({ tag, flags: 0, offset: offset + prefix, byteLength: length }));
  }
  if (!numResources) {
    if (lowBytes) span(1, headerSize, lowBytes);
    span(0x30, imageOffset, imageBytes);
  } else for (const entry of entries) {
    if (entry.flags & 2) resources.push(Object.freeze({ tag: entry.tag, flags: entry.flags, inlineValue: entry.value }));
    else if (entry.tag === 0x30) span(entry.tag, entry.value, imageBytes);
    else if (entry.tag === 1) span(entry.tag, entry.value, lowBytes);
    else {
      if (entry.value < headerSize) fail('resource size prefix overlaps the header');
      const size = view(await read(file, entry.value, 4, 'resource size prefix', signal)).getUint32(0, true);
      span(entry.tag, entry.value, size, 4);
    }
  }
  spans.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < spans.length; i++) if (spans[i].offset < spans[i - 1].end) fail('overlapping resource data');
  const header: SourceVtfHeader = Object.freeze({ versionMajor: 7, versionMinor: minor, headerSize, width, height, depth, flags, frames, firstFrame, mipCount, format, faces, storedFaces, hasSpheremap, reflectivity, bumpScale, lowResFormat, lowResWidth, lowResHeight, srgbFlag: Boolean(flags & 0x40), colorSpace });
  signal?.throwIfAborted();
  async function encoded(selection: SourceVtfSelection = {}, readSignal: AbortSignal | undefined = signal): Promise<SourceVtfEncoded> {
    readSignal?.throwIfAborted();
    const { frame = 0, face = 0, mip = 0, z = 0 } = selection;
    index(frame, frames, 'frame'); index(face, storedFaces, 'face'); index(mip, mipCount, 'mip');
    const level = levels[mip]; index(z, level.depth, 'z');
    const sourceOffset = level.offset + ((frame * storedFaces + face) * level.depth + z) * level.sliceBytes;
    const data = await read(file, sourceOffset, level.sliceBytes, 'selected image slice', readSignal);
    return { frame, face, mip, z, width: level.width, height: level.height, sourceOffset, sourceByteLength: level.sliceBytes, data };
  }
  return Object.freeze({
    header, resources: Object.freeze(resources), levels: Object.freeze(levels), encoded,
    async decode(selection: SourceVtfSelection = {}, decodeSignal: AbortSignal | undefined = signal): Promise<SourceVtfDecoded> {
      decodeSignal?.throwIfAborted();
      const mip = selection.mip ?? 0;
      index(mip, mipCount, 'mip');
      const level = levels[mip];
      if (level.width * level.height * (kind === 'byte' ? 4 : 16) > 0xffffffff) fail('selected decoded slice exceeds typed-array capacity');
      const selected = await encoded(selection, decodeSignal);
      const data = decodeSourceVtfPixels(selected.data, format, selected.width, selected.height, decodeSignal);
      decodeSignal?.throwIfAborted();
      return { ...selected, format, flags, colorSpace, pixelType: data instanceof Float32Array ? 'rgba32f' : 'rgba8', data };
    },
  });
}
