/** Export panel, docked over the right column so the viewport stays visible: while it is open the
 * viewport looks through the shot camera, letterboxed to the output frame, and every change here
 * shows there at once.
 *
 *   Video            camera (mode, framing, presets, grab the current view), lens (focal length on
 *                    a sensor), output (resolution, frame rate, speed), format (MP4 / MOV / WebM /
 *                    PNG sequence, codec, quality, transparent background, floor) → Render
 *   Blender & data   glTF scene (.glb) with the animated parts and shot camera, motion CSV, take file */
import type { VideoCodec } from "mediabunny";
import { CODEC_LABEL, CODECS, CONTAINER_LABEL, canAlpha, encodableCodecs, frameCount, renderVideo,
         type Container, type QualityLevel, type Stage, type VideoJob } from "./export-video";
import { FOCALS, PRESETS, SENSORS, hfov, vfov, type Shot, type ShotMode, type ShotPath } from "./shot";
import { csvJointNames, type Take } from "./take";
import { fmtTime } from "./timeline";

export interface ExportHost {
  take(): Take;
  range(): [number, number];
  shot: Shot;
  /** the shot or output aspect changed: rebuild the camera path, repaint the preview */
  shotChanged(): void;
  /** framing of the free viewport camera right now */
  grabView(): Pick<Shot, "distance" | "azimuth" | "elevation" | "height">;
  path(): ShotPath;
  stage(): Stage;
  setExporting(on: boolean): void;
  glb(fps: number, camera: boolean, floor: boolean): Promise<Blob>;
  csv(fps: number): string;
  saveTake(): void;
  save(blob: Blob, ext: string): void;
  onClose(): void;
}

export interface OutputPrefs {
  res: string; width: number; height: number; fps: number; speed: number;
  container: Container; codec: VideoCodec; quality: QualityLevel; transparent: boolean; floor: boolean;
  glbFps: number; glbCamera: boolean; glbFloor: boolean; csvFps: number;
}

const RESOLUTIONS: [string, string, number, number][] = [
  ["720p", "HD 1280 × 720", 1280, 720],
  ["1080p", "Full HD 1920 × 1080", 1920, 1080],
  ["1440p", "QHD 2560 × 1440", 2560, 1440],
  ["2160p", "4K UHD 3840 × 2160", 3840, 2160],
  ["dci4k", "DCI 4K 4096 × 2160", 4096, 2160],
  ["vertical", "Vertical 1080 × 1920", 1080, 1920],
  ["square", "Square 1080 × 1080", 1080, 1080],
  ["custom", "Custom…", 0, 0],
];
const FPS = [24, 25, 30, 50, 60];
const SPEEDS = [0.25, 0.5, 1, 2];
const PREFS_KEY = "ume-export";

export function defaultPrefs(): OutputPrefs {
  return { res: "1080p", width: 1920, height: 1080, fps: 30, speed: 1, container: "mp4", codec: "avc",
           quality: "high", transparent: false, floor: true, glbFps: 30, glbCamera: true, glbFloor: true, csvFps: 30 };
}
export function loadPrefs(): { out: OutputPrefs; shot?: Partial<Shot> } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { out: { ...defaultPrefs(), ...(p.out ?? {}) }, shot: p.shot };
  } catch { return { out: defaultPrefs() }; }
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(label: string, cls: string, onclick: () => void, title = ""): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.onclick = onclick;
  if (title) b.title = title;
  return b;
}
function select<T extends string | number>(opts: [T, string][], value: T, onchange: (v: T) => void): HTMLSelectElement {
  const s = h("select");
  for (const [v, l] of opts) s.add(new Option(l, String(v)));
  s.value = String(value);
  s.onchange = () => { const o = opts.find(([v]) => String(v) === s.value); if (o) onchange(o[0]); };
  return s;
}
function field(label: string, ...kids: Node[]): HTMLElement {
  const row = h("div", "xf");
  row.append(h("label", "", label), ...kids);
  return row;
}

export class ExportDialog {
  private body: HTMLElement;
  private tabs = new Map<string, HTMLButtonElement>();
  private tab: "video" | "data" = "video";
  private out: OutputPrefs;
  private supported: Set<VideoCodec> | null = null;
  private probedKey = "";
  private busy: AbortController | null = null;
  private status!: HTMLElement;

