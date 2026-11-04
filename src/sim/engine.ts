/** MuJoCo WASM engine wrapper.
 *
 * Loads the official `mujoco` npm bindings (google-deepmind/mujoco wasm),
 * writes the robot model bundle (scene.xml + robot xml + STL meshes) into the
 * emscripten MEMFS, compiles the model, and exposes the typed-array views and
 * address helpers the drivers/FSM need.
 *
 * All big arrays (qpos, qvel, qfrc_applied, xquat, geom_xpos, geom_xmat) are
 * live views into wasm memory — read/write them directly, no copying.
 *
 * `createScene` composes several robots into one model with MJCF `<attach>`.
 * The world is either the primary robot's scene, whose robot keeps its
 * unprefixed names, or a generated minimal world with no robot of its own.
 * Each attached robot gets an `${id}/` prefix. All robots share one
 * MjModel/MjData, contact set, timestep and global `<option>`; each gets an
 * EntityEngine view that scopes names, hinges and clears to its slice.
 */
import type { MainModule, MjModel, MjData } from "mujoco";
import { gunzipSync } from "fflate";
import { fetchAsset } from '../core/prepared-assets';
import type { RobotSpec } from '../core/types';
import type { MapSource } from '../maps/source';
import { authoredOptions, EntityEngine, freeJointRootBody, type SceneEntity } from './entities';

interface BundleManifest { files: string[]; gzipFiles?: string[] }
export interface ExtraBundle { source: MapSource; mount: string }
/** A map bundle whose physics manifest has been read. */
export type PreparedExtra = ExtraBundle & { manifest: BundleManifest };
export interface PreparedEngine {
  modelDir: string;
  scene: string;
  manifest: BundleManifest;
  extra?: PreparedExtra;
  urls: string[];
}

/** One robot in a composed scene. `id` names the entity and, for attached robots, its `${id}/` prefix. */
export interface SceneSlot {
  readonly id: string;
  readonly robot: RobotSpec;
}

/** With a `primary`, that robot's scene is the world (floor, lights, terrain, global options) and
 * `slots` are attached to it. Without one, the world is WORLD_XML and every robot is a slot;
 * no slots at all is an empty world. `extra` (a map) applies either way. */
export interface SceneSpec {
  readonly primary?: SceneSlot;
  readonly slots: readonly SceneSlot[];
  readonly extra?: ExtraBundle;
}

export interface PreparedSlot {
  readonly slot: SceneSlot;
  readonly modelDir: string;
  readonly scene: string;
  readonly manifest: BundleManifest;
}

interface PreparedSceneParts {
  readonly spec: SceneSpec;
  readonly slots: readonly PreparedSlot[];
  /** Every dependency URL once: the world's (primary scene and map) first, then each new attached
   * bundle file. A generated world adds no URL of its own; a local map adds none either. */
  readonly urls: readonly string[];
}

/** The primary robot's scene is the world. Its map, if any, is `base.extra`. */
export interface PreparedRobotScene extends PreparedSceneParts {
  readonly base: PreparedEngine;
}

/** The world is generated: `spec.primary` is absent and no robot bundle is read for it. */
export interface PreparedWorldScene extends PreparedSceneParts {
  readonly base: null;
  readonly extra?: PreparedExtra;
}

/** Metadata for a composed scene: every manifest is read, nothing is compiled.
 * Narrow on `base === null` to tell a generated world from a primary robot's scene. */
export type PreparedScene = PreparedRobotScene | PreparedWorldScene;

/** What a policy driver and its FSM may touch. The root Engine is the whole model (robot mode);
 * an EntityEngine is one robot in a composed scene. Names are the robot's unprefixed names. */
