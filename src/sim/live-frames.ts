/** Simulation frames in shared memory, read on the page's animation frame.
 *
 * After each input event Chrome defers posted worker messages until the next frame is presented.
 * When the page presents frames slower than key auto-repeat, a held key starves frame messages for
 * the whole hold. The worker therefore writes every frame here as well as posting it: the page
 * reads this mailbox from requestAnimationFrame, which input does not defer, and posted messages
 * remain the complete, ordered stream. Each mailbox travels with the model message whose layout its
 * frames use, so a frame can never overtake its model.
 *
 * Slots are seqlocked: a slot's control word holds `seq + 1` only while it holds that complete
 * frame, and a reader keeps a copy only if the word is unchanged after copying. */
import type { PlayerSimFrame } from '../player/types';
import type { FromWorker } from './protocol';

export type LiveFrame = Extract<FromWorker, { t: 'frame' }>;

export interface LiveFrameLayout {
  /** Moving geom rows per frame. */
  moving: number;
  nq: number;
  /** Player worlds carry player state; robot frames carry none. */
  player: boolean;
}

const MAGIC = 0x4c46524d;
const H_MAGIC = 0, H_LATEST = 1, H_SLOTS = 2, H_SLOT_BYTES = 3, H_MOVING = 4, H_NQ = 5, H_JSON = 6;
const HEADER_BYTES = 32;
/** clock, baseX, baseY, hoist kind (0 absent, 1 null, 2 point), hoist point. */
const SCALARS = 7;
const PLAYER_JSON_BYTES = 16 << 10;
/** Robot takes record posted messages, so live presentation only needs the newest frame. */
const ROBOT_SLOTS = 8;
/** Player takes record from the mailbox in order: about five seconds of 50 Hz frames. */
const PLAYER_SLOTS = 256;
const PLAYER_RING_BYTES = 32 << 20;

/** Byte offsets inside one slot. */
interface SlotLayout {
  scalars: number;
  f32: number;
  /** Start of the player JSON. */
  bytes: number;
  size: number;
}

function slotLayout(moving: number, nq: number, json: number): SlotLayout {
  const scalars = 8, f32 = scalars + 8 * (SCALARS + nq), bytes = f32 + 4 * 12 * moving;
  return { scalars, f32, bytes, size: Math.ceil((bytes + json) / 8) * 8 };
}

/** A mailbox for one model's frames, or null where SharedArrayBuffer cannot reach the page. */
export function createLiveFrameWriter(layout: LiveFrameLayout,
    isolated = globalThis.crossOriginIsolated === true): LiveFrameWriter | null {
  if (!isolated || typeof SharedArrayBuffer !== 'function' || typeof Atomics !== 'object') return null;
  const json = layout.player ? PLAYER_JSON_BYTES : 0, size = slotLayout(layout.moving, layout.nq, json).size;
  const slots = layout.player ? Math.max(ROBOT_SLOTS, Math.min(PLAYER_SLOTS, Math.floor(PLAYER_RING_BYTES / size))) : ROBOT_SLOTS;
  return new LiveFrameWriter(layout, slots);
}

class Views {
  readonly i32: Int32Array;
  readonly f64: Float64Array;
  readonly f32: Float32Array;
  readonly u8: Uint8Array;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.i32 = new Int32Array(buffer); this.f64 = new Float64Array(buffer);
    this.f32 = new Float32Array(buffer); this.u8 = new Uint8Array(buffer);
  }
}

export class LiveFrameWriter {
  readonly buffer: SharedArrayBuffer;
  private readonly v: Views;
  private readonly slot: SlotLayout;
  private readonly encoder = new TextEncoder();
  private readonly scratch: Uint8Array;
  private seq = 0;

  constructor(private readonly layout: LiveFrameLayout, readonly slots: number) {
    if (!Number.isSafeInteger(layout.moving) || layout.moving < 0 || !Number.isSafeInteger(layout.nq) || layout.nq < 0
        || !Number.isSafeInteger(slots) || slots < 1) throw new RangeError('Invalid live frame layout.');
    const json = layout.player ? PLAYER_JSON_BYTES : 0;
    this.slot = slotLayout(layout.moving, layout.nq, json);
    this.scratch = new Uint8Array(json);
    this.buffer = new SharedArrayBuffer(HEADER_BYTES + slots * this.slot.size);
    const v = this.v = new Views(this.buffer), h = v.i32;
    h[H_SLOTS] = slots; h[H_SLOT_BYTES] = this.slot.size; h[H_MOVING] = layout.moving; h[H_NQ] = layout.nq; h[H_JSON] = json;
    Atomics.store(h, H_LATEST, -1);
    Atomics.store(h, H_MAGIC, MAGIC);
  }