  constructor(readonly root: HTMLElement, readonly host: ExportHost) {
    this.out = loadPrefs().out;
    root.replaceChildren();
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Export");
    const head = h("header", "p-head");
    head.append(h("h1", "", "Export"));
    const tabbar = h("div", "x-tabs");
    for (const [k, label] of [["video", "Video"], ["data", "Blender & data"]] as const) {
      const b = btn(label, "", () => this.show(k));
      tabbar.append(b);
      this.tabs.set(k, b);
    }
    head.append(tabbar, btn("✕", "btn ghost icon", () => this.close(), "Close (Esc)"));
    this.body = h("div", "x-body");
    root.append(head, this.body);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.busy) { e.stopPropagation(); this.close(); }
      e.stopPropagation();          // typing in a field must not drive the robot or the timeline
    });
  }

  get isOpen(): boolean { return !this.root.hidden; }

  open(tab: "video" | "data") {
    this.root.hidden = false;
    document.body.classList.add("x-open");
    this.show(tab);
  }

  close() {
    if (this.busy) return;
    this.root.hidden = true;
    document.body.classList.remove("x-open");
    this.host.onClose();
  }

  /** Output frame aspect (w / h) — the preview letterbox follows it. */
  get aspect(): number { return this.out.width / this.out.height; }
  get outSize(): [number, number] { return [this.out.width, this.out.height]; }

  /** Re-read the shot into the fields (after it was re-framed in the viewport). */
  refresh() {
    if (this.isOpen && !this.busy) { this.persist(); this.render(); }
  }

  private persist() {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ out: this.out, shot: this.host.shot }));
  }

  private show(tab: "video" | "data") {
    this.tab = tab;
    for (const [k, b] of this.tabs) b.classList.toggle("on", k === tab);
    this.render();
  }

  private render() {
    this.body.replaceChildren();
    this.status = h("div", "x-status");
    if (this.tab === "video") this.renderVideo(); else this.renderData();
    this.body.append(this.status);
  }

  private section(title: string, meta = ""): HTMLElement {
    const s = h("section", "blk");
    const hd = h("div", "blk-h");
    hd.append(h("h2", "", title));
    if (meta) hd.append(h("span", "meta", meta));
    s.append(hd);
    this.body.append(s);
    return s;
  }

  private shotEdit(patch: Partial<Shot>, rerender = false) {
    Object.assign(this.host.shot, patch);
    this.host.shotChanged();
    this.persist();
    if (rerender) this.render();
  }

  /** slider + number pair bound to a numeric shot field */
  private slider(label: string, key: "distance" | "azimuth" | "elevation" | "height" | "smooth",
                 min: number, max: number, step: number, unit: string): HTMLElement {
    const range = h("input");
    range.type = "range"; range.min = String(min); range.max = String(max); range.step = String(step);
    const num = h("input");
    num.type = "number"; num.step = String(step);
    const set = (v: number) => { range.value = String(v); num.value = String(v); };
    set(this.host.shot[key]);
    range.oninput = () => { num.value = range.value; this.shotEdit({ [key]: Number(range.value) }); };
    num.onchange = () => { const v = Number(num.value); if (Number.isFinite(v)) { set(v); this.shotEdit({ [key]: v }); } };
    const wrap = h("div", "x-slider");
    wrap.append(range, num, h("span", "u", unit));
    return field(label, wrap);
  }

  // ---- video tab -------------------------------------------------------------
  private renderVideo() {
    const shot = this.host.shot, o = this.out;

    const cam = this.section("Camera");
    const seg = h("div", "seg");
    for (const [m, label, title] of [
      ["viewport", "Viewport", "The camera you drove while recording"],
      ["follow", "Follow", "A fixed offset from the robot, tracking it"],
      ["orbit", "Orbit", "Follow while circling the robot"],
      ["fixed", "Fixed", "Locked off where the robot stood at the range start"]] as [ShotMode, string, string][]) {
      const b = btn(label, shot.mode === m ? "active" : "", () => this.shotEdit({ mode: m }, true), title);
      seg.append(b);
    }
    cam.append(seg);
    if (shot.mode !== "viewport") {
      const pre = h("div", "x-chips");
      for (const p of PRESETS)
        pre.append(btn(p.label, "chip", () => this.shotEdit({ azimuth: p.azimuth, elevation: p.elevation }, true),
                       `azimuth ${p.azimuth}°, elevation ${p.elevation}°`));
      pre.append(btn("Grab view", "chip accent", () => this.shotEdit(this.host.grabView(), true),
                     "Take the framing of the free viewport camera (switch the view to Free, orbit, then grab)"));
      cam.append(pre,
        this.slider("Distance", "distance", 0.5, 12, 0.05, "m"),
        this.slider("Azimuth", "azimuth", -180, 180, 1, "°"),
        this.slider("Elevation", "elevation", -10, 89, 1, "°"),
        this.slider("Look-at height", "height", 0, 2, 0.01, "m"));
      if (shot.mode === "orbit") {
        const per = h("input");
        per.type = "number"; per.step = "0.5"; per.value = String(shot.orbitPeriod);
        per.onchange = () => { const v = Number(per.value); if (v) this.shotEdit({ orbitPeriod: v }); };
        cam.append(field("Orbit period", per, h("span", "u", "s / turn (negative: clockwise)")));
      }
    }
    cam.append(this.slider("Smoothing", "smooth", 0, 2, 0.05, "s"));

    const lens = this.section("Lens");
    const fovEl = h("div", "sub");
    const updFov = () => {
      fovEl.textContent = `Field of view ${hfov(shot.focal, shot.sensor, this.aspect).toFixed(1)}° × ` +
        `${vfov(shot.focal, shot.sensor, this.aspect).toFixed(1)}° (h × v) · sensor covers the longer side, ` +
        `like Blender's Auto fit`;
    };
    const focal = h("input");
    focal.type = "number"; focal.min = "4"; focal.max = "600"; focal.step = "1"; focal.value = String(shot.focal);
    focal.onchange = () => { const v = Number(focal.value); if (v >= 4) { this.shotEdit({ focal: v }); updFov(); } };
    const chips = h("div", "x-chips");
    for (const f of FOCALS)
      chips.append(btn(`${f}`, "chip" + (shot.focal === f ? " on" : ""), () => this.shotEdit({ focal: f }, true), `${f} mm`));
    lens.append(field("Focal length", focal, h("span", "u", "mm")), chips,
      field("Sensor", select(SENSORS.map((s) => [s.mm, s.label] as [number, string]),
                             SENSORS.find((s) => Math.abs(s.mm - shot.sensor) < 0.01)?.mm ?? 36,
                             (v) => { this.shotEdit({ sensor: v }); updFov(); })),
      fovEl);
    updFov();

    const outS = this.section("Output");
    const w = h("input"), hh = h("input");
    for (const [inp, k] of [[w, "width"], [hh, "height"]] as const) {
      inp.type = "number"; inp.min = "64"; inp.max = "8192"; inp.step = "2"; inp.value = String(o[k]);
      inp.disabled = o.res !== "custom";
      inp.onchange = () => {
        const v = Math.max(64, Math.min(8192, Math.round(Number(inp.value) / 2) * 2 || o[k]));
        o[k] = v; inp.value = String(v); this.changed();
      };
    }
    const dims = h("div", "x-dims");
    dims.append(w, h("span", "u", "×"), hh, h("span", "u", "px"));
    outS.append(
      field("Resolution", select(RESOLUTIONS.map(([k, l]) => [k, l] as [string, string]), o.res, (v) => {
        o.res = v;
        const r = RESOLUTIONS.find(([k]) => k === v)!;
        if (r[2]) { o.width = r[2]; o.height = r[3]; }
        this.changed(true);
      })),
      field("", dims),
      field("Frame rate", select(FPS.map((f) => [f, `${f} fps`] as [number, string]), o.fps, (v) => { o.fps = v; this.changed(true); })),
      field("Speed", select(SPEEDS.map((s) => [s, s === 1 ? "1× real time" : `${s}×`] as [number, string]), o.speed,
                            (v) => { o.speed = v; this.changed(true); })));
    const [t0, t1] = this.host.range(), whole = t0 < 1e-6 && t1 >= this.host.take().duration - 1e-6;
    outS.append(field("Range", h("span", "x-ro", `${fmtTime(t0)} → ${fmtTime(t1)} s` +
      (whole ? " (whole take — set In / Out on the timeline)" : ""))));

    const fmt = this.section("Format");
    const codecSel = h("select");
    const fillCodecs = () => {
      codecSel.replaceChildren();
      if (o.container === "png") { codecSel.add(new Option("PNG (lossless, alpha)", "png")); codecSel.disabled = true; return; }
      codecSel.disabled = false;
      const list = CODECS[o.container];
      for (const c of list) {
        const ok = !this.supported || this.supported.has(c);
        const opt = new Option(CODEC_LABEL[c] + (ok ? "" : " — not available in this browser"), c);
        opt.disabled = !ok;
        codecSel.add(opt);
      }
      if (!list.includes(o.codec) || (this.supported && !this.supported.has(o.codec)))
        o.codec = list.find((c) => !this.supported || this.supported.has(c)) ?? list[0];
      codecSel.value = o.codec;
    };
    codecSel.onchange = () => { o.codec = codecSel.value as VideoCodec; this.changed(true); };
    fillCodecs();
    const bg = select<"scene" | "alpha">([["scene", "Scene"], ["alpha", "Transparent"]], o.transparent ? "alpha" : "scene",
                                         (v) => { o.transparent = v === "alpha"; this.changed(); });
    bg.disabled = !canAlpha(o);
    if (!canAlpha(o)) bg.value = "scene";
    const floor = h("input");
    floor.type = "checkbox"; floor.checked = o.floor;
    floor.onchange = () => { o.floor = floor.checked; this.changed(); };
    const floorLbl = h("label", "x-check");
    floorLbl.append(floor, " Ground plane");
    fmt.append(
      field("Container", select((Object.keys(CONTAINER_LABEL) as Container[]).map((c) => [c, CONTAINER_LABEL[c]] as [Container, string]),
                                o.container, (v) => { o.container = v; this.changed(true); })),
      field("Codec", codecSel),
      field("Quality", select<QualityLevel>([["medium", "Medium"], ["high", "High"], ["very-high", "Very high"]], o.quality,
                                            (v) => { o.quality = v; this.changed(); })),
      field("Background", bg, h("span", "u", canAlpha(o) ? "" : "PNG or WebM VP9 for alpha")),
      field("", floorLbl));

    const job = this.job();
    const N = frameCount(job);
    const summary = h("div", "x-summary",
      `${o.width} × ${o.height} · ${o.fps} fps · ${fmtTime(N / o.fps)} s → ${N} frames`);
    const go = btn("Render video", "btn primary x-go", () => void this.renderVideoJob());
    const foot = h("div", "x-foot");
    foot.append(summary, go);
    this.body.append(foot);
    void this.probe(fillCodecs);
  }

  /** Probe encoder support once per size / rate (async; refills the codec list). */
  private async probe(refill: () => void) {
    const key = `${this.out.width}x${this.out.height}@${this.out.fps}`;
    if (key === this.probedKey) return;
    this.probedKey = key;
    this.supported = await encodableCodecs(this.out.width, this.out.height, this.out.fps);
    if (this.probedKey === key && this.tab === "video") refill();
    if (!this.supported.size) this.say("This browser has no WebCodecs video encoder — PNG sequence still works.", true);
  }

  private changed(rerender = false) {
    this.persist();
    this.host.shotChanged();
    if (rerender) this.render();
  }

  private job(): VideoJob {
    const [t0, t1] = this.host.range(), o = this.out;
    return { width: o.width, height: o.height, fps: o.fps, speed: o.speed, t0, t1, container: o.container,
             codec: o.codec, quality: o.quality, transparent: o.transparent && canAlpha(o), floor: o.floor };
  }

  private say(msg: string, err = false) {
    this.status.textContent = msg;
    this.status.classList.toggle("err", err);
  }

  private async renderVideoJob() {
    const job = this.job();
    if (job.container !== "png" && this.supported && !this.supported.has(job.codec))
      return this.say(`${CODEC_LABEL[job.codec]} at ${job.width} × ${job.height} is not available in this browser.`, true);
    const ac = new AbortController();
    this.busy = ac;
    this.root.classList.add("busy");
    const foot = this.body.querySelector(".x-foot")!;
    const bar = h("div", "x-progress"), fill = h("i"), txt = h("span");
    bar.append(fill);
    const cancel = btn("Cancel", "btn", () => ac.abort());
    foot.replaceChildren(bar, txt, cancel);
    this.host.setExporting(true);
    const t0 = performance.now();
    try {
      const blob = await renderVideo(job, this.host.stage(), (p) => {
        fill.style.width = `${(100 * p.frame / p.frames).toFixed(1)}%`;
        const eta = (p.frames - p.frame) / Math.max(p.fps, 1e-3);
        txt.textContent = `${p.frame} / ${p.frames} · ${p.fps.toFixed(1)} fps · ${fmtTime(eta, 0)} s left`;
      }, ac.signal);
      this.host.save(blob, job.container === "png" ? "png.zip" : job.container);
      this.say(`Saved ${(blob.size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    } catch (e) {
      this.say(e instanceof DOMException && e.name === "AbortError" ? "Cancelled." : `Export failed: ${e}`,
               !(e instanceof DOMException && e.name === "AbortError"));
    } finally {
      this.busy = null;
      this.root.classList.remove("busy");
      this.host.setExporting(false);
      const msg = this.status.textContent, err = this.status.classList.contains("err");
      this.render();
      this.say(msg ?? "", err);
    }
  }

  // ---- data tab ----------------------------------------------------------------
  private renderData() {
    const o = this.out, take = this.host.take();
    const [t0, t1] = this.host.range();
    const rate = (v: number, set: (v: number) => void) => select(
      [...FPS.map((f) => [f, `${f} fps`] as [number, string]),
       [Math.round(1 / take.dt), `${Math.round(1 / take.dt)} fps (every recorded frame)`] as [number, string]]
        .filter((x, i, a) => a.findIndex((y) => y[0] === x[0]) === i), v, set);

    const glb = this.section("Blender scene", ".glb · glTF 2.0");
    const cam = h("input"), floor = h("input");
    cam.type = floor.type = "checkbox";
    cam.checked = o.glbCamera; floor.checked = o.glbFloor;
    cam.onchange = () => { o.glbCamera = cam.checked; this.persist(); };
    floor.onchange = () => { o.glbFloor = floor.checked; this.persist(); };
    const camL = h("label", "x-check"), floorL = h("label", "x-check");
    camL.append(cam, " Shot camera (Video tab camera, lens and frame)");
    floorL.append(floor, " Ground plane");
    glb.append(field("Key rate", rate(o.glbFps, (v) => { o.glbFps = v; this.persist(); })), field("", camL), field("", floorL),
      h("p", "x-note", "Every robot part and terrain piece is its own named object with its materials, " +
        "keyed in world space; the camera keeps its field of view (focal / sensor are in its custom properties). " +
        "In Blender: File › Import › glTF 2.0, then press play. Keys are in seconds, so the motion runs at true " +
        "speed at any scene frame rate; set the scene to the key rate for one key per frame."),
      this.action("Export .glb", async () => {
        const blob = await this.host.glb(o.glbFps, o.glbCamera, o.glbFloor);
        this.host.save(blob, "glb");
        return `Saved ${(blob.size / 1e6).toFixed(1)} MB (${fmtTime(t1 - t0)} s at ${o.glbFps} fps).`;
      }));

    const csv = this.section("Motion CSV", "base pose + joint angles");
    const names = csvJointNames(take.meta);
    csv.append(field("Rate", rate(o.csvFps, (v) => { o.csvFps = v; this.persist(); })),
      h("p", "x-note", `One row per frame: base position (3), base quaternion x y z w (4), then ${names.length} ` +
        "joint angles in radians, no header. Opens again here under Reference clip (at the same fps) and in " +
        "retargeting tools that read this layout."),
      this.details("Joint order", names.map((n, i) => `${i + 8}. ${n}`).join("\n")),
      this.action("Export .csv", async () => {
        const text = this.host.csv(o.csvFps);
        this.host.save(new Blob([text], { type: "text/csv" }), `${o.csvFps}fps.csv`);
        return `Saved ${text.split("\n").length - 1} rows.`;
      }));

    const tk = this.section("Take file", ".take.zip");
    tk.append(h("p", "x-note", "The whole recording — motion, inputs, camera — to reopen in this timeline later " +
      "(Recording › Open take). Needs the same robot model and terrain loaded."),
      this.action("Save take", async () => { this.host.saveTake(); return "Saved."; }));
    this.body.append(h("div", "x-range", `Range ${fmtTime(t0)} → ${fmtTime(t1)} s (set In / Out on the timeline)`));
  }

  private details(summary: string, text: string): HTMLElement {
    const d = h("details", "x-det");
    d.append(h("summary", "", summary), h("pre", "", text));
    return d;
  }

  private action(label: string, run: () => Promise<string>): HTMLElement {
    const row = h("div", "x-act");
    const b = btn(label, "btn primary", async () => {
      b.disabled = true;
      this.say("Working…");
      try { this.say(await run()); } catch (e) { this.say(`Export failed: ${e}`, true); }
      b.disabled = false;
    });
    row.append(b);
    return row;
  }
}