export interface EngineScope {
  readonly engine: Engine;
  readonly prefix: string;
  readonly qpos: Float64Array;
  readonly qvel: Float64Array;
  readonly qfrcApplied: Float64Array;
  readonly xfrcApplied: Float64Array;
  forward(): void;
  jointQposAdr(name: string): number;
  jointDofAdr(name: string): number;
  bodyId(name: string): number;
  actuatorLim(jointName: string): number;
  hinges(): HingeSet;
  /** Bodies this scope may seat or drop (never the world body). */
  allBodyIds(): number[];
  minGeomZ(bodyIds: Iterable<number>): number;
  /** Zero qvel over this scope's dofs. */
  clearVelocity(): void;
  /** Zero qfrc_applied over this scope's dofs. */
  clearAppliedTorque(): void;
  /** Zero xfrc_applied over this scope's bodies. */
  clearAppliedForce(): void;
}

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

/** Remove files written under `mount`, then the directories that held only them. */
function unmountFiles(FS: MainModule["FS"], mount: string, files: Iterable<string>) {
  const dirs = new Set<string>();
  for (const rel of files) {
    try { FS.unlink(`${mount}/${rel}`); } catch { /* A failed mount may not have written this leaf. */ }
    let dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    while (dir) { dirs.add(`${mount}/${dir}`); dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''; }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) { try { FS.rmdir(dir); } catch { /* Remove only empty owned directories. */ } }
  try { FS.rmdir(mount); } catch { /* The failed mount may not have created its root. */ }
}

/** Keep at most four file bodies in flight, but mount in manifest order.
 * Fetches never write to MEMFS; drain them on failure before a caller can retry. */
async function mountFiles(
  files: readonly string[],
  load: (rel: string) => Promise<string | Uint8Array>,
  mount: (rel: string, body: string | Uint8Array) => void,
) {
  const start = async (rel: string) => {
    try {
      return { ok: true as const, body: await load(rel) };
    } catch (error) {
      return { ok: false as const, error };
    }
  };
  const pending = files.slice(0, 4).map(start);
  let next = pending.length;
  try {
    for (const rel of files) {
      const result = await pending.shift()!;
      if (!result.ok) throw result.error;
      mount(rel, result.body);
      if (next < files.length) pending.push(start(files[next++]));
    }
  } finally {
    // Rejections are captured by start, including failures ahead of the cursor.
    await Promise.all(pending);
  }
}

/** Fetch indexed robot bundle files from `modelDir` and write them under `root`. MJCF is forced to
 * compile single-threaded, then transformed; `written` receives each final MJCF text in file order. */
async function mountBundle(FS: MainModule["FS"], root: string, modelDir: string, index: string,
    files: readonly string[], gzipFiles: ReadonlySet<string> | undefined,
    transformXml?: (name: string, xml: string) => string, written?: Map<string, string>) {
  mkdirTree(FS, root);
  await mountFiles(files, async (rel) => {
    const compressed = gzipFiles?.has(rel) === true;
    const file = compressed ? `${rel}.gz` : rel;
    const resp = await fetchAsset(`${modelDir}/${file}`);
    if (!resp.ok) throw new Error(
      `bundle file listed in ${index} is missing: ${file} (${resp.status})`);
    if (rel.endsWith(".xml")) return resp.text();
    const body = new Uint8Array(await resp.arrayBuffer());
    // Match explicit Source atlas gzip: dev hosts may already decode Content-Encoding.
    return compressed && body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  }, (rel, body) => {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (dir) mkdirTree(FS, `${root}/${dir}`);
    if (typeof body === "string") {
      let text = body;
      // threaded model compilation spawns wasm pthreads and then blocks on
      // them, which deadlocks in the browser — force single-threaded compile
      if (text.includes("<compiler "))
        text = text.replace(/<compiler /g, '<compiler usethread="false" ');
      else
        text = text.replace(/(<mujoco[^>]*>)/, '$1\n  <compiler usethread="false"/>');
      if (transformXml) text = transformXml(rel, text);
      written?.set(rel, text);
      FS.writeFile(`${root}/${rel}`, text);
    } else {
      FS.writeFile(`${root}/${rel}`, body);
    }
  });
}

