/** UI shell — rendering, panel, keyboard and gamepad. All simulation runs in
 * the sim worker (see src/sim/protocol.ts for why); this side only exchanges
 * messages: commands in, model description + frames + status out. */
import * as THREE from "three";
import { NoclipFlight, isCameraKey, isCameraMovementKey } from "./input/noclip";
import type { Command } from "./core/types";
import { GamepadInput, type ComboAction } from "./input/gamepad";
import { ExportDialog, loadPrefs as loadExportPrefs } from "./record/export-dialog";
import { exportGlb } from "./record/export-blender";
import type { Stage } from "./record/export-video";
import { applyStaticShot, grabShotView, defaultShot, ShotPath, type Shot } from "./record/shot";
import { loadTake, motionCsv, saveTake, Take, TakeRecorder } from "./record/take";
import { eventList, fmtTime, Timeline, type ViewMode } from "./record/timeline";
import { download, capturePng, stamp } from "./render/recorder";
import { SceneView, type Appearance, type HeadVisual } from "./render/scene";
import { SceneCamera } from './render/scene-camera';
import type { FromWorker, InspectMsg, RenderModel, StatusMsg, ToWorker, SceneIdentity } from "./sim/protocol";
import type { FsmState } from "./sim/fsm";
import { FrameGeometryBuffer } from './sim/geometry-frames';
import { isTerrain, listMaps, mapId, type TerrainName } from "./sim/terrain";
import { Panel, type StatusRow } from "./ui/panel";
import { LookPanel, type MapLight, type LookState } from "./ui/look";
import { ExplorePanel, sharedView, viewLink, type SavedView } from "./ui/explore";
import { policyPresentation } from './ui/policy-names';
import { FloatingWorkspace } from './ui/floating-workspace';
import './ui/floating-workspace.css';
import { launch } from './ui/launch';
import { HelpDialog } from './ui/help';
import { StorageConsent } from './ui/storage-consent';
import { VisualPicker } from './ui/visual-picker';
import { ShotLibrary, type SavedShot } from './record/library';
import { ShotLibraryDialog } from './ui/shot-library';
import { PhotoLibrary } from './record/photos';
import { RecordingRecovery, type RecordingCheckpointWriter } from './record/recovery';
import { storageErrorMessage, sameIdentity } from './record/storage';
import { characterOptions } from './ui/preview-catalog';
import type { SceneDisplay } from './render/display';
import { effectiveVisualState, type ShotLight } from './record/post';
import { loadStartupCatalogue, plannedAssets, priorIntakeAssets } from './loading/catalogue';
import { OptionalVisualAssetError, planVisualAssets } from './loading/visual-plan';
import { resolveLaunchVisualSelection, type ResolvedLaunchVisualSelection } from './loading/visual-selection';
import type { StartupAssetCatalogue, VisualAssetPlan, WorkerAssetPlan } from './loading/asset-plan';
import { discardPreparedPmodelCharacters } from './characters/prepared-pmodel';
import { mapSource, validLocalMap, type MapSource, type LocalMapIdentity } from './maps/source';
import { openLocalMap } from './ui/local-map';
import type { PreparedTerrainVisual } from './render/scene';

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
const LIVE_ONLY_MESSAGES: Partial<Record<ToWorker['t'], true>> = {
  robot: true, terrain: true, policy: true, cycle: true, state: true, reset: true, hoist: true,
  remote: true, playback: true, stopPlayback: true, deletePack: true, deleteAllPacks: true, recenter: true,
};

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
  const policyLabel = m.policy === '-' ? 'No policy' : policyPresentation(m.policy).label;
  H.push(`<div class="ins-pol" title="${esc(policyLabel)}">${esc(policyLabel)}</div>`);
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

interface ViewRestoreRequest {
  id:number;view:SavedView;navigating:boolean;heldBefore:boolean;resolve:()=>void;reject:(error:Error)=>void;
}
interface SceneChangeOptions {
  signal?:AbortSignal;onCommit?:()=>void;robot?:string;validate?:(scene:SceneIdentity)=>void;
}
interface StoredTakeState {
  id:string;name:string;model:RenderModel;created:boolean;writing:boolean;dirty:boolean;
  failed:boolean;deleted:boolean;previewDirty:boolean;previewReady:boolean;previewFailed:boolean;
  thumbnail?:Blob;previewTimer?:number;previewVersion:number;
  recovery?:RecordingCheckpointWriter;
}
interface WorkspaceCamera {
  position: [number, number, number];
  target: [number, number, number];
  orientation: [number, number, number, number];
  up: [number, number, number];
  fov: number;
  held: boolean;
  mode: ViewMode;
}
class App {
  private sessionMaps=new Map<string,{identity:LocalMapIdentity;source:WeakRef<MapSource>}>();
  private liveMapSource:MapSource|null=null;
  private takeSources=new WeakMap<Take,MapSource>();
  private mapRequest=0;
  private mapPreparing=false;
  private pendingMap:{id:number;terrain:TerrainName;source:MapSource|null;stage:PreparedTerrainVisual|null;resolve:()=>void;reject:(error:unknown)=>void;committing:boolean;onCommit?:()=>void;validate?:(scene:SceneIdentity)=>void}|null=null;
  /** Modal surfaces own keyboard, pointer and gamepad input. */
  private get inputBlocked() { return launch.active || this.mapPreparing || !!this.pendingMap || !!document.querySelector('dialog[data-local-map][open]') || !!this.help?.isOpen || !!this.shotLibrary?.isOpen || VisualPicker.active; }
  private help!: HelpDialog;
  private modalKeys = new Set<string>();
  private initialViewRestore: Promise<void> = Promise.resolve();
  private launchCharacterApplied = false;
  private startupCatalogue!: StartupAssetCatalogue;
  private launchVisualSelection: ResolvedLaunchVisualSelection | null = null;
  private launchPlanToken: string | null = null;
  private resolveFirstFrame: (() => void) | null = null;
  private firstSimulationFrame = new Promise<void>(resolve => { this.resolveFirstFrame = resolve; });
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
  private liveGeometry: FrameGeometryBuffer | null = null;
  private baseXY: [number, number] = [0, 0];
  private baseZ = 0.7;
  private noclip = false;
  private noclipFov: number | null = null;
  private flight!: NoclipFlight;
  private flightReadout = "";
  private flashlight = false;
  private heldView = false;
  private viewRestoreSequence=0;
  private pendingViewRestore:ViewRestoreRequest|null=null;
  private viewRestoreAbort:AbortController|null=null;
  private viewRestoreWork:Promise<void>|null=null;
  private captureNavigationNotice = false;
  private placingRobot = false;
  private placementPending = false;
  private placementPoint: THREE.Vector3 | null = null;
  private explore!: ExplorePanel;
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
  private mapVisualTerrain: TerrainName | null = null;
  private mapVisualGeneration = 0;