  /** Writes the next frame and returns its sequence number, which its posted message carries. A frame
   * the mailbox cannot hold stays unreadable here and reaches the page by message only. */
  write(frame: LiveFrame): number {
    const seq = this.seq++, base = HEADER_BYTES + (seq % this.slots) * this.slot.size, ctrl = base >> 2, i32 = this.v.i32;
    Atomics.store(i32, ctrl, -1);
    if (this.fill(frame, base)) Atomics.store(i32, ctrl, seq + 1);
    Atomics.store(i32, H_LATEST, seq);
    return seq;
  }

  private fill(frame: LiveFrame, base: number): boolean {
    const { moving, nq } = this.layout, { f64, f32, u8, i32 } = this.v, slot = this.slot;
    if (frame.xpos.length !== moving * 3 || frame.xmat.length !== moving * 9 || frame.qpos.length !== nq) return false;
    let json = -1;
    if (frame.player) {
      const text = encodePlayer(frame.player);
      const { read, written } = this.encoder.encodeInto(text, this.scratch);
      if (read !== text.length) return false;
      u8.set(this.scratch.subarray(0, written), base + slot.bytes);
      json = written;
    }
    i32[(base >> 2) + 1] = json;
    const s = (base + slot.scalars) >> 3, h = frame.hoistAnchor;
    f64[s] = frame.clock; f64[s + 1] = frame.baseX; f64[s + 2] = frame.baseY;
    f64[s + 3] = h === undefined ? 0 : h === null ? 1 : 2;
    if (h) { f64[s + 4] = h[0]; f64[s + 5] = h[1]; f64[s + 6] = h[2]; }
    f64.set(frame.qpos, s + SCALARS);
    const p = (base + slot.f32) >> 2;
    f32.set(frame.xpos, p); f32.set(frame.xmat, p + 3 * moving);
    return true;
  }
}

export class LiveFrameReader {
  private readonly v: Views;
  private readonly slots: number;
  private readonly slotBytes: number;
  private readonly json: number;
  private readonly slot: SlotLayout;
  private readonly decoder = new TextDecoder();

  /** The page checks the mailbox against the model message that delivered it. */
  constructor(buffer: SharedArrayBuffer, private readonly expected: { moving: number; nq: number }) {
    const v = this.v = new Views(buffer), h = v.i32;
    if (buffer.byteLength < HEADER_BYTES || Atomics.load(h, H_MAGIC) !== MAGIC || h[H_MOVING] !== expected.moving || h[H_NQ] !== expected.nq)
      throw new RangeError('The live frame mailbox does not match its model.');
    this.slots = h[H_SLOTS]; this.slotBytes = h[H_SLOT_BYTES]; this.json = h[H_JSON];
    this.slot = slotLayout(expected.moving, expected.nq, this.json);
    if (this.slots < 1 || this.slot.size !== this.slotBytes || buffer.byteLength !== HEADER_BYTES + this.slots * this.slotBytes)
      throw new RangeError('The live frame mailbox does not match its model.');
  }

  /** The newest written sequence number, -1 before the first frame. */
  latest(): number { return Atomics.load(this.v.i32, H_LATEST); }

