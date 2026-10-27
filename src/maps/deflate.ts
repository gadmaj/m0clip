/** Bounded streaming adapter for exact-pinned fflate 0.8.3, not a second decoder. */
import { Inflate } from 'fflate';

// Inflate grows and copies BEFORE its callback. RFC1951 emits at most 258 bytes per
// length/distance pair (at least two compressed bits): <=1032 bytes/input byte.
// A partial pair carries <8 bytes; dynamic headers carry <1KiB and emit no body.
// An unfinished stored block buffers <=65541 bytes (including carried header bits)
// and emits <=65535, not 1032x that buffer. One 4096-byte feed emits <4.31MiB.
// fflate's doubling buffer stays <2*(32768 + 4.31MiB + 131072); the callback copy,
// old/history buffers, bounded Huffman tables and input concatenation fit in 16MiB.
// Callers reserve that workspace separately from owned output BEFORE construction.
// Callback rejection bounds retained output, NOT codec allocation.
export const deflateFeedBytes = 4096;
export const deflateWorkspaceBytes = 16 * 1024 * 1024;
const maxCarryBytes = 65536 + 16;

interface CheckedInflate {
  readonly p: Uint8Array;
  readonly o: Uint8Array;
  readonly s: {
    readonly i: number;
    readonly b: number;
    readonly p?: number;
    readonly f?: number;
    readonly l?: Uint16Array | null;
  };
}
function fail(message: string): never { throw new Error(`Deflate: ${message}`); }
/** A dependency/layout change fails closed instead of weakening EOF accounting. */
function checkedInflate(value: unknown): CheckedInflate {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Inflate.prototype ||
      !('p' in value) || !(value.p instanceof Uint8Array) ||
      !('o' in value) || !(value.o instanceof Uint8Array) || value.o.length > 32768 ||
      !('s' in value) || !value.s || typeof value.s !== 'object') fail('unsupported pinned fflate 0.8.3 runtime layout');
  const state = value.s;
  if (!('i' in state) || state.i !== 0 && state.i !== 1 ||
      !('b' in state) || typeof state.b !== 'number' || !Number.isInteger(state.b) || state.b < 0 || state.b > 32768 ||
      'p' in state && (typeof state.p !== 'number' || !Number.isInteger(state.p) || state.p < 0 || state.p > 7) ||
      'f' in state && state.f !== 0 && state.f !== 1 ||
      'l' in state && state.l !== null && !(state.l instanceof Uint16Array)) fail('unsupported pinned fflate 0.8.3 state layout');
  if (value.p.length > maxCarryBytes) fail('retained input exceeds bounded carry');
  return value as CheckedInflate;
}

/** Enforces feed/carry/output bounds and exact compressed EOF on a single member.
 * Callers own collection and CRC; finish() requires both declared lengths exactly.
 * Public Inflate's callback final flag is NOT an end-of-stream receipt. */
export class BoundedInflate {
  private readonly inflate: Inflate;
  private compressedBytes = 0;
  private outputBytes = 0;
  private ended = false;
  constructor(
    private readonly expectedCompressedBytes: number,
    private readonly expectedOutputBytes: number,
    ondata: (chunk: Uint8Array) => void,
    private readonly signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(expectedCompressedBytes) || expectedCompressedBytes < 0 ||
        !Number.isSafeInteger(expectedOutputBytes) || expectedOutputBytes < 0) fail('invalid declared byte count');
    signal?.throwIfAborted();
    this.inflate = new Inflate(chunk => {
      signal?.throwIfAborted();
      if (chunk.length > expectedOutputBytes - this.outputBytes) fail('inflated body exceeds declared size');
      this.outputBytes += chunk.length;
      if (chunk.length) ondata(chunk);
    });
    checkedInflate(this.inflate);
  }
  push(bytes: Uint8Array) {
    this.signal?.throwIfAborted();
    if (this.ended) fail('trailing bytes after Deflate end');
    if (!bytes.length || bytes.length > deflateFeedBytes || bytes.length > this.expectedCompressedBytes - this.compressedBytes) fail('invalid or oversized input feed');
    // BEFORE Inflate.e() can concatenate any new input onto retained carry.
    checkedInflate(this.inflate);
    this.compressedBytes += bytes.length;
    this.inflate.push(bytes, this.compressedBytes === this.expectedCompressedBytes);
    const state = checkedInflate(this.inflate);
    if (state.s.f === 1 && !state.s.l) {
      this.ended = true;
      // Only the byte containing final partial bits may remain, never whole bytes.
      const partialByte = (state.s.p ?? 0) > 0 ? 1 : 0;
      if (state.p.length !== partialByte || this.compressedBytes !== this.expectedCompressedBytes) fail('trailing bytes after Deflate end');
    }
  }
  finish() {
    this.signal?.throwIfAborted();
    if (!this.ended || this.compressedBytes !== this.expectedCompressedBytes) fail('missing Deflate stream end');
    if (this.outputBytes !== this.expectedOutputBytes) fail('wrong decompressed byte count');
  }
}
