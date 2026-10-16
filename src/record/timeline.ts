/** The take timeline: the deck under the viewport once a recording stops. Laid out like Emote
 * Studio's (teaching-creator.html on the unitree-dev `web` branch): a transport row, then a canvas
 * with lanes, top to bottom —
 *
 *   ruler     scrub; the In / Out flags of the export range sit here and drag
 *   inputs    one diamond per user input (FSM state, policy, move, reset, hoist, clip)
 *   command   the commanded vx / vy / wz
 *   curves    joint angles (the most active joints, or a limb group), or the base position
 *
 * Wheel zooms at the cursor, shift-wheel or a sideways swipe pans, alt- / middle-drag pans, the
 * bottom bar scrolls, double-click fits. Keys while the deck is open: Space play, ← → frame,
 * Shift+← → second, ↑ ↓ previous / next input, Home / End, I / O range, X clear range, L loop,
 * F fit, Esc close. */
import type { Take, TakeEvent, TakeEventKind } from "./take";

export type ViewMode = "free" | "recorded" | "shot";

export interface TimelineHost {
  close(): void;
  exportVideo(): void;
  exportData(): void;
  save(): void;
  viewMode(m: ViewMode): void;
}

export const KIND_COLOR: Record<TakeEventKind, string> = {
  state: "#e0a23c", policy: "#a98bf0", move: "#5fbf6b", reset: "#e0685c", hoist: "#5b92f0", clip: "#4fb3bf",
};
export const KIND_LABEL: Record<TakeEventKind, string> = {
  state: "State", policy: "Policy", move: "Move", reset: "Reset", hoist: "Hoist", clip: "Clip",
};
const CURVE_COLORS = ["#e0a23c", "#5b92f0", "#5fbf6b", "#e0685c", "#a98bf0", "#4fb3bf", "#d19a66", "#9aa3ad"];
const CMD_COLORS = ["#e0a23c", "#5b92f0", "#5fbf6b"];

type CurveSet = "active" | "legs" | "arms" | "torso" | "base";
const CURVE_SETS: [CurveSet, string, RegExp | null][] = [
  ["active", "Most active joints", null],
  ["legs", "Legs", /hip|knee|ankle|thigh|calf/],
  ["arms", "Arms", /shoulder|elbow|wrist|hand/],
  ["torso", "Waist & head", /waist|torso|head|neck/],
  ["base", "Base position", null],
];

const LANE = { ruler: 18, events: 24, cmd: 30 };
const PAD = 10;
const SCROLL_H = 10;           // bottom strip: scrollbar
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2];
const DECK_KEY = "ume-deck-h";

export const fmtTime = (t: number, d = 2) => {
  if (Math.abs(t) < 60) return t.toFixed(d);
  const m = Math.floor(t / 60), s = t - 60 * m;
  return `${m}:${s.toFixed(d).padStart(d + 3, "0")}`;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function tbtn(label: string, title: string, onclick: () => void, cls = "tb"): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.title = title;
  b.onclick = onclick;
  return b;
}

interface Channel { name: string; color: string; get(i: number): number }

export class Timeline {
  take: Take | null = null;
  time = 0;
  playing = false;
  loop = true;
  speed = 1;
  /** export range, take seconds */
  rangeIn = 0;
  rangeOut = 0;
  mode: ViewMode = "free";

  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tip: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly rangeEl: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly curveSel: HTMLSelectElement;
  private readonly modeBtns = new Map<ViewMode, HTMLButtonElement>();
  private view = { t0: 0, t1: 1 };
  private W = 1; private H = 1;
  private drag: null | { mode: "scrub" | "pan" | "scroll" | "in" | "out"; x0: number; t0: number; t1: number } = null;
  private hover: TakeEvent | null = null;
  private curves: Channel[] = [];
  private curveRange: [number, number] = [0, 1];
  private cmdScale = 1;
  private scrollRect: { y: number; x0: number; x1: number; full0: number; span: number } | null = null;
  private colors = { bg: "#0b0d10", lane: "#14171a", line: "#252a30", lineHi: "#343b43", text: "#9aa3ad",
                     text3: "#6b747e", accent: "#e0a23c", head: "#5b92f0" };

