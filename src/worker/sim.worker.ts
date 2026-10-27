/** Sim worker — owns MuJoCo wasm, onnxruntime, the FSM and the active driver.
 * See src/sim/protocol.ts for why this must run off the main thread. */
import { makeDriver, type BaseDriver } from "../core/drivers";
import { sampleTraj, wxyz } from "../core/math";
import type { PolicyEntry, Command, EvalConfig, RobotSpec } from "../core/types";
import { listPacks, deletePack, deleteAllPacks, loadPack, importAny, packEntries, packAssetUrls, resolvePackConfig,
         revokePack, type PackMetadata } from "../packs";
import { installDefaultPacks } from '../packs/defaults';
import { releasePolicySessions } from '../core/policy';
import { Engine, MissingBundleError, GEOM_MESH, type PreparedEngine } from "../sim/engine";
import { SimFSM, type FsmState } from "../sim/fsm";
import { isTerrain, mapId, terrainTransform, type TerrainName } from "../sim/terrain";
import { getSpec, SPECS } from "../robots";
import { observeTransfers } from "../loading/transfers";
import { robotFamily as fam, r1Models, modelKey, specFor, selectRobotPolicy, type RobotPolicySelection } from './robot-policy';
import type { FromWorker, RenderModel, ToWorker, SceneIdentity } from "../sim/protocol";
import { createFrameGeometryLayout, copyMovingGeometry } from '../sim/geometry-frames';
import { PreparedAssets, httpAssetKey, usePreparedAssets } from '../core/prepared-assets';
import { StartupGate } from '../core/startup-gate';
import { driverAssetUrls, selectedDriverAssets } from '../core/driver-assets';
import { expandAssetUrls } from '../loading/catalogue';
import { mapSource, registerLocalMap, type MapSource } from '../maps/source';

/** Kinematic-playback state: a user-supplied reference clip is set into qpos
 * frame-by-frame (no physics), to preview retargeted mocap on the robot. */
interface Playback {
  rows: Float32Array; nRows: number; nCols: number;
  fps: number; njoints: number; name: string;
  bqp: number;                 // base qpos address
  jointAddr: Int32Array;       // qpos address per clip joint (model order)
  extraAddr: Int32Array;       // hinges not in the clip → held at 0
  t: number;                   // playback clock (s)
}

/** Parse a reference CSV: rows of [pos(3), quat_xyzw(4), joint_pos(n)].
 * Tolerates comma or whitespace delimiters and skips header/non-numeric rows. */
function parseTrajCsv(text: string):
    { rows: Float32Array; nRows: number; nCols: number } | null {
  const out: number[] = [];
  let nCols = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const nums = s.split(/[,\s]+/).map(Number);
    if (nums.some((v) => !Number.isFinite(v))) continue;   // header / junk
    if (!nCols) nCols = nums.length;
    if (nums.length !== nCols) continue;
    for (const v of nums) out.push(v);
  }
  if (nCols < 8 || out.length < nCols) return null;
  return { rows: Float32Array.from(out), nRows: out.length / nCols, nCols };
}

