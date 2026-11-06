/** Player presentation owner: the third-person body, the per-tool view models, the player camera
 * and the view-model pass. Live frames go through `present` (advance controllers, then `apply`);
 * review and export call `apply` with a recorded presentation, which is pure.
 *
 * The physics gun and spawn tool always have a view model: a game-file model when one loads, else
 * the bundled default (default-viewmodel.ts). `viewModelPath` reports which, for take metadata.
 *
 * View-model motion follows the Source SDK: HL2's AddViewmodelBob (speed-scaled bob cycle) and
 * CBaseViewModel::CalcViewModelLag (facing drift and pitch offsets), recorded camera-relative as
 * viewModelPosition (metres) and viewModelOrientation (xyzw) so any render camera carries them.
 * The view model is drawn after the world inside the same post-process with its own FOV (54 at
 * 4:3, hor+) after clearing depth, so it never clips into walls (Source DrawViewModels). */
import * as THREE from 'three';
import type { GoldSrcSource } from '../characters/goldsrc';
import type { LocalGameContent } from '../../player/assets/local-content';
import { SourceMaterialLibrary } from '../../player/materials/library';
import { loadStudioModel } from '../../player/studio';
import type { PlayerAnimationPose, PlayerPresentation, PlayerSimFrame, PlayerTool, SourceFrame } from '../../player/types';
import { INCH } from '../../player/source-frame';
import type { PlayerTake } from '../../record/player-take';
import { DEG, type PlayerBodyRig } from './body';
import { horPlusVerticalFov, PlayerCamera, PLAYER_VIEWMODEL_FOV } from './camera';
import { GoldSrcPlayerBody } from './goldsrc-body';
import { StudioPlayerBody } from './studio-body';
import type { MaterialLighter } from './studio-object';
import { WorldRayGrid } from './trace';
import { DefaultViewModelKit, DefaultViewModelRig, defaultViewModelPath, isDefaultViewModelPath } from './default-viewmodel';
import { PLAYER_VIEWMODEL_LAYER, ViewModelRig, type PlayerViewModelRig, type ViewModelAction } from './viewmodel';

export type PlayerBodySource =
  | { kind: 'goldsrc'; id: string; source: GoldSrcSource }
  | { kind: 'studio'; content: LocalGameContent; path: string };
/** A view model from the person's game files. If it fails to load, `onError` 'default' (the
 * default) shows the tool's bundled model instead; 'clear' leaves the tool without one, for
 * reviewing a take that recorded this exact model. */
export interface PlayerViewModelSource { content: LocalGameContent; path: string; hands?: string; onError?: 'default' | 'clear' }
export interface PlayerViewModelStatus {
  tool: PlayerTool;
  shown: boolean;
  /** What the tool has: the bundled model, one from game files, or nothing. */
  source: 'default' | 'imported' | null;
  path: string | null;
  reason?: string;
}

export interface PlayerViewHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly light: MaterialLighter;
  /** Static world roots the third-person camera collides with. */
  collision(): readonly THREE.Object3D[];
}