  constructor(readonly root: HTMLElement, readonly host: TimelineHost) {
    root.replaceChildren();
    const dragbar = h("div", "dk-drag");
    dragbar.title = "Drag to resize the timeline";
    this.wireResize(dragbar);

    const bar = h("div", "dk-bar");
    this.playBtn = tbtn("▶", "Play / pause (Space)", () => this.setPlaying(!this.playing), "tb play");
    this.loopBtn = tbtn("⟳", "Loop the range (L)", () => this.setLoop(!this.loop));
    this.clockEl = h("span", "dk-clock");
    this.frameEl = h("span", "dk-frame");
    const speedSel = h("select", "dk-sel");
    speedSel.title = "Playback speed";
    for (const s of SPEEDS) speedSel.add(new Option(`${s}×`, String(s)));
    speedSel.value = "1";
    speedSel.onchange = () => { this.speed = Number(speedSel.value); speedSel.blur(); };
    this.rangeEl = h("span", "dk-range");
    this.clearBtn = tbtn("×", "Clear the range (X)", () => this.clearRange());
    this.curveSel = h("select", "dk-sel");
    this.curveSel.title = "Curves lane";
    this.curveSel.onchange = () => { this.buildCurves(); this.paint(); this.curveSel.blur(); };
    const seg = h("div", "dk-seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Viewport camera");
    for (const [m, label, title] of [["free", "Free", "Orbit freely around the robot"],
                                     ["recorded", "Recorded", "The camera as it moved while recording"],
                                     ["shot", "Shot", "Through the export camera, letterboxed to the output frame"]] as const) {
      const b = tbtn(label, title, () => { this.setMode(m); this.host.viewMode(m); }, "");
      b.setAttribute("role", "radio");
      seg.append(b);
      this.modeBtns.set(m, b);
    }
    const group = (...k: Node[]) => { const d = h("div", "dk-grp"); d.append(...k); return d; };
    bar.append(
      group(tbtn("⏮", "Start of the range (Home)", () => this.seek(this.rangeIn)),
            tbtn("◆◀", "Previous input (↑)", () => this.jumpEvent(-1)),
            this.playBtn,
            tbtn("▶◆", "Next input (↓)", () => this.jumpEvent(1)),
            tbtn("⏭", "End of the range (End)", () => this.seek(this.rangeOut)),
            this.loopBtn),
      group(this.clockEl, this.frameEl),
      group(speedSel),
      group(tbtn("In", "Range start at the playhead (I)", () => this.setIn(this.time), "tb wide"),
            tbtn("Out", "Range end at the playhead (O)", () => this.setOut(this.time), "tb wide"),
            this.rangeEl, this.clearBtn),
      group(seg, this.curveSel),
      h("div", "dk-sp"),
      group(tbtn("Export video…", "Render the range to MP4 / MOV / WebM / PNG", () => host.exportVideo(), "btn primary"),
            tbtn("Blender & data…", "glTF scene for Blender, motion CSV, take file", () => host.exportData(), "btn"),
            tbtn("Save take", "Save this take to reopen it later (.take.zip)", () => host.save(), "btn"),
            tbtn("✕", "Close the timeline, back to the live sim (Esc)", () => host.close(), "btn ghost icon")),
    );

    const wrap = h("div", "dk-tl");
    this.canvas = h("canvas");
    this.g = this.canvas.getContext("2d")!;
    this.tip = h("div", "dk-tip");
    wrap.append(this.canvas, this.tip);
    root.append(dragbar, bar, wrap);
    this.wireCanvas();
    new ResizeObserver(() => this.paint()).observe(wrap);
    const saved = Number(localStorage.getItem(DECK_KEY));
    if (saved > 0) root.style.height = `${saved}px`;
    const css = getComputedStyle(document.documentElement);
    const v = (k: string, d: string) => css.getPropertyValue(k).trim() || d;
    this.colors.lane = v("--panel", this.colors.lane);
    this.colors.line = v("--line", this.colors.line);
    this.colors.lineHi = v("--line-hi", this.colors.lineHi);
    this.colors.text = v("--text-2", this.colors.text);
    this.colors.text3 = v("--text-3", this.colors.text3);
    this.colors.accent = v("--accent", this.colors.accent);
  }