  /** A private copy of frame `seq`, or null when its slot no longer (or never) held it intact. */
  read(seq: number): LiveFrame | null {
    const latest = this.latest();
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > latest || seq <= latest - this.slots) return null;
    const base = HEADER_BYTES + (seq % this.slots) * this.slotBytes, ctrl = base >> 2;
    const { i32, f64, f32, u8 } = this.v, { moving, nq } = this.expected, slot = this.slot;
    if (Atomics.load(i32, ctrl) !== seq + 1) return null;
    const json = i32[ctrl + 1], s = (base + slot.scalars) >> 3, p = (base + slot.f32) >> 2;
    const clock = f64[s], baseX = f64[s + 1], baseY = f64[s + 2], hoist = f64[s + 3];
    const point: [number, number, number] = [f64[s + 4], f64[s + 5], f64[s + 6]];
    const qpos = f64.slice(s + SCALARS, s + SCALARS + nq);
    const xpos = f32.slice(p, p + 3 * moving), xmat = f32.slice(p + 3 * moving, p + 12 * moving);
    const bytes = json >= 0 && json <= this.json ? u8.slice(base + slot.bytes, base + slot.bytes + json) : null;
    // Only a copy the writer did not touch meanwhile is this frame.
    if (Atomics.load(i32, ctrl) !== seq + 1 || (json !== -1 && !bytes)) return null;
    const frame: LiveFrame = { t: 'frame', xpos, xmat, baseX, baseY, clock, qpos, seq };
    if (hoist) frame.hoistAnchor = hoist === 2 ? point : null;
    if (bytes) frame.player = decodePlayer(this.decoder.decode(bytes));
    return frame;
  }
}

/** Worker side: each model message gets a new mailbox, and each frame after it is written there. */
export class LiveFramePublisher {
  private writer: LiveFrameWriter | null = null;
  constructor(private readonly isolated = globalThis.crossOriginIsolated === true) {}

  /** Annotates every outgoing message just before it is posted. */
  annotate(m: FromWorker): void {
    if (m.t === 'model') {
      this.writer = createLiveFrameWriter({ moving: m.desc.ngeom - m.geometry.fixedIds.length, nq: m.desc.nq,
        player: m.desc.mode === 'player' }, this.isolated);
      if (this.writer) m.live = this.writer.buffer;
    } else if (m.t === 'frame' && this.writer) m.seq = this.writer.write(m);
  }
}

/** Exactly-once intake from the mailbox and the posted messages, which deliver the same frames. */
export class LiveFrameIntake {
  private next = 0;
  constructor(private readonly reader: LiveFrameReader | null) {}

  /** Page side: the frames of the model this message delivers. */
  static forModel(m: Extract<FromWorker, { t: 'model' }>): LiveFrameIntake {
    return new LiveFrameIntake(m.live
      ? new LiveFrameReader(m.live, { moving: m.desc.ngeom - m.geometry.fixedIds.length, nq: m.desc.nq }) : null);
  }

  /** Whether a posted frame is new here; false when the mailbox delivered it first. */
  accept(seq: number | undefined): boolean {
    if (!this.reader || seq === undefined) return true;
    if (seq < this.next) return false;
    this.next = seq + 1;
    return true;
  }

  /** Delivers mailbox frames the messages have not. `inOrder` delivers each in turn and leaves any
   * the mailbox no longer holds intact to its message; otherwise only the newest frame is delivered.
   * `deliver` returns false for a frame it did not take: the mailbox offers it again, and its message
   * is still accepted. A frame whose delivery throws counts as taken. */
  drain(inOrder: boolean, deliver: (frame: LiveFrame) => boolean): void {
    const reader = this.reader;
    if (!reader) return;
    const latest = reader.latest();
    for (let seq = inOrder ? this.next : latest; seq >= this.next && seq <= latest; seq++) {
      const frame = reader.read(seq);
      if (!frame) return;
      let taken = true;
      try { taken = deliver(frame); }
      finally { if (taken) this.next = seq + 1; }
      if (!taken) return;
    }
  }
}

/** JSON tags for what plain JSON cannot carry exactly. */
const F64 = '$f64', NUM = '$num';

/** JSON that decodes to an identical frame: typed arrays stay typed; NaN, ±Infinity and -0 survive. */
function encodePlayer(player: PlayerSimFrame): string {
  return JSON.stringify(player, (_key, value: unknown) => {
    if (value instanceof Float64Array) return { [F64]: Array.from(value) };
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return { [NUM]: Object.is(value, -0) ? '-0' : String(value) };
    return value;
  });
}

function decodePlayer(text: string): PlayerSimFrame {
  // Trusted: the writer's own encoding of a PlayerSimFrame. The reviver runs innermost first.
  return JSON.parse(text, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object') return value;
    if (NUM in value && typeof value[NUM] === 'string') return Number(value[NUM]);
    if (F64 in value && Array.isArray(value[F64])) return Float64Array.from(value[F64]);
    return value;
  }) as PlayerSimFrame;
}