const post = (m: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(m, transfer);

let loadingGeneration: number | undefined;
let loadingEpoch = 0;
let stopLoading: (() => void) | undefined;
let releasePrepared: (() => void) | undefined;
let terrainEpoch=0;
let stagedTerrain: {request:number;baseRobot:string;robot:string;terrain:TerrainName;source:MapSource|null;engine:Engine;scene:SceneIdentity;selection?:RobotPolicySelection}|undefined;
const startupGate = new StartupGate();

function finishLoading(generation: number) {
  if (generation !== loadingGeneration) return;
  startupGate.finish(generation);
  stopLoading?.();
  releasePrepared?.();
  stopLoading = releasePrepared = undefined;
  loadingGeneration = undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class SimWorker {
  eng!: Engine;
  fsm!: SimFSM;
  driver: BaseDriver | null = null;

  robot = "r1";
  terrain: TerrainName = "flat";
  private activeMap: MapSource | null = null;
  packs: PackMetadata[] = [];          // catalog only; selected weights load in cfgFor
  configs = new Map<string, EvalConfig>();
  policies: PolicyEntry[] = [];       // pack entries for the active robot
  polIdx = 0;
  command: Command = [0, 0, 0];
  /** The command actually handed to the driver this step (0 while the policy ignores commands). */
  cmdNow: Command = [0, 0, 0];
  busy = true;
  rtf = 0;
  /** simulated seconds of policy control (inspect snapshot; lets tests schedule by sim time) */
  simT = 0;
  /** pending scripted stimulus (message "script"), absolute simT; `stick` persists and is rescaled per tick */
  private script: { at: number; stick?: [number, number, number]; combo?: string }[] = [];
  private stick: [number, number, number] | null = null;
  private scriptT0 = -1;
  playback: Playback | null = null;
  inspectOn = false;
  /** take review: the control loop idles so the robot is where the recording left it on resume */
  paused = false;
  private noclip = false;
  private noclipVelocity: [number, number, number] = [0, 0, 0];
  /** frame clock (s): advanced by every posted frame's step — the time base of recorded takes */
  private clock = 0;
  private movingGeomIds!: Uint32Array;
  private prevCmd: { target: Float64Array | null; kp: Float64Array; kd: Float64Array } | null = null;
  baseAddr = 0;                        // floating-base qpos addr (for driver-less frames)
  private baseVaddr = 0;               // floating-base qvel addr
  /** measured base speed [forward, lateral (heading frame), yaw rate], ~0.5 s moving average */
  private speed: [number, number, number] = [0, 0, 0];
  /** policy entered by an automatic hand-over (its notice popup is suppressed until picked by hand) */
  private autoPolicy?: string;
  hoistOn = false;                     // overhead suspension gantry support: off by default (H / button turns it on)
  hoistZ = 0;                          // nominal standing height captured on reset
  leash: { on: boolean; x: number; y: number } = { on: false, x: 0, y: 0 };
  private anchorBid = 0;               // body the leash force applies to
  private hoistBid = 0;                // body the overhead hoist holds (spec hoist_body, else anchor)
  private hoistOff: [number, number, number] = [0, 0, 0];   // hoist point in that body's frame
  private stallSteps = 0;              // leash taut but dog not moving
  private lastInspect = 0;

  /** Leash: a capped horizontal spring pulling the "collar" (front of the
   * trunk) toward the anchor point — the interactive form of the reference
   * implementation's external-pull force. Runs every control step. */
  private applyLeash() {
    const xf = this.eng.xfrcApplied;
    const off = 6 * this.anchorBid;
    const drv = this.driver as (BaseDriver & { leashCapable?: boolean }) | null;
    if (!this.leash.on || !drv?.leashCapable) {
      if (!this.hoistOn || this.fsm.state === "policy") {
        xf[off] = 0;
        xf[off + 1] = 0;
        xf[off + 5] = 0;
      }
      return;
    }
    const q = this.eng.qpos, b = drv.bqp;
    const [w, x, y, z] = [q[b + 3], q[b + 4], q[b + 5], q[b + 6]];
    const yaw = Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z));
    const COLLAR = 0.25;                       // m ahead of the base
    const cx = q[b] + Math.cos(yaw) * COLLAR;
    const cy = q[b + 1] + Math.sin(yaw) * COLLAR;
    // The drag policy is delicate: the reference walks under a ~10 N frontal
    // pull and topples at 15 N+, and barely reacts to sideways force at all.
    // So (a) the spring saturates quickly to a ~11 N cap, and (b) like a real
    // dog on a leash, an off-axis pull mostly TURNS the dog (amplified yaw
    // torque) until the pull is frontal — then it walks.
    // Tension profile of a real leash: firm on a planted dog (ignition),
    // near-slack once it walks — the predictor keeps it walking, the leash
    // only steers. A hard constant pull drags the dog off its feet.
    const speed0 = Math.hypot(this.eng.qvel[drv.bqv], this.eng.qvel[drv.bqv + 1]);
    const K = 60, FMAX = speed0 > 0.15 ? 5 : 11, STEER = 5;
    let fx = K * (this.leash.x - cx), fy = K * (this.leash.y - cy);
    const f = Math.hypot(fx, fy);
    if (f > FMAX) { fx *= FMAX / f; fy *= FMAX / f; }
    xf[off] = fx;
    xf[off + 1] = fy;
    const rx = cx - q[b], ry = cy - q[b + 1];
    xf[off + 5] = STEER * (rx * fy - ry * fx);
    // Ignition: the pull-velocity predictor only sustains once the dog is
    // STEPPING (planted feet + static friction read as pr ~ 0). When the
    // leash is taut but the dog is stalled, clear the obs history — the
    // cold-start transient makes the predictor kick off the first steps,
    // the same regime the reference rollout starts in.
    const speed = Math.hypot(this.eng.qvel[drv.bqv], this.eng.qvel[drv.bqv + 1]);
    if (f > 0.85 * FMAX && speed < 0.08) {
      if (++this.stallSteps > 30) {
        // start toward the anchor: forward if it's ahead, turn first if not
        const rel = Math.atan2(this.leash.y - q[b + 1], this.leash.x - q[b]) - yaw;
        const cr = Math.cos(rel), sr = Math.sin(rel);
        // turning is the drag actor's stable axis (forward walking is
        // marginal even in the reference) — start gently, steer decisively
        (drv as unknown as { kick?: (vx: number, wz: number) => void })
          .kick?.(Math.max(0.12, 0.25 * cr), 1.1 * sr);
        this.stallSteps = -60;                 // ~1.2 s cooldown
      }
    } else if (this.stallSteps > 0) this.stallSteps = 0;
  }

  /** Overhead hoist: vertical suspension & posture stabilization.
   * Runs every physics substep at 500–2000 Hz.
   * In Stance/Damping/ZeroTorque: holds nominal standing height and upright posture.
   * In Policy: acts as a safety tether that engages only if the robot begins falling. */
  private applyHoist() {
    const xf = this.eng.xfrcApplied;
    const off = 6 * this.hoistBid;
    const leashHere = this.leash.on && this.hoistBid === this.anchorBid;
    const slack = () => {                     // release the hoist (keep a leash on the same body)
      xf[off + 2] = 0; xf[off + 3] = 0; xf[off + 4] = 0;
      if (!leashHere) { xf[off] = 0; xf[off + 1] = 0; xf[off + 5] = 0; }
    };
    if (!this.hoistOn) return slack();

    const bqp = this.driver?.bqp ?? this.baseAddr;
    const bqv = this.driver?.bqv ?? this.baseVaddr;
    const q = this.eng.qpos, qv = this.eng.qvel;
    const z = q[bqp + 2], vz = qv[bqv + 2];
    const mass = this.eng.totalMass;
    const g = 9.81;

    const isPolicy = this.fsm.state === "policy";
    // In Policy mode, only catch if robot falls below fall threshold (~0.48m),
    // never interfering with normal walking stride height dips (0.65-0.78m)
    const catchZ = Math.min(0.48, this.hoistZ - 0.25);
    const targetZ = isPolicy ? catchZ : this.hoistZ;

    // Safety tether is completely slack when policy is walking upright,
    // or executing ground-start / squat / jump maneuvers
    if (isPolicy && (z >= targetZ || this.driver?.groundStart || this.driver?.maneuver)) return slack();

    // Vertical suspension force (spring + damping + gravity compensation)
    const Kz = 20.0 * mass;
    const Dz = 2.5 * mass;
    const f = [0, 0, Math.max(0, Kz * (targetZ - z) - Dz * vz + mass * g)];

    // Posture stabilization torques (roll/pitch upright restoration)
    const Krot = 5.0 * mass;
    const Drot = 0.7 * mass;
    const [w, x, y] = [q[bqp + 3], q[bqp + 4], q[bqp + 5]];
    const [wx, wy, wz] = [qv[bqv + 3], qv[bqv + 4], qv[bqv + 5]];
    const t = [-Krot * (2.0 * w * x) - Drot * wx, -Krot * (2.0 * w * y) - Drot * wy, 0];

    if (!leashHere) {
      t[2] = -Drot * wz;
      if (!isPolicy) {
        const home = this.driver?.homeXY ?? [0, 0];
        const Kxy = 5.0 * mass, Dxy = 1.5 * mass;
        f[0] = -Kxy * (q[bqp] - home[0]) - Dxy * qv[bqv];
        f[1] = -Kxy * (q[bqp + 1] - home[1]) - Dxy * qv[bqv + 1];
      }
    }
    // xfrc_applied acts at the body COM: holding the robot at the hoist point p adds (p - com) x f
    const p = this.hoistPoint(), c = this.eng.xipos, cb = 3 * this.hoistBid;
    const r = [p[0] - c[cb], p[1] - c[cb + 1], p[2] - c[cb + 2]];
    t[0] += r[1] * f[2] - r[2] * f[1];
    t[1] += r[2] * f[0] - r[0] * f[2];
    t[2] += r[0] * f[1] - r[1] * f[0];
    xf[off + 2] = f[2]; xf[off + 3] = t[0]; xf[off + 4] = t[1];
    if (!leashHere) { xf[off] = f[0]; xf[off + 1] = f[1]; xf[off + 5] = t[2]; }
  }

  /** World position of the hoist point (spec hoist_body + hoist_offset). */
  private hoistPoint(): [number, number, number] {
    const b = this.hoistBid, o = this.hoistOff, xp = this.eng.xpos, R = this.eng.xmat;
    const m = 9 * b;
    return [xp[3 * b] + R[m] * o[0] + R[m + 1] * o[1] + R[m + 2] * o[2],
            xp[3 * b + 1] + R[m + 3] * o[0] + R[m + 4] * o[1] + R[m + 5] * o[2],
            xp[3 * b + 2] + R[m + 6] * o[0] + R[m + 7] * o[1] + R[m + 8] * o[2]];
  }

  async init(m: Extract<ToWorker, { t: "init" }>, epoch = loadingEpoch) {
    if (epoch !== loadingEpoch) return;
    stopLoading?.();
    releasePrepared?.();
    loadingGeneration = m.loadingId;
    const generation = m.loadingId;
    const assets = m.catalogue && generation !== undefined ? new PreparedAssets() : undefined;
    releasePrepared = assets ? usePreparedAssets(assets) : undefined;
    stopLoading = generation === undefined ? undefined : observeTransfers(`worker:${generation}`, updates => {
      post({ t: 'loading', generation, updates });
    });
    post({ t: "busy", msg: "loading imported policy packs…" });
    this.packs = await listPacks();
    try {
      this.packs = await installDefaultPacks(this.packs, msg => post({ t: 'busy', msg }),
        assets ? url => assets.prepare(url) : undefined);
    } catch (error) {
      // A failed download must not prevent browsing maps or using manual packs.
      // Leave the marker unset so the next visit retries, keeping partial imports.
      console.warn('Default policies could not be installed; reload to retry.', error);
      this.packs = await listPacks();
    }
    if (isTerrain(m.terrain)) this.terrain = m.terrain;
    if(m.localMap){if(m.localMap.id!==mapId(this.terrain))throw new Error('The selected map source does not match the requested terrain.');this.activeMap=registerLocalMap(m.localMap);}
    this.activeMap=mapSource(this.terrain);
    const entries = this.allEntries();
    const robots = [...new Set(entries.map((e) => e.robot))].filter((r) => r in SPECS);
    const robot = m.robot && m.robot in SPECS ? m.robot
      : robots.includes("r1") ? "r1" : (robots[0] ?? "r1");
    const selection = selectRobotPolicy(robot, entries, m.policy, m.robotExplicit);
    this.robot = selection.robot;
    this.policies = selection.policies;
    this.polIdx = -1;
    const first = selection.index;
    if (epoch !== loadingEpoch) return;

    let preparedEngine: PreparedEngine | undefined;
    let preparedConfig: PromiseSettledResult<EvalConfig> | undefined;
    if (assets && m.catalogue && generation !== undefined) {
      post({ t: 'busy', msg: 'Planning selected scene assets…' });
      const catalogue = m.catalogue;
      const entry = this.policies[first];
      const selected = entry ? this.packs.find(pack => pack.id === entry.packId) : undefined;
      const downloadUrl = selected?.downloadUrl;
      const downloadKey = downloadUrl ? httpAssetKey(downloadUrl) : null;
      // Local packs already have their real bytes. Unknown hosted packs must be
      // downloaded and resolved now, so their actual external dependencies are known.
      if (entry && (!downloadKey || catalogue.sizes[downloadKey] === undefined || this.configs.has(entry.name))) {
        preparedConfig = await (async () => {
          if (downloadUrl) await assets.prepare(downloadUrl);
          return this.cfgFor(entry);
        })().then(
          value => ({ status: 'fulfilled' as const, value }),
          reason => ({ status: 'rejected' as const, reason }),
        );
      }
      if (epoch !== loadingEpoch || generation !== loadingGeneration) return;
      const spec = getSpec(this.robot), source = this.activeMap;
      const mount = source?.identity ? `/work/maps/${source.identity.fingerprint}` : '/work/map';
      preparedEngine = await Engine.prepare(spec.model_dir, spec.scene,
        source ? { source, mount } : undefined, url => assets.prepare(url));
      if (epoch !== loadingEpoch || generation !== loadingGeneration) return;
      if (preparedConfig?.status === 'rejected') throw preparedConfig.reason;
      const policyUrls = preparedConfig?.status === 'fulfilled'
        ? driverAssetUrls(selectedDriverAssets(preparedConfig.value))
        : selected ? packAssetUrls(selected) : [];
      const roots = [...catalogue.runtime.worker, '/wasm/mujoco.js', '/wasm/mujoco.wasm',
        ...preparedEngine.urls, ...policyUrls, ...(downloadUrl ? [downloadUrl] : []),
        ...(entry ? catalogue.runtime.inference : []), ...assets.snapshot().map(asset => asset.url)];
      const urls = expandAssetUrls(catalogue, roots.filter(url => httpAssetKey(url) !== null));
      for (const url of urls) {
        if (epoch !== loadingEpoch || generation !== loadingGeneration) return;
        if (catalogue.sizes[url] === undefined) await assets.prepare(url);
      }
      if (epoch !== loadingEpoch || generation !== loadingGeneration) return;
      const waiting = startupGate.wait(generation);
      post({ t: 'loadingPlan', plan: { generation, token: waiting.token, robot: this.robot,
        policy: entry?.name ?? null, pack: entry?.packId ?? null, inference: !!entry,
        urls, prepared: assets.snapshot() } });
      if (!await waiting.ready || epoch !== loadingEpoch || generation !== loadingGeneration) return;
    }

    post({ t: "busy", msg: "compiling MuJoCo model (wasm)…" });
    if (this.policies.length) {
      // Only config/download work is engine-independent. Drain both before releasing
      // the worker queue, retaining model errors even if the selected policy fails too.
      const [engine, prepared] = await Promise.allSettled([
        this.buildEngine(preparedEngine), preparedConfig
          ? preparedConfig.status === 'fulfilled' ? preparedConfig.value : Promise.reject(preparedConfig.reason)
          : this.cfgFor(this.policies[first]),
      ]);
      if (engine.status === "rejected") throw engine.reason;
      await this.loadDriver(first, true, prepared);
    } else {
      await this.buildEngine(preparedEngine);
      this.driver = null;
      await releasePolicySessions();
    }
    this.fsm.enter("policy");
    this.busy = false;
    post({ t: "ready" });
    this.sendStatus();
    void this.controlLoop();
  }

  /** Every imported pack entry, unfiltered. */
  private allEntries(): PolicyEntry[] {
    return this.packs.flatMap(packEntries);
  }

  /** Policy list for the active robot FAMILY (r1 covers r1_air, g1 covers g1_air). */
  private rebuildPolicies() {
    this.policies = this.allEntries().filter((e) => fam(e.robot) === fam(this.robot));
  }


  private async buildEngine(prepared?: PreparedEngine, current=()=>true, compiled?:Engine, identity?:SceneIdentity) {
    const prev = this.eng as Engine | undefined;
    const spec0 = getSpec(this.robot);
    const source = this.activeMap;
    const mount = source?.identity ? `/work/maps/${source.identity.fingerprint}` : '/work/map';
    const next = compiled ?? await Engine.create(spec0.model_dir, terrainTransform(this.terrain, {}, mount), spec0.scene,
                                   source ? { source, mount } : undefined, prepared);
    if(!current()){next.dispose();throw new DOMException('Map loading cancelled.','AbortError');}
    this.eng=next;
    if (prev) {
      // the old driver is bound to the old engine's model/data; every caller
      // reloads one (or runs driverless) — drop it before freeing the wasm side
      this.driver = null;
      prev.dispose();
    }
    this.eng.timestep = getSpec(this.robot).sim_dt;
    this.baseAddr = this.eng.jointQposAdr(getSpec(this.robot).floating_base_joint);
    this.baseVaddr = this.eng.jointDofAdr(getSpec(this.robot).floating_base_joint);
    this.anchorBid = this.eng.bodyId(getSpec(this.robot).anchor_body);
    const spec = getSpec(this.robot);
    this.hoistBid = spec.hoist_body ? this.eng.bodyId(spec.hoist_body) : this.anchorBid;
    this.hoistOff = spec.hoist_offset ?? [0, 0, 0];
    this.hoistZ = this.eng.qpos[this.baseAddr + 2];
    this.fsm = new SimFSM(this.eng);
    const bodyIds: unknown = Reflect.get(this.eng.model, 'geom_bodyid');
    if (!(bodyIds instanceof Int32Array)) throw new Error('The compiled model has no geometry body IDs.');
    const geometry = createFrameGeometryLayout(bodyIds, this.eng.geomXpos, this.eng.geomXmat);
    this.movingGeomIds = geometry.movingIds;
    post({ t: "model", desc: this.renderModel(identity), geometry: geometry.layout });
  }

  private sceneIdentity(engine:Engine,robot:string,terrain:TerrainName):SceneIdentity {
    const hinges=engine.hinges();
    return {robot,terrain,ngeom:engine.model.ngeom,nq:engine.model.nq,
      baseQadr:engine.jointQposAdr(getSpec(robot).floating_base_joint),
      hinges:hinges.names.map((name,i)=>({name,qadr:hinges.qadr[i]}))};
  }

  /** Copy the geom/mesh tables out of wasm memory for the renderer. */
  private renderModel(identity=this.sceneIdentity(this.eng,this.robot,this.terrain)): RenderModel {
    const m = this.eng.model as any;
    const ngeom = this.eng.model.ngeom;
    const geomType: Int32Array = m.geom_type;
    const dataid = Int32Array.from(m.geom_dataid as Int32Array);
    const meshes: RenderModel["meshes"] = {};
    const vertadr: Int32Array = m.mesh_vertadr, vertnum: Int32Array = m.mesh_vertnum;
    const faceadr: Int32Array = m.mesh_faceadr, facenum: Int32Array = m.mesh_facenum;
    const vert: Float32Array = m.mesh_vert, face: Int32Array = m.mesh_face;
    const mpos: Float64Array = m.mesh_pos, mquat: Float64Array = m.mesh_quat;
    for (let g = 0; g < ngeom; g++) {
      const mid = dataid[g];
      if (geomType[g] === GEOM_MESH && mid >= 0 && !(mid in meshes)) {
        const name = this.eng.mj.mj_id2name(this.eng.model, this.eng.mj.mjtObj.mjOBJ_MESH.value, mid) ?? '';
        meshes[mid] = {
          name,
          vert: vert.slice(3 * vertadr[mid], 3 * (vertadr[mid] + vertnum[mid])),
          face: Uint32Array.from(
            face.subarray(3 * faceadr[mid], 3 * (faceadr[mid] + facenum[mid]))),
          pos: [mpos[3 * mid], mpos[3 * mid + 1], mpos[3 * mid + 2]],
          quat: [mquat[4 * mid], mquat[4 * mid + 1], mquat[4 * mid + 2], mquat[4 * mid + 3]],
        };
      }
    }
    return {
      ...identity,
      type: Int32Array.from(geomType),
      size: Float64Array.from(m.geom_size as Float64Array),
      rgba: Float32Array.from(m.geom_rgba as Float32Array),
      group: Int32Array.from(m.geom_group as Int32Array),
      contype: Int32Array.from(m.geom_contype as Int32Array),
      bodyid: Int32Array.from(m.geom_bodyid as Int32Array),
      dataid, meshes,
      bodyFrames: { parent: Int32Array.from(m.body_parentid), pos: Float64Array.from(m.body_pos), quat: Float64Array.from(m.body_quat) },
      geomFrames: { pos: Float64Array.from(m.geom_pos), quat: Float64Array.from(m.geom_quat) },
      bodyNames: Array.from({ length: this.eng.model.nbody }, (_, i) =>
        this.eng.mj.mj_id2name(this.eng.model, this.eng.mj.mjtObj.mjOBJ_BODY.value, i) ?? ''),
    };
  }

  private async cfgFor(entry: PolicyEntry): Promise<EvalConfig> {
    let c = this.configs.get(entry.name);
    if (!c) {
      const index = this.packs.findIndex(pack => pack.id === entry.packId);
      if (index < 0) throw new Error(`imported pack ${entry.packId} not found`);
      const pack = await loadPack(entry.packId, this.packs[index]);
      const { files: _files, ...metadata } = pack;
      this.packs[index] = metadata;
      c = resolvePackConfig(pack, entry);
      this.configs.set(entry.name, c);
    }
    return c;
  }

  async loadDriver(idx: number, keepModel = false, prepared?: PromiseSettledResult<EvalConfig>) {
    this.busy = true;
    const entry = this.policies[idx];
    post({ t: "busy", msg: `loading ${entry.name}…` });
    try {
      // a family spans specs: adopt the policy's own spec so joint subset / gains / fall height match
      // (r1 ↔ r1_air_edu share the compiled model; r1 ↔ r1_air and g1 ↔ g1_air recompile — EDU vs Air)
      const want = specFor(entry, this.robot, keepModel);
      if (want !== this.robot) {
        const rebuild = modelKey(getSpec(want)) !== modelKey(getSpec(this.robot));
        this.robot = want;
        if (rebuild) {
          const label = want === "g1_air" ? "G1 Air 23-DOF" : want === "r1_air" ? "R1 Air 20-DOF" : want;
          post({ t: "busy", msg: `compiling MuJoCo model (wasm, ${label})…` });
          await this.buildEngine();
          post({ t: "busy", msg: `loading ${entry.name}…` });
        }
      }
      if (prepared?.status === "rejected") throw prepared.reason;
      const cfg = prepared?.status === "fulfilled" ? prepared.value : await this.cfgFor(entry);
      // launch the new policy where the robot currently stands, not at the
      // origin — Recenter (C) is the explicit way back to the middle
      const b = this.eng.jointQposAdr(getSpec(this.robot).floating_base_joint);
      const here: [number, number] = [this.eng.qpos[b], this.eng.qpos[b + 1]];
      this.driver = await makeDriver(cfg, getSpec(this.robot), this.eng);
      this.driver.homeXY = here;
      this.polIdx = idx;
      this.command = [0, 0, 0];
      this.cmdNow = [0, 0, 0];
      this.driver.reset();
      this.hoistZ = (this.driver.groundStart || this.driver.maneuver)
        ? (fam(this.robot) === "g1" ? 0.78 : getSpec(this.robot).fall_height + 0.3)
        : this.eng.qpos[this.driver.bqp + 2];
      post({ t: "ready" });
    } catch (e) {
      console.error(e);
      post({ t: "error", msg: `failed to load ${entry.name}: ${e}` });
    } finally {
      this.busy = false;
      this.sendStatus();
    }
  }

  /** The running policy is done (end of a clip / get-up): continue with the config's `g1.next_policy`
   * like the robot's FSM auto-switch, WITHOUT re-seating — the new driver starts from the current pose. */
  private async handover(cfg: EvalConfig | undefined) {
    const drv = this.driver!;
    drv.done = false;                       // only try once per completion
    // a driver may name the policy itself (R1 firmware remote switch, r1_fw.ts), else the config's next_policy
    const want = (drv as { nextPolicy?: string }).nextPolicy;
    (drv as { nextPolicy?: string }).nextPolicy = undefined;
    const next = want ?? cfg?.g1?.next_policy ?? (cfg?.r1?.next_policy as string | undefined);
    const idx = next ? this.policies.findIndex((p) => p.name === next) : -1;
    if (idx < 0) return;                    // next policy not imported: keep running this one
    const qpos = Float64Array.from(this.eng.qpos), qvel = Float64Array.from(this.eng.qvel);
    const eng = this.eng;
    await this.loadDriver(idx, true);       // reset() clears the new driver's history but re-seats…
    if (this.eng === eng) {                 // (unless the model had to change: then it stays re-seated)
      this.eng.qpos.set(qpos); this.eng.qvel.set(qvel);   // …so put the robot back where it was
      this.eng.forward();
    }
    if (this.driver) {
      this.hoistZ = this.eng.qpos[this.driver.bqp + 2];
      post({ t: "notice", msg: `${drv.name} finished → ${next}` });
      this.autoPolicy = next;               // reached by hand-over: don't pop its how-to notice
    }
  }

  /** Preflight an explicit robot selection before touching the active engine or driver.
   * An empty family keeps the existing idle-preview/manual-pack flow. Callers reenter(). */
  private async setRobot(robot: string) {
    const selection = selectRobotPolicy(robot, this.allEntries(), undefined, true);
    const prevKey = modelKey(getSpec(this.robot));
    this.playback = null;
    this.robot = selection.robot;
    this.policies = selection.policies;
    this.polIdx = -1;
    if (modelKey(getSpec(this.robot)) !== prevKey) {
      this.busy = true;
      post({ t: "busy", msg: "compiling MuJoCo model (wasm)…" });
      await this.buildEngine();
      this.busy = false;
    }
    if (this.policies.length) await this.loadDriver(selection.index, true);  // posts "ready"
    else { this.driver = null; await releasePolicySessions(); post({ t: "ready" }); }  // idle preview
  }

  private reenter() {
    const st: FsmState = this.fsm.state === "policy" || this.fsm.state === "stance"
      ? this.fsm.state : "policy";
    this.fsm.enter(st);
    this.sendStatus();
  }

  async onMessage(m: ToWorker, current=()=>true) {
    switch (m.t) {
      case "init": return this.init(m);
      case "playback": return this.startPlayback(m.csv, m.fps, m.name);
      case "stopPlayback": return this.stopPlayback();
      case "importPack": return this.doImportPack(m.zip);
      case "deletePack": return this.doDeletePack(m.id);
      case "deleteAllPacks": return this.doDeleteAllPacks();
      case "inspect": this.inspectOn = m.on; return;
      case 'viewReady': post({t:'viewReady',request:m.request,robot:this.robot,terrain:this.terrain});return;
      case "pause":
        this.paused = m.on;
        this.noclipVelocity = [0, 0, 0];
        return;
      case "noclip":
        this.noclip = m.on;
        this.noclipVelocity = [0, 0, 0];
        this.playback = null;
        this.command = this.cmdNow = [0, 0, 0];
        if (!this.busy) {
          this.eng.qvel.fill(0);
          this.eng.forward();
          this.prevCmd = null;
          this.fsm.enter(this.fsm.state);
          this.hoistZ = this.eng.qpos[(this.driver?.bqp ?? this.baseAddr) + 2];
          if (this.driver) this.driver.homeXY = [this.eng.qpos[this.driver.bqp], this.eng.qpos[this.driver.bqp + 1]];
        }
        return;
      case "noclipStep": {
        if (!this.noclip || this.busy || this.paused || !m.delta.every(Number.isFinite)) return;
        const b = this.driver?.bqp ?? this.baseAddr;
        if (b >= 0) for (let i = 0; i < 3; i++) this.eng.qpos[b + i] += m.delta[i];
        return;
      }
      case "noclipMove":
        if (m.velocity.every(Number.isFinite)) this.noclipVelocity = m.velocity;
        return;
      case 'placeRobot': {
        if (this.busy || this.paused || !this.noclip || !m.position.every(Number.isFinite) || !Number.isFinite(m.yaw)) {
          post({ t: 'robotPlacementFailed', msg: 'The simulation is not ready to place the robot. Try again when loading finishes.' }); return;
        }
        const b = this.driver?.bqp ?? this.baseAddr;
        if (b < 0) return;
        this.playback = null;
        this.command = this.cmdNow = [0, 0, 0]; this.noclipVelocity = [0, 0, 0];
        if (this.driver) { this.driver.homeXY = [m.position[0], m.position[1]]; this.driver.reset(); }
        else this.eng.resetData();
        this.eng.qpos[b] = m.position[0]; this.eng.qpos[b + 1] = m.position[1];
        this.eng.qpos[b + 3] = Math.cos(m.yaw / 2); this.eng.qpos[b + 4] = this.eng.qpos[b + 5] = 0;
        this.eng.qpos[b + 6] = Math.sin(m.yaw / 2);
        this.eng.forward();
        const feet = getSpec(this.robot).foot_bodies.map(name => this.eng.bodyId(name)).filter(id => id >= 0);
        const floor = this.eng.minGeomZ(feet);
        if (Number.isFinite(floor)) this.eng.qpos[b + 2] += m.position[2] + .02 - floor;
        this.eng.qvel.fill(0); this.eng.qfrcApplied.fill(0); this.eng.forward();
        this.hoistZ = this.eng.qpos[b + 2]; this.hoistOn = false;
        this.prevCmd = null; this.fsm.enter(this.fsm.state);
        this.postFrame(0); post({ t: 'robotPlaced' }); this.sendStatus();
        return;
      }
      case "leash":
        this.leash = { on: m.on, x: m.x ?? this.leash.x, y: m.y ?? this.leash.y };
        return;
      case "hoist":
        this.hoistOn = m.on;
        this.sendStatus();
        return;
      case "policy": {
        this.playback = null;
        const idx = this.policies.findIndex((e) => e.name === m.name);
        if (idx >= 0) { this.autoPolicy = undefined; await this.loadDriver(idx); this.reenter(); }
        return;
      }
      case "cycle": {
        this.playback = null;
        if (!this.policies.length) return;
        const n = this.policies.length;
        this.autoPolicy = undefined;
        await this.loadDriver((this.polIdx + m.step + n) % n);
        this.reenter();
        return;
      }
      case "state":
        this.playback = null;
        this.fsm.enter(m.state);
        return this.sendStatus();
      case "robot":
        await this.setRobot(m.robot);
        return this.reenter();
      case "terrain": {
        this.busy = true;
        const previous={terrain:this.terrain,source:this.activeMap,robot:this.robot,policies:this.policies,polIdx:this.polIdx,playback:this.playback};
        let compiled:Engine|undefined;
        let selection:RobotPolicySelection|undefined;
        post({ t: "busy", msg: "Preparing map physics…" });
        try {
          let source:MapSource|null,robot:string,scene:SceneIdentity;
          if(m.commit){
            const staged=stagedTerrain;
            if(!staged||staged.request!==m.request||staged.baseRobot!==this.robot||staged.terrain!==m.terrain)
              throw new Error('The prepared scene is no longer available.');
            ({source,robot,scene,selection}=staged);compiled=staged.engine;
            stagedTerrain=undefined;
          }else{
            source=m.localMap?registerLocalMap(m.localMap):mapSource(m.terrain);
            if((source?.id??null)!==mapId(m.terrain))throw new Error('The selected map source does not match the requested terrain.');
            selection=m.robot?selectRobotPolicy(m.robot,this.allEntries(),undefined,true):undefined;
            robot=selection?.robot??this.robot;
            const mount=source?.identity?`/work/maps/${source.identity.fingerprint}`:'/work/map',spec=getSpec(robot);
            compiled=await Engine.create(spec.model_dir,terrainTransform(m.terrain,{},mount),spec.scene,source?{source,mount}:undefined);
            if(!current())throw new DOMException('Map loading cancelled.','AbortError');
            scene=this.sceneIdentity(compiled,robot,m.terrain);
            stagedTerrain?.engine.dispose();
            stagedTerrain={request:m.request,baseRobot:this.robot,robot,terrain:m.terrain,source,engine:compiled,scene,selection};
            post({t:'terrainPrepared',request:m.request,scene});return;
          }
          if(!current())throw new DOMException('Map loading cancelled.','AbortError');
          this.terrain=m.terrain;this.activeMap=source;this.robot=robot;
          if(selection){this.playback=null;this.policies=selection.policies;this.polIdx=selection.index;}
          await this.buildEngine(undefined,()=>true,compiled,scene);
        } catch (error) {
          if(compiled&&this.eng!==compiled)compiled.dispose();
          this.terrain=previous.terrain;this.activeMap=previous.source;this.robot=previous.robot;
          this.policies=previous.policies;this.polIdx=previous.polIdx;this.playback=previous.playback;
          if(stagedTerrain&&stagedTerrain.request===m.request){stagedTerrain.engine.dispose();stagedTerrain=undefined;}
          post({t:'terrainFailed',request:m.request,msg:String(error)});return;
        } finally {this.busy=false;}
        if (this.playback) this.rebindPlayback();
        else if (this.policies.length) await this.loadDriver(this.polIdx,!!selection);
        else {if(selection)await releasePolicySessions();post({t:'ready'});}
        return this.playback ? (post({t:'ready'}),this.sendStatus()) : this.reenter();
      }
      case "command":
        this.command = m.cmd;
        return;
      case "remote":
        this.driver?.remote(m.combo);
        return;
      case "script":
        this.scriptT0 = this.simT;
        this.script = m.steps.map((x) => ({ ...x, at: this.simT + x.at })).sort((a, b) => a.at - b.at);
        this.stick = null;
        return;
      case "reset":
        this.playback = null;
        this.noclipVelocity = [0, 0, 0];
        this.command = [0, 0, 0];
        this.cmdNow = [0, 0, 0];
        if (this.driver) this.driver.reset();
        else this.eng.resetData();
        if (this.driver) {
          this.hoistZ = (this.driver.groundStart || this.driver.maneuver)
            ? (fam(this.robot) === "g1" ? 0.78 : getSpec(this.robot).fall_height + 0.3)
            : this.eng.qpos[this.driver.bqp + 2];
        } else if (this.baseAddr >= 0) this.hoistZ = this.eng.qpos[this.baseAddr + 2];
        this.fsm.enter(this.fsm.state);
        return;
      case "recenter":
        if (this.driver) {
          this.driver.homeXY = [0, 0];   // recenter also re-homes future resets
          this.driver.recenter();
        }
        return;
    }
  }

  // ---- kinematic mocap playback --------------------------------------
  private specForJointCount(nj: number): RobotSpec | undefined {
    return Object.values(SPECS).find((s) => s.joint_names.length === nj);
  }

  /** Resolve base + joint qpos addresses for a spec against the live model. */
  private bindPlayback(spec: RobotSpec, base: Omit<Playback, "bqp" | "jointAddr" | "extraAddr">): Playback {
    const bqp = this.eng.jointQposAdr(spec.floating_base_joint);
    const jointAddr = Int32Array.from(spec.joint_names.map((n) => this.eng.jointQposAdr(n)));
    const driven = new Set(spec.joint_names);
    const h = this.eng.hinges();
    const extra: number[] = [];
    h.names.forEach((nm, i) => { if (!driven.has(nm)) extra.push(h.qadr[i]); });
    return { ...base, bqp, jointAddr, extraAddr: Int32Array.from(extra) };
  }

  private rebindPlayback() {
    if (!this.playback) return;
    const spec = this.specForJointCount(this.playback.njoints);
    if (spec) this.playback = this.bindPlayback(spec, this.playback);
  }

  async startPlayback(csv: string, fps: number, name: string) {
    const parsed = parseTrajCsv(csv);
    if (!parsed) {
      return post({ t: "error", msg: `${name}: could not parse a numeric CSV` });
    }
    const { nCols } = parsed;
    const njoints = nCols - 7;
    const spec = this.specForJointCount(njoints);
    if (!spec) {
      return post({ t: "error", msg:
        `${name}: ${nCols} columns → ${njoints} joints; expected ` +
        `[pos(3), quat_xyzw(4), joints] with ${Object.values(SPECS)
          .map((s) => s.joint_names.length).join(" or ")} joints` });
    }
    // ensure the compiled model matches the clip's robot (20 joints → the R1 Air model, 24 → EDU)
    if (modelKey(getSpec(this.robot)) !== modelKey(spec)) {
      this.busy = true;
      this.robot = spec.robot;
      post({ t: "busy", msg: "compiling MuJoCo model (wasm)…" });
      await this.buildEngine();
      this.busy = false;
    } else {
      this.robot = spec.robot;
    }
    this.playback = this.bindPlayback(spec,
      { ...parsed, fps: fps > 0 ? fps : 30, njoints, name, t: 0 });
    post({ t: "ready" });
    this.sendStatus();
  }

  private stopPlayback() {
    if (!this.playback) return;
    this.playback = null;
    this.driver?.reset();
    this.reenter();
  }

  // ---- policy pack import/delete --------------------------------------
  private async doImportPack(zip: ArrayBuffer) {
    try {
      const imported = await importAny(new Uint8Array(zip));   // single pack OR bundle
      const curName = this.policies[this.polIdx]?.name;
      for (const pack of imported) {
        revokePack(pack.id);
        for (const e of packEntries(pack)) this.configs.delete(e.name);
        this.packs = this.packs.filter((p) => p.id !== pack.id);   // replace by id
        const { files: _files, ...metadata } = pack;
        this.packs.push(metadata);
      }
      // if the current family has nothing to run, follow the import to its robot
      // (setRobot recompiles the scene if the model differs and loads policy 0)
      if (!this.allEntries().some((e) => fam(e.robot) === fam(this.robot)) &&
          imported[0].manifest.robot in SPECS) {
        await this.setRobot(imported[0].manifest.robot);
        return this.reenter();
      }
      this.rebuildPolicies();
      if (this.driver && curName) {
        const i = this.policies.findIndex((e) => e.name === curName);
        if (i >= 0) {
          this.polIdx = i;
          const wasImported = imported.some((p) => packEntries(p).some((e) => e.name === curName));
          if (wasImported) {
            await this.loadDriver(i);
            return this.reenter();
          }
        }
        post({ t: "ready" });
        this.sendStatus();
      } else if (this.policies.length) {
        await this.loadDriver(0);    // first policy for this family just arrived
        this.reenter();
      } else {
        post({ t: "ready" });
        this.sendStatus();
      }
    } catch (e) {
      console.error(e);
      post({ t: "error", msg: `import failed: ${e instanceof Error ? e.message : e}` });
    }
  }

  private async doDeletePack(id: string) {
    const currentName = this.policies[this.polIdx]?.name;
    const gone = new Set(this.packs.filter((p) => p.id === id).flatMap(packEntries).map((e) => e.name));
    await deletePack(id);
    for (const n of gone) this.configs.delete(n);
    revokePack(id);
    this.packs = this.packs.filter((p) => p.id !== id);
    this.rebuildPolicies();
    // if the active policy vanished, fall back to the first available
    if (this.policies.length) {
      const surviving = this.policies.findIndex(policy => policy.name === currentName);
      if (surviving >= 0) this.polIdx = surviving;
      else {
        this.playback = null;
        await this.loadDriver(Math.min(this.polIdx, this.policies.length - 1));
        this.reenter();
        return;
      }
    } else {
      this.playback = null;
      this.driver = null;
      await releasePolicySessions();
      this.reenter();
      return;
    }
    this.sendStatus();
  }

  private async doDeleteAllPacks() {
    await deleteAllPacks();
    for (const p of this.packs) revokePack(p.id);
    this.configs.clear();
    this.packs = [];
    this.rebuildPolicies();
    this.playback = null;
    this.polIdx = 0;
    this.driver = null;
    await releasePolicySessions();
    this.reenter();
  }

  private playbackStep() {
    const pb = this.playback!;
    const row = sampleTraj(pb.rows, pb.nRows, pb.nCols, pb.t, pb.fps);
    const q = this.eng.qpos;
    q[pb.bqp] = row[0]; q[pb.bqp + 1] = row[1]; q[pb.bqp + 2] = row[2];
    const wq = wxyz([row[3], row[4], row[5], row[6]]);
    q[pb.bqp + 3] = wq[0]; q[pb.bqp + 4] = wq[1]; q[pb.bqp + 5] = wq[2]; q[pb.bqp + 6] = wq[3];
    for (let i = 0; i < pb.njoints; i++) q[pb.jointAddr[i]] = row[7 + i];
    for (let i = 0; i < pb.extraAddr.length; i++) q[pb.extraAddr[i]] = 0;
    this.eng.qvel.fill(0);
    this.eng.forward();
    pb.t += 0.02;                          // 50 fps real-time playback
    if (pb.t >= pb.nRows / pb.fps) pb.t = 0;
  }

  /** Low-passed base velocity in the robot's heading frame (free-joint qvel: linear in world, angular in body). */
  private updateSpeed(dt: number) {
    const qa = this.driver?.bqp ?? this.baseAddr, va = this.driver?.bqv ?? this.baseVaddr;
    const q = this.eng.qpos, v = this.eng.qvel;
    const [w, x, y, z] = [q[qa + 3], q[qa + 4], q[qa + 5], q[qa + 6]];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const now: [number, number, number] = [c * v[va] + s * v[va + 1], -s * v[va] + c * v[va + 1], v[va + 5]];
    const a = Math.min(1, dt / 0.5);
    for (let i = 0; i < 3; i++) this.speed[i] += a * ((Number.isFinite(now[i]) ? now[i] : 0) - this.speed[i]);
  }

  private sendStatus() {
    const e = this.policies[this.polIdx];
    post({
      t: "status",
      // one selectable entry per FAMILY (r1 covers r1_air; the loaded policy
      // decides the exact spec)
      robots: [...new Set(Object.keys(SPECS).map(fam))],
      robot: fam(this.robot),
      policies: this.policies.map((p) => ({
        name: p.name, family: p.family, dof: p.dof,
        group: p.group, packId: p.packId, fsmId: p.fsmId,
        models: fam(p.robot) === "r1" ? r1Models(p) : p.models })),
      packs: this.packs.map((p) => ({
        id: p.id, group: p.manifest.group, robot: p.manifest.robot,
        checkpoints: p.manifest.checkpoints.map((c) => c.id) })),
      policy: e?.name ?? "-",
      family: e?.family ?? "-",
      dof: e?.dof ?? 0,
      state: this.fsm.state,
      command: [...this.cmdNow] as Command,   // what the policy is actually fed
      rtf: this.rtf,
      playback: this.playback?.name,
      model: fam(this.robot) === "g1"
        ? (this.robot === "g1_air" ? "G1 Air · 23-DOF" : "G1 EDU · 29-DOF")
        : fam(this.robot) === "r1"
          ? (this.robot === "r1_air" ? "R1 Air · 20-DOF" : "R1 EDU · 24-DOF") : undefined,
      leash: !!(this.driver as { leashCapable?: boolean } | null)?.leashCapable,
      velRange: this.driver?.needsCommand ? this.driver.velRange : undefined,
      needsCommand: !!this.driver?.needsCommand,
      hoist: this.hoistOn,
      // pad pass-through / G-cycling use the same named controls as the panel buttons
      combos: this.driver?.remoteActions().flatMap((g) => g.items.map((i) => i.combo)),
      speed: [...this.speed] as [number, number, number],
      actions: this.driver?.remoteActions(),
      notice: this.driver && this.driver.name !== this.autoPolicy ? this.driver.cfg.control_ui?.notice : undefined,
    });
  }

  /** apply due scripted stimulus steps (message "script") before this control tick */
  private runScript() {
    while (this.script.length && this.script[0].at <= this.simT + 1e-9) {
      const x = this.script.shift()!;
      if (x.stick) this.stick = x.stick;
      if (x.combo) this.driver?.remote(x.combo);
    }
    if (this.stick && this.driver) {
      const v = this.driver.velRange ?? [-1, 1, -1, 1, -1, 1], [ly, lx, rx] = this.stick;
      this.command = [ly * v[1], -lx * v[3], -rx * v[5]];
    }
  }

  /** Build + post the obs/action inspector snapshot (≤10 Hz, panel-gated). */
  private maybeInspect(now: number) {
    if (!this.inspectOn || now - this.lastInspect < 100) return;
    this.lastInspect = now;
    const drv = this.driver;
    if (this.playback || !drv) {
      post({ t: "inspect", policy: "—", family: "—",
             state: this.playback ? "kinematic playback" : "—",
             baseZ: 0, command: [0, 0, 0], drive: "—", onnxInputs: 1,
             stackDepth: 1, perFrame: 0, terms: [], actions: [],
             playback: !!this.playback, hoist: this.hoistOn });
      return;
    }
    const e = this.policies[this.polIdx];
    const cfg = this.configs.get(e?.name ?? "");
    const frame = drv.lastFrame;
    const perFrame = drv.frameLayout.reduce((s, [, d]) => s + d, 0);
    const terms: { name: string; dim: number; vals: number[] }[] = [];
    if (frame && frame.length >= perFrame && perFrame > 0) {
      let off = 0;
      for (const [name, dim] of drv.frameLayout) {
        terms.push({ name, dim, vals: Array.from(frame.subarray(off, off + Math.min(dim, 6))) });
        off += dim;
      }
    }
    const act = drv.lastAction;
    post({
      t: "inspect",
      policy: e?.name ?? "-",
      family: e?.family ?? "-",
      state: this.fsm.state,
      baseZ: this.eng.qpos[drv.bqp + 2],
      baseXY: [this.eng.qpos[drv.bqp], this.eng.qpos[drv.bqp + 1]],
      baseQuat: [this.eng.qpos[drv.bqp + 3], this.eng.qpos[drv.bqp + 4], this.eng.qpos[drv.bqp + 5],
                 this.eng.qpos[drv.bqp + 6]],
      simT: this.simT, scriptT0: this.scriptT0,
      hoist: this.hoistOn,
      lidar: (() => {
        const v = drv as { lastHmap?: Float32Array | null;
                           lidarDims?: { nx: number; ny: number } };
        return v.lastHmap && v.lidarDims
          ? { ...v.lidarDims, grid: Array.from(v.lastHmap) } : undefined;
      })(),
      command: [...this.cmdNow] as Command,   // what the policy is actually fed
      drive: (drv.clipDriven ? "clip"
        : (drv as { leashCapable?: boolean }).leashCapable ? "leash pull"
        : drv.needsCommand ? "command" : "—")
        + ((drv as { activeNet?: string }).activeNet ? ` · ${(drv as { activeNet?: string }).activeNet}` : ""),
      onnxInputs: (cfg?.policy?.onnx_inputs as number) ?? 1,
      stackDepth: drv.stackDepth,
      perFrame,
      terms,
      actions: drv.actJointNames.map((n, i) => ({ name: n, value: act?.[i] ?? 0 })),
      playback: false,
    });
  }

  /** Post the scene state after a step of `dt` simulated seconds. */
  private postFrame(dt: number) {
    this.clock += dt;
    const xpos = new Float32Array(this.movingGeomIds.length*3);
    const xmat = new Float32Array(this.movingGeomIds.length*9);
    copyMovingGeometry(this.movingGeomIds, this.eng.geomXpos, this.eng.geomXmat, xpos, xmat);
    const qpos = Float64Array.from(this.eng.qpos);
    const b = this.playback?.bqp ?? this.driver?.bqp ?? this.baseAddr;
    const hoistAnchor: [number, number, number] | null = this.hoistOn
      ? this.hoistPoint()
      : null;
    post({ t: "frame", xpos, xmat,
           baseX: this.eng.qpos[b], baseY: this.eng.qpos[b + 1],
           hoistAnchor, clock: this.clock, qpos },
         [xpos.buffer, xmat.buffer, qpos.buffer]);
  }

  private lastControlStatus = 0;

  private async controlStep(): Promise<number> {
    let lastStatus = this.lastControlStatus;
    try {
      if (this.busy || this.paused) return 50;
      if (this.noclip) {
        const t0 = performance.now(), dt = 0.02;
        const b = this.driver?.bqp ?? this.baseAddr;
        if (b >= 0) {
          for (let i = 0; i < 3; i++) this.eng.qpos[b + i] += this.noclipVelocity[i] * dt;
          this.eng.qvel.fill(0);
          this.eng.forward(); // kinematic movement: no gravity, contacts, or policy steps
        }
        this.postFrame(dt);
        this.maybeInspect(t0);
        if (t0 - lastStatus > 400) { this.sendStatus(); lastStatus = t0; }
        return Math.max(20 - (performance.now() - t0), 0);
      }
      if (this.playback) {
        const t0 = performance.now();
        this.playbackStep();
        this.postFrame(0.02);
        this.maybeInspect(t0);
        if (t0 - lastStatus > 400) { this.sendStatus(); lastStatus = t0; }
        return Math.max(20 - (performance.now() - t0), 0);
      }
      const cfg = this.driver ? this.configs.get(this.policies[this.polIdx]?.name) : undefined;
      const stepDt = cfg?.control.step_dt ?? 0.02;
      const simDt = cfg?.control.sim_dt ?? getSpec(this.robot).sim_dt;
      if (this.eng.timestep !== simDt) this.eng.timestep = simDt;
      const nSub = Math.max(1, Math.round(stepDt / simDt));
      const t0 = performance.now();
      this.runScript();

      // every driver shapes the command itself the way its firmware does (ramps / low-passes), so the worker
      // hands the requested command straight through
      const cmd: Command = this.driver?.needsCommand
        ? (this.cmdNow = [...this.command] as Command) : (this.cmdNow = [0, 0, 0]);
      try {
        if (this.driver?.done) await this.handover(cfg);
        const target = this.driver ? await this.fsm.infer(this.driver, cmd) : null;
        this.applyLeash();
        // command latency (config control.cmd_delay, s): the previous target / gains stay on the motors for the
        // first substeps of the period, like the robot's lowcmd → motor path (Go2 bench: ~5 ms)
        const drv = this.driver, prev = this.prevCmd;
        const dly = drv ? Math.round((cfg?.control.cmd_delay ?? 0) / simDt) : 0;
        const cur = drv ? { target, kp: drv.kp, kd: drv.kd } : null;
        for (let s = 0; s < nSub; s++) {
          this.applyHoist();
          if (drv && cur && s < dly && prev) { drv.kp = prev.kp; drv.kd = prev.kd; this.fsm.substepTorque(drv, prev.target); drv.kp = cur.kp; drv.kd = cur.kd; }
          else this.fsm.substepTorque(drv, target);
          this.eng.step();
        }
        this.prevCmd = dly && cur ? { target: target && Float64Array.from(target), kp: Float64Array.from(cur.kp), kd: Float64Array.from(cur.kd) } : null;
      } catch (e) {
        console.error(e);
        post({ t: "error", msg: `sim step failed: ${e}` });
        this.fsm.enter("damping");
      }
      this.simT += stepDt;
      this.updateSpeed(stepDt);
      this.postFrame(stepDt);
      this.maybeInspect(t0);
      const elapsed = performance.now() - t0;
      this.rtf = 0.9 * this.rtf + 0.1 * (stepDt * 1000 / Math.max(elapsed, 1e-3));
      if (t0 - lastStatus > 400) { this.sendStatus(); lastStatus = t0; }
      return Math.max(stepDt * 1000 - elapsed, 0);
    } finally { this.lastControlStatus = lastStatus; }
  }

  private async controlLoop() {
    for (;;) {
      let delay = 50;
      // The same queue also owns model/driver changes. Inference may await, so
      // a busy flag alone cannot keep a rebuild from freeing its live model.
      await serializeWork(async () => { delay = await this.controlStep(); });
      await sleep(delay);
    }
  }
}