  get isOpen(): boolean { return !!this.take && !this.root.hidden; }
  get duration(): number { return this.take?.duration ?? 0; }
  get hasRange(): boolean { return this.rangeIn > 1e-9 || this.rangeOut < this.duration - 1e-9; }

  open(take: Take, title: string) {
    this.take = take;
    this.root.hidden = false;
    this.rangeIn = 0;
    this.rangeOut = take.duration;
    this.time = 0;
    this.hover = null;
    this.root.setAttribute("aria-label", `Take timeline: ${title}`);
    this.curveSel.replaceChildren();
    for (const [k, label, re] of CURVE_SETS)
      if (!re || take.meta.hinges.some((j) => re.test(j.name))) this.curveSel.add(new Option(label, k));
    this.cmdScale = 0.1;
    for (const v of take.cmd) this.cmdScale = Math.max(this.cmdScale, Math.abs(v));
    this.buildCurves();
    this.setMode(this.mode);
    this.setPlaying(false);
    this.setLoop(this.loop);
    requestAnimationFrame(() => this.fit());
  }

  close() {
    this.setPlaying(false);
    this.root.hidden = true;
  }

  // ---- transport -----------------------------------------------------------
  seek(t: number) {
    this.time = clamp(t, 0, this.duration);
    this.keepInView();
    this.paint();
  }

  setPlaying(on: boolean) {
    if (on && this.time >= this.rangeOut - 1e-6) this.time = this.rangeIn;
    this.playing = on && !!this.take;
    this.playBtn.textContent = this.playing ? "⏸" : "▶";
    this.playBtn.setAttribute("aria-pressed", String(this.playing));
    this.paint();
  }

  setLoop(on: boolean) {
    this.loop = on;
    this.loopBtn.setAttribute("aria-pressed", String(on));
  }

  setMode(m: ViewMode) {
    this.mode = m;
    for (const [k, b] of this.modeBtns) {
      b.classList.toggle("on", k === m);
      b.setAttribute("aria-checked", String(k === m));
    }
  }

  /** Advance the playhead by `dt` real seconds (called every animation frame). */
  tick(dt: number) {
    if (!this.playing || !this.take) return;
    let t = this.time + dt * this.speed;
    const a = this.rangeIn, b = this.rangeOut;
    if (t >= b) {
      if (this.loop && b - a > 1e-3) t = a + ((t - a) % (b - a));
      else { t = b; this.setPlaying(false); }
    }
    if (t < a) t = a;
    this.seek(t);
  }

  setIn(t: number) {
    this.rangeIn = clamp(t, 0, this.duration);
    if (this.rangeOut <= this.rangeIn + 1e-3) this.rangeOut = this.duration;
    this.paint();
  }
  setOut(t: number) {
    this.rangeOut = clamp(t, 0, this.duration);
    if (this.rangeIn >= this.rangeOut - 1e-3) this.rangeIn = 0;
    this.paint();
  }
  clearRange() { this.rangeIn = 0; this.rangeOut = this.duration; this.paint(); }

  private jumpEvent(dir: 1 | -1) {
    const ev = this.take?.events ?? [];
    const e = dir > 0 ? ev.find((x) => x.t > this.time + 1e-4) : [...ev].reverse().find((x) => x.t < this.time - 1e-4);
    this.seek(e ? e.t : dir > 0 ? this.rangeOut : this.rangeIn);
  }

