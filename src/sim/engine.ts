/** MuJoCo WASM engine wrapper.
 *
 * Loads the official `mujoco` npm bindings (google-deepmind/mujoco wasm),
 * writes the robot model bundle (scene.xml + robot xml + STL meshes) into the
 * emscripten MEMFS, compiles the model, and exposes the typed-array views and
 * address helpers the drivers/FSM need.
 *
 * All big arrays (qpos, qvel, qfrc_applied, xquat, geom_xpos, geom_xmat) are
 * live views into wasm memory — read/write them directly, no copying.
 */
import type { MainModule, MjModel, MjData } from "mujoco";

// mjtJoint / mjtGeom numeric constants (stable MuJoCo ABI values)
export const JNT_FREE = 0, JNT_BALL = 1, JNT_SLIDE = 2, JNT_HINGE = 3;
export const GEOM_PLANE = 0, GEOM_HFIELD = 1, GEOM_SPHERE = 2, GEOM_CAPSULE = 3,
             GEOM_ELLIPSOID = 4, GEOM_CYLINDER = 5, GEOM_BOX = 6, GEOM_MESH = 7;

/** Thrown when a robot's model bundle isn't present on disk. Not really an
 * error condition — a fresh checkout ships no models — so callers surface it
 * as an informational notice rather than a red error. */
export class MissingBundleError extends Error {
  constructor(readonly modelDir: string) {
    super("No robot models loaded yet");
    this.name = "MissingBundleError";
  }
}

let modulePromise: Promise<MainModule> | null = null;

/** The wasm module is a singleton — model reloads reuse it.
 * The emscripten glue is dynamic-imported from /wasm/ (copied out of
 * node_modules by the postinstall script) because vite cannot statically
 * bundle its worker bootstrap; only the *types* come from the npm package. */
export function mujocoModule(): Promise<MainModule> {
  if (!modulePromise) {
    // native dynamic import, invisible to vite/rollup — the glue lives in
    // public/wasm and must not be transformed by the bundler
    const nativeImport =
      new Function("u", "return import(u)") as (u: string) =>
        Promise<{ default: (o?: unknown) => Promise<MainModule> }>;
    modulePromise = nativeImport("/wasm/mujoco.js").then((mod) =>
      mod.default({
        locateFile: (p: string) => (p.endsWith(".wasm") ? "/wasm/mujoco.wasm" : p),
      }));
  }
  return modulePromise;
}

