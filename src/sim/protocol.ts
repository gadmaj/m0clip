/** Message protocol between the UI (main thread) and the sim worker.
 *
 * The whole simulation — MuJoCo wasm, onnxruntime, drivers, FSM — lives in a
 * Web Worker. This is not just a performance nicety: MuJoCo's model compiler
 * spawns pthreads (wasm workers) and *blocks* waiting for them, which
 * deadlocks the browser main thread; inside a worker, blocking is legal and
 * the pthread pool boots fine.
 */
import type { Command, RemoteActionGroup } from "../core/types";
import type { TransferUpdate } from "../loading/transfers";
import type { FsmState } from "./fsm";
import type { TerrainName } from "./terrain";
import type { FrameGeometryLayout } from './geometry-frames';
import type { StartupAssetCatalogue, WorkerAssetPlan } from '../loading/asset-plan';

// ---- main -> worker --------------------------------------------------
export type ToWorker =
  | { t: "init"; robot?: string; robotExplicit?: boolean; terrain?: TerrainName; policy?: string; loadingId?: number; catalogue?: StartupAssetCatalogue }  // explicit robot selection must not fall back to another model
  | { t: 'loadingProceed'; generation: number; token: string }
  | { t: "loadingFinished"; generation: number }
  | { t: "policy"; name: string }
  | { t: "cycle"; step: 1 | -1 }
  | { t: "state"; state: FsmState }
  | { t: "robot"; robot: string }
  | { t: "terrain"; terrain: TerrainName }
  | { t: "command"; cmd: Command }
  | { t: "reset" }
  | { t: "noclip"; on: boolean }
  | { t: "noclipStep"; delta: [number, number, number] } // render-frame displacement in metres
  | { t: "noclipMove"; velocity: [number, number, number] } // world-space m/s
  | { t: 'placeRobot'; position: [number, number, number]; yaw: number } // feet at the selected surface
  | { t: "recenter" }
  | { t: "playback"; csv: string; fps: number; name: string }  // kinematic mocap preview
  | { t: "stopPlayback" }
  | { t: "importPack"; zip: ArrayBuffer }
  | { t: "deletePack"; id: string }
  | { t: "deleteAllPacks" }
  | { t: "inspect"; on: boolean }    // stream live obs/action inspector data
  | { t: "leash"; on: boolean; x?: number; y?: number }  // drag: pull anchor (world xy)
  | { t: "hoist"; on: boolean }      // overhead suspension gantry support
  | { t: "remote"; combo: string }  // remote-controller combo for the active policy (e.g. 505 "R1+Up")
  | { t: 'viewReady'; request: number } // scene-navigation barrier
  | { t: "pause"; on: boolean }     // freeze the control loop (take review: the timeline owns the scene)
  /** scripted stimulus on SIM time (tests / bench replays): at `at` s after receipt set the sticks
   * (ly, lx, rx in [-1, 1], scaled by the active policy's velRange every tick) and / or press a combo */
  | { t: "script"; steps: { at: number; stick?: [number, number, number]; combo?: string }[] };

// ---- worker -> main --------------------------------------------------
/** Everything the renderer needs to build the scene, copied out of the model
 * (typed arrays are structured-clone copies, not wasm views). */
export interface RenderModel {
  terrain?: TerrainName;
  robot: string;           // active robot (r1* / go2 → paint palette, else model rgba)
  ngeom: number;
  type: Int32Array;        // ngeom
  size: Float64Array;      // 3*ngeom
  rgba: Float32Array;      // 4*ngeom
  group: Int32Array;       // ngeom
  contype: Int32Array;     // ngeom (0 = visual-only geom)
  bodyid: Int32Array;      // ngeom (0 = worldbody/terrain)
  dataid: Int32Array;      // ngeom (mesh id or -1)
  /** vert is in MuJoCo's compiled (inertia-centred) mesh frame; pos + quat
   * (mesh_pos / mesh_quat) map it back to the asset file's frame:
   * file = pos + quat * vert. */
  meshes: Record<number, {
    name: string; vert: Float32Array; face: Uint32Array;
    pos: [number, number, number]; quat: [number, number, number, number];
  }>;
  nq: number;
  bodyNames: string[];     // nbody (names the parts of a Blender export)
  /** Compiled local frames let cosmetics reconstruct body poses from recorded geom poses. */
  bodyFrames?: { parent: Int32Array; pos: Float64Array; quat: Float64Array };
  geomFrames?: { pos: Float64Array; quat: Float64Array };
  baseQadr: number;        // floating-base qpos address, -1 when the model has none
  hinges: { name: string; qadr: number }[];   // every hinge joint, model order
}