const sim = new SimWorker();
// Keep messages and asynchronous control periods in one order. A model, driver
// or playback change cannot overtake an outstanding inference using its state.
let chain: Promise<void> = Promise.resolve();
function serializeWork(task: () => void | Promise<void>) {
  chain = chain.then(task).catch((e) => {
    // no model bundle on disk is the expected state of a fresh checkout, not a
    // failure — surface it as a friendly notice, don't spam the console red.
    if (e instanceof MissingBundleError) {
      sim.busy = false;
      post({ t: "notice", msg:
        "No robot models loaded yet.\n\n" +
        "Add MJCF and meshes under public/assets/models/<robot>/, " +
        "then run scripts/index_model_assets.mjs for its scene. " +
        "See the README “Robot models” section." });
      return;
    }
    console.error(e);
    post({ t: "error", msg: String(e) });
  });
  return chain;
}
self.onmessage = (ev: MessageEvent<ToWorker>) => {
  // Planning barriers and observation cleanup cannot queue behind init's wait.
  if (ev.data.t === 'loadingProceed') {
    startupGate.proceed(ev.data.generation, ev.data.token);
    return;
  }
  if (ev.data.t === 'loadingFinished') {
    finishLoading(ev.data.generation);
    return;
  }
  if (ev.data.t === 'init') {
    const message = ev.data, epoch = ++loadingEpoch;
    startupGate.cancel();
    void serializeWork(() => sim.init(message, epoch));
    return;
  }
  if(ev.data.t==='cancelTerrain'){++terrainEpoch;stagedTerrain?.engine.dispose();stagedTerrain=undefined;return;}
  if(ev.data.t==='terrain'){
    const message=ev.data,epoch=++terrainEpoch;
    if(!message.commit){stagedTerrain?.engine.dispose();stagedTerrain=undefined;}
    void serializeWork(()=>epoch===terrainEpoch?sim.onMessage(message,()=>epoch===terrainEpoch):undefined);
    return;
  }
  void serializeWork(() => sim.onMessage(ev.data));
};