function mkdirTree(FS: MainModule["FS"], path: string) {
  let cur = "";
  for (const seg of path.split("/").filter(Boolean)) {
    cur += "/" + seg;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

export interface HingeSet {
  qadr: Int32Array;    // qpos address per hinge
  vadr: Int32Array;    // dof address per hinge
  lim: Float64Array;   // |torque| limit per hinge (from its actuator, 200 fallback)
  names: string[];
}

export class Engine {
  private constructor(
    readonly mj: MainModule,
    readonly model: MjModel,
    readonly data: MjData,
    readonly modelDir: string,
  ) {}

  /** Fetch every file in the model bundle into MEMFS and compile the scene.
   * `modelDir` is a URL prefix holding manifest.json (list of relative files)
   * and scene.xml. `transformXml` lets terrain presets rewrite the scene. `scene` picks another
   * scene file of the same bundle (the G1 Air model shares the G1 bundle's meshes). */
  static async create(modelDir: string,
                      transformXml?: (name: string, xml: string) => string,
                      scene = "scene.xml"):
      Promise<Engine> {
    const mj = await mujocoModule();
    const manifest: { files: string[] } =
      await fetch(`${modelDir}/manifest.json`).then(async (r) => {
        // A missing file under the dev/preview server is answered with the SPA
        // fallback (index.html, HTTP 200) rather than a 404, so !r.ok never
        // fires and r.json() would blow up with "Unexpected token '<'". Treat a
        // non-JSON body as "bundle absent" and say so clearly.
        const ct = r.headers.get("content-type") ?? "";
        if (!r.ok || !ct.includes("json")) throw new MissingBundleError(modelDir);
        return r.json();
      });
    const root = "/work";
    mkdirTree(mj.FS, root);
    for (const rel of manifest.files) {
      const url = `${modelDir}/${rel}`;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (dir) mkdirTree(mj.FS, `${root}/${dir}`);
      if (rel.endsWith(".xml")) {
        let text = await fetch(url).then((r) => {
          if (!r.ok) throw new Error(
            `bundle file listed in manifest.json is missing: ${rel} (${r.status})`);
          return r.text();
        });
        // threaded model compilation spawns wasm pthreads and then blocks on
        // them, which deadlocks in the browser — force single-threaded compile
        if (text.includes("<compiler "))
          text = text.replace(/<compiler /g, '<compiler usethread="false" ');
        else
          text = text.replace(/(<mujoco[^>]*>)/, '$1\n  <compiler usethread="false"/>');
        if (transformXml) text = transformXml(rel, text);
        mj.FS.writeFile(`${root}/${rel}`, text);
      } else {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(
          `bundle file listed in manifest.json is missing: ${rel} (${resp.status})`);
        const ab: ArrayBuffer = await resp.arrayBuffer();
        mj.FS.writeFile(`${root}/${rel}`, new Uint8Array(ab));
      }
    }
    console.log(`[engine] bundle written (${manifest.files.length} files), compiling`);
    const model = mj.MjModel.mj_loadXML(`${root}/${scene}`);
    console.log(`[engine] model compiled: nq=${model.nq} ngeom=${model.ngeom}`);
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    return new Engine(mj, model, data, modelDir);
  }

  /** Free the wasm-side MjData/MjModel. Every terrain/robot switch compiles a
   * fresh model; without this each one leaked (the G1, with its large mesh
   * set, exhausted the 2 GB wasm heap after a handful of terrain switches:
   * "Could not allocate memory"). The engine is unusable afterwards. */
  dispose() {
    this.rayGid?.delete(); this.rayGid = null;
    (this.data as any).delete?.();
    (this.model as any).delete?.();
  }

  // ---- stepping -------------------------------------------------------
  step() { this.mj.mj_step(this.model, this.data); }
  forward() { this.mj.mj_forward(this.model, this.data); }
  resetData() { this.mj.mj_resetData(this.model, this.data); this.forward(); }

  set timestep(dt: number) { (this.model as any).opt.timestep = dt; }

  // ---- live views -----------------------------------------------------
  get qpos(): Float64Array { return (this.data as any).qpos; }
  get qvel(): Float64Array { return (this.data as any).qvel; }
  get qfrcApplied(): Float64Array { return (this.data as any).qfrc_applied; }
  get xfrcApplied(): Float64Array { return (this.data as any).xfrc_applied; } // nbody*6
  get xpos(): Float64Array { return (this.data as any).xpos; }          // nbody*3
  get xquat(): Float64Array { return (this.data as any).xquat; }       // nbody*4 wxyz
  get xipos(): Float64Array { return (this.data as any).xipos; }       // nbody*3 (COM)
  get xmat(): Float64Array { return (this.data as any).xmat; }         // nbody*9
  get geomXpos(): Float64Array { return (this.data as any).geom_xpos; } // ngeom*3
  get geomXmat(): Float64Array { return (this.data as any).geom_xmat; } // ngeom*9
  get nv(): number { return this.model.nv; }
  get totalMass(): number {
    const sm = (this.model as any).body_subtreemass as Float64Array | undefined;
    if (sm && sm.length > 0 && sm[0] > 0) return sm[0];
    const bm = (this.model as any).body_mass as Float64Array | undefined;
    if (bm) {
      let sum = 0;
      for (let i = 0; i < this.model.nbody; i++) sum += bm[i];
      if (sum > 0) return sum;
    }
    return 35.0;
  }

  // ---- named lookups (accessor handles deleted immediately) -----------
  private withJnt<T>(name: string, f: (a: any) => T): T {
    const a = (this.model as any).jnt(name);
    try { return f(a); } finally { a.delete?.(); }
  }

  jointQposAdr(name: string): number {
    return this.withJnt(name, (a) => Number(a.qposadr[0] ?? a.qposadr));
  }
  jointDofAdr(name: string): number {
    return this.withJnt(name, (a) => Number(a.dofadr[0] ?? a.dofadr));
  }

  bodyId(name: string): number {
    const a = (this.model as any).body(name);
    try { return a.id; } finally { a.delete?.(); }
  }

  /** |ctrlrange[1]| of the actuator driving `<joint>`, trying both `<joint>`
   * (G1) and `<joint>` minus "_joint" (Go2/R1), 200 fallback. */
  actuatorLim(jointName: string): number {
    for (const aname of [jointName, jointName.replace("_joint", "")]) {
      try {
        const a = (this.model as any).actuator(aname);
        try {
          const hi = Math.abs(Number(a.ctrlrange[1]));
          if (hi > 0) return hi;
        } finally { a.delete?.(); }
      } catch { /* try next */ }
    }
    return 200.0;
  }

  /** Every hinge joint in the model with addresses + torque limits. */
  hinges(): HingeSet {
    const m = this.model as any;
    const type: Int32Array = m.jnt_type;
    const qposadr: Int32Array = m.jnt_qposadr;
    const dofadr: Int32Array = m.jnt_dofadr;
    const qadr: number[] = [], vadr: number[] = [], lim: number[] = [], names: string[] = [];
    for (let i = 0; i < this.model.njnt; i++) {
      if (type[i] !== JNT_HINGE) continue;
      const acc = m.jnt(i);
      const name = acc.name as string;
      acc.delete?.();
      qadr.push(qposadr[i]); vadr.push(dofadr[i]);
      lim.push(this.actuatorLim(name)); names.push(name);
    }
    return { qadr: Int32Array.from(qadr), vadr: Int32Array.from(vadr),
             lim: Float64Array.from(lim), names };
  }

  /** Body ids whose geoms matter for drop-seating (all non-world bodies). */
  allBodyIds(): number[] {
    return Array.from({ length: this.model.nbody - 1 }, (_, i) => i + 1);
  }

  /** Lowest z over the geoms attached to `bodyIds` (used to seat the robot). */
  minGeomZ(bodyIds: Iterable<number>): number {
    const set = new Set(bodyIds);
    const m = this.model as any;
    const bodyid: Int32Array = m.geom_bodyid;
    const contype: Int32Array | undefined = m.geom_contype;
    const conaffinity: Int32Array | undefined = m.geom_conaffinity;
    const geomType: Int32Array | undefined = m.geom_type;
    const geomSize: Float64Array | undefined = m.geom_size;
    const geomRbound: Float64Array | undefined = m.geom_rbound;

    let zmin = Infinity;
    for (let g = 0; g < this.model.ngeom; g++) {
      if (!set.has(bodyid[g])) continue;
      if (contype && conaffinity && contype[g] === 0 && conaffinity[g] === 0) continue;

      let bottom = this.geomXpos[3 * g + 2];
      const type = geomType ? geomType[g] : -1;
      if (type === 2 && geomSize) {
        bottom -= geomSize[3 * g];
      } else if (type === 3 && geomSize) {
        bottom -= geomSize[3 * g] + geomSize[3 * g + 1];
      } else if (type === 6 && geomSize) {
        bottom -= geomSize[3 * g + 2];
      } else if (geomRbound && geomRbound[g] > 0) {
        bottom -= geomRbound[g];
      }
      zmin = Math.min(zmin, bottom);
    }
    return zmin === Infinity ? 0 : zmin;
  }

  /** A scratch MjData on the same model (reference poses for motion tracking). */
  makeScratchData(): MjData { return new this.mj.MjData(this.model); }
  forwardData(d: MjData) { this.mj.mj_forward(this.model, d); }

  // ---- ray casting (LIDAR emulation) ----------------------------------
  private rayGid: { GetView(): Int32Array; delete(): void } | null = null;

  /** Cast a ray from `pnt` along `vec`; `geomgroup` is a 6-slot 0/1 mask of
   * geom groups the ray may hit. Returns the distance to the first hit and
   * the geom id, or dist<0 / geom -1 on a miss. */
  ray(pnt: number[], vec: number[], geomgroup: number[]): { dist: number; geom: number } {
    const mj = this.mj as any;
    if (!this.rayGid) this.rayGid = new mj.IntBuffer(1);
    const dist: number = mj.mj_ray(this.model, this.data, pnt, vec, geomgroup,
                                   1, -1, this.rayGid, null);
    return { dist, geom: this.rayGid!.GetView()[0] };
  }
}