export interface PolicyInfo {
  name: string; family: string; dof: number; group: string;
  packId: string;            // owning pack (all policies come from packs)
  fsmId?: number;            // ai_sport FSM id on the robot (G1), shown in the picker
  models?: string[];         // G1 / R1 variants it runs on ("air" / "edu"): picker lists Air, Air+EDU, EDU
}

export interface PackInfo {
  id: string; group: string; robot: string; checkpoints: string[];
}

export interface StatusMsg {
  t: "status";
  robots: string[];
  robot: string;
  policies: PolicyInfo[];
  packs: PackInfo[];        // imported packs (for the manager list)
  policy: string;
  family: string;
  dof: number;
  state: FsmState;
  command: Command;
  rtf: number;
  playback?: string;        // clip name when in kinematic-playback mode
  model?: string;           // loaded model variant when a family has several ("G1 Air · 23-DOF", "R1 EDU · 24-DOF")
  leash?: boolean;          // active policy is leash-capable (drag family)
  velRange?: number[];      // active policy's own clamp [vx-,vx+,vy-,vy+,wz-,wz+]
  needsCommand?: boolean;   // driver consumes velocity commands
  hoist?: boolean;          // overhead suspension hoist enabled
  speed?: [number, number, number];  // measured base speed: forward, lateral m/s (heading frame), yaw rad/s
  combos?: string[];        // remote combos the active policy reacts to (trigger buttons / pad pass-through)
  actions?: RemoteActionGroup[];            // the same combos, named and grouped for the panel
  notice?: { title?: string; text: string }; // popup shown when the policy is selected
}

/** Live obs/action inspector snapshot (streamed ~10 Hz while the panel is open). */
export interface InspectMsg {
  t: "inspect";
  policy: string; family: string; state: string;
  baseZ: number; baseXY?: [number, number]; baseQuat?: [number, number, number, number]; simT?: number; scriptT0?: number; command: Command; drive: string;
  hoist?: boolean;
  lidar?: { nx: number; ny: number; grid: number[] };  // occupancy minimap
  onnxInputs: number; stackDepth: number; perFrame: number;
  terms: { name: string; dim: number; vals: number[] }[];   // vals = first 6 of newest frame
  actions: { name: string; value: number }[];               // per driven joint
  playback: boolean;
}

export type FromWorker =
  | { t: "loading"; generation: number; updates: TransferUpdate[] }
  | { t: 'loadingPlan'; plan: WorkerAssetPlan }
  | {t:'viewReady';request:number;robot:string;terrain:TerrainName}
  | { t: 'robotPlaced' }
  | { t: 'robotPlacementFailed'; msg: string }
  | { t: "model"; desc: RenderModel; geometry: FrameGeometryLayout }
  /** Geom rows are ascending original IDs excluding `model.geometry.fixedIds`; qpos is complete.
   * `clock` advances by each posted simulation step, preserving recorded time under load. */
  | { t: "frame"; xpos: Float32Array; xmat: Float32Array; baseX: number; baseY: number;
      hoistAnchor?: [number, number, number] | null; clock: number; qpos: Float64Array }
  | StatusMsg
  | InspectMsg
  | { t: "busy"; msg: string }
  | { t: "ready" }
  | { t: "notice"; msg: string }   // informational (e.g. no model bundle on disk yet)
  | { t: "error"; msg: string };