async function readManifest(modelDir: string, scene: string,
    fetchMetadata: (url: string) => Promise<Response>): Promise<{ manifest: BundleManifest; urls: string[] }> {
  const indexUrl = `${modelDir}/${scene}.manifest.json`;
  const response = await fetchMetadata(indexUrl);
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json'))
    throw new MissingBundleError(modelDir);
  const manifest: BundleManifest = await response.json();
  const compressed = new Set(manifest.gzipFiles);
  return { manifest,
    urls: [indexUrl, ...manifest.files.map(rel => `${modelDir}/${rel}${compressed.has(rel) ? '.gz' : ''}`)] };
}

/** Read a map's physics manifest; HTTP maps list their manifest and files as dependencies. */
async function prepareExtra(extra: ExtraBundle,
    fetchMetadata: (url: string) => Promise<Response>): Promise<{ extra: PreparedExtra; urls: string[] }> {
  const map = await extra.source.read('manifest.json', fetchMetadata);
  if (!map.ok) throw new Error(`Map manifest failed: ${extra.source.id}`);
  const manifest: BundleManifest = await map.json();
  if (!Array.isArray(manifest.files) || !manifest.files.includes('map.xml')) throw new Error('Map physics manifest must include map.xml.');
  for (const path of manifest.files) extra.source.path(path);
  return { extra: { ...extra, manifest },
    urls: extra.source.isLocal ? [] : [extra.source.httpUrl('manifest.json'), ...manifest.files.map(rel => extra.source.httpUrl(rel))] };
}

/** Name the generated world is transformed and compiled as, like a robot bundle's top scene. */
const WORLD_SCENE = 'scene.xml';

/** The world of a scene without a primary robot: an infinite ground plane named `floor` (the name
 * and plane type terrainTransform edits) and one light. It authors no `<option>`, so MuJoCo's
 * defaults govern every robot in it: timestep 0.002 s until the owner sets `Engine.timestep`,
 * Euler integrator, Newton solver, pyramidal friction cone, impratio 1. Those are the G1 and R1
 * bundles' own settings; Go2's authored elliptic cone and impratio 100 do not apply here, as they
 * do not when Go2 is attached to a G1 or R1 scene (see SceneEntity.ignoredOptions). The floor uses
 * the G1 and R1 scene floors' friction; Go2's scene floor uses 1 1 1. */
const WORLD_XML = `<mujoco model="m0clip world">
  <compiler usethread="false"/>
  <worldbody>
    <light pos="0 0 3.5" dir="0 0 -1" directional="true"/>
    <geom name="floor" type="plane" size="0 0 0.05" friction="1.5 0.02 0.0005"/>
  </worldbody>
</mujoco>
`;

/** The primary robot's bundle authors the world's options, so none of its own are ignored. */
const NO_OPTIONS: Readonly<Record<string, string>> = Object.freeze({});

const SLOT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

function validateScene(spec: SceneSpec) {
  const ids = new Set<string>();
  for (const { id } of spec.primary ? [spec.primary, ...spec.slots] : spec.slots) {
    if (!SLOT_ID.test(id)) throw new Error(`Scene slot id must start with a letter and use only letters, digits, _ or -: ${id}`);
    if (ids.has(id)) throw new Error(`Duplicate scene slot id: ${id}`);
    ids.add(id);
  }
}

