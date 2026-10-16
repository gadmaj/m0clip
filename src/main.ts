/** UI shell — rendering, panel, keyboard and gamepad. All simulation runs in
 * the sim worker (see src/sim/protocol.ts for why); this side only exchanges
 * messages: commands in, model description + frames + status out. */
import * as THREE from "three";
import type { Command } from "./core/types";
import { GamepadInput, type ComboAction } from "./input/gamepad";
import { ExportDialog, loadPrefs as loadExportPrefs } from "./record/export-dialog";
import { exportGlb } from "./record/export-blender";
import type { Stage } from "./record/export-video";
import { defaultShot, ShotPath, type Shot } from "./record/shot";
import { loadTake, motionCsv, saveTake, Take, TakeRecorder } from "./record/take";
import { eventList, fmtTime, Timeline, type ViewMode } from "./record/timeline";
import { download, screenshot, stamp } from "./render/recorder";
import { SceneView } from "./render/scene";
import type { FromWorker, InspectMsg, RenderModel, StatusMsg, ToWorker } from "./sim/protocol";
import type { FsmState } from "./sim/fsm";
import { TERRAINS, type TerrainName } from "./sim/terrain";
import { Panel, type StatusRow } from "./ui/panel";

/** Robot family: r1 + r1_air (EDU 24-DOF / Air 20-DOF) share one UI slot, g1 + g1_air (EDU 29-DOF / Air 23-DOF) one UI
 * slot; go2 is its own. */
const fam = (r: string) => (r.startsWith("r1") ? "r1" : r.startsWith("g1") ? "g1" : r);

/** Session prefs (robot / terrain / policy) persisted across reloads. */
const PREFS_KEY = "ume-prefs";
interface Prefs { robot?: string; terrain?: TerrainName; policy?: string }
/** Per-axis command a full stick deflection (or a Shift-held key) is worth: the widest side of each axis
 * of the active policy's `vel_range` (the stick is symmetric; the driver re-clamps per direction).
 * 1.0 when the policy declares none. */
function cmdMax(vr?: number[]): Command {
  if (!vr || vr.length < 6) return [1, 1, 1];
  const axis = (i: number) => Math.max(Math.abs(vr[2 * i]), Math.abs(vr[2 * i + 1])) || 1;
  return [axis(0), axis(1), axis(2)];
}

function loadPrefs(): Prefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Prefs; }
  catch { return {}; }
}

/** FSM state names as the timeline labels them. */
const STATE_NAME: Record<FsmState, string> = {
  zero_torque: "ZeroTorque", damping: "Damping", lock: "Lock", stance: "Stance", policy: "Policy",
};
/** Longest take kept in memory (≈ 100 MB of R1 frames). */
const MAX_TAKE_S = 20 * 60;
const slug = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "take";

const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sgn = (x: number, d = 2) => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(d);

/** Live obs/action inspector as HTML: header, key/value block, observation terms, top joint actions
 * with a diverging bar (zero at center, full width at |a| = 1.5). */
function formatInspect(m: InspectMsg): string {
  if (m.playback) return `<span class="ins-empty">Kinematic playback — no policy observation.</span>`;
  const vals = (v: number[], dim: number) => {
    const shown = v.slice(0, 3).map((x) => sgn(x)).join(" ");
    return shown + (dim > 3 ? " …" : "");
  };
  const bar = (x: number) => {
    const w = Math.min(Math.abs(x) / 1.5, 1) * 50;
    return `<div class="bar"><i class="${x >= 0 ? "pos" : ""}" style="${x >= 0 ? "left:50%" : `right:50%`};width:${w.toFixed(1)}%"></i></div>`;
  };
  const [vx, vy, wz] = m.command;
  const H: string[] = [];
  H.push(`<div class="ins-pol" title="${esc(m.policy)}">${esc(m.policy)}</div>`);
  const kv: [string, string][] = [["state", m.state], ["base z", `${m.baseZ.toFixed(2)} m`]];
  if (m.baseXY) kv.push(["xy", `${sgn(m.baseXY[0])} ${sgn(m.baseXY[1])}`]);
  kv.push(["drive", m.drive]);
  if (m.drive === "command") kv.push(["cmd", `vx ${sgn(vx)}  vy ${sgn(vy)}  wz ${sgn(wz)}`]);
  H.push(`<dl class="ins-kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`);

  const topo = m.onnxInputs === 1 ? "1 input" : `${m.onnxInputs} inputs`;
  H.push(`<div class="ins-sec">Observation<span>${m.perFrame}/frame × ${m.stackDepth} · ${topo}</span></div>`);
  if (m.terms.length) {
    H.push(`<table class="ins-t"><colgroup><col style="width:38%"><col style="width:13%"><col></colgroup>`);
    for (const t of m.terms)
      H.push(`<tr><td class="n" title="${esc(t.name)}">${esc(t.name)}</td><td class="d">${t.dim}</td>` +
             `<td class="v">${vals(t.vals, t.dim)}</td></tr>`);
    H.push(`</table>`);
  } else H.push(`<span class="ins-empty">Warming up…</span>`);

  const top = [...m.actions].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 8);
  H.push(`<div class="ins-sec">Action<span>${m.actions.length} joints · top ${top.length}</span></div>`);
  if (top.length) {
    H.push(`<table class="ins-t"><colgroup><col style="width:46%"><col style="width:17%"><col></colgroup>`);
    for (const a of top) {
      const n = a.name.replace(/_joint$/, "");
      H.push(`<tr><td class="n" title="${esc(n)}">${esc(n)}</td><td class="num">${sgn(a.value)}</td><td>${bar(a.value)}</td></tr>`);
    }
    H.push(`</table>`);
  } else H.push(`<span class="ins-empty">No action in this state.</span>`);
  return H.join("");
}