  private stepFrame(n: number) {
    if (!this.take) return;
    const i = clamp(this.take.frameAt(this.time) + n, 0, this.take.n - 1);
    this.setPlaying(false);
    this.seek(this.take.t[i]);
  }

  /** Keyboard while the deck is open; true when the key was used. */
  onKey(e: KeyboardEvent): boolean {
    if (!this.isOpen || e.ctrlKey || e.metaKey) return false;
    switch (e.key) {
      case " ": this.setPlaying(!this.playing); return true;
      case "ArrowLeft": if (e.shiftKey) { this.setPlaying(false); this.seek(this.time - 1); } else this.stepFrame(-1); return true;
      case "ArrowRight": if (e.shiftKey) { this.setPlaying(false); this.seek(this.time + 1); } else this.stepFrame(1); return true;
      case "ArrowUp": this.jumpEvent(-1); return true;
      case "ArrowDown": this.jumpEvent(1); return true;
      case "Home": this.seek(this.rangeIn); return true;
      case "End": this.seek(this.rangeOut); return true;
      case "i": case "I": this.setIn(this.time); return true;
      case "o": case "O": this.setOut(this.time); return true;
      case "x": case "X": this.clearRange(); return true;
      case "l": case "L": this.setLoop(!this.loop); return true;
      case "f": case "F": this.fit(); return true;
      case "Escape": this.host.close(); return true;
    }
    return false;
  }

  // ---- view window -----------------------------------------------------------
  fit() {
    const d = this.duration || 1, m = 0.03 * d;
    this.view = { t0: -m, t1: d + m };
    this.paint();
  }

  private zoomAt(t: number, factor: number) {
    const span = clamp((this.view.t1 - this.view.t0) * factor, 0.05, Math.max(4, this.duration * 4));
    const f = (t - this.view.t0) / Math.max(1e-6, this.view.t1 - this.view.t0);
    this.view.t0 = t - f * span;
    this.view.t1 = this.view.t0 + span;
    this.paint();
  }

  /** while playing, page the window along with the playhead */
  private keepInView() {
    const { t0, t1 } = this.view, span = t1 - t0;
    if (this.time > t1 || this.time < t0) {
      this.view.t0 = this.time - 0.1 * span;
      this.view.t1 = this.view.t0 + span;
    }
  }

  private tX = (t: number) => PAD + (this.W - 2 * PAD) * (t - this.view.t0) / Math.max(1e-6, this.view.t1 - this.view.t0);
  private xT = (x: number) => this.view.t0 + (x - PAD) / Math.max(1, this.W - 2 * PAD) * (this.view.t1 - this.view.t0);

  private lanes() {
    const ruler = 0, events = LANE.ruler, cmd = events + LANE.events, curves = cmd + LANE.cmd;
    return { ruler, events, cmd, curves, curvesH: Math.max(0, this.H - curves - SCROLL_H - 2) };
  }