/** Ownership of one robot's kinematic tree in the compiled model, verified rather than assumed. */
function describeEntity(mj: MainModule, model: MjModel, slot: SceneSlot, prefix: string,
    rootBodyName: string, ignoredOptions: Readonly<Record<string, string>>): SceneEntity {
  const rootid: Int32Array = model.body_rootid, qposadr: Int32Array = model.jnt_qposadr, dofadr: Int32Array = model.jnt_dofadr;
  const parentid: Int32Array = model.body_parentid, jointType: Int32Array = model.jnt_type;
  const geomBody: Int32Array = model.geom_bodyid, jointBody: Int32Array = model.jnt_bodyid, dofBody: Int32Array = model.dof_bodyid;
  const bodyType = mj.mjtObj.mjOBJ_BODY.value, jointName = prefix + slot.robot.floating_base_joint;
  const rootBody = mj.mj_name2id(model, bodyType, prefix + rootBodyName);
  if (rootBody <= 0 || parentid[rootBody] !== 0)
    throw new Error(`Scene slot ${slot.id} has no top-level body ${prefix}${rootBodyName}.`);
  const freeJoint = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, jointName);
  if (freeJoint < 0 || jointType[freeJoint] !== JNT_FREE || rootid[jointBody[freeJoint]] !== rootBody)
    throw new Error(`Scene slot ${slot.id} has no free joint ${jointName} in its own tree.`);
  const range = (kind: string, count: number, bodyOf: (i: number) => number): [number, number] => {
    let start = -1, end = -1;
    for (let i = 0; i < count; i++) {
      if (rootid[bodyOf(i)] !== rootBody) continue;
      if (start < 0) start = i;
      else if (i !== end) throw new Error(`Scene slot ${slot.id} ${kind}s are not contiguous.`);
      end = i + 1;
    }
    return start < 0 ? [0, 0] : [start, end];
  };
  const [bodyStart, bodyEnd] = range('body', model.nbody, i => i);
  const [geomStart, geomEnd] = range('geom', model.ngeom, i => geomBody[i]);
  const [jointStart, jointEnd] = range('joint', model.njnt, i => jointBody[i]);
  const [dofStart, dofEnd] = range('dof', model.nv, i => dofBody[i]);
  if (prefix) for (let b = bodyStart; b < bodyEnd; b++) {
    const name = mj.mj_id2name(model, bodyType, b) ?? '';
    if (!name.startsWith(prefix)) throw new Error(`Body ${name} in scene slot ${slot.id} lacks its prefix.`);
  }
  return Object.freeze({
    id: slot.id, robot: slot.robot.robot, prefix, rootBody, rootBodyName, freeJoint, ignoredOptions,
    rootQpos: qposadr[freeJoint], rootDof: dofadr[freeJoint],
    bodyStart, bodyEnd, geomStart, geomEnd, jointStart, jointEnd, dofStart, dofEnd,
    qposStart: qposadr[jointStart], qposEnd: jointEnd < model.njnt ? qposadr[jointEnd] : model.nq,
  });
}

/** Each composed compile writes attached bundles under its own MEMFS root. */
let sceneMounts = 0;

export interface HingeSet {
  qadr: Int32Array;    // qpos address per hinge
  vadr: Int32Array;    // dof address per hinge
  lim: Float64Array;   // |torque| limit per hinge (from its actuator, 200 fallback)
  names: string[];
}

export class Engine implements EngineScope {
  readonly prefix = '';
  /** Robots of a composed scene, primary (if any) first; empty for a single-robot engine and for
   * a world with no robots. */
  readonly entities: readonly SceneEntity[];
  /** One scoped view per entity, in `entities` order. Views share this engine's native memory. */
  readonly scopes: readonly EntityEngine[];
  private disposed = false;
  /** Mirrors model.opt.timestep, so reading it costs no native call. */
  private dt: number;

  private constructor(
    readonly mj: MainModule,
    readonly model: MjModel,
    readonly data: MjData,
    /** The world robot's bundle directory; null for a generated world. */
    readonly modelDir: string | null,
    entities: readonly SceneEntity[] = [],
  ) {
    this.entities = Object.freeze([...entities]);
    this.scopes = Object.freeze(this.entities.map(entity => new EntityEngine(this, entity)));
    this.dt = model.opt.timestep;
  }

  get engine(): Engine { return this; }

  /** Metadata only: resolve the selected physics closure without starting WASM. */
  static async prepare(modelDir: string, scene = 'scene.xml', extra?: ExtraBundle,
      fetchMetadata: (url: string) => Promise<Response> = fetchAsset): Promise<PreparedEngine> {
    const { manifest, urls } = await readManifest(modelDir, scene, fetchMetadata);
    const result: PreparedEngine = { modelDir, scene, manifest, urls };
    if (extra) {
      const map = await prepareExtra(extra, fetchMetadata);
      result.extra = map.extra;
      result.urls.push(...map.urls);
    }
    return result;
  }