  // ---- recording / review ----
  private model: RenderModel | null = null;       // the live model (last "model" message)
  private viewBuildGeneration=0;
  private viewModel: RenderModel | null = null;   // the model the scene currently shows
  private rec: TakeRecorder | null = null;
  private recCheckpoint:RecordingCheckpointWriter|null=null;
  private recordStarting = false;
  private screenshotPending=false;
  private screenshotRequest=0;
  private screenshotAbort:AbortController|null=null;
  private screenshotIsCurrent:(()=>boolean)|null=null;
  private liveReview: { model: RenderModel | null; appearance: Appearance; head: HeadVisual; look: LookState; display: SceneDisplay; flashlight: boolean; shot: Shot; camera: WorkspaceCamera } | null = null;
  private reviewOriginal: { take: Take; appearance: Appearance; head: HeadVisual; look: LookState; display: SceneDisplay; flashlight: boolean; lights: ShotLight[] } | null = null;
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
  private readonly shotStore=new ShotLibrary();
  private readonly photoStore=new PhotoLibrary();
  private readonly recordingRecovery=new RecordingRecovery(this.shotStore);
  private shotLibrary!:ShotLibraryDialog;
  private readonly storedTakes=new WeakMap<Take,StoredTakeState>();
  private readonly shotWrites=new Set<Promise<void>>();
  private readonly warnPendingSave=(event:BeforeUnloadEvent)=>{
    if(!this.screenshotPending&&!this.shotWrites.size)return;
    event.preventDefault();event.returnValue='';
  };
  private openingShotLibrary=false;
  private takeTitle = "";
  private takeNo = 0;
  private timeline: Timeline;
  private dialog: ExportDialog;
  private shot: Shot;
  private shotPath: ShotPath | null = null;
  private readonly liveShotBase: [number, number, number] = [0, 0, 0];
  private readonly shotCam = new SceneCamera(40, 16 / 9, 0.05, 100);
  private readonly exportCam = new SceneCamera(40, 16 / 9, 0.05, 100);
  private exporting = false;
  private shotDrag: { az: number; el: number; d: number; off: THREE.Vector3 } | null = null;
  private viewBeforeDialog: ViewMode = "free";
  private setupCamera: WorkspaceCamera | null = null;
  private look!: LookPanel;
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
      onRobot: (r) => {
        if(this.timeline.isOpen||this.exporting||(this.mapPreparing&&!this.viewRestoreAbort))return;
        this.cancelScreenshot();
        void this.cancelViewRestore().then(()=>{if(this.noclip)this.setNoclip(false);this.heldView=false;this.send({t:'robot',robot:r});});
      },
      onTerrain: (t) => {
        if(this.timeline.isOpen||this.exporting||(this.mapPreparing&&!this.viewRestoreAbort))return;
        this.cancelScreenshot();
        void this.cancelViewRestore().then(()=>{
          if(this.noclip)this.setNoclip(false);this.heldView=false;
          return this.selectTerrain(t);
        }).catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))this.panel.showNotice('Map not loaded',error instanceof Error?error.message:String(error));});
      },
      onPolicy: (name) => { if(this.timeline.isOpen||this.exporting)return; this.logInput("policy", name); this.send({ t: "policy", name }); },
      onState: (s) => this.setState(s),
      onReset: () => this.reset(),
      onRecenter: () => this.recenterView(),
      onZeroCmd: () => this.stopAndRearm(),
      onScreenshot: () => {void this.takeScreenshot();},
      onRecordToggle: () => this.toggleRecording(),
      onOpenTimeline: () => this.openReview(),
      onExportSetup: () => this.openExport("video"),
      onOpenShots:()=>{void this.openShots();},
      onLoadTake: (file) => void this.openTakeFile(file),
      onLocalMap: async file=>{
        if(this.rec||this.recordStarting||this.timeline.isOpen||this.exporting||(this.mapPreparing&&!this.viewRestoreAbort))throw new Error('Finish the current recording, review or export before loading a map.');
        await this.cancelViewRestore();
        try{await openLocalMap(file,undefined,(source,signal,onCommit)=>this.changeTerrain(`map:${source.id}`,source,{signal,onCommit}));}
        catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))throw error;}
      },
      onLoadCsv: (file, fps) => this.loadCsv(file, fps),
      onStopPlayback: () => this.send({ t: "stopPlayback" }),
      onImportPack: (file) => this.importPack(file),
      onDeletePack: (id) => this.send({ t: "deletePack", id }),
      onDeleteAllPacks: () => this.send({ t: "deleteAllPacks" }),
      onHoist: (on) => this.setHoist(on),
      onNoclip: (on) => this.setNoclip(on),
      onFlashlight: (on) => this.setFlashlight(on),
      onRemote: (combo) => this.remote(combo),
    });
    this.timeline = new Timeline(document.getElementById("deck")!, {
      close: () => this.closeReview(),
      exportVideo: () => this.openExport("video"),
      exportData: () => this.openExport("data"),
      save: () => void this.saveTakeFile(),
      library:()=>{void this.openShots();},
      editLook: () => this.editTakeLook(),
      rangeChanged:()=>{
        if(!this.take||!this.timeline.isOpen||this.exporting)return;
        this.take.range=[this.timeline.rangeIn,this.timeline.rangeOut];this.rebuildShot();
      },
      viewMode: (m) => this.setViewMode(m),
    });
    const saved = loadExportPrefs();
    this.shot = { ...defaultShot(0.7), ...(saved.shot ?? {}) };
    this.dialog = new ExportDialog(document.getElementById("export")!, {
      take: () => this.timeline.isOpen ? this.take : null,
      range: () => this.timeline.isOpen && this.take ? [this.timeline.rangeIn, this.timeline.rangeOut] : null,
      shot: this.shot,
      shotChanged: () => this.rebuildShot(),
      grabView: () => this.timeline.isOpen && this.take
        ? ShotPath.grab(this.take, this.timeline.time, this.view.camera.position, this.view.controls.target)
        : grabShotView(this.view.camera.position, this.view.controls.target),
      path: () => this.timeline.isOpen ? this.shotPath : null,
      stage: () => this.stage(),
      setExporting: (on) => this.setExporting(on),
      glb: (fps, camera, floor) => exportGlb(this.take!, this.view, this.takeModel!, {
        fps, t0: this.timeline.rangeIn, t1: this.timeline.rangeOut, floor, look: this.look.getState(),
        camera: camera ? { path: this.shotPath!, shot: this.shot, aspect: this.dialog.aspect } : null }),
      csv: (fps) => motionCsv(this.take!, fps, this.timeline.rangeIn, this.timeline.rangeOut),
      saveTake: () => this.saveTakeFile(),
      save: (blob, ext) => download(blob, `${this.fileStem()}.${ext}`),
      onClose: () => {
        document.body.classList.remove('output-setup');
        if (this.setupCamera) {
          const camera = this.setupCamera; this.setupCamera = null;
          this.restoreWorkspaceCamera(camera);
          this.flight.setActive(this.noclip);
          document.getElementById('flight-hud')!.hidden = !this.noclip;
        } else this.setViewMode(this.viewBeforeDialog);
      },
    });
    this.wireShotOrbit();
    this.look = new LookPanel(document.getElementById("panel")!, this.view);
    this.explore = new ExplorePanel(document.getElementById("panel")!, {
      display: (display) => this.view.setDisplay(display),
      capture: () => this.captureView(), restore: (view) => this.restoreView(view),
    });
    this.setFlashlight(localStorage.getItem('ume-live-flashlight') === 'true', false);
    window.addEventListener('hashchange', () => { const view = sharedView(); if (view) void this.explore.restoreView(view); });
    this.wirePartPicking();
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      try { this.onWorker(ev.data); }
      catch (error) { this.showOverlay(`Scene could not load: ${error instanceof Error ? error.message : error}`, 'error'); }
    };
    this.worker.onerror = (e) =>
      this.showOverlay(`sim worker crashed: ${e.message ?? e}`, 'error');
    this.flight = new NoclipFlight(this.view.camera, this.view.controls.target,
      this.view.renderer.domElement, () => this.send({ t: 'noclipMove', velocity: [0, 0, 0] }));
    let controlsBeforeHelp = true;
    const storageConsent = new StorageConsent(document.getElementById('viewport')!, () => this.stopAndRearm());
    this.help = new HelpDialog({
      storageConsent,
      context: () => this.timeline.isOpen ? 'timeline' : this.noclip ? 'flight' : 'play',
      onOpen: () => {
        controlsBeforeHelp = this.view.controls.enabled;
        this.stopAndRearm();
        this.view.controls.enabled = false;
      },
      onClose: () => {
        this.pad.rearm();
        this.view.controls.enabled = controlsBeforeHelp && !launch.active && !this.exporting && !VisualPicker.active;
      },
    });
    this.help.attachTo(document.getElementById('viewport-tools')!);
    let controlsBeforeShots=true,openedStoredShot=false;
    this.shotLibrary=new ShotLibraryDialog(document.body,{
      library:this.shotStore,photos:this.photoStore,recoveries:this.recordingRecovery,
      open:async(saved,signal)=>{await this.openStoredShot(saved,signal);openedStoredShot=true;},
      deleted:id=>{
        const state=this.take&&this.storedTakes.get(this.take);
        if(state?.id===id){state.deleted=true;clearTimeout(state.previewTimer);this.updateShotSaveStatus(this.take!,state);}
      },
      blocked:()=>this.shotLibraryBlocked(),
      modalChanged:open=>{
        if(open){
          openedStoredShot=false;
          controlsBeforeShots=this.view.controls.enabled;
          this.timeline.setPlaying(false);this.stopAndRearm();this.view.controls.enabled=false;
        }else{
          this.pad.rearm();
          const enabled=openedStoredShot?this.timeline.mode!=='recorded'&&!this.noclip:controlsBeforeShots;
          this.view.controls.enabled=enabled&&!launch.active&&!this.exporting&&!this.help.isOpen&&!VisualPicker.active;
        }
      },
    });
    new FloatingWorkspace();
    let controlsBeforeGallery = true;
    window.addEventListener('visual-picker-open', () => {
      controlsBeforeGallery = this.view.controls.enabled;
      this.stopAndRearm();
      this.view.controls.enabled = false;
    });
    window.addEventListener('visual-picker-close', () => {
      this.pad.rearm();
      this.view.controls.enabled = controlsBeforeGallery && !launch.active && !this.exporting && !this.help.isOpen && !this.shotLibrary.isOpen;
    });
    this.wireNavigation();
    window.addEventListener('keydown', event => {
      if (this.help.isOpen || this.shotLibrary.isOpen || VisualPicker.active) this.modalKeys.add(event.code);
    }, true);
    window.addEventListener('keyup', event => this.modalKeys.delete(event.code), true);
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    // Return keyboard control to the simulation after a dropdown or ordinary action.
    // Dropdowns consume W/S and buttons consume Space; navigation owns its focus.
    document.addEventListener("change", (e) => {
      if (this.inputBlocked) return;
      if (e.target instanceof HTMLSelectElement) e.target.blur();
    });
    document.addEventListener("click", (e) => {
      if (this.inputBlocked) return;
      if ((e.target as Element | null)?.closest?.('.help-dialog,.help-trigger,[data-visual-picker],#workspace-panels')) return;
      const b = (e.target as Element | null)?.closest?.("button");
      if (b instanceof HTMLButtonElement) b.blur();
    });
    // a key released while the window is unfocused never sends keyup — stop instead of walking on
    window.addEventListener("blur", () => {
      this.modalKeys.clear();
      if (this.keysHeld.size) { this.keysHeld.clear(); this.applyKeys(false); }
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.recCheckpoint?.checkpoint();});
    window.addEventListener('pagehide',()=>this.recCheckpoint?.checkpoint());
    this.wireLeash();
    // restore the previous session's robot / terrain / policy
    this.pad.scale = [...this.cmdMax] as Command;
    launch.onEnter(() => {
      this.keysHeld.clear(); this.flight.stop(); this.pad.rearm(); this.view.controls.enabled = !this.noclip;
      this.send({ t: 'loadingFinished', generation: launch.loadingId });
      discardPreparedPmodelCharacters();
      storageConsent.sceneEntered();
    });
    launch.onFailure(() => {
      this.send({ t: 'loadingFinished', generation: launch.loadingId });
      discardPreparedPmodelCharacters();
    });
    void this.start().catch(error => this.showOverlay(`Scene could not start: ${error instanceof Error ? error.message : error}`, 'error'));
    this.renderLoop();
  }

  /** Consume the in-memory launch choice; no storage-based launch message bus. */
  private async start() {
    const prefs = loadPrefs(), selection = launch.selection;
    if(selection.localSource){const source=this.liveMapSource=selection.localSource;if(source.identity)this.sessionMaps.set(source.id,{identity:source.identity,source:new WeakRef(source)});selection.localSource=undefined;}
    const requestedSource=this.resolveTerrainSource(selection.terrain,selection.preserveView?sharedView()?.localMap:undefined);
    this.liveMapSource=requestedSource instanceof Promise?await requestedSource:requestedSource;
    const maps = await listMaps();
    for(const {identity} of this.sessionMaps.values())maps.push(identity);
    if (selection.terrain.startsWith('map:') && !maps.some(map => `map:${map.id}` === selection.terrain)) {
      maps.push({ id: selection.terrain.slice(4), name: selection.terrain.slice(4), game: 'Selected map' });
    }
    this.panel.setMaps(maps);
    let shared = selection.preserveView ? sharedView() : null;
    const navigation = new URL(location.href);
    if (!selection.preserveView && navigation.hash.startsWith('#view=')) navigation.hash = '';
    if (selection.terrain.startsWith('map:')&&!selection.terrain.startsWith('map:local-')) navigation.searchParams.set('map', selection.terrain.slice(4));
    else navigation.searchParams.delete('map');
    history.replaceState(null, '', navigation);
    if (selection.character) {
      // A deliberate preset choice replaces linked body/paint, never a default preselection.
      const url = new URL(location.href);
      url.searchParams.delete('body');
      history.replaceState(null, '', url);
      if (shared) shared = { ...shared, appearance: undefined, sourceHead: 'stock' };
    }
    this.panel.setTerrain(selection.terrain);
    if (shared) {
      this.initialViewRestore = this.restoreView(shared, false);
      void this.initialViewRestore.catch(error => this.failLaunchVisuals(`Shared view could not load: ${error instanceof Error ? error.message : error}`));
    }
    const catalogue = this.startupCatalogue = await loadStartupCatalogue();
    this.send({ t: "init", robot: selection.robot, terrain: selection.terrain, localMap:mapSource(selection.terrain)?.payload, loadingId: launch.loadingId, catalogue,
      robotExplicit:selection.robotChanged||selection.preserveView,
      policy: selection.robotChanged || selection.robot !== prefs.robot ? undefined : prefs.policy });
    if (this.pendingViewRestore) this.send({ t: 'viewReady', request: this.pendingViewRestore.id });
    this.send({ t: "inspect", on: true });   // left column always streams
  }

  /** The worker's actual model/policy selection owns the one startup payload plan. */
  private async prepareStartupAssets(plan: WorkerAssetPlan) {
    if (!launch.active || plan.generation !== launch.loadingId || this.launchPlanToken !== null) return;
    this.launchPlanToken = plan.token;
    let optionalFailure = false;
    const prepare = async (original: boolean) => {
      const catalogue = this.startupCatalogue, selection = launch.selection;
      let appearances: Record<string, Appearance> = {}, heads: Record<string, HeadVisual> = {};
      try { appearances = JSON.parse(localStorage.getItem('ume-appearance') ?? '{}') as Record<string, Appearance> ?? {}; } catch { /* Default paint. */ }
      try { heads = JSON.parse(localStorage.getItem('ume-head-visuals') ?? '{}') as Record<string, HeadVisual> ?? {}; } catch { /* Stock head. */ }
      if (original) {
        discardPreparedPmodelCharacters();
        selection.character = 'stock';
      }
      const linked = this.pendingViewRestore?.view;
      const visual = resolveLaunchVisualSelection({ terrain: selection.terrain, robot: plan.robot,
        character: selection.character, sharedAppearance: linked?.appearance,
        rememberedAppearance: appearances[plan.robot], queryBody: new URLSearchParams(location.search).get('body'),
        sharedHead: linked?.sourceHead, rememberedHead: heads[plan.robot] });
      this.launchVisualSelection = visual;
      if (original && this.pendingViewRestore) {
        this.pendingViewRestore.view = { ...this.pendingViewRestore.view, appearance: visual.appearance, sourceHead: 'stock' };
      }
      let visuals: VisualAssetPlan;
      try { visuals = await planVisualAssets(visual, catalogue); }
      catch (error) { optionalFailure = error instanceof OptionalVisualAssetError; throw error; }
      if (!launch.active || plan.generation !== launch.loadingId || this.launchPlanToken !== plan.token) {
        discardPreparedPmodelCharacters();
        return;
      }
      const prepared = [...plan.prepared, ...visuals.prepared];
      // File intake can have already evaluated page dependencies before Load.
      // Exclude only that page scope; independent worker/visual reads still count.
      const priorPageAssets = priorIntakeAssets(catalogue, launch.priorLocalMapIntake,
        performance.getEntriesByType('resource') as PerformanceResourceTiming[]);
      const assets = [
        ...plannedAssets(catalogue, catalogue.runtime.page, [], priorPageAssets),
        ...plannedAssets(catalogue, [...plan.urls, ...visuals.urls, ...prepared.map(asset => asset.url)], prepared),
        ...(launch.usesLocalMapVerification
          ? plannedAssets(catalogue, catalogue.runtime.localMapVerification, []).map(asset => ({ ...asset, realm: 'map-verification' as const }))
          : []),
      ];
      launch.freezeAssets(plan.generation, assets, prepared);
      this.send({ t: 'loadingProceed', generation: plan.generation, token: plan.token });
      this.prepareMapVisual(selection.terrain);
    };
    try { await prepare(false); }
    catch (error) {
      discardPreparedPmodelCharacters();
      const message = `Scene assets could not be planned: ${error instanceof Error ? error.message : error}`;
      if (optionalFailure) launch.fail(message, () => prepare(true));
      else this.showOverlay(message, 'error');
    }
  }

  sourceForTerrain(terrain:TerrainName):MapSource|null {return mapId(terrain)===this.liveMapSource?.id?this.liveMapSource:mapSource(terrain);}
  private send(m: ToWorker) {
    if ((this.timeline?.isOpen || this.exporting || this.mapPreparing || this.pendingMap) && LIVE_ONLY_MESSAGES[m.t]) return;
    this.worker.postMessage(m);
  }
  private async selectTerrain(terrain:TerrainName):Promise<void>{
    this.panel.setTerrain(this.model?.terrain??this.panel.terrain);
    const id=mapId(terrain),local=id&&this.sessionMaps.get(id);
    if(local&&!local.source.deref()){
      await openLocalMap(undefined,local.identity,(source,signal,onCommit)=>this.changeTerrain(terrain,source,{signal,onCommit}));
    }else await this.changeTerrain(terrain);
  }

  /** Rendering and native compilation both finish before replacing the active map. */
  private async changeTerrain(terrain:TerrainName,source=this.sourceForTerrain(terrain),options:SceneChangeOptions={}):Promise<void> {
    const {signal,onCommit,robot,validate}=options;
    if((source?.id??null)!==mapId(terrain))throw new Error('The selected map source does not match the requested terrain.');
    if(this.mapPreparing||this.pendingMap)throw new Error('A map is already loading.');
    this.mapPreparing=true;
    try{
    const previous=this.model?.terrain??this.panel.terrain;
    this.panel.setTerrain(previous);
    const id=++this.mapRequest;
    this.stopAndRearm();this.cancelScreenshot();
    signal?.throwIfAborted();
    const stage=terrain===this.mapVisualTerrain&&this.view.mapSource?.id===source?.id
      ?null:await this.view.stageTerrainVisual(source);
    if(signal?.aborted){stage?.dispose();signal.throwIfAborted();}
    const {promise,resolve,reject}=Promise.withResolvers<void>();
    const pending=this.pendingMap={id,terrain,source,stage,resolve,reject,committing:false,onCommit,validate};
    const cancel=()=>{if(this.pendingMap!==pending||pending.committing)return;this.pendingMap=null;stage?.dispose();this.worker.postMessage({t:'cancelTerrain'});this.overlay.classList.add('hidden');reject(new DOMException('Map loading cancelled.','AbortError'));};
    signal?.addEventListener('abort',cancel,{once:true});
    try{
      this.worker.postMessage({t:'terrain',terrain,robot,request:id,localMap:source?.payload});
      await promise;
    }catch(error){
      if(this.pendingMap===pending){this.pendingMap=null;stage?.dispose();this.worker.postMessage({t:'cancelTerrain'});this.overlay.classList.add('hidden');}
      throw error;
    }finally{signal?.removeEventListener('abort',cancel);}
    }finally{this.mapPreparing=false;this.updateCaptureNavigationNotice();}
  }

  /** Existing sources stay synchronous so the initial shared-view worker barrier is installed before init. */
  private resolveTerrainSource(terrain:TerrainName,identity?:LocalMapIdentity,signal?:AbortSignal):MapSource|null|Promise<MapSource> {
    if(identity&&!validLocalMap(identity,terrain))throw new Error('The saved local map identity is invalid.');
    try{return this.sourceForTerrain(terrain);}
    catch(error){
      if(!terrain.startsWith('map:local-'))throw error;
      const id=terrain.slice(4),fingerprint=id.slice(6);
      if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('Choose a verified map bundle before restoring this view.');
      const expected=identity??this.sessionMaps.get(id)?.identity??{id,fingerprint,name:'Local map',game:'Local'};
      const observer = launch.active ? launch.beginLocalMapVerification() : undefined;
      return openLocalMap(undefined,expected,undefined,signal,observer).then(source=>{
        signal?.throwIfAborted();
        this.sessionMaps.set(source.id,{identity:expected,source:new WeakRef(source)});
        return source;
      });
    }
  }

  private async attachTakeMap(take:Take,signal?:AbortSignal):Promise<void> {
    const meta=take.meta;
    if(!meta.terrain.startsWith('map:local-'))return;
    if(!validLocalMap(meta.localMap,meta.terrain))throw new Error('This take has no valid local map identity. Re-record it with its original map.');
    const resolved=this.resolveTerrainSource(meta.terrain as TerrainName,meta.localMap,signal);
    const source=resolved instanceof Promise?await resolved:resolved;
    if(!source)throw new Error('The take’s local map is unavailable.');
    this.takeSources.set(take,source);
    this.panel.addLocalMap(source.id,meta.localMap.name);
  }

  private setHoist(on: boolean) {
    if(this.timeline.isOpen||this.exporting)return;
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
      if (this.noclip || !this.leashCapable || ev.button !== 0 || this.timeline.isOpen) return;
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
    if (launch.active) {
      if (kind === 'error' || kind === 'notice') launch.fail(msg);
      else launch.phase(msg);
      return;
    }
    this.overlayMsg.textContent = msg;
    this.overlayMsg.dataset.kind = kind;
    this.overlay.classList.remove("hidden");
  }

  private setState(s: FsmState) {
    if(this.timeline.isOpen||this.exporting)return;
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
    if(this.timeline.isOpen||this.exporting)return;
    this.stopAndRearm();
    this.rec?.mark("reset", "Reset");
    this.send({ t: "reset" });
  }

  /** A remote combo of the active policy (panel button, pad pass-through, G cycling). */
  private remote(combo: string) {
    if(this.timeline.isOpen||this.exporting)return;
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
    this.keysHeld.clear();
    this.flight?.stop();
    this.send({ t: "noclipMove", velocity: [0, 0, 0] });
    this.pad.rearm();
    this.setCommand([0, 0, 0]);
  }

  private setNoclip(on: boolean) {
    if (this.timeline.isOpen || this.exporting || this.noclip === on) return;
    this.stopAndRearm();
    this.cancelPlacement();
    this.noclip = on;
    this.view.setRobotHidden(on);
    if (on) { this.noclipFov = this.view.camera.fov; this.view.camera.fov = 60; }
    else if (this.noclipFov !== null) { this.view.camera.fov = this.noclipFov; this.noclipFov = null; }
    this.view.camera.updateProjectionMatrix();
    if (on) {
      const damping = this.view.controls.enableDamping;
      this.view.controls.enableDamping = false;
      this.view.controls.update();
      this.view.controls.enableDamping = damping;
    }
    this.view.controls.enabled = !on;
    this.flight.setActive(on);
    document.getElementById('flight-hud')!.hidden = !on;
    if (on && !this.inputBlocked) this.view.renderer.domElement.focus({ preventScroll: true });
    // Flying owns the camera directly. Keep the final view when returning to physics.
    this.heldView = true;
    this.panel.setNoclip(on);
    this.rec?.mark("noclip", on ? "Noclip on" : "Noclip off");
    this.send({ t: "noclip", on });
  }

  private wireNavigation() {
    const panels = document.getElementById('toggle-panels') as HTMLButtonElement;
    const inspector = document.getElementById('toggle-inspector') as HTMLButtonElement;
    const menu = document.getElementById('toggle-menu') as HTMLButtonElement;
    let visible = { inspector: false, menu: false };
    let restore = { inspector: false, menu: true };
    try {
      const saved = JSON.parse(localStorage.getItem('ume-panel-visibility') ?? 'null');
      if (typeof saved?.inspector === 'boolean' && typeof saved?.menu === 'boolean') {
        visible = { inspector: saved.inspector, menu: saved.menu };
        if (typeof saved.restore?.inspector === 'boolean' && typeof saved.restore?.menu === 'boolean'
            && (saved.restore.inspector || saved.restore.menu)) restore = saved.restore;
      }
    } catch { /* Keep the default layout when stored preferences are unavailable. */ }
    menu.textContent = 'Controls';
    const update = (focus = true) => {
      const hidden = !visible.inspector && !visible.menu;
      document.body.classList.toggle('map-focus', hidden);
      document.body.classList.toggle('inspector-hidden', !visible.inspector);
      document.body.classList.toggle('menu-hidden', !visible.menu);
      for (const [button, name, shown] of [[inspector, 'inspector', visible.inspector], [menu, 'controls', visible.menu]] as const) {
        button.setAttribute('aria-pressed', String(shown));
        button.setAttribute('aria-expanded', String(shown));
        button.title = `${shown ? 'Hide' : 'Show'} ${name}`;
        button.setAttribute('aria-label', button.title);
      }
      panels.textContent = hidden ? 'Show panels' : 'Hide panels';
      panels.setAttribute('aria-pressed', String(hidden));
      if (!hidden) restore = { ...visible };
      try { localStorage.setItem('ume-panel-visibility', JSON.stringify({ ...visible, restore })); } catch { /* Layout still works without persistence. */ }
      if (focus) this.view.renderer.domElement.focus({ preventScroll: true });
    };
    panels.onclick = () => {
      if (this.exporting) return;
      visible = !visible.inspector && !visible.menu ? { ...restore } : { inspector: false, menu: false };
      update();
    };
    inspector.onclick = () => { if (!this.exporting) { visible.inspector = !visible.inspector; update(); } };
    menu.onclick = () => { if (!this.exporting) { visible.menu = !visible.menu; update(); } };
    update(false);
    const toolbar = document.getElementById('viewport-tools')!;
    new ResizeObserver(() => {
      document.getElementById('viewport')!.style.setProperty('--viewport-tools-height', `${toolbar.offsetHeight}px`);
    }).observe(toolbar);
    window.addEventListener('keydown', e => {
      if (this.inputBlocked) return;
      if (e.code === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
          && e.target === this.view.renderer.domElement) {
        e.preventDefault(); panels.click();
      }
    });
    const fullscreen = document.getElementById('fullscreen') as HTMLButtonElement;
    if (!document.fullscreenEnabled) fullscreen.hidden = true;
    fullscreen.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.getElementById('app')!.requestFullscreen();
      } catch { fullscreen.textContent = 'Full screen unavailable'; }
    };
    document.addEventListener('fullscreenchange', () => {
      fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
      fullscreen.setAttribute('aria-pressed', String(!!document.fullscreenElement));
    });
    const speed = document.getElementById('flight-speed') as HTMLInputElement;
    speed.oninput = () => { this.flight.speed = Number(speed.value); this.updateFlightHud(); };
    document.getElementById('flight-hover')!.onclick = () => { this.flight.hover = !this.flight.hover; this.updateFlightHud(); };
    document.getElementById('flight-exit')!.onclick = () => this.setNoclip(false);
    document.getElementById('flight-place')!.onclick = () => this.placingRobot ? this.cancelPlacement() : this.beginPlacement();
    const canvas = this.view.renderer.domElement;
    const hitAt = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return this.view.pickPlacement(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1,
        1 - (event.clientY - box.top) / box.height * 2));
    };
    canvas.addEventListener('pointermove', event => {
      if (!this.placingRobot || this.placementPending) return;
      const hit = hitAt(event);
      this.view.showPlacement(hit?.point ?? null, hit?.normal, hit?.valid);
      document.getElementById('flight-hint')!.textContent = hit?.valid
        ? 'Click to place the robot here. Esc cancels.' : 'Choose a floor or upward-facing surface. Esc cancels.';
    });
    canvas.addEventListener('pointerdown', event => {
      if (!this.placingRobot) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.button !== 0 || this.placementPending) return;
      const hit = hitAt(event);
      this.view.showPlacement(hit?.point ?? null, hit?.normal, hit?.valid);
      if (!hit?.valid) return;
      this.placementPending = true; this.placementPoint = hit.point;
      const direction = this.view.camera.getWorldDirection(new THREE.Vector3());
      document.getElementById('flight-hint')!.textContent = 'Placing robot…';
      this.send({ t: 'placeRobot', position: hit.point.toArray() as [number, number, number], yaw: Math.atan2(direction.y, direction.x) });
    }, true);
  }

  private beginPlacement() {
    if (!this.noclip || this.timeline.isOpen || this.exporting || this.placementPending) return;
    this.placingRobot = true;
    this.flight.setActive(false);
    const button = document.getElementById('flight-place')!;
    button.querySelector('.lbl')!.textContent = 'Cancel placement'; button.setAttribute('aria-pressed', 'true');
    document.getElementById('flight-hint')!.textContent = 'Click a floor or upward-facing surface to place the robot. Esc cancels.';
    this.view.renderer.domElement.style.cursor = 'crosshair';
    this.view.renderer.domElement.focus({ preventScroll: true });
  }

  private cancelPlacement() {
    this.placingRobot = false; this.placementPending = false; this.placementPoint = null;
    this.view.showPlacement(null);
    const button = document.getElementById('flight-place')!;
    button.querySelector('.lbl')!.textContent = 'Place robot'; button.setAttribute('aria-pressed', 'false');
    document.getElementById('flight-hint')!.textContent = 'Drag to look · WASD / arrows fly · Numpad 8/2/4/6 move, 9/3 up/down, 5 stop · Shift faster';
    if (this.noclip) this.flight.setActive(true);
  }

  private updateFlightHud() {
    const speed = document.getElementById('flight-speed') as HTMLInputElement;
    speed.value = String(this.flight.speed);
    const text = `${(this.flight.speed * 60 / 20 * .0254).toFixed(1)} m/s`;
    if (text !== this.flightReadout) {
      this.flightReadout = text; document.getElementById('flight-readout')!.textContent = text;
    }
    document.getElementById('flight-hover')!.setAttribute('aria-pressed', String(this.flight.hover));
  }

  private setFlashlight(on: boolean, deliberate = true) {
    if (this.exporting) return;
    this.cancelScreenshot();
    this.flashlight = on;
    this.view.setFlashlight(on);
    this.panel.setFlashlight(on);
    if (deliberate) {
      if (this.timeline.isOpen && this.take) this.saveTakeEdits(this.take);
      else localStorage.setItem('ume-live-flashlight', String(on));
    }
  }

  private captureView(): SavedView {
    if(this.pendingViewRestore||this.viewRestoreAbort)throw new Error('Wait for the view to finish restoring before saving or sharing it.');
    const p = this.view.camera.position, t = this.view.controls.target, appearance = this.view.getAppearance();
    return { version: 1, robot: this.viewModel?.robot ?? this.model?.robot ?? this.status?.robot ?? 'r1', terrain: this.viewModel?.terrain ?? this.panel.terrain,
      localMap:this.sourceForTerrain(this.viewModel?.terrain??this.panel.terrain)?.identity,
      position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: this.view.camera.fov,
      display: this.explore.getDisplay(), flashlight: this.flashlight, look: this.look.getState(),
      appearance,sourceHead:(appearance.sourceBody??'stock')==='stock'&&this.view.getHeadVisualState().available?this.view.getHeadVisual():'stock',
      orientation:this.view.camera.quaternion.toArray(),noclip:this.noclip,flight:{speed:this.flight.speed,hover:this.flight.hover} };
  }

  private restoreView(view:SavedView,navigate=true):Promise<void> {
    if(this.rec||this.recordStarting)return Promise.reject(new Error('Stop recording before restoring a view.'));
    if(this.exporting)return Promise.reject(new Error('Wait for the export to finish before restoring a view.'));
    if(this.timeline.isOpen)return Promise.reject(new Error('Close the timeline before restoring a view.'));
    if(this.mapPreparing&&!this.viewRestoreAbort)return Promise.reject(new Error('Wait for the map to finish loading.'));
    const previous=this.viewRestoreWork;
    void this.cancelViewRestore();
    const controller=this.viewRestoreAbort=new AbortController(),id=++this.viewRestoreSequence;
    this.updateCaptureNavigationNotice();
    const work=this.runViewRestore(view,navigate,controller,id,previous);
    this.viewRestoreWork=work;
    const finished=()=>{if(this.viewRestoreWork===work)this.viewRestoreWork=null;};
    void work.then(finished,finished);
    return work;
  }

  private async runViewRestore(view:SavedView,navigate:boolean,controller:AbortController,id:number,previous:Promise<void>|null):Promise<void> {
    let request:ViewRestoreRequest|null=null,complete=false;
    const heldBefore=this.heldView;
    try{
      if(previous)await previous.catch(()=>{});
      controller.signal.throwIfAborted();
      const restored=structuredClone(view);
      const resolved=this.resolveTerrainSource(restored.terrain,restored.localMap,controller.signal);
      const source=resolved instanceof Promise?await resolved:resolved;
      controller.signal.throwIfAborted();
      if(source?.identity){
        restored.localMap={...source.identity};
        this.panel.addLocalMap(source.id,source.identity.name);
      }
      const navigation=new URL(location.href);
      if(source&&!source.isLocal)navigation.searchParams.set('map',source.id);
      else navigation.searchParams.delete('map');
      const href=viewLink(restored,navigation.href);
      if(this.rec||this.recordStarting||this.exporting||this.timeline.isOpen)throw new Error('Finish the current recording, review or export before restoring a view.');
      this.cancelScreenshot();
      const completion=Promise.withResolvers<void>();
      void completion.promise.catch(()=>{});
      request={id,view:restored,navigating:true,heldBefore,resolve:completion.resolve,reject:completion.reject};
      this.pendingViewRestore=request;
      this.cancelPlacement();this.flight?.stop();this.heldView=true;
      if(restored.noclip)this.view.controls.enabled=false;
      if(!navigate)this.applyViewCamera(restored);
      if(navigate){
        this.stopAndRearm();
        if(this.model?.terrain!==restored.terrain||this.viewModel?.robot!==restored.robot){
          const robot=this.model?.robot!==restored.robot||this.viewModel?.robot!==restored.robot?restored.robot:undefined;
          await this.changeTerrain(restored.terrain,source,{signal:controller.signal,robot,validate:scene=>{
            controller.signal.throwIfAborted();
            if(scene.terrain!==restored.terrain||scene.robot.split('_')[0]!==restored.robot.split('_')[0])
              throw new Error('The requested robot or map could not be prepared.');
          }});
        }
        controller.signal.throwIfAborted();
        history.replaceState(null,'',href);
        this.send({t:'viewReady',request:id});
      }
      await completion.promise;
      complete=true;
    }catch(error){
      const failure=error instanceof Error?error:new Error(String(error));
      if(this.pendingViewRestore===request)this.pendingViewRestore=null;
      request?.reject(failure);
      throw failure;
    }finally{
      if(this.viewRestoreAbort===controller){
        this.viewRestoreAbort=null;
        if(!complete){this.heldView=heldBefore;this.view.controls.enabled=!this.noclip;}
      }
      this.updateCaptureNavigationNotice();
    }
  }

  private cancelViewRestore():Promise<void> {
    const request=this.pendingViewRestore,work=this.viewRestoreWork;
    this.pendingViewRestore=null;
    const error=new DOMException('View restore canceled: the robot or map was changed.','AbortError');
    this.viewRestoreAbort?.abort(error);
    if(request){this.heldView=request.heldBefore;request.reject(error);}
    this.view.controls.enabled=!this.noclip;
    return work?work.catch(()=>{}):Promise.resolve();
  }

  private applyViewCamera(view:SavedView) {
    const damping=this.view.controls.enableDamping;
    this.view.controls.enableDamping=false;this.view.controls.update();
    this.view.camera.position.set(...view.position);this.view.camera.fov=view.fov;
    this.view.camera.updateProjectionMatrix();this.view.controls.target.set(...view.target);
    if(!view.orientation)this.view.controls.update();
    if(view.orientation)this.view.camera.quaternion.fromArray(view.orientation);
    this.view.camera.updateMatrixWorld(true);this.view.controls.enableDamping=damping;
  }

  private async finishViewRestore(message:Extract<FromWorker,{t:'viewReady'}>) {
    const request=this.pendingViewRestore;if(!request||request.id!==message.request)return;
    request.navigating=false;
    try{
      const view=request.view,family=(robot:string)=>robot.split('_')[0],model=this.viewModel;
      if(!model||message.terrain!==view.terrain||model.terrain!==view.terrain||family(message.robot)!==family(view.robot))throw new Error('The requested robot or map did not load.');
      if(view.appearance){
        this.look.restoreAppearance(model.robot,view.appearance,view.sourceHead);
        if(model.robot!==view.robot)this.look.restoreAppearance(view.robot,view.appearance,view.sourceHead);
      }
      if(view.sourceHead!==undefined)await this.view.setSourceHead(view.sourceHead);
      await Promise.all([this.view.waitForRobotVisuals(),this.view.waitForTerrainVisuals()]);
      if(this.pendingViewRestore!==request)return;
      if(this.viewModel!==model||this.panel.terrain!==view.terrain)throw new Error('The robot or map changed while restoring the view.');
      if(view.noclip!==undefined)this.setNoclip(view.noclip);
      if(view.flight){this.flight.speed=view.flight.speed;this.flight.hover=view.flight.hover;this.updateFlightHud();}
      this.applyViewCamera(view);this.flight.setActive(this.noclip);this.explore.setDisplay(view.display);this.look.setState(view.look);this.setFlashlight(view.flashlight);
      this.look.refreshHead();this.pendingViewRestore=null;request.resolve();
    }catch(error){
      if(this.pendingViewRestore!==request)return;
      this.pendingViewRestore=null;this.view.controls.enabled=!this.noclip;
      request.reject(error instanceof Error?error:new Error(String(error)));
    }
  }

  private recenterView() {
    if (this.noclip) {
      this.flight.stop();
      this.view.camera.position.set(this.baseXY[0] + 2.2, this.baseXY[1] - 2.2, this.baseZ + 1.4);
      this.view.controls.target.set(this.baseXY[0], this.baseXY[1], this.baseZ);
      this.view.camera.lookAt(this.view.controls.target);
      this.flight.setActive(true);
      return;
    }
    if (this.heldView) { this.heldView = false; return; }
    this.send({ t: 'recenter' });
  }

  private async loadCsv(file: File, fps: number) {
    if(this.timeline.isOpen||this.exporting)return;
    try {
      const csv = await file.text();
      if(this.timeline.isOpen||this.exporting)return;
      if (this.noclip) this.setNoclip(false);
      this.send({ t: "playback", csv, fps, name: file.name });
    } catch (e) {
      this.showOverlay(`failed to read ${file.name}: ${e}`);
    }
  }

  private importChain: Promise<void> = Promise.resolve();

  /** Reads are chained so multi-file imports reach the worker in the order
   * the user picked them (concurrent file reads finish smallest-first). */
  private importPack(file: File) {
    if(this.timeline.isOpen||this.exporting)return;
    this.importChain = this.importChain.then(async () => {
      try {
        const zip = await file.arrayBuffer();
        if(this.timeline.isOpen||this.exporting)return;
        this.worker.postMessage({ t: "importPack", zip }, [zip]);
      } catch (e) {
        this.showOverlay(`failed to read ${file.name}: ${e}`);
      }
    });
  }

  private updateCaptureNavigationNotice(show = false): boolean {
    const message = this.pendingViewRestore || this.viewRestoreAbort
      ? 'Wait for the saved view to finish restoring.'
      : this.mapPreparing || this.pendingMap ? 'Wait for the map to finish loading.' : null;
    this.captureNavigationNotice = (show || this.captureNavigationNotice) && message !== null;
    this.panel.setNavigationNotice(this.captureNavigationNotice ? message : null);
    return message !== null;
  }

  // ---- recording -------------------------------------------------------
  private toggleRecording() {
    if (this.rec) this.stopRecording();
    else this.startRecording();
  }

  private startRecording() {
    if(this.updateCaptureNavigationNotice(true))return;
    if (this.recordStarting || this.rec || !this.model || this.exporting) return;
    if (this.timeline.isOpen) this.closeReview();
    if (this.dialog.isOpen) this.dialog.close();
    this.recordStarting = true;
    const generation=this.viewBuildGeneration,model=this.model;
    this.look.setHeadLocked(true);
    this.panel.setRecordInfo('Preparing scene visuals…');
    void Promise.all([this.view.waitForRobotVisuals(),this.view.waitForTerrainVisuals()]).then(() => {
      if(generation!==this.viewBuildGeneration||this.model!==model||(model.terrain??this.panel.terrain)!==this.panel.terrain){
        this.panel.setRecordInfo('The scene changed. Press Record again when it has loaded.');return;
      }
      const terrain=model.terrain??this.panel.terrain;
      if(terrain.startsWith('map:local-')&&this.view.mapSource?.id!==mapId(terrain))throw new Error('Reattach the original map bundle before recording.');
      if (!this.exporting && !this.timeline.isOpen) this.beginRecording();
    }).catch(error => {
      this.panel.setRecordInfo(`Recording could not start: ${error instanceof Error ? error.message : error}`);
    }).finally(() => {
      this.recordStarting = false;
      if (!this.rec && !this.timeline.isOpen) this.look.setHeadLocked(false);
    });
  }

  private beginRecording() {
    const m = this.model;
    if (!m || !this.liveGeometry || this.exporting) return;
    if (this.timeline.isOpen) this.closeReview();
    const s = this.status;
    this.recModel = m;
    this.rec = new TakeRecorder({
      robot: m.robot, model: s?.model, terrain: m.terrain??this.panel.terrain, localMap:mapSource(m.terrain??this.panel.terrain)?.identity, sourceTime: this.view.getSourceTime(), appearance: this.view.getAppearance(), sourceHead: this.view.getSourceHead(), look: this.look.getState(), display: this.explore.getDisplay(), flashlight: this.flashlight, lights: this.view.getShotLights(), robotFade: this.view.getRobotFadeState(), policy: s?.policy ?? "-",
      created: new Date().toISOString(), ngeom: m.ngeom, nq: m.nq, baseQadr: m.baseQadr, hinges: m.hinges,
    }, this.liveGeometry.partition);
    this.logged = {};
    this.pending = {};
    if (s?.playback) this.rec.mark("clip", s.playback);
    else if (s && s.policy !== "-") this.logInput("policy", s.policy, false);
    if (s && !s.playback) this.logInput("state", s.state, false);
    this.logged.hoist = this.hoistOn;
    this.panel.setRecording(true);
    this.recBadge.hidden = false;
    this.recTime.textContent = "REC 0.0 s";
    this.recBadge.title='Preparing recording recovery…';
    const rec=this.rec;
    this.recCheckpoint=this.recordingRecovery.record(rec,m,
      `#${this.takeNo+1} · ${s?.model??m.robot} · ${s?.policy??'-'}`,state=>{
        if(this.rec!==rec)return;
        this.recBadge.title=state.error?state.error:
          state.saving?'Saving recording recovery…':state.frames?`Recovery saved through ${fmtTime(state.duration)} s`:'Preparing recording recovery…';
        this.updateRecordingInfo(state.error);
      });
    this.updateRecordingInfo();
  }

  private updateRecordingInfo(error=this.recCheckpoint?.error) {
    const rec=this.rec;if(!rec)return;
    const time=fmtTime(rec.elapsed,1),text=`REC ${time} s${error?' · recovery failed':''}`;
    if(this.recTime.textContent===text)return;
    this.recTime.textContent=text;
    this.panel.setRecordInfo(`Recording… ${time} s, ${rec.frames} frames.`+
      (error?` ${error}`:''));
  }

  /** Stop and open the take on the timeline (`why` explains an automatic stop). */
  private stopRecording(why?: string) {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    const checkpoint=this.recCheckpoint;this.recCheckpoint=null;
    void checkpoint?.stop();
    this.panel.setRecording(false);
    this.recBadge.hidden = true;
    const take = rec.finish();
    if (!take) {
      this.look.setHeadLocked(false);
      checkpoint?.release();
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
    this.rememberTake(take,this.takeModel!,this.takeTitle,checkpoint??undefined);
  }

  private camPose() {
    const c = this.view.camera, t = this.view.controls.target;
    return { pos: [c.position.x, c.position.y, c.position.z] as [number, number, number],
             target: [t.x, t.y, t.z] as [number, number, number], fov: c.fov,orientation:c.quaternion.toArray() };
  }

  // ---- review (timeline) ----------------------------------------------------
  private openReview() {
    if(this.updateCaptureNavigationNotice(true))return;
    const take = this.take, tm = this.takeModel;
    if (!take || !tm || this.exporting) return;
    this.cancelScreenshot();
    if (!this.timeline.isOpen) {
      this.liveReview = { model: this.viewModel, appearance: this.view.getAppearance(),
        head: this.view.getHeadVisualState().available ? this.view.getHeadVisual() : 'stock', look: this.look.getState(),
        display: this.explore.getDisplay(), flashlight: this.flashlight, shot: { ...this.shot },
        camera: this.setupCamera ?? this.captureWorkspaceCamera() };
      this.setupCamera = null;
    }
    // Review pauses the live simulation; it must not change its noclip/physics mode.
    this.cancelPlacement();
    this.flight.setActive(false);
    document.getElementById('flight-hud')!.hidden = true;
    if (this.viewModel !== tm) { this.buildView(tm); this.viewModel = tm; }
    this.reviewOriginal = { take,
      appearance: take.meta.appearance ?? { ...(this.liveReview?.model === tm ? this.liveReview.appearance : { colorway: 'grey', parts: {} }), sourceBody: 'stock' },
      head: take.meta.sourceHead === 'ghost' ? 'ghost' : 'stock',
      look: take.meta.look ?? this.liveReview!.look,
      display: take.meta.display ?? this.liveReview!.display,
      flashlight: take.meta.flashlight ?? this.liveReview!.flashlight,
      lights: take.meta.lights ?? [] };
    this.applyTakeLook();
    this.send({ t: "pause", on: true });
    this.keysHeld.clear();
    if (this.command.some((v) => v !== 0)) this.setCommand([0, 0, 0]);
    this.followZ = tm.robot.startsWith("go2") ? 0.35 : 0.7;
    Object.assign(this.shot, take.shot ?? this.liveReview!.shot);
    if (!take.shot) {
      if(this.shot.height<=0)this.shot.height=this.followZ;
      take.shot={...this.shot};
    }
    this.timeline.open(take, this.takeTitle);
    this.panel.setReviewScope(true);
    this.rebuildShot(false);
    if (this.dialog.isOpen) this.dialog.refresh();
    const savedState=this.storedTakes.get(take);
    this.timeline.setAutosaveState('');
    if(savedState)this.updateShotSaveStatus(take,savedState);
    this.setViewMode(this.timeline.mode);
    this.lidarBox.box.style.display = "none";
    this.inspectorBody.replaceChildren(eventList(take, this.takeTitle, (t) => this.timeline.seek(t)));
  }

  private closeReview(restoreMap=true) {
    if (this.exporting) return;
    this.cancelScreenshot();
    const stored=this.take&&this.storedTakes.get(this.take);
    if(stored&&stored.previewDirty&&stored.previewReady)this.snapshotShotPreview(this.take!,stored);
    if (this.dialog.isOpen) this.dialog.close();
    this.timeline.close();
    this.view.setSourceTime(null);
    this.view.setRobotOpacityOverride(null);
    this.setViewMode("free");
    const live=this.liveReview,sameRobot=!!live?.model&&live.model.robot===this.model?.robot;
    this.look.endShotEdit();
    this.look.setHeadLocked(false);
    this.explore.endShotEdit();
    if (live) {
      this.setFlashlight(live.flashlight, false);
      Object.assign(this.shot, live.shot);
    }
    this.shotPath = null;
    this.panel.setReviewScope(false);
    if (this.model && this.viewModel !== this.model) {
      this.buildView(this.model,restoreMap);
      this.viewModel = this.model;
      this.lastFrame = null;
    }
    if (sameRobot) this.view.setAppearance(live!.appearance, live!.head);
    else if (this.model) this.look.onModel(this.model.robot);
    const head = sameRobot ? live!.head : this.view.getHeadVisual();
    this.liveReview = null;
    this.reviewOriginal = null;
    void this.view.setSourceHead(head).then(() => this.look.refreshHead())
      .catch(error => { if (!this.timeline.isOpen && this.view.getHeadVisual() === head) this.showOverlay(`Head visual could not load: ${error instanceof Error ? error.message : error}`, 'error'); });
    this.followZ = this.model?.robot.startsWith("go2") ? 0.35 : 0.7;
    if (live) this.restoreWorkspaceCamera(live.camera);
    this.flight.setActive(this.noclip);
    document.getElementById('flight-hud')!.hidden = !this.noclip;
    this.send({ t: "pause", on: false });
    this.inspectorBody.innerHTML = `<span class="ins-empty">Back to the live sim…</span>`;
  }

  private applyTakeLook() {
    const original = this.reviewOriginal, take = this.take;
    if (!original || original.take !== take) return;
    const edits = take!.meta.edits, head = edits?.sourceHead ?? original.head;
    this.cancelScreenshot();
    this.view.setAppearance(edits?.appearance ?? original.appearance, head);
    const visuals = effectiveVisualState({ display: original.display, flashlight: original.flashlight, lights: original.lights, edits });
    this.explore.beginShotEdit(visuals.display, () => this.saveTakeEdits(take!));
    this.setFlashlight(visuals.flashlight, false);
    this.look.setHeadLocked(false);
    this.look.beginShotEdit(edits?.look ?? original.look, () => this.saveTakeEdits(take!), () => {
      if (this.take !== take || this.exporting) return;
      delete take!.meta.edits;
      this.applyTakeLook();
      this.queueShotUpdate(take!);
    }, visuals.lights);
    const generation = this.viewBuildGeneration;
    void this.view.setSourceHead(head).then(() => {
      if (this.take === take && this.viewBuildGeneration === generation) this.look.refreshHead();
    }).catch(error => {
      if (this.take === take && this.viewBuildGeneration === generation && this.timeline.isOpen)
        this.showOverlay(`Shot head could not load: ${error instanceof Error ? error.message : error}`, 'error');
    });
  }

  private saveTakeEdits(take: Take) {
    if (this.take !== take || !this.timeline.isOpen || this.exporting) return;
    this.cancelScreenshot();
    take.meta.edits = { version: 1, appearance: this.view.getAppearance(), sourceHead: this.view.getHeadVisual(),
      look: this.look.getState(), lights: this.view.getShotLights(), display: this.explore.getDisplay(), flashlight: this.flashlight };
    this.queueShotUpdate(take);
  }

  private editTakeLook() {
    if (!this.timeline.isOpen || this.exporting) return;
    if (document.body.classList.contains('menu-hidden')) document.getElementById('toggle-menu')!.click();
    document.querySelector<HTMLButtonElement>('#workspace-panels button[aria-controls="scene-window"]')!.click();
    this.look.revealShotEdit();
  }

  private setExporting(on: boolean) {
    this.exporting = on;
    this.cancelScreenshot();
    this.look.setReadOnly(on);
    this.explore.setReadOnly(on);
    this.timeline.root.inert = on;
    document.getElementById('panel')!.inert = on;
    document.getElementById('scene-actions')!.inert = on;
    document.getElementById('viewport-tools')!.inert = on;
    document.getElementById('flight-hud')!.inert = on;
    document.getElementById('policy-manager')!.inert = on;
    document.getElementById('inspector')!.inert = on;
    this.view.controls.enabled = !on && this.timeline.mode !== 'recorded';
    if(!on&&this.take){
      const state=this.storedTakes.get(this.take);
      if(state?.previewDirty&&!state.deleted)this.scheduleShotPreview(this.take,state);
    }
  }

  private setViewMode(m: ViewMode) {
    if(this.timeline.mode!==m)this.cancelScreenshot();
    this.timeline.setMode(m);
    const cam = this.view.camera;
    if (m !== "recorded" && cam.fov !== 45) { cam.fov = 45; cam.updateProjectionMatrix(); }
    this.shotFrame.hidden = m !== "shot";
    this.view.controls.enabled = m !== "recorded" && !this.exporting;
  }

  private rebuildShot(persist=true) {
    const reviewing = this.timeline.isOpen && this.take;
    this.shotPath = reviewing ? new ShotPath(reviewing, this.shot, this.timeline.rangeIn) : null;
    const s = this.shot;
    const [w, h] = this.dialog.outSize;
    this.shotFrame.querySelector("span")!.textContent = `${w} × ${h} · ${s.focal} mm · ${s.mode}${reviewing ? '' : ' · static'}`;
    if(persist && reviewing){reviewing.shot={...this.shot};this.queueShotUpdate(reviewing);}
  }

  private captureWorkspaceCamera(): WorkspaceCamera {
    return { position: this.view.camera.position.toArray(), target: this.view.controls.target.toArray(),
      orientation: this.view.camera.quaternion.toArray(), up: this.view.camera.up.toArray(),
      fov: this.view.camera.fov, held: this.heldView, mode: this.timeline.mode };
  }

  private restoreWorkspaceCamera(camera: WorkspaceCamera) {
    this.setViewMode(camera.mode);
    const controls = this.view.controls, damping = controls.enableDamping;
    controls.enableDamping = false; controls.update();
    this.view.camera.position.fromArray(camera.position); controls.target.fromArray(camera.target);
    this.view.camera.up.fromArray(camera.up); this.view.camera.quaternion.fromArray(camera.orientation);
    this.view.camera.fov = camera.fov; this.view.camera.updateProjectionMatrix();
    this.view.camera.updateMatrixWorld(true); controls.enableDamping = damping;
    controls.enabled = camera.mode !== 'recorded' && !this.noclip && !this.exporting;
    this.heldView = camera.held;
  }

  private openExport(tab: "video" | "data") {
    if (this.exporting) return;
    if (this.rec || this.recordStarting) {
      this.panel.setRecordInfo('Stop recording before opening camera / output setup.');
      return;
    }
    if (!this.dialog.isOpen) {
      this.viewBeforeDialog = this.timeline.mode;
      if (!this.timeline.isOpen) {
        this.setupCamera = this.captureWorkspaceCamera();
        this.flight.setActive(false);
        document.getElementById('flight-hud')!.hidden = true;
      }
    }
    this.timeline.setPlaying(false);
    document.body.classList.add('output-setup');
    this.dialog.open(tab);
    this.rebuildShot(false);
    this.setViewMode("shot");
  }

  /** Pose the scene from the take at time t (review frames and export frames alike). */
  private poseTake(t: number) {
    const take = this.take!;
    this.view.setSourceTime((take.meta.sourceTime ?? 0) + t);
    this.view.setRobotOpacityOverride(take.robotOpacityAt(t));
    const pose = take.poseAt(t);
    this.view.sync(pose.xpos, pose.xmat);
    const base = take.basePosAt(t);
    this.view.updateRobotLighting(base[0], base[1], base[2]);
    this.view.setHoist(take.hoistAt(t));
    return base;
  }

  private stage(): Stage {
    return {
      prepare: async () => {await Promise.all([this.view.waitForRobotVisuals(),this.view.waitForTerrainVisuals()]);if(this.take?.meta.localMap&&this.view.mapSource?.identity?.fingerprint!==this.take.meta.localMap.fingerprint)throw new Error('Reattach this take’s original map bundle before exporting.');},
      view: this.view, camera: this.exportCam,
      pose: (t) => this.poseTake(t),
      aim: (cam, t, aspect) => this.shotPath!.apply(cam, t, aspect),
    };
  }

  /** In the Shot view, orbiting the viewport re-frames the shot camera itself (azimuth, elevation,
   * distance), so a shot can be composed by hand and then fine-tuned in the export panel. */
  /** Build the scene for a model and re-apply the robot's paint (+ the map's own light). */
  private buildView(desc: RenderModel,prepareMap=true) {
    this.cancelScreenshot();
    ++this.viewBuildGeneration;
    this.view.build(desc);
    const visual = launch.active ? this.launchVisualSelection : null;
    const initialHead = visual?.head ?? this.pendingViewRestore?.view.sourceHead;
    this.look.onModel(desc.robot, initialHead, visual?.appearance ?? this.pendingViewRestore?.view.appearance);
    // Reuse the existing Character handler, including its Original paint semantics.
    const character = launch.selection.character;
    if (launch.active && character && !this.launchCharacterApplied) {
      this.look.restoreAppearance(desc.robot, visual?.appearance ?? { ...this.view.getAppearance(), sourceBody: 'stock' }, 'stock');
      const select = document.querySelector<HTMLSelectElement>('#panel select[aria-label="Character"]');
      if (!select) throw new Error('The character menu is unavailable for the selected robot.');
      characterOptions(select, character, desc.robot, true);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      this.launchCharacterApplied = true;
    }
    const terrain=desc.terrain??(desc===this.takeModel&&isTerrain(this.take?.meta.terrain)?this.take!.meta.terrain:this.panel.terrain);
    if(prepareMap)this.prepareMapVisual(terrain);
  }

  /** Map work survives same-map robot rebuilds; only a new map owns its callbacks. */
  private prepareMapVisual(terrain: TerrainName) {
    if (terrain === this.mapVisualTerrain) return;
    this.mapVisualTerrain = terrain;
    const generation = ++this.mapVisualGeneration, current = () => generation === this.mapVisualGeneration;
    const id = mapId(terrain), source=this.sourceForTerrain(terrain);
    const loading = document.getElementById('map-loading')!;
    const message = loading.querySelector('span')!, retry = loading.querySelector('button')!;
    const loadVisual=()=>{
      if(!current())return;
      let failed=false;
      this.look.setMapLight(null);
      if(source)void source.json<{light?:MapLight}>('manifest.json')
        .then((m:{light?:MapLight})=>{if(current())this.look.setMapLight(m.light??null)})
        .catch(()=>{if(current())this.look.setMapLight(null)});
      loading.hidden = !id; retry.hidden = true;
      message.textContent = 'Loading map visuals…';
      void this.view.setTerrainVisual(source, (phase, loaded, total) => {
        if (!current()||failed) return;
        const size = loaded ? ` · ${Math.ceil(loaded / 1_000_000)}${total ? ` / ${Math.ceil(total / 1_000_000)}` : ''} MB` : '';
        const text = `${phase === 'preparing materials' ? 'Preparing map materials' : `Loading ${phase}`}…${size}`;
        if (message.textContent !== text) message.textContent = text;
        launch.mapProgress(phase === 'preparing materials' ? 'Preparing map materials…' : `Map assets · ${phase}`);
      }).then(() => {
        if (current()) { loading.hidden = true; launch.mapProgress(id ? 'Map visuals ready.' : 'Built-in terrain ready.'); }
      })
        .catch((error) => {
          if (!current()) return;
          failed=true;
          console.warn('Map visual failed to load', error);
          loading.hidden = false; message.textContent = 'Map visuals could not load. Try again.'; retry.hidden = false;
          launch.fail(`Map visuals could not load: ${error instanceof Error ? error.message : error}`);
          // Retry only map assets: keep the current robot pose and recorded appearance.
          retry.onclick = () => { if(current())loadVisual(); };
        });
    };
    loadVisual();
  }

  /** While the paint editor's Pick is on, a click (not a drag) on the robot selects that part. */
  private wirePartPicking() {
    const dom = this.view.renderer.domElement;
    let down: [number, number] | null = null;
    dom.addEventListener("pointerdown", (e) => { down = !this.inputBlocked && this.look.picking ? [e.clientX, e.clientY] : null; });
    dom.addEventListener("pointerup", (e) => {
      const start=down;down=null;
      if (this.inputBlocked || !this.look.picking || !start || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) return;
      const part = this.view.pickPart(e);
      if (part) this.look.select(part);
    });
  }

  private wireShotOrbit() {
    const c = this.view.controls, R2D = 180 / Math.PI;
    const offset = () => this.view.camera.position.clone().sub(c.target);
    const azEl = (v: THREE.Vector3) => {
      const r = v.length() || 1;
      return [Math.atan2(v.y, v.x) * R2D, Math.asin(Math.max(-1, Math.min(1, v.z / r))) * R2D, r];
    };
    c.addEventListener("start", () => {
      if (this.timeline.mode !== "shot" || this.exporting || this.shot.mode === "viewport") return;
      if (this.shotPath) {
        const p = this.shotPath.at(this.timeline.time);
        c.target.copy(p.target);
        this.view.camera.position.copy(p.pos);
      } else if (this.dialog.isOpen) {
        applyStaticShot(this.shotCam, this.shot, this.liveShotBase, this.dialog.aspect, this.view.camera);
        c.target.set(this.baseXY[0], this.baseXY[1], this.shot.height);
        this.view.camera.position.copy(this.shotCam.position);
      } else return;
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
    const take = this.take, filename = `${this.fileStem()}.take.zip`;
    if (!take) return;
    download(await saveTake(take), filename);
  }

  private async openTakeFile(file: File) {
    if (this.exporting || this.recordStarting || this.mapPreparing || this.pendingMap || this.pendingViewRestore || this.viewRestoreAbort) return;
    try {
      const take = await loadTake(await file.arrayBuffer());
      if (this.exporting || this.recordStarting || this.mapPreparing || this.pendingMap || this.pendingViewRestore || this.viewRestoreAbort) return;
      const meta=take.meta,active=this.model;
      if(!active||active.robot!==meta.robot){
        this.panel.showNotice('Different scene loaded',`Load ${meta.model??meta.robot} before opening ${file.name}. The active scene has not changed.`);
        return;
      }
      const validate=(scene:SceneIdentity)=>{
        if(!sameIdentity(meta,scene))throw new Error(`This take needs ${meta.model??meta.robot} on ${meta.terrain} (${meta.ngeom} geoms). Load the original model and map, then open it again. The active scene has not changed.`);
        if(this.exporting||this.recordStarting)throw new Error('Finish preparing the current capture before opening a take.');
      };
      if(meta.localMap&&active.terrain!==meta.terrain){
        await this.attachTakeMap(take);
        await this.changeTerrain(meta.terrain as TerrainName,this.takeSources.get(take),{validate});
      }else{
        validate(active);
        await this.attachTakeMap(take);
        validate(this.model??active);
      }
      const m=this.model!;
      if (this.rec) this.stopRecording();
      if (this.timeline.isOpen) this.closeReview();
      this.take = take;
      this.takeModel = m;
      this.takeNo++;
      this.takeTitle = `${file.name.replace(/\.take\.zip$|\.zip$/, "")}`;
      this.panel.setTakeAvailable(true);
      this.panel.setRecordInfo(`Opened ${file.name}: ${fmtTime(take.duration)} s, ${take.n} frames.`);
      this.openReview();
      this.rememberTake(take,m,this.takeTitle);
    } catch (e) {
      this.panel.showNotice("Could not open the take", `${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private shotLibraryBlocked():string|null {
    if(this.mapPreparing||this.pendingMap)return 'Wait for the map to finish loading.';
    if(this.rec||this.recordStarting)return 'Stop recording before opening Shots.';
    if(this.exporting)return 'Wait for the export to finish.';
    if(this.pendingViewRestore||this.viewRestoreAbort)return 'Wait for the saved view to finish restoring.';
    return null;
  }

  private async openShots() {
    if(this.openingShotLibrary)return;
    this.openingShotLibrary=true;
    this.timeline.setPlaying(false);this.stopAndRearm();
    try{
      // Flush coalesced writes before a gallery can reopen an older copy of the same take.
      while(this.shotWrites.size)await Promise.all([...this.shotWrites]);
      this.shotLibrary.open();
    }finally{this.openingShotLibrary=false;}
  }

  private async openStoredShot(saved:SavedShot,signal?:AbortSignal) {
    const blocked=this.shotLibraryBlocked();
    if(blocked)throw new Error(blocked);
    await this.attachTakeMap(saved.take,signal);
    signal?.throwIfAborted();
    const terrain=saved.take.meta.terrain;
    const lightSource=isTerrain(terrain)&&terrain!==this.mapVisualTerrain?this.sourceForTerrain(terrain):null;
    const light=lightSource?await lightSource.json<{light?:MapLight}>('manifest.json'):null;
    signal?.throwIfAborted();
    const stage=isTerrain(terrain)&&terrain!==this.mapVisualTerrain?await this.view.stageTerrainVisual(this.sourceForTerrain(terrain)):null;
    if(signal?.aborted){stage?.dispose();signal.throwIfAborted();}
    if(this.timeline.isOpen)this.closeReview(false);
    if(stage){stage.commit();this.mapVisualTerrain=terrain as TerrainName;++this.mapVisualGeneration;document.getElementById('map-loading')!.hidden=true;this.look.setMapLight(light?.light??null);}
    this.take=saved.take;this.takeModel=saved.model;this.takeTitle=saved.info.name;
    const state:StoredTakeState={id:saved.info.id,name:saved.info.name,model:saved.model,created:true,
      writing:false,dirty:false,failed:false,deleted:false,previewDirty:!saved.info.thumbnail,previewReady:false,previewFailed:false,previewVersion:0};
    this.storedTakes.set(saved.take,state);
    this.panel.setTakeAvailable(true);
    this.panel.setRecordInfo(`Opened ${saved.info.name}: ${fmtTime(saved.take.duration)} s, ${saved.take.n} frames.`);
    this.openReview();
    if(!saved.info.thumbnail)this.scheduleShotPreview(saved.take,state,0);
  }

  private rememberTake(take:Take,model:RenderModel,name:string,recovery?:RecordingCheckpointWriter) {
    if(take.meta.localMap){const source=this.sourceForTerrain(take.meta.terrain as TerrainName);if(source)this.takeSources.set(take,source);}
    const state:StoredTakeState={id:recovery?.id??crypto.randomUUID(),name,model,created:false,writing:false,
      dirty:true,failed:false,deleted:false,previewDirty:true,previewReady:false,previewFailed:false,previewVersion:0,recovery};
    this.storedTakes.set(take,state);
    this.writeStoredTake(take,state);
    this.scheduleShotPreview(take,state,0);
  }

  private updateShotSaveStatus(take:Take,state:StoredTakeState) {
    if(this.take!==take)return;
    this.timeline.setAutosaveState(state.deleted?'Deleted':state.writing||state.dirty?'Saving…':
      state.failed?'Not saved · Save ZIP':state.previewFailed?'Saved · Preview unavailable':state.created?'Saved':'Not saved · Save ZIP',
      state.failed&&!state.deleted);
  }

  private queueShotUpdate(take:Take) {
    const state=this.storedTakes.get(take);
    if(!state||state.deleted)return;
    state.dirty=true;state.previewDirty=true;state.previewFailed=false;
    state.previewReady=state.previewReady&&!this.view.getBodyVisualState().loading&&!this.view.getHeadVisualState().loading;
    this.writeStoredTake(take,state);this.scheduleShotPreview(take,state);
  }

  private writeStoredTake(take:Take,state:StoredTakeState) {
    if(state.deleted||state.writing||state.failed&&!state.dirty
      ||state.created&&!state.dirty&&state.thumbnail===undefined)return;
    const metadataDirty=state.dirty||!state.created,thumbnail=state.thumbnail;
    state.thumbnail=undefined;state.dirty=false;state.writing=true;
    this.updateShotSaveStatus(take,state);
    let committed=false;
    const recovery=state.created?undefined:state.recovery;
    const save=()=>this.shotStore.save({id:state.id,name:state.name,take,model:state.model,thumbnail:thumbnail??null});
    const operation=state.created
      ?this.shotStore.update(state.id,{meta:take.meta,shot:take.shot,range:take.range,...(thumbnail?{thumbnail}:{})})
      :recovery?recovery.stop().then(save):save();
    const pending=operation.then(()=>{
      committed=true;state.created=true;state.failed=false;
      this.shotLibrary.refresh();
    }).catch(error=>{
      // A failed full save leaves the old recovery available; later RAM-take saves use a new identity.
      if(recovery)state.id=crypto.randomUUID();
      state.failed=metadataDirty||state.dirty;state.dirty=false;
      if(!state.failed)state.previewFailed=true;
      if(this.take===take&&state.failed)this.panel.setRecordInfo(
        `Shot not saved: ${storageErrorMessage(error)} Save a take ZIP before closing this page.`);
    }).finally(()=>{
      recovery?.release();if(state.recovery===recovery)state.recovery=undefined;
      state.writing=false;this.shotWrites.delete(pending);
      if(committed&&!state.deleted&&(state.dirty||state.thumbnail!==undefined))this.writeStoredTake(take,state);
      this.updatePendingSaveGuard();
      this.updateShotSaveStatus(take,state);
    });
    this.shotWrites.add(pending);
    this.updatePendingSaveGuard();
  }

  private scheduleShotPreview(take:Take,state:StoredTakeState,delayMs=500) {
    clearTimeout(state.previewTimer);
    const version=++state.previewVersion;
    state.previewTimer=window.setTimeout(()=>{
      state.previewTimer=undefined;
      const generation=this.viewBuildGeneration;
      void Promise.all([this.view.waitForRobotVisuals(),this.view.waitForTerrainVisuals()]).then(()=>{
        if(version!==state.previewVersion||generation!==this.viewBuildGeneration||this.take!==take||!this.timeline.isOpen||this.exporting)return;
        state.previewReady=true;this.snapshotShotPreview(take,state);
      }).catch(()=>{
        if(version!==state.previewVersion||state.deleted)return;
        state.previewFailed=true;this.updateShotSaveStatus(take,state);
      });
    },delayMs);
  }

  /** Copy a real, clean review frame now; asynchronous encoding owns only the small 2D bitmap. */
  private snapshotShotPreview(take:Take,state:StoredTakeState) {
    if(state.deleted||!state.previewDirty||this.take!==take||this.viewModel!==state.model
      ||!this.timeline.isOpen||this.exporting)return;
    clearTimeout(state.previewTimer);state.previewTimer=undefined;
    const version=++state.previewVersion;
    const restore=this.view.suspendHighlights();
    try{
      if(this.view.renderer.getContext().isContextLost())throw new Error('Viewport unavailable.');
      this.reviewFrame(0);
      const source=this.view.renderer.domElement,scale=Math.min(320/source.width,200/source.height);
      const image=document.createElement('canvas');
      image.width=Math.max(1,Math.round(source.width*scale));image.height=Math.max(1,Math.round(source.height*scale));
      const context=image.getContext('2d');if(!context)throw new Error('Preview canvas unavailable.');
      context.drawImage(source,0,0,image.width,image.height);state.previewDirty=false;
      image.toBlob(blob=>{
        if(version!==state.previewVersion||state.deleted)return;
        if(!blob){state.previewFailed=true;this.updateShotSaveStatus(take,state);return;}
        state.thumbnail=blob;this.writeStoredTake(take,state);
      },'image/webp',.8);
    }catch{
      state.previewFailed=true;this.updateShotSaveStatus(take,state);
    }finally{restore();}
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
    w: [0, 1], s: [0, -1],
    a: [2, 1], d: [2, -1],
    q: [1, 1], e: [1, -1],
  };
  private keysHeld = new Set<string>();

  private applyKeys(shift: boolean) {
    if (this.noclip) return;
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
    if (this.inputBlocked) return;
    if (this.flight.key(e, false)) return;
    const k = e.key.toLowerCase();
    if (k === "shift") { if (this.keysHeld.size) this.applyKeys(false); return; }
    if (!(k in App.MOVE_KEYS) || !this.keysHeld.delete(k)) return;
    this.applyKeys(e.shiftKey);
  }

  /** Gate entry on worker readiness, completed visuals and a genuinely rendered worker pose. */
  private async prepareLaunch() {
    try {
      await this.initialViewRestore;
      let generation: number;
      do {
        generation = this.viewBuildGeneration;
        await Promise.all([this.view.waitForRobotVisuals(), this.view.waitForTerrainVisuals(),
          this.view.waitForFlashlight(), this.firstSimulationFrame]);
      } while (generation !== this.viewBuildGeneration);
      if (!this.lastFrame) throw new Error('The simulator did not provide a scene frame.');
      if (this.view.renderer.getContext().isContextLost()) throw new Error('The viewport is unavailable.');
      this.drawLiveFrame();
      launch.firstFrame();
      this.overlay.classList.add('hidden');
      launch.visualsReady();
    } catch (error) {
      this.failLaunchVisuals(`Scene could not finish loading: ${error instanceof Error ? error.message : error}`);
    }
  }

  private failLaunchVisuals(message: string) {
    const body = this.view.getBodyVisualState(), head = this.view.getHeadVisualState();
    const optional = (body.choice !== 'stock' && (!body.available || body.error !== null))
      || (head.choice === 'ghost' && head.error !== null);
    if (launch.active && optional) launch.fail(message, () => this.useOriginalLaunch());
    else this.showOverlay(message, 'error');
  }

  /** A deliberate cosmetic opt-out changes the required scene, not its failure checks. */
  private async useOriginalLaunch() {
    const robot = this.model?.robot;
    if (!robot) throw new Error('The robot is not ready to switch appearance.');
    const linked = launch.selection.preserveView ? sharedView() : null;
    this.look.restoreAppearance(robot, { ...this.view.getAppearance(), sourceBody: 'stock' }, 'stock');
    const character = document.querySelector<HTMLSelectElement>('#panel select[aria-label="Character"]');
    if (!character) throw new Error('The character menu is unavailable for the selected robot.');
    character.value = 'stock';
    character.dispatchEvent(new Event('change', { bubbles: true }));
    launch.selection.character = 'stock';
    this.launchCharacterApplied = true;
    this.launchVisualSelection = resolveLaunchVisualSelection({ terrain: launch.selection.terrain,
      robot, character: 'stock', rememberedAppearance: this.view.getAppearance() });
    this.initialViewRestore = Promise.resolve();
    if (linked) {
      const original = { ...linked, appearance: this.view.getAppearance(), sourceHead: 'stock' as const };
      this.initialViewRestore = this.restoreView(original);
    } else {
      const url = new URL(location.href);
      if (robot.startsWith('r1')) url.searchParams.set('body', 'stock');
      else url.searchParams.delete('body');
      history.replaceState(null, '', url);
    }
    await this.prepareLaunch();
  }

  // ---- worker messages ------------------------------------------------
  private onWorker(m: FromWorker) {
    switch (m.t) {
      case 'loadingPlan': void this.prepareStartupAssets(m.plan); return;
      case 'loading': return launch.receiveTransfers(m.generation, m.updates);
      case 'terrainPrepared': {
        const pending=this.pendingMap;
        if(!pending||pending.id!==m.request)return;
        try{
          if(m.scene.terrain!==pending.terrain)throw new Error('The prepared map does not match the requested scene.');
          pending.validate?.(m.scene);
        }catch(error){
          this.pendingMap=null;pending.stage?.dispose();this.worker.postMessage({t:'cancelTerrain'});
          this.overlay.classList.add('hidden');pending.reject(error);return;
        }
        pending.committing=true;pending.onCommit?.();
        this.worker.postMessage({t:'terrain',terrain:pending.terrain,request:pending.id,commit:true});
        return;
      }
      case 'terrainFailed': {
        const pending=this.pendingMap;if(!pending||pending.id!==m.request)return;
        this.pendingMap=null;pending.stage?.dispose();pending.reject(new Error(m.msg));
        this.overlay.classList.add('hidden');this.panel.setTerrain(this.model?.terrain??'flat');return;
      }
      case "model":
        // End a recording before replacing its map; review continues owning the recorded world.
        if (this.rec) this.stopRecording("Stopped when the scene was rebuilt.");
        if(this.pendingMap&&m.desc.terrain===this.pendingMap.terrain){
          const pending=this.pendingMap;this.pendingMap=null;
          if(this.timeline.isOpen)pending.stage?.dispose();
          else{pending.stage?.commit();this.mapVisualTerrain=pending.terrain;++this.mapVisualGeneration;document.getElementById('map-loading')!.hidden=true;}
          this.liveMapSource=pending.source;
          if(pending.source?.identity){this.sessionMaps.set(pending.source.id,{identity:pending.source.identity,source:new WeakRef(pending.source)});this.panel.addLocalMap(pending.source.id,pending.source.identity.name);}
          this.panel.setTerrain(pending.terrain);
          const url=new URL(location.href);
          if(url.hash.startsWith('#view='))url.hash='';
          if(pending.source&&!pending.source.isLocal)url.searchParams.set('map',pending.source.id);
          else url.searchParams.delete('map');
          history.replaceState(null,'',url);
          if(!this.timeline.isOpen){
            this.look.setMapLight(null);
            const generation=this.mapVisualGeneration;
            if(pending.source)void pending.source.json<{light?:MapLight}>('manifest.json').then(m=>{if(generation===this.mapVisualGeneration)this.look.setMapLight(m.light??null);}).catch(()=>{if(generation===this.mapVisualGeneration)this.look.setMapLight(null);});
          }
          pending.resolve();
        }
        this.liveMapSource=this.sourceForTerrain(m.desc.terrain??'flat');
        if (launch.active) {
          this.resolveFirstFrame?.();
          this.firstSimulationFrame = new Promise<void>(resolve => { this.resolveFirstFrame = resolve; });
          launch.phase('Preparing robot and map visuals…');
        }
        this.model = m.desc;
        this.liveGeometry = new FrameGeometryBuffer(m.desc.ngeom, m.geometry);
        if (this.timeline.isOpen) return;          // the review keeps showing the take's model
        this.buildView(m.desc);
        this.viewModel = m.desc;
        this.lastFrame = null;
        // aim the camera at torso height: ~0.7 m for humanoids, lower for
        // the quadruped so its body doesn't sit at the bottom of the frame
        this.followZ = m.desc.robot.startsWith("go2") ? 0.35 : 0.7;
        return;
      case "frame":
        if (this.viewModel !== this.model) return;   // reviewing another model's take
        if (!this.liveGeometry) throw new Error('A simulation frame arrived without its geometry layout.');
        this.liveGeometry.apply(m.xpos, m.xmat);
        this.lastFrame = this.liveGeometry;
        this.resolveFirstFrame?.(); this.resolveFirstFrame = null;
        this.baseXY = [m.baseX, m.baseY];
        this.baseZ = this.model && this.model.baseQadr >= 0 ? m.qpos[this.model.baseQadr + 2] : this.followZ;
        if (!this.timeline.isOpen) this.view.setHoist(m.hoistAnchor ?? null);
        if (this.rec) {
          // Recording consumes the original-ID view; compact transferred buffers are no longer needed.
          m.xpos = this.liveGeometry.xpos; m.xmat = this.liveGeometry.xmat;
          this.rec.push(m, this.command, this.camPose());
          this.recCheckpoint?.changed();this.updateRecordingInfo();
          const e = this.rec.elapsed;
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
      case 'viewReady':void this.finishViewRestore(m);return;
      case "busy": return this.showOverlay(m.msg, "busy");
      case "ready": {
        if (launch.active) {
          launch.simulationReady();
          void this.prepareLaunch();
        } else if (this.overlayMsg.dataset.kind !== 'error') this.overlay.classList.add('hidden');
        return;
      }
      case 'robotPlaced': {
        if (!this.placementPending) return;
        const point = this.placementPoint?.clone();
        this.setNoclip(false);
        if (point) { this.view.controls.target.copy(point).z += this.followZ; this.view.camera.lookAt(this.view.controls.target); }
        this.rec?.mark('reset', 'Robot placed on surface');
        return;
      }
      case 'robotPlacementFailed':
        if (this.placingRobot) { this.placementPending = false; document.getElementById('flight-hint')!.textContent = m.msg; }
        return;
      case "policyFinished": return this.panel.showPolicyFinished(m.policy,m.active);
      case "notice": return this.showOverlay(m.msg, "notice");
      case "error":
        this.pendingViewRestore?.reject(new Error(m.msg));this.pendingViewRestore=null;
        this.view.controls.enabled=!this.noclip;return this.showOverlay(m.msg, "error");
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
    let policyOptionsChanged = !prev || prev.policies.length !== s.policies.length;
    if (prev && !policyOptionsChanged) {
      for (let i = 0; i < s.policies.length; i++) {
        if (prev.policies[i].name !== s.policies[i].name ||
            prev.policies[i].previewRobot !== s.policies[i].previewRobot) {
          policyOptionsChanged = true;
          break;
        }
      }
    }
    if (!prev || prev.robot !== s.robot || prev.robotSpec !== s.robotSpec ||
        policyOptionsChanged || prev.policy !== s.policy)
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
      this.panel.showNotice(s.notice.title ?? policyPresentation(s.policy).label, s.notice.text);
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
    rows.push(["policy", s.policy === '-' ? 'No policy' : policyPresentation(s.policy).label]);
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
    if (e.defaultPrevented || this.inputBlocked || launch.ownsKey(e.code) || this.modalKeys.has(e.code)) return;
    if (e.key === 'Escape' && this.dialog.isOpen) {
      e.preventDefault();
      if (!this.exporting) this.dialog.close();
      return;
    }
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    // Native buttons and details summaries own activation, including Workspace tools.
    if ((e.target instanceof HTMLButtonElement || e.target instanceof HTMLElement && e.target.closest('summary'))
        && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) this.help.open();
      return;
    }
    if (this.exporting || document.getElementById("policy-notice")) return;
    const flightModifier = this.noclip && !e.metaKey && !e.altKey
      && (e.code === 'Space' || e.code.startsWith('Control') || e.code.startsWith('Shift'));
    if ((e.ctrlKey || e.metaKey || e.altKey) && !flightModifier) return;
    if ((e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return this.toggleRecording();
    }
    if (this.timeline.isOpen) {
      // the deck owns the keyboard while reviewing; the sim is paused, so nothing drives it
      if (this.timeline.onKey(e)) e.preventDefault();
      return;
    }
    if (this.placingRobot && e.key === 'Escape') { e.preventDefault(); this.cancelPlacement(); return; }
    if (this.noclip && e.code === 'KeyP' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
      e.preventDefault(); if (this.placingRobot) this.cancelPlacement(); else this.beginPlacement(); return;
    }
    if (isCameraKey(e.code)) {
      if (this.placingRobot) { e.preventDefault(); return; }
      if (!this.noclip && !e.repeat && isCameraMovementKey(e.code)) this.setNoclip(true);
      // Reserved numpad keys must never leak into the robot's numbered FSM shortcuts.
      if (!this.noclip) { e.preventDefault(); return; }
    }
    if (this.flight.key(e, true)) return;
    const mk = e.key.toLowerCase();
    if (mk === "shift") { if (this.keysHeld.size) this.applyKeys(true); return; }
    if (mk in App.MOVE_KEYS) {
      e.preventDefault();
      if (e.repeat) return;
      if (!this.keysHeld.has(mk)) { this.keysHeld.add(mk); this.applyKeys(e.shiftKey); }
      return;
    }
    const states: FsmState[] = ["zero_torque", "damping", "lock", "stance", "policy"];
    if (e.key >= "0" && e.key <= "4") return this.setState(states[Number(e.key)]);
    switch (e.key) {
      case "]": return this.send({ t: "cycle", step: 1 });
      case "[": return this.send({ t: "cycle", step: -1 });
      case "r": case "R": return this.reset();
      case "c": case "C": return this.recenterView();
      case "h": case "H": return this.setHoist(!this.hoistOn);
      case "n": case "N": if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this.setNoclip(!this.noclip); return;
      case "f": case "F": if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this.setFlashlight(!this.flashlight); return;
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
  private updatePendingSaveGuard(){
    if(this.screenshotPending||this.shotWrites.size)window.addEventListener('beforeunload',this.warnPendingSave);
    else window.removeEventListener('beforeunload',this.warnPendingSave);
  }

  private cancelScreenshot(message='The scene changed. Take the screenshot again when it has loaded.'){
    if(!this.screenshotPending)return;
    ++this.screenshotRequest;this.screenshotPending=false;this.screenshotIsCurrent=null;
    this.screenshotAbort?.abort();this.screenshotAbort=null;
    this.updatePendingSaveGuard();
    this.panel.setScreenshotState(false,message);
  }

  private retainScreenshot(png:Blob,name:string,created:string,robot:string,terrain:string,request:number) {
    const pending=this.photoStore.save({id:crypto.randomUUID(),name,created,robot,terrain,png}).then(()=>{
      this.shotLibrary.refresh();
      if(request===this.screenshotRequest&&!this.screenshotPending)this.panel.setScreenshotState(false,'PNG downloaded · saved in Shots');
    }).catch(error=>{
      if(request===this.screenshotRequest&&!this.screenshotPending)this.panel.setScreenshotState(false,
        `PNG downloaded; Shots could not save: ${storageErrorMessage(error)} Keep the PNG file.`);
    }).finally(()=>{this.shotWrites.delete(pending);this.updatePendingSaveGuard()});
    this.shotWrites.add(pending);
    this.updatePendingSaveGuard();
  }

  private async takeScreenshot(){
    if(this.mapPreparing||this.pendingMap){this.panel.setScreenshotState(false,'Wait for the map to finish loading.');return;}
    if(this.screenshotPending)return;
    if(this.exporting){this.panel.setScreenshotState(false,'Wait for the export to finish, then take a screenshot.');return}
    if(this.pendingViewRestore||this.viewRestoreAbort){this.panel.setScreenshotState(false,'Wait for the saved view to finish restoring, then take a screenshot.');return}
    const model=this.viewModel,review=this.timeline.isOpen,take=this.take,mode=this.timeline.mode;
    if(!model||!review&&(!this.lastFrame||model!==this.model||!this.overlay.classList.contains('hidden')||(model.terrain??this.panel.terrain)!==this.panel.terrain)){
      this.panel.setScreenshotState(false,'Wait for the scene to finish loading, then take a screenshot.');return;
    }
    const request=++this.screenshotRequest,generation=this.viewBuildGeneration,revision=this.view.getVisualRevision(),controller=new AbortController();
    const current=()=>request===this.screenshotRequest&&generation===this.viewBuildGeneration&&model===this.viewModel
      &&review===this.timeline.isOpen&&(!review||take===this.take&&mode===this.timeline.mode)
      &&revision===this.view.getVisualRevision()&&!this.exporting&&!this.pendingViewRestore
      &&(review||model===this.model&&this.overlay.classList.contains('hidden')&&(model.terrain??this.panel.terrain)===this.panel.terrain);
    this.screenshotPending=true;this.screenshotAbort=controller;this.screenshotIsCurrent=current;
    this.updatePendingSaveGuard();
    this.panel.setScreenshotState(true,'Preparing scene visuals…');
    const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new DOMException('Screenshot cancelled.','AbortError')),{once:true}));
    let phase:'prepare'|'capture'='prepare',message='',restoreHighlights:(()=>void)|undefined;
    try{
      await Promise.race([Promise.all([this.view.waitForRobotVisuals(),this.view.waitForTerrainVisuals()]),aborted]);
      if(!current()){this.cancelScreenshot();return}
      const terrain=model.terrain??(review&&isTerrain(take?.meta.terrain)?take!.meta.terrain:this.panel.terrain);
      if(terrain.startsWith('map:local-')&&this.view.mapSource?.id!==mapId(terrain)){message='Reattach the original map bundle, then try Screenshot again.';return;}
      phase='capture';
      if(this.view.renderer.getContext().isContextLost())throw new Error('Viewport unavailable.');
      restoreHighlights=this.view.suspendHighlights();
      if(review&&this.take)this.reviewFrame(0);else this.drawLiveFrame();
      const filename=`${mapId(terrain)??terrain}_${model.robot}_${stamp()}.png`;
      const created=new Date().toISOString();
      const blob=await Promise.race([capturePng(this.view.renderer.domElement),aborted]);
      if(!current()){this.cancelScreenshot();return}
      if(this.view.renderer.getContext().isContextLost())throw new Error('Viewport unavailable.');
      download(blob,filename);message='PNG downloaded · saving to Shots…';
      this.retainScreenshot(blob,filename.slice(0,-4),created,model.robot,terrain,request);
    }catch{
      if(request!==this.screenshotRequest)return;
      message=!current()?'The scene changed. Take the screenshot again when it has loaded.'
        :this.view.renderer.getContext().isContextLost()?'The viewport is unavailable. Wait for it to recover, then try Screenshot again.'
        :phase==='prepare'?'Scene visuals could not load. Retry the map or robot model, then try Screenshot again.'
        :'The PNG could not be saved. Try Screenshot again.';
    }finally{
      restoreHighlights?.();
      if(request===this.screenshotRequest){
        this.screenshotPending=false;this.screenshotAbort=null;this.screenshotIsCurrent=null;
        this.updatePendingSaveGuard();
        this.panel.setScreenshotState(false,message);
      }
    }
  }

  /** Draw the latest live pose without polling controls or advancing the simulation. */
  private drawLiveFrame(){
    if(this.lastFrame){
      if(!this.heldView&&!this.noclip&&!this.shotDrag)this.view.follow(this.baseXY[0],this.baseXY[1],this.baseZ);
      this.view.updateRobotLighting(this.baseXY[0],this.baseXY[1],this.baseZ);
      this.view.sync(this.lastFrame.xpos,this.lastFrame.xmat);
    }
    if(this.leashDrag)this.view.setLeash([this.baseXY[0],this.baseXY[1],.3],[this.leashDrag[0],this.leashDrag[1],.12]);
    if (this.dialog.isOpen && !this.timeline.isOpen) {
      this.liveShotBase[0] = this.baseXY[0]; this.liveShotBase[1] = this.baseXY[1]; this.liveShotBase[2] = this.baseZ;
      if (this.shotDrag) this.view.controls.update();
      applyStaticShot(this.shotCam, this.shot, this.liveShotBase, this.dialog.aspect, this.view.camera);
      const r = this.view.renderFramed(this.shotCam, this.dialog.aspect), st = this.shotFrame.style;
      st.left = `${r.x}px`; st.top = `${r.y}px`; st.width = `${r.w}px`; st.height = `${r.h}px`;
      return;
    }
    this.view.render();
  }

  private renderLoop() {
    let lastPadCmd = "";
    let padWasActive = false;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      requestAnimationFrame(tick);
      if(this.screenshotIsCurrent&&!this.screenshotIsCurrent())this.cancelScreenshot(this.exporting
        ?'An export started. Take another screenshot after it finishes.':undefined);
      if (this.exporting) return;                    // the export owns the canvas
      if (this.timeline.isOpen && this.take) return this.reviewFrame(dt);
      // The loading game owns the screen; prepareLaunch renders one real ready frame.
      if (launch.active) return;
      if (this.inputBlocked) { this.drawLiveFrame(); return; }
      const padCmd = this.pad.poll((a) => this.onPadAction(a), this.status?.combos,
                                   (combo) => this.remote(combo));
      if (padCmd && !this.noclip) {
        padWasActive = true;
        const key = padCmd.map((v) => v.toFixed(2)).join(",");
        if (key !== lastPadCmd) { lastPadCmd = key; this.setCommand(padCmd); }
      } else if (padWasActive) {
        // pad vanished or disarmed mid-drive — don't leave a stale command
        padWasActive = false;
        lastPadCmd = "";
        this.setCommand([0, 0, 0]);
      }
      if (this.noclip && !this.dialog.isOpen) {
        const velocity = this.flight.update(dt);
        this.updateFlightHud();
        if (velocity.lengthSq() > 0) this.send({ t: 'noclipStep', delta: velocity.toArray().map(v => v * dt) as [number, number, number] });
      }
      this.drawLiveFrame();
      if (this.panel.padDebugOpen()) this.updatePadDebug();
    };
    requestAnimationFrame(tick);
  }

  /** One animation frame of the review: advance the playhead, pose the take, render the chosen view. */
  private reviewFrame(dt: number) {
    const take = this.take!, tl = this.timeline;
    tl.tick(dt);
    const t = tl.time;
    const b = this.poseTake(t);
    if (tl.mode === "recorded") {
      const c = take.camAt(t), cam = this.view.camera;
      cam.position.set(...c.pos);
      this.view.controls.target.set(...c.target);
      if(c.orientation)cam.quaternion.fromArray(c.orientation);else cam.lookAt(this.view.controls.target);
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