  // ---- curves -------------------------------------------------------------
  private buildCurves() {
    const take = this.take;
    this.curves = [];
    if (!take) return;
    const set = (this.curveSel.value || "active") as CurveSet;
    const nq = take.meta.nq, Q = take.qpos;
    if (set === "base") {
      const bq = take.meta.baseQadr;
      if (bq >= 0)
        ["x", "y", "z"].forEach((ax, k) => this.curves.push({
          name: `base ${ax}`, color: CURVE_COLORS[k], get: (i) => Q[i * nq + bq + k] }));
    } else {
      let joints = take.meta.hinges;
      const re = CURVE_SETS.find((c) => c[0] === set)?.[2];
      if (re) joints = joints.filter((j) => re.test(j.name));
      const travel = (qa: number) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < take.n; i++) { const v = Q[i * nq + qa]; if (v < lo) lo = v; if (v > hi) hi = v; }
        return hi - lo;
      };
      const ranked = joints.map((j) => ({ j, r: travel(j.qadr) })).filter((o) => o.r > 1e-3);
      if (set === "active") ranked.sort((a, b) => b.r - a.r);
      ranked.slice(0, set === "active" ? 4 : 8).forEach(({ j }, k) => this.curves.push({
        name: j.name.replace(/_joint$/, ""), color: CURVE_COLORS[k % CURVE_COLORS.length],
        get: (i) => Q[i * nq + j.qadr] }));
    }
    let lo = Infinity, hi = -Infinity;
    for (const c of this.curves) for (let i = 0; i < take.n; i++) { const v = c.get(i); if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi > lo)) { lo = (Number.isFinite(lo) ? lo : 0) - 1; hi = lo + 2; }
    const pad = (hi - lo) * 0.1;
    this.curveRange = [lo - pad, hi + pad];
  }

  // ---- painting -------------------------------------------------------------
  paint() {
    const take = this.take;
    if (!take || this.root.hidden) return;
    this.updateReadouts();
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.round(r.width * dpr)), bh = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }
    this.W = r.width || 1; this.H = r.height || 1;
    const g = this.g, C = this.colors, W = this.W, H = this.H, L = this.lanes();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.font = "600 10px Inter, system-ui, sans-serif";
    g.textBaseline = "top";

    // ruler + grid
    const span = this.view.t1 - this.view.t0;
    const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => span / s <= Math.max(4, W / 90)) ?? 600;
    g.lineWidth = 1;
    for (let t = Math.ceil(this.view.t0 / step) * step; t <= this.view.t1 + 1e-9; t += step) {
      const x = Math.round(this.tX(t)) + 0.5;
      g.strokeStyle = C.line;
      g.beginPath(); g.moveTo(x, 11); g.lineTo(x, H - SCROLL_H); g.stroke();
      g.fillStyle = C.text3;
      g.fillText(fmtTime(Math.abs(t) < 1e-9 ? 0 : t, step < 0.1 ? 2 : step < 1 ? 2 : step < 10 ? 1 : 0), x + 3, 3);
    }

    // take extent in the input lane
    const d = take.duration, x0 = this.tX(0), x1 = this.tX(d);
    g.fillStyle = C.lane;
    g.fillRect(x0, L.events + 2, Math.max(0, x1 - x0), LANE.events - 4);

    // command lane
    const cy = L.cmd + LANE.cmd / 2, ch = LANE.cmd / 2 - 3;
    g.strokeStyle = C.line;
    g.beginPath(); g.moveTo(0, Math.round(cy) + 0.5); g.lineTo(W, Math.round(cy) + 0.5); g.stroke();
    const visible = (fn: (i: number) => number, y: (v: number) => number) => {
      g.beginPath();
      let started = false;
      const N = Math.max(2, Math.round(W));
      for (let s = 0; s <= N; s++) {
        const t = this.view.t0 + span * s / N;
        if (t < 0 || t > d) continue;
        const px = this.tX(t), py = y(fn(take.frameAt(t)));
        if (started) g.lineTo(px, py); else { g.moveTo(px, py); started = true; }
      }
      g.stroke();
    };
    g.lineWidth = 1.3;
    for (let k = 0; k < 3; k++) {
      g.strokeStyle = CMD_COLORS[k];
      visible((i) => take.cmd[3 * i + k], (v) => cy - (v / this.cmdScale) * ch);
    }
    this.legend([["cmd", C.text3], ["vx", CMD_COLORS[0]], ["vy", CMD_COLORS[1]], ["wz", CMD_COLORS[2]]], L.cmd + 2);

    // curves lane
    if (this.curves.length && L.curvesH > 16) {
      const [lo, hi] = this.curveRange;
      const vy = (v: number) => L.curves + L.curvesH - (v - lo) / (hi - lo) * (L.curvesH - 4) - 2;
      g.strokeStyle = C.line;
      if (lo < 0 && hi > 0) { g.beginPath(); g.moveTo(0, Math.round(vy(0)) + 0.5); g.lineTo(W, Math.round(vy(0)) + 0.5); g.stroke(); }
      g.lineWidth = 1.4;
      for (const c of this.curves) { g.strokeStyle = c.color; visible(c.get, vy); }
      this.legend(this.curves.map((c) => [c.name, c.color]), L.curves + 3);
    }

    // input events: diamonds; inputs closer than a few px share one label ("Clip · Hoist on"),
    // labelled while there is room before the next group
    const evs = take.events, ey = L.events + LANE.events / 2;
    for (let k = 0; k < evs.length;) {
      const x = this.tX(evs[k].t);
      let j = k + 1;
      while (j < evs.length && this.tX(evs[j].t) - x < 4) j++;
      if (x > -200 && x < W + 8) {
        for (let i = j - 1; i >= k; i--) {
          const e = evs[i], hot = e === this.hover, s = hot ? 5 : 4;
          g.save();
          g.translate(this.tX(e.t), ey); g.rotate(Math.PI / 4);
          g.fillStyle = KIND_COLOR[e.kind];
          g.fillRect(-s, -s, 2 * s, 2 * s);
          g.strokeStyle = C.bg; g.lineWidth = 1.4;
          g.strokeRect(-s, -s, 2 * s, 2 * s);
          g.restore();
        }
        const room = (j < evs.length ? this.tX(evs[j].t) : W) - x - 14;
        if (room > 24) {
          const hot = evs.slice(k, j).includes(this.hover!);
          g.fillStyle = hot ? "#fff" : C.text;
          let label = evs.slice(k, j).map((e) => e.label).join(" · ");
          while (label.length > 1 && g.measureText(label).width > room) label = label.slice(0, -2) + "…";
          g.fillText(label, x + 8, ey - 5);
        }
      }
      k = j;
    }

    // outside the export range: dimmed; In / Out flags on the ruler
    g.fillStyle = "rgba(0,0,0,.5)";
    const ri = this.tX(this.rangeIn), ro = this.tX(this.rangeOut);
    g.fillRect(0, LANE.ruler, Math.max(0, ri), H - LANE.ruler - SCROLL_H);
    g.fillRect(ro, LANE.ruler, Math.max(0, W - ro), H - LANE.ruler - SCROLL_H);
    if (this.hasRange) {
      g.fillStyle = C.accent;
      g.globalAlpha = 0.18;
      g.fillRect(ri, 12, ro - ri, 4);
      g.globalAlpha = 1;
    }
    for (const [x, dir] of [[ri, 1], [ro, -1]] as const) {
      g.fillStyle = C.accent;
      g.fillRect(Math.round(x) - (dir > 0 ? 0 : 2), 2, 2, H - 2 - SCROLL_H);
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x + 7 * dir, 2); g.lineTo(x, 10); g.closePath(); g.fill();
    }

    // horizontal scrollbar: the visible window over the whole take
    const full0 = Math.min(0, this.view.t0), full1 = Math.max(d, this.view.t1), fs = full1 - full0;
    const sy = H - SCROLL_H + 3;
    g.fillStyle = C.lineHi; g.globalAlpha = 0.4;
    g.fillRect(PAD, sy, W - 2 * PAD, 4); g.globalAlpha = 1;
    const sx0 = PAD + (W - 2 * PAD) * (this.view.t0 - full0) / fs, sx1 = PAD + (W - 2 * PAD) * (this.view.t1 - full0) / fs;
    g.fillStyle = C.text3;
    g.fillRect(sx0, sy, Math.max(12, sx1 - sx0), 4);
    this.scrollRect = { y: sy - 3, x0: sx0, x1: sx1, full0, span: fs };

    // playhead
    const px = Math.round(this.tX(this.time)) + 0.5;
    g.strokeStyle = C.head; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(px, 9); g.lineTo(px, H - SCROLL_H); g.stroke();
    g.fillStyle = C.head;
    g.beginPath(); g.moveTo(px - 5, 8); g.lineTo(px + 5, 8); g.lineTo(px, 15); g.closePath(); g.fill();
  }

  /** One row of coloured labels at the top-left of a lane, on a backing so curves don't run through. */
  private legend(items: [string, string][], y: number) {
    const g = this.g;
    let x = 4;
    for (const [text, color] of items) {
      const w = g.measureText(text).width;
      if (x + w > this.W - 8) break;
      g.fillStyle = "rgba(11,13,16,.75)";
      g.fillRect(x - 2, y - 1, w + 4, 12);
      g.fillStyle = color;
      g.fillText(text, x, y);
      x += w + 10;
    }
  }

  private updateReadouts() {
    const take = this.take!;
    this.clockEl.innerHTML = `${fmtTime(this.time, 3)}<i> / </i>${fmtTime(take.duration, 3)}<i> s</i>`;
    this.frameEl.textContent = `f ${take.frameAt(this.time) + 1} / ${take.n}`;
    this.rangeEl.textContent = this.hasRange
      ? `${fmtTime(this.rangeIn)} → ${fmtTime(this.rangeOut)} · ${fmtTime(this.rangeOut - this.rangeIn)} s`
      : "whole take";
    this.clearBtn.style.visibility = this.hasRange ? "visible" : "hidden";
  }

  // ---- pointer --------------------------------------------------------------
  private eventAt(x: number, y: number): TakeEvent | null {
    const L = this.lanes();
    if (!this.take || y < L.events || y > L.events + LANE.events) return null;
    let best: TakeEvent | null = null, bd = 7;
    for (const e of this.take.events) { const dd = Math.abs(this.tX(e.t) - x); if (dd < bd) { bd = dd; best = e; } }
    return best;
  }

  private wireCanvas() {
    const cv = this.canvas;
    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    cv.addEventListener("pointerdown", (e) => {
      if (!this.take || e.button === 2) return;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      const base = { x0: x, t0: this.view.t0, t1: this.view.t1 };
      if (e.button === 1 || e.altKey) { this.drag = { mode: "pan", ...base }; return; }
      const sr = this.scrollRect;
      if (sr && y >= sr.y) {
        if (x < sr.x0 - 3 || x > sr.x1 + 3) {                 // jump: centre the window on the click
          const span = this.view.t1 - this.view.t0;
          const tc = sr.full0 + sr.span * (x - PAD) / Math.max(1, this.W - 2 * PAD);
          this.view = { t0: tc - span / 2, t1: tc + span / 2 };
          base.t0 = this.view.t0; base.t1 = this.view.t1;
        }
        this.drag = { mode: "scroll", ...base };
        this.paint();
        return;
      }
      if (y < LANE.ruler) {
        const di = Math.abs(x - this.tX(this.rangeIn)), dO = Math.abs(x - this.tX(this.rangeOut));
        if (Math.min(di, dO) < 7) { this.drag = { mode: di <= dO ? "in" : "out", ...base }; return; }
      }
      const ev = this.eventAt(x, y);
      this.setPlaying(false);
      this.drag = { mode: "scrub", ...base };
      this.seek(ev ? ev.t : this.xT(x));
    });
    cv.addEventListener("pointermove", (e) => {
      const [x, y] = pos(e);
      const dr = this.drag;
      if (!dr) {
        const ev = this.eventAt(x, y);
        if (ev !== this.hover) { this.hover = ev; this.paint(); }
        this.showTip(ev, x);
        const nearFlag = y < LANE.ruler &&
          Math.min(Math.abs(x - this.tX(this.rangeIn)), Math.abs(x - this.tX(this.rangeOut))) < 7;
        cv.style.cursor = ev ? "pointer" : nearFlag || (this.scrollRect && y >= this.scrollRect.y) ? "ew-resize" : "crosshair";
        return;
      }
      const span = dr.t1 - dr.t0, perPx = span / Math.max(1, this.W - 2 * PAD);
      if (dr.mode === "pan") { const dt = (x - dr.x0) * perPx; this.view = { t0: dr.t0 - dt, t1: dr.t1 - dt }; this.paint(); }
      else if (dr.mode === "scroll" && this.scrollRect) {
        const dt = (x - dr.x0) / Math.max(1, this.W - 2 * PAD) * this.scrollRect.span;
        this.view = { t0: dr.t0 + dt, t1: dr.t1 + dt }; this.paint();
      }
      else if (dr.mode === "in") this.setIn(this.xT(x));
      else if (dr.mode === "out") this.setOut(this.xT(x));
      else this.seek(this.xT(x));
    });
    const up = () => { this.drag = null; };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", () => { if (this.hover) { this.hover = null; this.paint(); } this.showTip(null, 0); });
    cv.addEventListener("dblclick", () => this.fit());
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x] = pos(e);
      const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) + 0.5;
      if (horiz || e.shiftKey) {
        const d = (horiz ? e.deltaX : e.deltaY) / Math.max(1, this.W) * (this.view.t1 - this.view.t0);
        this.view.t0 += d; this.view.t1 += d; this.paint();
      } else this.zoomAt(this.xT(x), Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
  }

  private showTip(e: TakeEvent | null, x: number) {
    if (!e) { this.tip.style.display = "none"; return; }
    this.tip.replaceChildren(h("b", "", KIND_LABEL[e.kind]), document.createTextNode(` ${e.label}`),
                             h("span", "", `${fmtTime(e.t, 3)} s`));
    this.tip.style.display = "block";
    this.tip.style.left = `${clamp(x + 10, 4, this.W - 220)}px`;
    this.tip.style.top = `${LANE.ruler + LANE.events + 2}px`;
  }

  private wireResize(bar: HTMLElement) {
    bar.addEventListener("pointerdown", (e) => {
      bar.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = this.root.getBoundingClientRect().height;
      const move = (ev: PointerEvent) => {
        const hh = clamp(h0 - (ev.clientY - y0), 120, window.innerHeight * 0.7);
        this.root.style.height = `${hh}px`;
      };
      const end = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", end);
        localStorage.setItem(DECK_KEY, String(Math.round(this.root.getBoundingClientRect().height)));
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", end);
    });
  }
}