  /** Metadata only for a composed scene: the world (primary scene and map, or the map alone for a
   * generated world) plus each distinct attached bundle. */
  static async prepareScene(spec: SceneSpec,
      fetchMetadata: (url: string) => Promise<Response> = fetchAsset): Promise<PreparedScene> {
    validateScene(spec);
    const urls = new Set<string>(), manifests = new Map<string, BundleManifest>();
    let base: PreparedEngine | null = null, extra: PreparedExtra | undefined;
    if (spec.primary) {
      const { robot } = spec.primary;
      base = await Engine.prepare(robot.model_dir, robot.scene ?? 'scene.xml', spec.extra, fetchMetadata);
      manifests.set(`${base.modelDir}/${base.scene}`, base.manifest);
      for (const url of base.urls) urls.add(url);
    } else if (spec.extra) {
      const map = await prepareExtra(spec.extra, fetchMetadata);
      extra = map.extra;
      for (const url of map.urls) urls.add(url);
    }
    const slots: PreparedSlot[] = [];
    for (const slot of spec.slots) {
      const modelDir = slot.robot.model_dir, scene = slot.robot.scene ?? 'scene.xml', key = `${modelDir}/${scene}`;
      let manifest = manifests.get(key);
      if (!manifest) {
        const read = await readManifest(modelDir, scene, fetchMetadata);
        manifest = read.manifest;
        manifests.set(key, manifest);
        for (const url of read.urls) urls.add(url);
      }
      slots.push({ slot, modelDir, scene, manifest });
    }
    const parts = { spec, slots, urls: [...urls] };
    if (base) return { ...parts, base };
    return extra ? { ...parts, base: null, extra } : { ...parts, base: null };
  }

  /** Fetch the selected scene's indexed dependencies and compile it in MEMFS.
   * `modelDir` holds MJCF, assets and `<scene>.manifest.json`, generated by
   * scripts/index_model_assets.mjs using the native compiler's actual reads.
   * Variants share their mesh files without fetching unrelated variants. */
  static async create(modelDir: string,
                      transformXml?: (name: string, xml: string) => string,
                      scene = "scene.xml",
                      extra?: ExtraBundle, prepared?: PreparedEngine):
      Promise<Engine> {
    const [mj, bundle] = await Promise.all([
      mujocoModule(), prepared ?? Engine.prepare(modelDir, scene, extra),
    ]);
    const manifest = bundle.manifest;
    await mountBundle(mj.FS, "/work", modelDir, `${scene}.manifest.json`, manifest.files,
      manifest.gzipFiles ? new Set(manifest.gzipFiles) : undefined, transformXml);
    return Engine.compileWork(mj, `/work/${bundle.scene}`, bundle.extra, bundle.modelDir, manifest.files.length);
  }