const IDENTITY_FRAME: SourceFrame = Object.freeze({ origin: Object.freeze([0, 0, 0]) as readonly [number, number, number], yawDeg: 0 });
/** HL2 bob constants (basehlcombatweapon_shared.cpp) and CalcViewModelLag's MAX_VIEWMODEL_LAG. */
const BOB_CYCLE_MAX = 0.45, BOB_UP = 0.5, MAX_LAG = 1.5, LAG_SPEED = 5;
/** Source viewmodel near plane (1 unit); far is the world's reach. */
const VM_NEAR = INCH, VM_FAR = 1000;
/** Source eye frame (X forward, Y left, Z up) to Three camera frame (−Z forward, +X right, +Y up). */
const SOURCE_TO_CAMERA = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1));
const CAMERA_TO_SOURCE = SOURCE_TO_CAMERA.clone().invert();

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class PlayerView {
  private sourceFrame: SourceFrame = IDENTITY_FRAME;
  private body: PlayerBodyRig | null = null;
  private bodyLoad: Promise<void> = Promise.resolve();
  private bodyGeneration = 0;
  private readonly viewModels = new Map<PlayerTool, PlayerViewModelRig>();
  /** Pending game-file loads by tool; a load whose entry was replaced or removed is discarded. */
  private readonly viewModelLoads = new Map<PlayerTool, { promise: Promise<void> }>();
  /** Why the last requested game-file model for a tool did not load. */
  private readonly viewModelErrors = new Map<PlayerTool, string>();
  /** Materials shared by the bundled view models; made on first use, released in dispose. */
  private defaultKit: DefaultViewModelKit | null = null;
  private readonly libraries = new Map<LocalGameContent, SourceMaterialLibrary>();
  private readonly cam = new PlayerCamera();
  private world: WorldRayGrid | null = null;
  private worldBuilt = -1;
  /** Bumped by the host when the static world changes. */
  worldRevision = 0;
  /** Capture modes that must not show the view model (e.g. a free or shot camera) turn this off. */
  showViewModel = true;
  /** External cameras (review free, follow and shot cameras) turn this on to show the body in a
   * first-person presentation; it never shows through the first-person camera by default. */
  showBody = false;

  private readonly presentation: Mutable<PlayerPresentation>;
  private readonly emptyPose: PlayerAnimationPose = { sequence: 0, cycle: 0, poseParameters: new Float32Array(0), layers: [] };
  private readonly actions: ViewModelAction[] = [];
  private lastTool: PlayerTool | null = null;
  private activeViewModel: PlayerViewModelRig | null = null;
  private appliedThird = false;
  private appliedTool: PlayerTool = 'none';
  private viewModelFov = PLAYER_VIEWMODEL_FOV;
  private readonly vmCamera = new THREE.PerspectiveCamera(horPlusVerticalFov(PLAYER_VIEWMODEL_FOV), 1, VM_NEAR, VM_FAR);
  private readonly vmLocal = new THREE.Matrix4();
  // Bob / lag state and scratch.
  private bobTime = 0;
  private readonly lastFacing = new THREE.Vector3(1, 0, 0);
  private facingSet = false;
  private readonly vmPosition: [number, number, number] = [0, 0, 0];
  private readonly vmOrientation: [number, number, number, number] = [0, 0, 0, 1];
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'ZYX');
  private readonly scale = new THREE.Vector3(INCH, INCH, INCH);

  constructor(private readonly host: PlayerViewHost) {
    this.vmCamera.layers.set(PLAYER_VIEWMODEL_LAYER);
    this.vmCamera.up.set(0, 0, 1);
    this.presentation = { thirdPerson: false, bodyYaw: 0, body: this.emptyPose };
  }

  /** The map's Source frame (identity for built-in arenas). */
  setSourceFrame(frame: SourceFrame | undefined): void { this.sourceFrame = frame ?? IDENTITY_FRAME; }

  private library(content: LocalGameContent): SourceMaterialLibrary {
    let library = this.libraries.get(content);
    if (!library || library.disposed) {
      library = new SourceMaterialLibrary({ content, renderer: this.host.renderer, unrecognizedParameters: 'record' });
      this.libraries.set(content, library);
    }
    return library;
  }

  /** Loads the third-person body. The previous body stays until the new one is ready; rejects
   * with an explicit error (missing file, texture, unsupported data or missing activities). */
  setBody(source: PlayerBodySource | null, signal?: AbortSignal): Promise<void> {
    const generation = ++this.bodyGeneration;
    const load = (async () => {
      let rig: PlayerBodyRig | null = null;
      if (source?.kind === 'goldsrc') rig = await GoldSrcPlayerBody.load(source.id, source.source, this.host.light);
      else if (source) {
        const model = await loadStudioModel(source.content, source.path, signal);
        rig = await StudioPlayerBody.load(source.path, model, this.library(source.content), this.host.light, signal);
      }
      if (generation !== this.bodyGeneration || signal?.aborted) { rig?.dispose(); signal?.throwIfAborted(); return; }
      this.body?.dispose();
      this.body = rig;
      if (rig) { rig.object.visible = false; this.host.scene.add(rig.object); }
    })();
    this.bodyLoad = load.catch(() => {});
    return load;
  }

  /** Shows a view model for `tool`. Null, or a source whose path is a bundled id, selects the
   * bundled model of the physics gun or spawn tool without reading game files (and clears any other
   * tool); it takes effect at once and supersedes a pending load. Showing the bundled model that is
   * already shown keeps it. A game-file model replaces the current one once it has loaded; until
   * then the current one stays. A failed load rejects, keeps the reason for viewModelStatus and
   * applies `source.onError`. An aborted or superseded load changes nothing. */
  setViewModel(tool: PlayerTool, source: PlayerViewModelSource | null, signal?: AbortSignal): Promise<void> {
    this.viewModelLoads.delete(tool);
    this.viewModelErrors.delete(tool);
    if (!source || isDefaultViewModelPath(source.path)) {
      try {
        signal?.throwIfAborted();
        this.showDefaultViewModel(tool, source?.path ?? null);
      } catch (error) {
        if (!signal?.aborted) this.viewModelErrors.set(tool, error instanceof Error ? error.message : String(error));
        return Promise.reject(error);
      }
      return Promise.resolve();
    }
    // Registered before any work starts, so the load can always tell whether it is still current.
    const entry = { promise: Promise.resolve() };
    this.viewModelLoads.set(tool, entry);
    entry.promise = this.loadViewModel(tool, source, entry, signal);
    return entry.promise;
  }

  private async loadViewModel(tool: PlayerTool, source: PlayerViewModelSource, entry: { promise: Promise<void> }, signal?: AbortSignal): Promise<void> {
    /** Ends this load's pending entry; true when its result should still be shown. */
    const settle = () => {
      const mine = this.viewModelLoads.get(tool) === entry;
      if (mine) this.viewModelLoads.delete(tool);
      return mine && !signal?.aborted;
    };
    let rig: ViewModelRig;
    try {
      const [model, hands] = await Promise.all([loadStudioModel(source.content, source.path, signal),
        source.hands ? loadStudioModel(source.content, source.hands, signal) : null]);
      rig = await ViewModelRig.load(source.path, model, this.library(source.content), hands, this.host.light, signal);
    } catch (error) {
      if (!settle()) { signal?.throwIfAborted(); return; }
      this.viewModelErrors.set(tool, `${source.path}: ${error instanceof Error ? error.message : String(error)}`);
      if (source.onError === 'clear') this.removeViewModel(tool);
      else this.showDefaultViewModel(tool, null);
      throw error;
    }
    if (!settle()) { rig.dispose(); signal?.throwIfAborted(); return; }
    this.installViewModel(tool, rig);
  }

  /** The bundled model for `tool` (reused when already shown), or none for a tool without one. */
  private showDefaultViewModel(tool: PlayerTool, requested: string | null): void {
    const id = defaultViewModelPath(tool);
    if (requested !== null && requested !== id) throw new Error(`${requested} is not the bundled view model for this tool.`);
    if (tool !== 'physgun' && tool !== 'spawn') { this.removeViewModel(tool); return; }
    if (this.viewModels.get(tool)?.path === id) return;
    if (!this.defaultKit || this.defaultKit.disposed) this.defaultKit = new DefaultViewModelKit(this.host.light);
    this.installViewModel(tool, DefaultViewModelRig.create(tool, this.defaultKit));
  }

  private installViewModel(tool: PlayerTool, rig: PlayerViewModelRig): void {
    this.removeViewModel(tool);
    rig.object.visible = false;
    this.host.scene.add(rig.object);
    this.viewModels.set(tool, rig);
  }

  private removeViewModel(tool: PlayerTool): void {
    const rig = this.viewModels.get(tool);
    if (!rig) return;
    if (rig === this.activeViewModel) this.activeViewModel = null;
    rig.dispose();
    this.viewModels.delete(tool);
  }

  async waitForVisuals(): Promise<void> {
    await this.bodyLoad;
    await Promise.all([...this.viewModelLoads.values()].map(entry => entry.promise.catch(() => {})));
  }

  /** Body identity for take metadata: the pmodel id or the canonical model path. */
  bodyPath(): string | null { return this.body?.path ?? null; }
  /** View-model identity for take metadata: the canonical game-file path or a bundled id. */
  viewModelPath(tool: PlayerTool): string | null { return this.viewModels.get(tool)?.path ?? null; }
  /** What the displayed player can't reproduce, for exports and diagnostics. */
  limitations(): string[] {
    return [...(this.body?.limitations ?? []), ...[...this.viewModels.values()].flatMap(rig => rig.limitations)];
  }

  /** Every material the body and view models draw, once each (for display toggles). */
  eachMaterial(visit: (material: THREE.Material) => void): void {
    const seen = new Set<THREE.Material>();
    const roots: THREE.Object3D[] = [...(this.body ? [this.body.object] : []), ...[...this.viewModels.values()].map(rig => rig.object)];
    for (const root of roots) root.traverse(o => {
      if (o instanceof THREE.Mesh) for (const m of [o.material].flat()) if (!seen.has(m)) { seen.add(m); visit(m); }
    });
  }

  /** Queues a view-model activity (and the body's attack gesture) for the next `present`. */
  trigger(action: ViewModelAction): void { if (this.actions.length < 8) this.actions.push(action); }

  viewModelStatus(): PlayerViewModelStatus {
    const tool = this.appliedTool, rig = this.viewModels.get(tool) ?? null, error = this.viewModelErrors.get(tool);
    const status: PlayerViewModelStatus = { tool, shown: rig !== null && rig === this.activeViewModel,
      source: rig ? rig.builtin ? 'default' : 'imported' : null, path: rig?.path ?? null };
    if (tool === 'none') status.reason = 'No tool is equipped.';
    else if (this.viewModelLoads.has(tool)) status.reason = 'The view model is loading.';
    else if (error) status.reason = rig ? `${error} Showing the bundled model instead.` : error;
    else if (!rig) status.reason = 'Your selected game files have no view model for this tool.';
    else if (this.appliedThird) status.reason = 'Third person.';
    else if (!this.showViewModel) status.reason = 'This camera does not show the view model.';
    else if (!status.shown) status.reason = 'This presentation has no view-model pose.';
    return status;
  }

  /** Per worker frame: advances the controllers by `dt` simulated seconds and shows the result.
   * The returned presentation is borrowed until the next call. */
  present(frame: PlayerSimFrame, clock: number, dt: number): PlayerPresentation {
    const p = this.presentation, body = this.body;
    p.thirdPerson = frame.thirdPerson;
    if (frame.tool !== this.lastTool) {
      this.lastTool = frame.tool;
      this.viewModels.get(frame.tool)?.start('draw');
    }
    const vm = this.viewModels.get(frame.tool) ?? null;
    for (const action of this.actions) {
      vm?.start(action);
      if (action === 'attack' || action === 'attackHit') body?.attack(frame.tool);
    }
    this.actions.length = 0;
    if (body) { body.advance(frame, dt); p.bodyYaw = body.bodyYaw; p.body = body.pose; }
    else { p.bodyYaw = frame.yaw; p.body = this.emptyPose; }
    if (vm) {
      vm.advance(dt);
      p.viewModel = vm.pose;
      this.viewModelMotion(frame, dt);
      p.viewModelPosition = this.vmPosition;
      p.viewModelOrientation = this.vmOrientation;
      p.viewModelFov = PLAYER_VIEWMODEL_FOV;
    } else {
      delete p.viewModel; delete p.viewModelPosition; delete p.viewModelOrientation; delete p.viewModelFov;
    }
    this.apply(frame, p, clock);
    return p;
  }

  /** Source vectors for (pitch, yaw, roll) degrees into v1 (forward), v2 (right), v3 (up). */
  private angleVectors(pitch: number, yaw: number, roll: number) {
    const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG), sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
    const sr = Math.sin(roll * DEG), cr = Math.cos(roll * DEG);
    this.v1.set(cp * cy, cp * sy, -sp);
    this.v2.set(-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp);
    this.v3.set(cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp);
  }

  /** HL2 CalcViewmodelBob for one bob period: a raised sine whose amplitude grows with speed. */
  private bob(period: number, speed: number): number {
    let cycle = (this.bobTime - Math.trunc(this.bobTime / period) * period) / period;
    cycle = cycle < BOB_UP ? Math.PI * cycle / BOB_UP : Math.PI + Math.PI * (cycle - BOB_UP) / (1 - BOB_UP);
    const base = speed * 0.005;
    return Math.max(-7, Math.min(4, base * 0.3 + base * 0.7 * Math.sin(cycle)));
  }

  /** HL2 view-model bob and Source view-model lag, as a camera-relative offset. */
  private viewModelMotion(frame: PlayerSimFrame, dt: number) {
    const speed = Math.min(320, Math.hypot(frame.velocity[0], frame.velocity[1]));
    this.bobTime += dt * (speed / 320);
    const vertical = this.bob(BOB_CYCLE_MAX, speed), lateral = this.bob(BOB_CYCLE_MAX * 2, speed);
    const pitch = frame.pitch, yaw = frame.yaw, o = this.origin.set(0, 0, 0);
    // AddViewmodelBob
    this.angleVectors(pitch, yaw, 0);
    o.addScaledVector(this.v1, vertical * 0.1);
    o.z += vertical * 0.1;
    const vmPitch = pitch - vertical * 0.4, vmYaw = yaw - lateral * 0.3, vmRoll = vertical * 0.5;
    o.addScaledVector(this.v2, lateral * 0.8);
    // CalcViewModelLag
    this.angleVectors(vmPitch, vmYaw, vmRoll);
    if (!this.facingSet) { this.lastFacing.copy(this.v1); this.facingSet = true; }
    if (dt !== 0) {
      const dx = this.v1.x - this.lastFacing.x, dy = this.v1.y - this.lastFacing.y, dz = this.v1.z - this.lastFacing.z;
      if (Math.abs(dx) > MAX_LAG || Math.abs(dy) > MAX_LAG || Math.abs(dz) > MAX_LAG) this.lastFacing.copy(this.v1);
      this.lastFacing.x += LAG_SPEED * dt * dx; this.lastFacing.y += LAG_SPEED * dt * dy; this.lastFacing.z += LAG_SPEED * dt * dz;
      this.lastFacing.normalize();
      o.x -= 5 * dx; o.y -= 5 * dy; o.z -= 5 * dz;
    }
    this.angleVectors(pitch, yaw, 0);
    o.addScaledVector(this.v1, -pitch * 0.035).addScaledVector(this.v2, -pitch * 0.03).addScaledVector(this.v3, -pitch * 0.02);
    // Into the eye frame, then the camera frame.
    const eye = this.q1.setFromEuler(this.euler.set(0, pitch * DEG, yaw * DEG, 'ZYX')).invert();
    o.applyQuaternion(eye).applyQuaternion(SOURCE_TO_CAMERA).multiplyScalar(INCH);
    this.vmPosition[0] = o.x; this.vmPosition[1] = o.y; this.vmPosition[2] = o.z;
    const rel = this.q2.setFromEuler(this.euler.set(vmRoll * DEG, vmPitch * DEG, vmYaw * DEG, 'ZYX')).premultiply(eye);
    rel.premultiply(SOURCE_TO_CAMERA).multiply(CAMERA_TO_SOURCE);
    this.vmOrientation[0] = rel.x; this.vmOrientation[1] = rel.y; this.vmOrientation[2] = rel.z; this.vmOrientation[3] = rel.w;
  }

  /** Shows a presentation: the body (third person, or any presentation when an external camera sets
   * showBody; Source never draws the local body through the first-person eye) and the current
   * tool's view model (first person only, when showViewModel). Pure. */
  apply(frame: PlayerSimFrame, presentation: PlayerPresentation, clock: number): void {
    const third = presentation.thirdPerson, body = this.body;
    this.appliedThird = third; this.appliedTool = frame.tool;
    if (body) {
      if (presentation.body !== this.emptyPose) body.apply(frame, presentation, clock, this.sourceFrame);
      body.object.visible = (third || this.showBody) && presentation.body !== this.emptyPose;
    }
    let active: PlayerViewModelRig | null = null;
    for (const [tool, rig] of this.viewModels) {
      const current = tool === frame.tool && !!presentation.viewModel;
      if (current) rig.apply(presentation.viewModel!, clock);
      rig.object.visible = current && !third && this.showViewModel;
      if (rig.object.visible) active = rig;
    }
    this.activeViewModel = active;
    if (!active) return;
    const pos = presentation.viewModelPosition, q = presentation.viewModelOrientation;
    this.v1.set(pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? 0);
    this.q1.set(q?.[0] ?? 0, q?.[1] ?? 0, q?.[2] ?? 0, q?.[3] ?? 1).multiply(SOURCE_TO_CAMERA);
    this.vmLocal.compose(this.v1, this.q1, this.scale);
    this.viewModelFov = presentation.viewModelFov ?? PLAYER_VIEWMODEL_FOV;
  }

  /** Player camera for live play; see PlayerCamera. */
  updateCamera(camera: THREE.PerspectiveCamera, frame: PlayerSimFrame, look: { yaw: number; pitch: number }, thirdPerson: boolean, dt: number): void {
    if (thirdPerson && this.worldBuilt !== this.worldRevision) {
      this.world = new WorldRayGrid(this.host.collision());
      this.worldBuilt = this.worldRevision;
    }
    this.cam.update(camera, frame, this.sourceFrame, look, thirdPerson, dt, thirdPerson ? this.world : null);
  }

  /** The view-model pass, called after the world inside the Source post-process. The view-model
   * FOV is hor+ for screens at least 4:3 wide; narrower (portrait) screens keep its 4:3 horizontal
   * extent instead, so the model stays in view rather than being cropped off the right edge. */
  drawViewModel(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const rig = this.activeViewModel;
    if (!rig || !rig.object.visible || !(camera instanceof THREE.PerspectiveCamera)) return;
    camera.updateMatrixWorld();
    const vm = this.vmCamera, fov = camera.aspect >= 4 / 3 ? horPlusVerticalFov(this.viewModelFov)
      : 2 * Math.atan(Math.tan(this.viewModelFov * DEG / 2) / camera.aspect) / DEG;
    camera.matrixWorld.decompose(vm.position, vm.quaternion, this.v2);
    if (vm.fov !== fov || vm.aspect !== camera.aspect) { vm.fov = fov; vm.aspect = camera.aspect; vm.updateProjectionMatrix(); }
    vm.updateMatrixWorld();
    rig.object.matrix.multiplyMatrices(camera.matrixWorld, this.vmLocal);
    rig.object.matrixWorldNeedsUpdate = true;
    const autoClear = renderer.autoClear, background = scene.background, shadows = renderer.shadowMap.autoUpdate;
    try {
      renderer.clearDepth();
      renderer.autoClear = false; scene.background = null; renderer.shadowMap.autoUpdate = false;
      renderer.render(scene, vm);
    } finally {
      renderer.autoClear = autoClear; scene.background = background; renderer.shadowMap.autoUpdate = shadows;
    }
  }

  /** glTF actors for exportPlayerGlb: the GoldSrc body as a skinned mesh with node tracks keyed at
   * t0 + times[i] in the MuJoCo frame. Bodies from local game files and view models are never
   * re-exported; their limits are listed. */
  async actors(take: PlayerTake, times: Float32Array, t0: number): Promise<{ root: THREE.Object3D; tracks: THREE.KeyframeTrack[]; limitations: string[] }> {
    await this.waitForVisuals();
    const root = new THREE.Group(), tracks: THREE.KeyframeTrack[] = [], n = times.length, used = new Set<string>();
    const limitations = ['The first-person view model is not exported: it is a screen-space overlay, and game files are never re-exported.'];
    root.name = 'player_actor';
    const unique = (base: string) => {
      const b = THREE.PropertyBinding.sanitizeNodeName(`player_${base}`) || 'player_node';
      let name = b;
      for (let k = 2; used.has(name); k++) name = `${b}_${k}`;
      used.add(name);
      return name;
    };
    const body = this.body;
    if (!body) { limitations.push('No player body was loaded, so none is exported.'); return { root, tracks, limitations }; }
    const copy = body.exportCopy();
    const node: THREE.Object3D = copy?.root ?? new THREE.Object3D();
    node.name = unique(copy ? 'body' : 'origin');
    root.add(node);
    const bones = copy?.bones ?? [], sourceBones = copy?.source ?? [];
    for (const bone of bones) bone.name = unique(bone.name);
    const position = new Float32Array(n * 3), quaternion = new Float32Array(n * 4);
    const bonePos = bones.map(() => new Float32Array(n * 3)), boneQuat = bones.map(() => new Float32Array(n * 4));
    const clockStart = take.meta.clockStart ?? 0, savedFrame = this.sourceFrame;
    try {
      for (let i = 0; i < n; i++) {
        const t = t0 + times[i], pose = take.poseAt(t);
        if (!pose.model.sourceFrame) throw new Error('This Player take has no Source frame for its scene.');
        this.sourceFrame = pose.model.sourceFrame;
        body.apply(pose.player, pose.presentation, clockStart + t, this.sourceFrame);
        body.object.position.toArray(position, i * 3);
        body.object.quaternion.toArray(quaternion, i * 4);
        for (let b = 0; b < bones.length; b++) {
          sourceBones[b].position.toArray(bonePos[b], i * 3);
          sourceBones[b].quaternion.toArray(boneQuat[b], i * 4);
        }
      }
    } finally { this.sourceFrame = savedFrame; }
    const continuous = (q: Float32Array) => {
      for (let i = 1; i < n; i++) if (q[i * 4] * q[i * 4 - 4] + q[i * 4 + 1] * q[i * 4 - 3] + q[i * 4 + 2] * q[i * 4 - 2] + q[i * 4 + 3] * q[i * 4 - 1] < 0)
        for (let k = 0; k < 4; k++) q[i * 4 + k] = -q[i * 4 + k];
      return q;
    };
    node.position.fromArray(position); node.quaternion.fromArray(quaternion);
    tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, times, position),
      new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, continuous(quaternion)));
    bones.forEach((bone, b) => {
      bone.position.fromArray(bonePos[b]); bone.quaternion.fromArray(boneQuat[b]);
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, bonePos[b]),
        new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, continuous(boneQuat[b])));
    });
    if (copy) limitations.push('The player body is exported for the whole range; the app shows it in third person and from cameras outside the eye.', ...body.limitations);
    else limitations.push(`The player body ${body.path} comes from your game files and is not re-exported; the "${node.name}" node carries its placement and facing.`);
    return { root, tracks, limitations };
  }

  dispose(): void {
    ++this.bodyGeneration;
    this.body?.dispose(); this.body = null;
    // Pending loads find their entries gone and discard what they load.
    this.viewModelLoads.clear(); this.viewModelErrors.clear();
    for (const rig of this.viewModels.values()) rig.dispose();
    this.viewModels.clear(); this.activeViewModel = null;
    this.defaultKit?.dispose(); this.defaultKit = null;
    for (const library of this.libraries.values()) library.dispose();
    this.libraries.clear();
    this.world = null;
  }
}