/** The take's inputs as a clickable list (the inspector column shows it while reviewing). */
export function eventList(take: Take, title: string, onSeek: (t: number) => void): HTMLElement {
  const box = h("div", "take-sum");
  const kv = h("dl", "ins-kv");
  const row = (k: string, v: string) => { kv.append(h("dt", "", k), h("dd", "", v)); };
  row("take", title);
  row("length", `${fmtTime(take.duration)} s · ${take.n} frames`);
  row("rate", `${(1 / take.dt).toFixed(0)} Hz`);
  row("terrain", take.meta.terrain);
  row("policy", take.meta.policy);
  box.append(kv);
  const head = h("div", "ins-sec", "Inputs");
  head.append(h("span", "", `${take.events.length}`));
  box.append(head);
  if (!take.events.length) box.append(h("span", "ins-empty", "No discrete inputs — only the command curve."));
  const list = h("div", "take-evs");
  for (const e of take.events) {
    const b = h("button", "take-ev");
    b.type = "button";
    const dot = h("i");
    dot.style.background = KIND_COLOR[e.kind];
    b.append(h("span", "t", fmtTime(e.t)), dot, h("span", "k", KIND_LABEL[e.kind]), h("span", "l", e.label));
    b.title = `${KIND_LABEL[e.kind]}: ${e.label} at ${fmtTime(e.t, 3)} s`;
    b.onclick = () => onSeek(e.t);
    list.append(b);
  }
  box.append(list);
  return box;
}