  /** Compile the world with every slot robot attached under its `${id}/` prefix. The world is the
   * primary robot's scene or, without a primary, WORLD_XML. `transformXml` applies to the world
   * only (terrain/map): to each primary bundle file, or once to WORLD_XML named `scene.xml`.
   * Each attached bundle directory is written once under its own MEMFS root, and the generated
   * world beside them; both are removed after compiling. */
  static async createScene(spec: SceneSpec,
      transformXml?: (name: string, xml: string) => string,
      prepared?: PreparedScene): Promise<Engine> {
    if (prepared && prepared.spec !== spec) throw new Error('The prepared scene belongs to another scene spec.');
    const [mj, plan] = await Promise.all([mujocoModule(), prepared ?? Engine.prepareScene(spec)]);
    const { base } = plan, mountRoot = `/scenes/${++sceneMounts}`;
    const top = base === null ? WORLD_SCENE : base.scene;
    const scenePath = base === null ? `${mountRoot}/${top}` : `/work/${top}`;
    const bundles = new Map<string, { root: string; index: string[]; files: string[];
      compressed: Map<string, boolean>; xml: Map<string, string> }>();
    for (const { modelDir, scene, manifest } of plan.slots) {
      let bundle = bundles.get(modelDir);
      if (!bundle) {
        bundle = { root: `${mountRoot}/${bundles.size}`, index: [], files: [], compressed: new Map(), xml: new Map() };
        bundles.set(modelDir, bundle);
      }
      const index = `${scene}.manifest.json`;
      if (bundle.index.includes(index)) continue;
      bundle.index.push(index);
      const gzip = new Set(manifest.gzipFiles);
      for (const rel of manifest.files) {
        const listed = bundle.compressed.get(rel);
        if (listed === undefined) { bundle.compressed.set(rel, gzip.has(rel)); bundle.files.push(rel); }
        else if (listed !== gzip.has(rel)) throw new Error(`${modelDir}/${rel} is listed both compressed and uncompressed.`);
      }
    }
    try {
      const worldXml = new Map<string, string>();
      let written: number;
      if (base === null) {
        worldXml.set(top, transformXml ? transformXml(top, WORLD_XML) : WORLD_XML);
        written = 1;
      } else {
        await mountBundle(mj.FS, '/work', base.modelDir, `${base.scene}.manifest.json`, base.manifest.files,
          base.manifest.gzipFiles ? new Set(base.manifest.gzipFiles) : undefined, transformXml, worldXml);
        written = base.manifest.files.length;
      }
      for (const [modelDir, bundle] of bundles) {
        const gzip = new Set(bundle.files.filter(rel => bundle.compressed.get(rel)));
        await mountBundle(mj.FS, bundle.root, modelDir, bundle.index.join(', '), bundle.files, gzip, undefined, bundle.xml);
        written += bundle.files.length;
      }
      const primary = spec.primary && { slot: spec.primary,
        rootBody: freeJointRootBody(worldXml.values(), spec.primary.robot.floating_base_joint) };
      const worldOptions = authoredOptions(worldXml.values());
      const models = new Map<string, string>();
      const attached = plan.slots.map(({ slot, modelDir, scene, manifest }) => {
        const bundle = bundles.get(modelDir)!, file = `${bundle.root}/${scene}`;
        let model = models.get(file);
        if (!model) { model = `m0clip_scene_model_${models.size}`; models.set(file, model); }
        const xml = manifest.files.filter(rel => rel.endsWith('.xml')).map(rel => bundle.xml.get(rel)!);
        const ignoredOptions: Record<string, string> = {};
        for (const [name, value] of authoredOptions(xml)) if (worldOptions.get(name) !== value) ignoredOptions[name] = value;
        return { slot, model, prefix: `${slot.id}/`, rootBody: freeJointRootBody(xml, slot.robot.floating_base_joint),
          ignoredOptions: Object.freeze(ignoredOptions) };
      });
      let world = worldXml.get(top);
      if (attached.length) {
        if (world === undefined || !/<\/mujoco>\s*$/.test(world)) throw new Error(`Scene ${top} cannot host attached robots.`);
        const assets = [...models].map(([file, name]) => `    <model name="${name}" file="${file}"/>`).join('\n');
        const attaches = attached.map(a => `    <attach model="${a.model}" body="${a.rootBody}" prefix="${a.prefix}"/>`).join('\n');
        world = world.replace(/<\/mujoco>\s*$/,
          `  <asset>\n${assets}\n  </asset>\n  <worldbody>\n${attaches}\n  </worldbody>\n</mujoco>\n`);
      }
      if (base === null) mkdirTree(mj.FS, mountRoot);
      if (attached.length || base === null) mj.FS.writeFile(scenePath, world!);
      return await Engine.compileWork(mj, scenePath, plan.base === null ? plan.extra : plan.base.extra,
        base === null ? null : base.modelDir, written, model => [
          ...(primary ? [describeEntity(mj, model, primary.slot, '', primary.rootBody, NO_OPTIONS)] : []),
          ...attached.map(a => describeEntity(mj, model, a.slot, a.prefix, a.rootBody, a.ignoredOptions)),
        ]);
    } finally {
      // The compiled model owns its geometry; attached bundle files and a generated world are not kept in MEMFS.
      for (const bundle of bundles.values()) unmountFiles(mj.FS, bundle.root, bundle.files);
      if (base === null) try { mj.FS.unlink(scenePath); } catch { /* A failed scene may not have written the world. */ }
      try { mj.FS.rmdir(mountRoot); } catch { /* Nothing was mounted for a robot scene without attached robots. */ }
    }
  }