class App {
  view = new SceneView(document.getElementById("viewport")!);
  panel: Panel;
  pad = new GamepadInput();
  worker = new Worker(new URL("./worker/sim.worker.ts", import.meta.url),
                      { type: "module" });

  command: Command = [0, 0, 0];
  needsCommand = true;      // refreshed from status messages (family-dependent)
  private cmdMax: Command = [1, 1, 1];   // from the active policy's vel_range
  private velRangeKey = "";
  private lastFrame: { xpos: Float32Array; xmat: Float32Array } | null = null;
  private baseXY: [number, number] = [0, 0];
  private status: StatusMsg | null = null;

  private overlay = document.getElementById("overlay")!;
  private overlayMsg = document.getElementById("overlay-msg")!;
  private inspectorBody = document.getElementById("inspector-body")!;
  private lidarBox = this.makeLidarBox();
  private savedPrefs = "";
  private followZ = 0.7;    // camera look-at height, robot-size dependent
  private leashCapable = false;         // active policy follows a leash pull
  private leashDrag: [number, number] | null = null;   // anchor while dragging
  private hoistOn = false;

  // ---- recording / review ----
  private model: RenderModel | null = null;       // the live model (last "model" message)
  private viewModel: RenderModel | null = null;   // the model the scene currently shows
  private rec: TakeRecorder | null = null;
  /** last value logged per input: a change the user makes is logged when they make it (at the frame
   * they were looking at), and the status that confirms it later is not logged again */
  private logged: { state?: FsmState; policy?: string; hoist?: boolean } = {};
  /** the user's latest request per input until a status confirms it: statuses already in flight carry
   * the old value and must not be logged as changes (counted, not timed — a busy main thread can hold
   * them for seconds) */
  private pending: Partial<Record<keyof App["logged"], { v: unknown; stale: number }>> = {};
  private recModel: RenderModel | null = null;
  private take: Take | null = null;
  private takeModel: RenderModel | null = null;
  private takeTitle = "";
  private takeNo = 0;
  private timeline: Timeline;
  private dialog: ExportDialog;
  private shot: Shot;
  private shotPath: ShotPath | null = null;
  private readonly shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 100);
  private readonly exportCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 100);
  private exporting = false;
  private reviewXpos = new Float32Array(0);
  private reviewXmat = new Float32Array(0);
  private shotDrag: { az: number; el: number; d: number; off: THREE.Vector3 } | null = null;
  private viewBeforeDialog: ViewMode = "free";
  private recBadge = document.getElementById("rec-badge")!;
  private recTime = document.getElementById("rec-time")!;
  private shotFrame = document.getElementById("shot-frame")!;

  /** LIDAR occupancy minimap (vision policies): canvas + caption, hidden
   * until inspect messages carry a grid. Robot at center, forward = up. */
  private makeLidarBox() {
    const box = document.createElement("div");
    box.className = "lidar";
    const canvas = document.createElement("canvas");
    const cap = document.createElement("div");
    cap.textContent = "Lidar occupancy · forward up";
    box.append(canvas, cap);
    this.inspectorBody.parentElement!.insertBefore(box, this.inspectorBody);
    return { box, canvas, cap };
  }

  private renderLidar(l?: { nx: number; ny: number; grid: number[] }) {
    const { box, canvas, cap } = this.lidarBox;
    if (!l) { box.style.display = "none"; return; }
    box.style.display = "block";
    const s = 7;                                     // px per cell
    // robot frame: x forward, y left → screen: forward up, left left
    const W = l.ny * s, H = l.nx * s;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      cap.textContent = `Lidar occupancy · ${(l.nx * 0.05).toFixed(1)} × ` +
        `${(l.ny * 0.05).toFixed(1)} m · forward up`;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#14171a";
    ctx.fillRect(0, 0, W, H);
    for (let ix = 0; ix < l.nx; ix++) {
      for (let iy = 0; iy < l.ny; iy++) {
        const v = l.grid[ix * l.ny + iy];            // order "xy": x outer
        ctx.fillStyle = v > 0.5 ? "#e0a23c" : "#1b1f23";
        ctx.fillRect((l.ny - 1 - iy) * s + 1, (l.nx - 1 - ix) * s + 1, s - 1, s - 1);
      }
    }
    // robot marker: cell nearest the base (grid center), pointing forward
    const cx = (l.ny - 1 - (l.ny - 1) / 2) * s + s / 2;
    const cy = (l.nx - 1 - (l.nx - 1) / 2) * s + s / 2;
    ctx.fillStyle = "#d9dee3";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4.5);
    ctx.lineTo(cx - 3.5, cy + 3.5);
    ctx.lineTo(cx + 3.5, cy + 3.5);
    ctx.closePath();
    ctx.fill();
  }

  constructor() {
    this.panel = new Panel(document.getElementById("panel")!,
                           document.getElementById("policy-manager")!, [], {
      onRobot: (r) => this.send({ t: "robot", robot: r }),
      onTerrain: (t) => this.send({ t: "terrain", terrain: t }),
      onPolicy: (name) => { this.logInput("policy", name); this.send({ t: "policy", name }); },
      onState: (s) => this.setState(s),
      onReset: () => this.reset(),
      onRecenter: () => this.send({ t: "recenter" }),
      onZeroCmd: () => this.stopAndRearm(),
      onScreenshot: () => screenshot(this.view.renderer.domElement),
      onRecordToggle: () => this.toggleRecording(),
      onOpenTimeline: () => this.openReview(),
      onLoadTake: (file) => void this.openTakeFile(file),
      onLoadCsv: (file, fps) => this.loadCsv(file, fps),
      onStopPlayback: () => this.send({ t: "stopPlayback" }),
      onImportPack: (file) => this.importPack(file),
      onDeletePack: (id) => this.send({ t: "deletePack", id }),
      onDeleteAllPacks: () => this.send({ t: "deleteAllPacks" }),
      onHoist: (on) => this.setHoist(on),
      onRemote: (combo) => this.remote(combo),
    });
    this.timeline = new Timeline(document.getElementById("deck")!, {
      close: () => this.closeReview(),
      exportVideo: () => this.openExport("video"),
      exportData: () => this.openExport("data"),
      save: () => void this.saveTakeFile(),
      viewMode: (m) => this.setViewMode(m),
    });
    const saved = loadExportPrefs();
    this.shot = { ...defaultShot(0.7), ...(saved.shot ?? {}) };
    this.dialog = new ExportDialog(document.getElementById("export")!, {
      take: () => this.take!,
      range: () => [this.timeline.rangeIn, this.timeline.rangeOut],
      shot: this.shot,
      shotChanged: () => this.rebuildShot(),
      grabView: () => ShotPath.grab(this.take!, this.timeline.time, this.view.camera.position, this.view.controls.target),
      path: () => this.shotPath!,
      stage: () => this.stage(),
      setExporting: (on) => { this.exporting = on; this.view.controls.enabled = !on; },
      glb: (fps, camera, floor) => exportGlb(this.take!, this.view, this.takeModel!, {
        fps, t0: this.timeline.rangeIn, t1: this.timeline.rangeOut, floor,
        camera: camera ? { path: this.shotPath!, shot: this.shot, aspect: this.dialog.aspect } : null }),
      csv: (fps) => motionCsv(this.take!, fps, this.timeline.rangeIn, this.timeline.rangeOut),
      saveTake: () => void this.saveTakeFile(),
      save: (blob, ext) => download(blob, `${this.fileStem()}.${ext}`),
      onClose: () => this.setViewMode(this.viewBeforeDialog),
    });
    this.wireShotOrbit();
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);
    this.worker.onerror = (e) =>
      this.showOverlay(`sim worker crashed: ${e.message ?? e}`);
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    // Hand the keyboard back to the sim after using the panel: a dropdown keeps focus after a choice (so W/S would
    // scroll the policy list instead of driving) and a clicked button would turn Space into another click.
    document.addEventListener("change", (e) => {
      if (e.target instanceof HTMLSelectElement) e.target.blur();
    });
    document.addEventListener("click", (e) => {
      const b = (e.target as Element | null)?.closest?.("button");
      if (b instanceof HTMLButtonElement) b.blur();
    });
    // a key released while the window is unfocused never sends keyup — stop instead of walking on
    window.addEventListener("blur", () => { if (this.keysHeld.size) { this.keysHeld.clear(); this.applyKeys(false); } });
    this.wireLeash();
    // restore the previous session's robot / terrain / policy
    const prefs = loadPrefs();
    if (prefs.terrain && (TERRAINS as readonly string[]).includes(prefs.terrain))
      this.panel.setTerrain(prefs.terrain);
    this.pad.scale = [...this.cmdMax] as Command;
    this.send({ t: "init", robot: prefs.robot,
                terrain: this.panel.terrain, policy: prefs.policy });
    this.send({ t: "inspect", on: true });   // left column always streams
    this.renderLoop();
  }

  private send(m: ToWorker) { this.worker.postMessage(m); }

  private setHoist(on: boolean) {
    this.logInput("hoist", on);
    this.hoistOn = on;
    this.send({ t: "hoist", on });
    this.panel.setHoist(on);
  }

  private prefRobot?: string;
  private prefPolicy?: string;

  private persistPrefs() {
    const pj = JSON.stringify({
      robot: this.prefRobot, terrain: this.panel.terrain,
      policy: this.prefPolicy } satisfies Prefs);
    if (pj !== this.savedPrefs) { this.savedPrefs = pj; localStorage.setItem(PREFS_KEY, pj); }
  }

  /** Leash play (drag policies): grab the robot — or the ground right next to
   * it — and pull; a spring force tugs the collar toward the cursor and the
   * dog walks along. Orbit controls pause while dragging. */
  private wireLeash() {
    const dom = this.view.renderer.domElement;
    const anchorAt = (ev: PointerEvent): [number, number] | null =>
      this.view.groundPoint(ev, 0.12);
    dom.addEventListener("pointerdown", (ev) => {
      if (!this.leashCapable || ev.button !== 0 || this.timeline.isOpen) return;
      const p = anchorAt(ev);
      if (!p) return;
      const nearRobot = Math.hypot(p[0] - this.baseXY[0], p[1] - this.baseXY[1]) < 0.8;
      if (!nearRobot && !this.view.pickPart(ev)) return;   // grabbed empty space
      this.leashDrag = p;
      this.view.controls.enabled = false;
      dom.setPointerCapture(ev.pointerId);
      dom.style.cursor = "grabbing";
      this.send({ t: "leash", on: true, x: p[0], y: p[1] });
      ev.preventDefault();
    });
    dom.addEventListener("pointermove", (ev) => {
      if (!this.leashDrag) return;
      const p = anchorAt(ev);
      if (!p) return;
      this.leashDrag = p;
      this.send({ t: "leash", on: true, x: p[0], y: p[1] });
    });
    const release = (ev: PointerEvent) => {
      if (!this.leashDrag) return;
      this.leashDrag = null;
      this.view.controls.enabled = true;
      dom.style.cursor = this.leashCapable ? "grab" : "";
      try { dom.releasePointerCapture(ev.pointerId); } catch { /* gone */ }
      this.send({ t: "leash", on: false });
      this.view.setLeash(null);
    };
    dom.addEventListener("pointerup", release);
    dom.addEventListener("pointercancel", release);
  }

  private showOverlay(msg: string, kind: "busy" | "notice" | "error" = "busy") {
    this.overlayMsg.textContent = msg;
    this.overlayMsg.dataset.kind = kind;
    this.overlay.classList.remove("hidden");
  }

  private setState(s: FsmState) {
    this.logInput("state", s);
    this.send({ t: "state", state: s });
  }

  /** A state / policy / hoist value reported by the worker: logged when it is a change nobody asked
   * for here (policy hand-over, a failed step dropping to damping, [ / ] cycling). */
  private statusInput<K extends keyof App["logged"]>(kind: K, v: NonNullable<App["logged"][K]>) {
    const p = this.pending[kind];
    if (p) {
      if (p.v !== v && ++p.stale <= 3) return;            // the request is still in flight
      delete this.pending[kind];
    }
    this.logInput(kind, v, false);
  }

  /** Log a state / policy / hoist input on the take being recorded, unless it is already the value. */
  private logInput<K extends keyof App["logged"]>(kind: K, v: NonNullable<App["logged"][K]>, byUser = true) {
    if (!this.rec) return;
    if (byUser) this.pending[kind] = { v, stale: 0 };
    if (this.logged[kind] === v) return;
    this.logged[kind] = v;
    this.rec.mark(kind, kind === "state" ? STATE_NAME[v as FsmState]
                      : kind === "hoist" ? (v ? "Hoist on" : "Hoist off") : String(v));
  }

  private reset() {
    this.rec?.mark("reset", "Reset");
    this.send({ t: "reset" });
  }

  /** A remote combo of the active policy (panel button, pad pass-through, G cycling). */
  private remote(combo: string) {
    if (this.rec) {
      const item = this.status?.actions?.flatMap((g) => g.items).find((i) => i.combo === combo);
      this.rec.mark("move", item ? `${item.label} (${combo})` : combo);
    }
    this.send({ t: "remote", combo });
  }

  private setCommand(cmd: Command) {
    this.command = cmd;
    this.send({ t: "command", cmd });
  }

  /** Space / Stop: zero the command AND re-sample the pad's rest position, so
   * a drifting or mis-neutraled pad can always be recovered hands-off. */
  private stopAndRearm() {
    this.pad.rearm();
    this.setCommand([0, 0, 0]);
  }

  private async loadCsv(file: File, fps: number) {
    try {
      const csv = await file.text();
      this.send({ t: "playback", csv, fps, name: file.name });
    } catch (e) {
      this.showOverlay(`failed to read ${file.name}: ${e}`);
    }
  }

  private importChain: Promise<void> = Promise.resolve();

  /** Reads are chained so multi-file imports reach the worker in the order
   * the user picked them (concurrent file reads finish smallest-first). */
  private importPack(file: File) {
    this.importChain = this.importChain.then(async () => {
      try {
        const zip = await file.arrayBuffer();
        this.worker.postMessage({ t: "importPack", zip }, [zip]);
      } catch (e) {
        this.showOverlay(`failed to read ${file.name}: ${e}`);
      }
    });
  }

  // ---- recording -------------------------------------------------------
  private toggleRecording() {
    if (this.rec) this.stopRecording();
    else this.startRecording();
  }

  private startRecording() {
    const m = this.model;
    if (!m || this.exporting) return;
    if (this.timeline.isOpen) this.closeReview();
    const s = this.status;
    this.recModel = m;
    this.rec = new TakeRecorder({
      robot: m.robot, model: s?.model, terrain: this.panel.terrain, policy: s?.policy ?? "-",
      created: new Date().toISOString(), ngeom: m.ngeom, nq: m.nq, baseQadr: m.baseQadr, hinges: m.hinges,
    });
    this.logged = {};
    this.pending = {};
    if (s?.playback) this.rec.mark("clip", s.playback);
    else if (s && s.policy !== "-") this.logInput("policy", s.policy, false);
    if (s && !s.playback) this.logInput("state", s.state, false);
    this.logged.hoist = this.hoistOn;
    this.panel.setRecording(true);
    this.recBadge.hidden = false;
    this.recTime.textContent = "REC 0.0 s";
  }

  /** Stop and open the take on the timeline (`why` explains an automatic stop). */
  private stopRecording(why?: string) {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    this.panel.setRecording(false);
    this.recBadge.hidden = true;
    const take = rec.finish();
    if (!take) {
      this.panel.setRecordInfo("Nothing recorded — the sim posted no frames (is it loading?).");
      return;
    }
    this.take = take;
    this.takeModel = this.recModel;
    this.takeNo++;
    this.takeTitle = `#${this.takeNo} · ${take.meta.model ?? take.meta.robot} · ${take.meta.policy}`;
    this.panel.setTakeAvailable(true);
    this.panel.setRecordInfo(`Take #${this.takeNo}: ${fmtTime(take.duration)} s, ${take.n} frames, ` +
                             `${take.events.length} inputs.` + (why ? ` ${why}` : ""));
    this.openReview();
  }

  private camPose() {
    const c = this.view.camera, t = this.view.controls.target;
    return { pos: [c.position.x, c.position.y, c.position.z] as [number, number, number],
             target: [t.x, t.y, t.z] as [number, number, number], fov: c.fov };
  }

  // ---- review (timeline) ----------------------------------------------------
  private openReview() {
    const take = this.take, tm = this.takeModel;
    if (!take || !tm) return;
    if (this.viewModel !== tm) { this.view.build(tm); this.viewModel = tm; }
    this.send({ t: "pause", on: true });
    this.keysHeld.clear();
    if (this.command.some((v) => v !== 0)) this.setCommand([0, 0, 0]);
    this.reviewXpos = new Float32Array(3 * tm.ngeom);
    this.reviewXmat = new Float32Array(9 * tm.ngeom);
    this.followZ = tm.robot.startsWith("go2") ? 0.35 : 0.7;
    if (this.shot.height <= 0) this.shot.height = this.followZ;
    this.timeline.open(take, this.takeTitle);
    this.rebuildShot();
    this.setViewMode(this.timeline.mode);
    this.lidarBox.box.style.display = "none";
    this.inspectorBody.replaceChildren(eventList(take, this.takeTitle, (t) => this.timeline.seek(t)));
  }

  private closeReview() {
    if (this.exporting) return;
    if (this.dialog.isOpen) this.dialog.close();
    this.timeline.close();
    this.setViewMode("free");
    if (this.model && this.viewModel !== this.model) {
      this.view.build(this.model);
      this.viewModel = this.model;
      this.lastFrame = null;
    }
    this.followZ = this.model?.robot.startsWith("go2") ? 0.35 : 0.7;
    this.send({ t: "pause", on: false });
    this.inspectorBody.innerHTML = `<span class="ins-empty">Back to the live sim…</span>`;
  }

  private setViewMode(m: ViewMode) {
    this.timeline.setMode(m);
    const cam = this.view.camera;
    if (m !== "recorded" && cam.fov !== 45) { cam.fov = 45; cam.updateProjectionMatrix(); }
    this.shotFrame.hidden = m !== "shot";
    this.view.controls.enabled = m !== "recorded" && !this.exporting;
  }

  private rebuildShot() {
    if (!this.take) return;
    this.shotPath = new ShotPath(this.take, this.shot, this.timeline.rangeIn);
    const s = this.shot;
    const [w, h] = this.dialog.outSize;
    this.shotFrame.querySelector("span")!.textContent = `${w} × ${h} · ${s.focal} mm · ${s.mode}`;
  }

  private openExport(tab: "video" | "data") {
    if (!this.take) return;
    if (!this.dialog.isOpen) this.viewBeforeDialog = this.timeline.mode;
    this.timeline.setPlaying(false);
    this.dialog.open(tab);
    this.setViewMode("shot");
  }

  /** Pose the scene from the take at time t (review frames and export frames alike). */
  private poseTake(t: number) {
    const take = this.take!;
    take.geomXformAt(t, this.reviewXpos, this.reviewXmat);
    this.view.sync(this.reviewXpos, this.reviewXmat);
    this.view.setHoist(take.hoistAt(t));
  }

  private stage(): Stage {
    return {
      view: this.view, camera: this.exportCam,
      pose: (t) => this.poseTake(t),
      aim: (cam, t, aspect) => this.shotPath!.apply(cam, t, aspect),
    };
  }

  /** In the Shot view, orbiting the viewport re-frames the shot camera itself (azimuth, elevation,
   * distance), so a shot can be composed by hand and then fine-tuned in the export panel. */
  private wireShotOrbit() {
    const c = this.view.controls, R2D = 180 / Math.PI;
    const offset = () => this.view.camera.position.clone().sub(c.target);
    const azEl = (v: THREE.Vector3) => {
      const r = v.length() || 1;
      return [Math.atan2(v.y, v.x) * R2D, Math.asin(Math.max(-1, Math.min(1, v.z / r))) * R2D, r];
    };
    c.addEventListener("start", () => {
      if (this.timeline.mode !== "shot" || !this.shotPath || this.shot.mode === "viewport") return;
      const p = this.shotPath.at(this.timeline.time);   // start from what the shot shows now
      c.target.copy(p.target);
      this.view.camera.position.copy(p.pos);
      this.shotDrag = { az: this.shot.azimuth, el: this.shot.elevation, d: this.shot.distance, off: offset() };
    });
    c.addEventListener("change", () => {
      const dr = this.shotDrag;
      if (!dr) return;
      const [az, el, r] = azEl(offset()), [az0, el0, r0] = azEl(dr.off);
      let daz = az - az0;
      if (daz > 180) daz -= 360; else if (daz < -180) daz += 360;
      this.shot.azimuth = Math.round(((dr.az + daz + 540) % 360) - 180);
      this.shot.elevation = Math.round(Math.max(-10, Math.min(89, dr.el + el - el0)));
      this.shot.distance = +Math.max(0.3, dr.d * r / r0).toFixed(2);
      this.rebuildShot();
    });
    c.addEventListener("end", () => {
      if (!this.shotDrag) return;
      this.shotDrag = null;
      this.dialog.refresh();
    });
  }

  private fileStem(): string {
    const m = this.take?.meta;
    if (!m) return `take_${stamp()}`;
    const d = new Date(m.created);
    return `${m.robot}_${slug(m.policy === "-" ? "idle" : m.policy)}_${stamp(Number.isNaN(+d) ? undefined : d)}`;
  }

  private async saveTakeFile() {
    if (!this.take) return;
    download(await saveTake(this.take), `${this.fileStem()}.take.zip`);
  }

  private async openTakeFile(file: File) {
    try {
      const take = await loadTake(await file.arrayBuffer());
      const m = this.model, meta = take.meta;
      if (!m || m.robot !== meta.robot || m.ngeom !== meta.ngeom || m.nq !== meta.nq || this.panel.terrain !== meta.terrain) {
        this.panel.showNotice("Different scene loaded",
          `${file.name} was recorded on ${meta.model ?? meta.robot} with the ${meta.terrain} terrain ` +
          `(${meta.ngeom} geoms). Load that robot model and terrain first (the policy decides between ` +
          `variants such as EDU and Air), then open the take again.`);
        return;
      }
      if (this.rec) this.stopRecording();
      this.take = take;
      this.takeModel = m;
      this.takeNo++;
      this.takeTitle = `${file.name.replace(/\.take\.zip$|\.zip$/, "")}`;
      this.panel.setTakeAvailable(true);
      this.panel.setRecordInfo(`Opened ${file.name}: ${fmtTime(take.duration)} s, ${take.n} frames.`);
      this.openReview();
    } catch (e) {
      this.panel.showNotice("Could not open the take", `${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Adopt the active policy's command maxima: they scale the gamepad sticks and the held keys, and
   * clamp whatever is already being commanded. */
  private applyCmdMax(max: Command) {
    this.cmdMax = max;
    this.pad.scale = [...max] as Command;
    const clamped = this.command.map((v, i) =>
      Math.max(-max[i], Math.min(max[i], v))) as Command;
    if (clamped.some((v, i) => v !== this.command[i])) this.setCommand(clamped);
  }

  /** Movement keys are hold-to-move: while held the axis runs at half the policy's limit (full with
   * Shift); releasing every key stops the robot. */
  private static readonly MOVE_KEYS: Record<string, [0 | 1 | 2, 1 | -1]> = {
    w: [0, 1], arrowup: [0, 1], s: [0, -1], arrowdown: [0, -1],
    a: [2, 1], arrowleft: [2, 1], d: [2, -1], arrowright: [2, -1],
    q: [1, 1], e: [1, -1],
  };
  private keysHeld = new Set<string>();

  private applyKeys(shift: boolean) {
    const max = this.cmdMax;
    const c: Command = [0, 0, 0];
    for (const k of this.keysHeld) {
      const [i, dir] = App.MOVE_KEYS[k];
      c[i] += dir;
    }
    const f = shift ? 1 : 0.5;
    this.setCommand(c.map((v, i) => Math.max(-1, Math.min(1, v)) * max[i] * f) as Command);
  }

  private onKeyUp(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === "shift") { if (this.keysHeld.size) this.applyKeys(false); return; }
    if (!(k in App.MOVE_KEYS) || !this.keysHeld.delete(k)) return;
    this.applyKeys(e.shiftKey);
  }

  // ---- worker messages ------------------------------------------------
  private onWorker(m: FromWorker) {
    switch (m.t) {
      case "model":
        // a rebuild mid-recording ends the take there: its frames belong to the old model
        if (this.rec) this.stopRecording("Stopped when the scene was rebuilt.");
        this.model = m.desc;
        if (this.timeline.isOpen) return;          // the review keeps showing the take's model
        this.view.build(m.desc);
        this.viewModel = m.desc;
        this.lastFrame = null;
        // aim the camera at torso height: ~0.7 m for humanoids, lower for
        // the quadruped so its body doesn't sit at the bottom of the frame
        this.followZ = m.desc.robot.startsWith("go2") ? 0.35 : 0.7;
        return;
      case "frame":
        if (this.viewModel !== this.model) return;   // reviewing another model's take
        this.lastFrame = { xpos: m.xpos, xmat: m.xmat };
        this.baseXY = [m.baseX, m.baseY];
        if (!this.timeline.isOpen) this.view.setHoist(m.hoistAnchor ?? null);
        if (this.rec) {
          this.rec.push(m, this.command, this.camPose());
          const e = this.rec.elapsed;
          const txt = `REC ${fmtTime(e, 1)} s`;
          if (txt !== this.recTime.textContent) {
            this.recTime.textContent = txt;
            this.panel.setRecordInfo(`Recording… ${fmtTime(e, 1)} s, ${this.rec.frames} frames.`);
          }
          if (e >= MAX_TAKE_S) this.stopRecording(`Stopped at the ${MAX_TAKE_S / 60} min limit.`);
        }
        return;
      case "status":
        this.applyStatus(m);
        return;
      case "inspect":
        if (this.timeline.isOpen) return;            // the take summary owns the inspector
        this.inspectorBody.innerHTML = formatInspect(m);
        this.renderLidar(m.lidar);
        return;
      case "busy": return this.showOverlay(m.msg, "busy");
      case "ready": return this.overlay.classList.add("hidden");
      case "notice": return this.showOverlay(m.msg, "notice");
      case "error": return this.showOverlay(m.msg, "error");
    }
  }

  private updatePadDebug() {
    const s = this.pad.debugState();
    if (!s) { this.panel.setPadDebug("no gamepad (press any pad button)"); return; }
    const AXN = ["LX", "LY", "RX", "RY"];
    const BTN = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "SEL", "STA",
                 "L3", "R3", "▲", "▼", "◀", "▶", "HOME"];
    const lines = [
      `${s.name.slice(0, 36)}`,
      `mapping ${s.mapping}   ${s.armed ? "ARMED" : "arming — release sticks"}`,
      ...s.axes.map((a, i) =>
        `ax${i} ${(AXN[i] ?? "  ").padEnd(2)} raw ${a.raw.toFixed(2).padStart(6)}` +
        `  n ${a.neutral.toFixed(2).padStart(6)}  → ${a.out.toFixed(2).padStart(6)}` +
        (Math.abs(a.out) > 0 ? "  ●" : "")),
      s.buttons.map((b, i) =>
        `${BTN[i] ?? i}${b.pressed ? "■" : b.value > 0.05 ? b.value.toFixed(1) : "·"}`)
        .join(" "),
    ];
    this.panel.setPadDebug(lines.join("\n"));
  }

  private applyStatus(s: StatusMsg) {
    const prev = this.status;
    this.status = s;
    // changes the user did not make directly (policy hand-over, a step error dropping to damping, [ / ])
    if (this.rec && prev) {
      if ((s.playback ?? "") !== (prev.playback ?? "")) this.rec.mark("clip", s.playback ?? "clip stopped");
      if (s.policy !== "-") this.statusInput("policy", s.policy);
      if (!s.playback) this.statusInput("state", s.state);
      if (s.hoist !== undefined) this.statusInput("hoist", s.hoist);
    }
    if (!prev || prev.robots.join() !== s.robots.join() || prev.robot !== s.robot)
      this.panel.setRobots(s.robots, s.robot);
    const polKey = (m: StatusMsg) => m.policies.map((p) => p.name).join("|");
    if (!prev || prev.robot !== s.robot ||
        polKey(prev) !== polKey(s) || prev.policy !== s.policy)
      this.panel.setPolicies(s.policies, s.policy, s.robot);
    // the manager lists only the ACTIVE family's packs (r1+r1_air | go2)
    const famPacks = s.packs.filter((p) => fam(p.robot) === s.robot);
    if (!prev || prev.robot !== s.robot ||
        prev.packs.map((p) => p.id).join("|") !== s.packs.map((p) => p.id).join("|"))
      this.panel.setPacks(famPacks);
    // persist session choices (robot / terrain / active policy)
    this.prefRobot = s.robot;
    this.prefPolicy = s.policy !== "-" ? s.policy : undefined;
    this.persistPrefs();
    // stick / key scale follows the policy that's now loaded
    const vrKey = s.velRange?.join() ?? "";
    if (vrKey !== this.velRangeKey) { this.velRangeKey = vrKey; this.applyCmdMax(cmdMax(s.velRange)); }
    this.panel.setState(s.state);
    this.panel.setRemoteActions(s.actions);
    // a policy that needs special control explains itself once, when it becomes active
    if (s.notice && s.policy !== "-" && s.policy !== this.noticedPolicy) {
      this.noticedPolicy = s.policy;
      this.panel.showNotice(s.notice.title ?? s.policy, s.notice.text);
    } else if (!s.notice) this.noticedPolicy = undefined;
    if (s.hoist !== undefined && s.hoist !== this.hoistOn) {
      this.hoistOn = s.hoist;
      this.panel.setHoist(s.hoist);
    }
    this.panel.setPlayback(s.playback ?? null);
    this.needsCommand = !s.playback && (s.needsCommand ?? (s.family.includes("locomotion") || s.family.includes("mimic")));
    this.leashCapable = !!s.leash && !s.playback;
    if (!this.leashDrag)
      this.view.renderer.domElement.style.cursor = this.leashCapable ? "grab" : "";
    const [vx, vy, wz] = s.command;
    const f = (x: number) => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(2);
    const pad = this.pad.connected
      ? this.pad.name.slice(0, 28) + (this.pad.armed ? "" : " — release sticks to arm")
      : "none";
    const rows: StatusRow[] = [];
    if (s.playback) rows.push(["clip", s.playback, true]);
    rows.push(["policy", s.policy]);
    rows.push(["model", s.model ? `${s.model}` : `${s.dof} DOF`]);
    rows.push(["state", s.playback ? "kinematic playback" : s.state]);
    rows.push(["cmd", `vx ${f(vx)}  vy ${f(vy)}  wz ${f(wz)}`]);
    if (s.speed) {
      rows.push(["meas", `vx ${f(s.speed[0])}  vy ${f(s.speed[1])}  wz ${f(s.speed[2])}`]);
      rows.push(["speed", `${Math.hypot(s.speed[0], s.speed[1]).toFixed(2)} m/s`]);
    }
    const load = 100 / Math.max(s.rtf, 0.01);
    rows.push(["load", s.policy === "-" ? "idle" : `${Math.min(load, 999).toFixed(0)}% of real-time budget`,
               s.policy !== "-" && load > 100]);
    rows.push(["hoist", this.hoistOn ? "on" : "off", this.hoistOn]);
    rows.push(["pad", pad]);
    if (this.leashCapable) rows.push(["leash", "drag the robot to pull it"]);
    this.panel.setStatus(rows);
  }

  // ---- input ----------------------------------------------------------
  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (this.exporting || document.getElementById("policy-notice")) return;
    if ((e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return this.toggleRecording();
    }
    if (this.timeline.isOpen) {
      // the deck owns the keyboard while reviewing; the sim is paused, so nothing drives it
      if (e.key === "Escape" && this.dialog.isOpen) { this.dialog.close(); e.preventDefault(); return; }
      if (this.timeline.onKey(e)) e.preventDefault();
      return;
    }
    const mk = e.key.toLowerCase();
    if (mk === "shift") { if (this.keysHeld.size) this.applyKeys(true); return; }
    if (mk in App.MOVE_KEYS) {
      e.preventDefault();
      if (!this.keysHeld.has(mk)) { this.keysHeld.add(mk); this.applyKeys(e.shiftKey); }
      return;
    }
    const states: FsmState[] = ["zero_torque", "damping", "lock", "stance", "policy"];
    if (e.key >= "0" && e.key <= "4") return this.setState(states[Number(e.key)]);
    switch (e.key) {
      case "]": return this.send({ t: "cycle", step: 1 });
      case "[": return this.send({ t: "cycle", step: -1 });
      case "r": case "R": return this.reset();
      case "c": case "C": return this.send({ t: "recenter" });
      case "h": case "H": return this.setHoist(!this.hoistOn);
      case "g": case "G": return this.cycleRemote(e.key === "G" ? -1 : 1);
      case " ": e.preventDefault(); return this.stopAndRearm();
    }
  }

  private noticedPolicy?: string;
  private remoteIdx = -1;
  /** G / Shift+G: fire the next / previous remote combo of the active policy */
  private cycleRemote(step: number) {
    const c = this.status?.combos;
    if (!c?.length) return;
    this.remoteIdx = (this.remoteIdx + step + c.length) % c.length;
    this.remote(c[this.remoteIdx]);
  }

  private onPadAction(a: ComboAction) {
    if (a.kind === "state") this.setState(a.state);
    else if (a.kind === "cycle") this.send({ t: "cycle", step: a.step });
    else if (a.kind === "reset") this.reset();
  }

  // ---- render loop ----------------------------------------------------
  private renderLoop() {
    let lastPadCmd = "";
    let padWasActive = false;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      requestAnimationFrame(tick);
      if (this.exporting) return;                    // the export owns the canvas
      if (this.timeline.isOpen && this.take) return this.reviewFrame(dt);
      const padCmd = this.pad.poll((a) => this.onPadAction(a), this.status?.combos,
                                   (combo) => this.remote(combo));
      if (padCmd) {
        padWasActive = true;
        const key = padCmd.map((v) => v.toFixed(2)).join(",");
        if (key !== lastPadCmd) { lastPadCmd = key; this.setCommand(padCmd); }
      } else if (padWasActive) {
        // pad vanished or disarmed mid-drive — don't leave a stale command
        padWasActive = false;
        lastPadCmd = "";
        this.setCommand([0, 0, 0]);
      }
      if (this.lastFrame) {
        this.view.follow(this.baseXY[0], this.baseXY[1], this.followZ);
        this.view.sync(this.lastFrame.xpos, this.lastFrame.xmat);
      }
      if (this.leashDrag)
        this.view.setLeash([this.baseXY[0], this.baseXY[1], 0.3],
                           [this.leashDrag[0], this.leashDrag[1], 0.12]);
      this.view.render();
      if (this.panel.padDebugOpen()) this.updatePadDebug();
    };
    requestAnimationFrame(tick);
  }

  /** One animation frame of the review: advance the playhead, pose the take, render the chosen view. */
  private reviewFrame(dt: number) {
    const take = this.take!, tl = this.timeline;
    tl.tick(dt);
    if (this.shotPath && this.shotPath.t0 !== tl.rangeIn) this.rebuildShot();   // range start anchors fixed / orbit
    const t = tl.time;
    this.poseTake(t);
    const b = take.basePosAt(t);
    if (tl.mode === "recorded") {
      const c = take.camAt(t), cam = this.view.camera;
      cam.position.set(...c.pos);
      this.view.controls.target.set(...c.target);
      cam.lookAt(this.view.controls.target);
      if (cam.fov !== c.fov) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
      this.view.renderWith(cam);
    } else if (tl.mode === "shot" && this.shotPath) {
      if (!this.shotDrag) this.view.follow(b[0], b[1], this.followZ);
      else this.view.controls.update();
      const aspect = this.dialog.aspect;
      this.shotPath.apply(this.shotCam, t, aspect);
      const r = this.view.renderFramed(this.shotCam, aspect);
      const st = this.shotFrame.style;
      st.left = `${r.x}px`; st.top = `${r.y}px`; st.width = `${r.w}px`; st.height = `${r.h}px`;
    } else {
      this.view.follow(b[0], b[1], this.followZ);
      this.view.render();
    }
  }
}

new App();