  /** Mount the map, compile `scene` (an absolute MEMFS path) and wrap it. Local map files are
   * removed either way. */
  private static async compileWork(mj: MainModule, scene: string, extra: PreparedExtra | undefined,
      modelDir: string | null, written: number,
      entities: (model: MjModel) => SceneEntity[] = () => []): Promise<Engine> {
    try {
      if (extra) await Engine.mountExtra(mj, extra);
      console.log(`[engine] bundle written (${written} files), compiling`);
      const model = mj.MjModel.mj_loadXML(scene);
      if(!model)throw new Error('MuJoCo could not compile the selected scene.');
      let data: MjData | undefined;
      try {
        console.log(`[engine] model compiled: nq=${model.nq} ngeom=${model.ngeom}`);
        const owned = entities(model);
        data = new mj.MjData(model);
        mj.mj_forward(model, data);
        return new Engine(mj, model, data, modelDir, owned);
      } catch(error) {data?.delete();model.delete();throw error;}
    } finally {
      // Compiled models own native geometry; local imports must not retain another file copy in MEMFS.
      if (extra?.source.isLocal) unmountFiles(mj.FS, extra.mount, extra.manifest.files);
    }
  }

  /** Write a second bundle (a terrain map: manifest.json + files) into MEMFS at `mount`; its XML
   * refers to its own files as MAPDIR/…, rewritten here to the absolute mount path. */
  private static async mountExtra(mj: MainModule, bundle: ExtraBundle & { manifest: BundleManifest }) {
    const { source, mount, manifest: man } = bundle;
    mkdirTree(mj.FS, mount);
    await mountFiles(man.files, async (rel) => {
      const r = await source.read(rel);
      if (!r.ok) throw new Error(`Map file missing: ${rel} (${r.status})`);
      return rel.endsWith(".xml")
        ? r.text()
        : new Uint8Array(await r.arrayBuffer());
    }, (rel, body) => {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (dir) mkdirTree(mj.FS, `${mount}/${dir}`);
      mj.FS.writeFile(`${mount}/${rel}`,
        typeof body === "string" ? body.replaceAll("MAPDIR/", `${mount}/`).replace(/(["'])MAPDIR\1/g,`$1${mount}$1`) : body);
    });
  }

  /** The scoped view of entity `id` in a composed scene. */
  scope(id: string): EntityEngine {
    const scope = this.scopes.find(s => s.entity.id === id);
    if (!scope) throw new Error(`No scene entity ${id}.`);
    return scope;
  }

  /** Free the wasm-side MjData/MjModel. Every terrain/robot switch compiles a
   * fresh model; without this each one leaked (the G1, with its large mesh
   * set, exhausted the 2 GB wasm heap after a handful of terrain switches:
   * "Could not allocate memory"). The engine and all of its entity scopes
   * are unusable afterwards; a second call does nothing. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rayGid?.delete(); this.rayGid = null;
    (this.data as any).delete?.();
    (this.model as any).delete?.();
  }

  // ---- stepping -------------------------------------------------------
  step() { this.mj.mj_step(this.model, this.data); }
  forward() { this.mj.mj_forward(this.model, this.data); }
  resetData() { this.mj.mj_resetData(this.model, this.data); this.forward(); }

  /** The one physics timestep (model.opt.timestep) every entity in this model steps with. Its
   * owner chooses a value that suits every active robot spec; the model cannot hold one per robot. */
  get timestep(): number { return this.dt; }
  set timestep(dt: number) {
    if (dt === this.dt) return;
    this.model.opt.timestep = dt;
    this.dt = dt;
  }

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
  get mocapPos(): Float64Array { return this.data.mocap_pos; }      // nmocap*3
  get mocapQuat(): Float64Array { return this.data.mocap_quat; }    // nmocap*4 wxyz

  // ---- live model metadata (views, not copies; geom contype/conaffinity are writable)
  get bodyMocapId(): Int32Array { return this.model.body_mocapid; }       // nbody, -1 if not mocap
  get bodyParentId(): Int32Array { return this.model.body_parentid; }     // nbody
  get bodyRootId(): Int32Array { return this.model.body_rootid; }         // nbody, top-level ancestor
  get bodySubtreeMass(): Float64Array { return this.model.body_subtreemass; } // nbody
  get geomBodyId(): Int32Array { return this.model.geom_bodyid; }         // ngeom
  get geomType(): Int32Array { return this.model.geom_type; }             // ngeom
  get geomGroup(): Int32Array { return this.model.geom_group; }           // ngeom
  get geomSize(): Float64Array { return this.model.geom_size; }           // ngeom*3
  get geomContype(): Int32Array { return this.model.geom_contype; }       // ngeom
  get geomConaffinity(): Int32Array { return this.model.geom_conaffinity; } // ngeom
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

  // ---- named lookups through the native ID tables --------------------
  private namedId(type: number, name: string): number {
    const id = this.mj.mj_name2id(this.model, type, name);
    if (id < 0) throw new Error(`Model object not found: ${name}`);
    return id;
  }

  jointId(name: string): number {
    return this.namedId(this.mj.mjtObj.mjOBJ_JOINT.value, name);
  }
  jointQposAdr(name: string): number {
    return this.model.jnt_qposadr[this.jointId(name)];
  }
  jointDofAdr(name: string): number {
    return this.model.jnt_dofadr[this.jointId(name)];
  }

  bodyId(name: string): number {
    return this.namedId(this.mj.mjtObj.mjOBJ_BODY.value, name);
  }

  /** |ctrlrange[1]| of the actuator driving `<joint>`, trying both `<joint>`
   * (G1) and `<joint>` minus "_joint" (Go2/R1), 200 fallback. An attached
   * robot's actuators carry its `prefix`. */
  actuatorLim(jointName: string, prefix = ''): number {
    for (const aname of [jointName, jointName.replace("_joint", "")]) {
      const id = this.mj.mj_name2id(this.model, this.mj.mjtObj.mjOBJ_ACTUATOR.value, prefix + aname);
      if (id < 0) continue;
      const hi = Math.abs(this.model.actuator_ctrlrange[id * 2 + 1]);
      if (hi > 0) return hi;
    }
    return 200.0;
  }

  /** Every hinge joint in the model with addresses + torque limits. */
  hinges(): HingeSet { return this.hingesIn(0, this.model.njnt, ''); }

  /** Hinges among joints [jointStart, jointEnd), named without `prefix`. */
  hingesIn(jointStart: number, jointEnd: number, prefix: string): HingeSet {
    const type: Int32Array = this.model.jnt_type;
    const qposadr: Int32Array = this.model.jnt_qposadr;
    const dofadr: Int32Array = this.model.jnt_dofadr;
    const qadr: number[] = [], vadr: number[] = [], lim: number[] = [], names: string[] = [];
    for (let i = jointStart; i < jointEnd; i++) {
      if (type[i] !== JNT_HINGE) continue;
      const full = this.mj.mj_id2name(this.model, this.mj.mjtObj.mjOBJ_JOINT.value, i) ?? '';
      if (!full.startsWith(prefix)) throw new Error(`Joint ${full} lacks its entity prefix ${prefix}.`);
      const name = full.slice(prefix.length);
      qadr.push(qposadr[i]); vadr.push(dofadr[i]);
      lim.push(this.actuatorLim(name, prefix)); names.push(name);
    }
    return { qadr: Int32Array.from(qadr), vadr: Int32Array.from(vadr),
             lim: Float64Array.from(lim), names };
  }

  /** Whole-model clears: the single-robot scope. Composed scenes clear per EntityEngine. */
  clearVelocity() { this.qvel.fill(0); }
  clearAppliedTorque() { this.qfrcApplied.fill(0); }
  clearAppliedForce() { this.xfrcApplied.fill(0); }

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
