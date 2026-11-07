/** Scene export of a take for Blender (or any DCC): a binary glTF (.glb) holding every rendered part
 * of the robot and terrain as its own named object with its own materials, the motion as keyframed
 * world transforms, and optionally the shot camera with its lens, animated along its path.
 *
 * MuJoCo is Z-up and glTF is Y-up, so poses are converted on the way out (Blender's importer
 * converts back): objects arrive in Blender with clean world transforms and no wrapper rotation. */
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { checkerTexture, type SceneView } from "../render/scene";
import type { RenderModel } from "../sim/protocol";
import { GEOM_STRIDE, matToQuat } from '../core/geometry';
import type { Take } from "./take";
import type { PlayerTake } from "./player-take";
import type { SceneDisplay } from '../render/display';
import type { Shot, ShotPath } from "./shot";
import { prepareLosslessTextures } from "./lossless-textures";
import { expandDetailBatches } from '../render/source-details';
import { losslessImageWriter } from "./lossless-images";
import { SceneCamera, infiniteCameraWriter } from '../render/scene-camera';
import { shotLightObjects } from '../render/shot-lights';
import type { LookState } from '../ui/look';
import type { ShotEdits, ShotLight } from './post';
import { extraSkinningWriter } from '../render/extra-skin';
import { sourceBaseTransformWriter } from '../render/source-materials';

export interface GlbJob {
  fps: number;              // key rate; keys are in seconds, so motion plays at true speed at any scene rate
  t0: number; t1: number;
  camera: { path: ShotPath; shot: Shot; aspect: number } | null;
  floor: boolean;           // ground plane (terrain geoms are always included)
  look?: LookState;         // effective review Look, including the fallback for legacy takes
}

/** −90° about X: MuJoCo Z-up → glTF Y-up. */
const TO_YUP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const yUp = (x: number, y: number, z: number): [number, number, number] => [x, z, -y];

/** Keep successive quaternions on one hemisphere so keys interpolate the short way. */
function pushQuat(out: number[], q: THREE.Quaternion) {
  const n = out.length;
  if (n >= 4 && out[n - 4] * q.x + out[n - 3] * q.y + out[n - 2] * q.z + out[n - 1] * q.w < 0)
    out.push(-q.x, -q.y, -q.z, -q.w);
  else out.push(q.x, q.y, q.z, q.w);
}


export async function exportGlb(take: Take, view: SceneView, model: RenderModel, job: GlbJob): Promise<Blob> {
  await Promise.all([view.waitForRobotVisuals(),view.waitForTerrainVisuals()]);
  if(take.meta.localMap&&view.mapSource?.identity?.fingerprint!==take.meta.localMap.fingerprint)
    throw new Error('Reattach this take’s original map bundle before exporting.');
  const restoreHighlights=view.suspendHighlights();
  try {
  const appearance = view.getAppearance(), sourceHead = view.getSourceHead(), lights = view.getShotLights();
  const display = view.getDisplay(), flashlight = view.getFlashlight();
  const look = structuredClone(job.look ?? take.meta.edits?.look ?? take.meta.look);
  const shotEdits: ShotEdits = {
    version: 1, appearance, sourceHead, ...(look ? { look } : {}), display, flashlight, lights,
  };
  const N = Math.max(2, Math.round((job.t1 - job.t0) * job.fps) + 1);
  const times = Float32Array.from({ length: N }, (_, i) => Math.min(i / job.fps, job.t1 - job.t0));
  const geometry = take.sampleGeometry(times, job.t0), poses = geometry.values;

  const scene = new THREE.Scene();
  scene.name = `${take.meta.robot}_take`;
  scene.userData = {
    generator: "m0clip-ts", robot: take.meta.robot, model: take.meta.model,
    terrain: take.meta.terrain, policy: take.meta.policy, recorded: take.meta.created,
    localMap: take.meta.localMap && {...take.meta.localMap},
    range_s: [job.t0, job.t1], key_fps: job.fps,
    robotAppearance: appearance, recordedAppearance: structuredClone(take.meta.appearance),
    sourceHead, recordedSourceHead: take.meta.sourceHead, look, recordedLook: structuredClone(take.meta.look),
    display, recordedDisplay: structuredClone(take.meta.display),
    flashlight, recordedFlashlight: take.meta.flashlight, lights, recordedLights: structuredClone(take.meta.lights),
    shotEdits, sourceRendering: 'Native Source lightmaps, tone mapping, browser wireframe and custom shader effects are not reproduced by glTF materials. Camera flashlight state is metadata only, not an exported light.',
    robotFade: take.meta.robotFade, noclipTransitions: take.events.filter(event => event.kind === 'noclip'),
  };
  const robot = new THREE.Group(), world = new THREE.Group();
  const detailCleanup: (()=>void)[]=[];
  robot.name = take.meta.robot;
  world.name = "terrain";
  scene.add(robot, world);

  const tracks: THREE.KeyframeTrack[] = [];
  const used = new Set<string>();
  const unique = (base: string) => {
    const b = THREE.PropertyBinding.sanitizeNodeName(base) || "part";
    let name = b;
    for (let k = 2; used.has(name); k++) name = `${b}_${k}`;
    used.add(name);
    return name;
  };
  const q = new THREE.Quaternion();

  for (const { geom, mesh } of view.exportParts()) {
    const body = model.bodyid[geom];
    const meshName = model.dataid[geom] >= 0 ? model.meshes[model.dataid[geom]]?.name : undefined;
    const node = new THREE.Mesh(mesh.geometry, mesh.material);
    node.name = unique(body > 0 ? (meshName && meshName !== model.bodyNames[body] ? `${model.bodyNames[body]}__${meshName}` : model.bodyNames[body])
                                : meshName ?? `terrain_${geom}`);
    node.userData = { geom, body: model.bodyNames[body] ?? "", mesh: meshName ?? "",
      ...(mesh.userData.sourceRobotPart ? { sourceModel: mesh.userData.sourceRobotPart } : {}) };
    if(mesh.userData.robotModule)node.userData.robotModule={...mesh.userData.robotModule};
    const first = geometry.offset(0, geom);
    (body > 0 ? robot : world).add(node);
    if (geometry.isFixed(geom)) {
      node.position.set(poses[first], poses[first+2], -poses[first+1]);
      node.quaternion.set(poses[first+4],poses[first+5],poses[first+6],poses[first+3]).premultiply(TO_YUP);
      continue;
    }
    const pos: number[] = [], rot: number[] = [];
    let moves = false;
    for (let i = 0; i < N; i++) {
      const o = geometry.offset(i, geom);
      pos.push(poses[o], poses[o + 2], -poses[o + 1]);
      q.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 3]).premultiply(TO_YUP);
      pushQuat(rot, q);
      if (i && !moves) {
        for (let k = 0; k < GEOM_STRIDE; k++) if (Math.abs(poses[o + k] - poses[first + k]) > 1e-6) { moves = true; break; }
      }
    }
    node.position.fromArray(pos, 0);
    node.quaternion.fromArray(rot, 0);
    if (moves) {
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, times, pos));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, rot));
    }
  }

  const sourceBody=display.robot?view.exportSourceBody(geometry,times):null;
  if(sourceBody){
    const wrap=new THREE.Group();wrap.name=unique('source_robot');wrap.quaternion.copy(TO_YUP);
    wrap.add(sourceBody.root);robot.add(wrap);tracks.push(...sourceBody.tracks);
  }

  return finishGlb({ scene, world, view, job, display, lights, times, tracks, unique, detailCleanup });
  } finally { restoreHighlights(); }
}

/** Map visual, ground, shot lights and shot camera shared by Robot and Player exports, then the binary glTF. */
async function finishGlb(s: { scene: THREE.Scene; world: THREE.Group; view: SceneView; job: GlbJob; display: Required<SceneDisplay>;
  lights: ShotLight[]; times: Float32Array; tracks: THREE.KeyframeTrack[]; unique: (base: string) => string; detailCleanup: (() => void)[] }): Promise<Blob> {
  const { scene, world, view, job, display, lights, times, tracks, unique, detailCleanup } = s, N = times.length, q = new THREE.Quaternion();
  // a converted game map's textured visual (already in the MuJoCo frame): wrapped into Y-up
  if (display.map && view.terrainObject) {
    const wrap = new THREE.Group();
    wrap.name = unique("map");
    wrap.quaternion.copy(TO_YUP);
    // Object3D.clone() leaves SkinnedMesh skeletons pointing into the live scene.
    const terrain = cloneSkeleton(view.terrainObject);
    detailCleanup.push(expandDetailBatches(terrain));
    terrain.traverse(object => {
      // Background sky and additive camera-facing glows are render effects, not solid DCC geometry.
      if (object.userData.sourceSky || object.userData.sourceSprite) object.visible = false;
    });
    wrap.add(terrain);
    world.add(wrap);
  }

  if (job.floor) {
    const tex = display.textures ? checkerTexture() : null;
    tex?.repeat.set(20 / 0.2, 20 / 0.2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }));
    floor.name = unique("ground");
    floor.quaternion.copy(TO_YUP);
    world.add(floor);
  }

  // Light positions and aim are authored in Z-up; convert their entire hierarchy exactly once.
  const lightWrap = new THREE.Group();
  lightWrap.name = unique('shot_lights');
  lightWrap.quaternion.copy(TO_YUP);
  lightWrap.add(shotLightObjects(lights));
  scene.add(lightWrap);

  if (job.camera) {
    const { path, shot, aspect } = job.camera;
    const cam = new SceneCamera(45, aspect, 0.05, 200);
    view.configureCamera(cam);
    path.apply(cam, job.t0, aspect);
    const shotCam = new SceneCamera(cam.fov, aspect, 0.05, 200);
    view.configureCamera(shotCam);
    shotCam.name = unique("shot_camera");
    shotCam.userData = { focal_mm: shot.focal, sensor_mm: shot.sensor, sensor_fit: "auto", mode: shot.mode };
    const pos: number[] = [], rot: number[] = [];
    for (let i = 0; i < N; i++) {
      path.apply(cam, job.t0 + times[i], aspect);
      pos.push(...yUp(cam.position.x, cam.position.y, cam.position.z));
      pushQuat(rot, q.copy(cam.quaternion).premultiply(TO_YUP));
    }
    shotCam.position.fromArray(pos, 0);
    shotCam.quaternion.fromArray(rot, 0);
    scene.add(shotCam);
    if (shot.mode !== "fixed") {
      tracks.push(new THREE.VectorKeyframeTrack(`${shotCam.name}.position`, times, pos));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${shotCam.name}.quaternion`, times, rot));
    }
  }

  const clip = new THREE.AnimationClip("take", job.t1 - job.t0, tracks);
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const cleanup = prepareLosslessTextures(scene),images=losslessImageWriter(view.renderer);
  try {
    const glb = await new GLTFExporter().register(images.plugin).register(infiniteCameraWriter).register(extraSkinningWriter).register(sourceBaseTransformWriter).parseAsync(scene, {
      binary: true, trs: true, onlyVisible: true, animations: tracks.length ? [clip] : [],
    });
    return new Blob([glb as ArrayBuffer], { type: "model/gltf-binary" });
  } finally { images.dispose();cleanup();for(const dispose of detailCleanup)dispose(); }
}

/** Main's render adapter for a Player take. Each epoch's recorded model is shown in `view` before its parts
 * are read; the player body and view model are built from the recorded presentation, never substituted. */
export interface PlayerGlbStage {
  view: SceneView;
  /** Show recorded epoch `epoch` (its own RenderModel) in `view`; resolves once its visuals are ready. */
  useEpoch(epoch: number, model: RenderModel): Promise<void>;
  /** The player body and view model in the MuJoCo frame, keyed at take times t0 + times[i]. Track names must
   * address uniquely named nodes inside `root`. Throws when a displayed actor cannot be exported. */
  playerActors(take: PlayerTake, times: Float32Array, t0: number): Promise<{ root: THREE.Object3D; tracks: THREE.KeyframeTrack[]; limitations: string[] }>;
  /** Return the view to the review state after export, including after a failure. */
  restore(): Promise<void> | void;
}

interface PlayerNode { node: THREE.Mesh; pos: Float32Array; rot: Float32Array; seen: Uint8Array; signature: string }

/** A Player take as glTF. A part keeps one node across epochs while its owner (entity id, or the world) and
 * shape stay the same; outside its lifetime it is scaled to zero with step keys, since glTF has no visibility
 * animation. Positions come from each epoch's own recorded geometry; nothing blends across a layout boundary. */
export async function exportPlayerGlb(take: PlayerTake, stage: PlayerGlbStage, job: GlbJob): Promise<Blob> {
  const { view } = stage;
  let restoreHighlights: (() => void) | null = null;
  try {
    const N = Math.max(2, Math.round((job.t1 - job.t0) * job.fps) + 1);
    const times = Float32Array.from({ length: N }, (_, i) => Math.min(i / job.fps, job.t1 - job.t0));
    const epochOf = Int32Array.from(times, (t) => take.epochAt(job.t0 + t));
    const nodes = new Map<string, PlayerNode>(), used = new Set<string>();
    const unique = (base: string) => {
      const b = THREE.PropertyBinding.sanitizeNodeName(base) || "part";
      let name = b;
      for (let k = 2; used.has(name); k++) name = `${b}_${k}`;
      used.add(name);
      return name;
    };
    const scene = new THREE.Scene(), robots = new THREE.Group(), world = new THREE.Group();
    robots.name = unique("robots"); world.name = unique("terrain");
    scene.add(robots, world);
    const q = new THREE.Quaternion(), wxyz = new Float32Array(4);
    for (let epoch = 0; epoch < take.epochs.length; epoch++) {
      if (!epochOf.includes(epoch)) continue;
      const model = take.epochs[epoch].model;
      restoreHighlights?.();
      await stage.useEpoch(epoch, model);
      if (take.meta.localMap && view.mapSource?.identity?.fingerprint !== take.meta.localMap.fingerprint)
        throw new Error('Reattach this take’s original map bundle before exporting.');
      restoreHighlights = view.suspendHighlights();
      const parts = view.exportParts().map(({ geom, mesh }) => {
        const entity = model.entities?.find(e => geom >= e.geomStart && geom < e.geomEnd);
        const body = model.bodyid[geom], meshName = model.dataid[geom] >= 0 ? model.meshes[model.dataid[geom]]?.name ?? '' : '';
        const owner = entity ? `${entity.id}:${geom - entity.geomStart}` : `world:${geom}`;
        const signature = `${model.type[geom]}:${meshName}:${Array.from(model.size.subarray(geom * 3, geom * 3 + 3)).join(',')}`;
        let key = owner, record = nodes.get(key);
        for (let k = 2; record && record.signature !== signature; k++) record = nodes.get(key = `${owner}#${k}`);
        if (!record) {
          const node = new THREE.Mesh(mesh.geometry, mesh.material), bodyName = model.bodyNames[body] ?? '';
          const local = entity && bodyName.startsWith(entity.prefix) ? bodyName.slice(entity.prefix.length) : bodyName;
          node.name = unique(entity ? `${entity.id}__${local}${meshName && meshName !== local ? `__${meshName}` : ''}`
            : body > 0 ? `${bodyName}${meshName && meshName !== bodyName ? `__${meshName}` : ''}` : meshName || `terrain_${geom}`);
          node.userData = { geom, body: bodyName, mesh: meshName, ...(entity ? { entity: entity.id, robot: entity.robot } : {}),
            ...(mesh.userData.sourceRobotPart ? { sourceModel: mesh.userData.sourceRobotPart } : {}) };
          (entity || body > 0 ? robots : world).add(node);
          record = { node, pos: new Float32Array(N * 3), rot: new Float32Array(N * 4), seen: new Uint8Array(N), signature };
          nodes.set(key, record);
        }
        return { geom, record };
      });
      for (let i = 0; i < N; i++) {
        if (epochOf[i] !== epoch) continue;
        const pose = take.poseAt(job.t0 + times[i]);
        if (pose.epoch !== epoch) throw new Error('Player take epoch changed while sampling.');
        for (const { geom, record } of parts) {
          const p = pose.xpos, o = i * 3, r = i * 4;
          record.pos[o] = p[geom * 3]; record.pos[o + 1] = p[geom * 3 + 2]; record.pos[o + 2] = -p[geom * 3 + 1];
          matToQuat(pose.xmat, geom * 9, wxyz, 0);
          q.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]).premultiply(TO_YUP);
          record.rot[r] = q.x; record.rot[r + 1] = q.y; record.rot[r + 2] = q.z; record.rot[r + 3] = q.w;
          record.seen[i] = 1;
        }
      }
    }
    restoreHighlights?.();
    restoreHighlights = view.suspendHighlights();

    const tracks: THREE.KeyframeTrack[] = [], lifetimes: { node: string; from_s: number; to_s: number }[] = [];
    for (const { node, pos, rot, seen } of nodes.values()) {
      // Hidden samples hold the nearest shown pose, so linear keys never sweep through invented space.
      let last = -1;
      for (let i = 0; i < N; i++) if (seen[i]) last = i; else if (last >= 0) { pos.copyWithin(i * 3, last * 3, last * 3 + 3); rot.copyWithin(i * 4, last * 4, last * 4 + 4); }
      const first = seen.indexOf(1);
      for (let i = first - 1; i >= 0; i--) { pos.copyWithin(i * 3, first * 3, first * 3 + 3); rot.copyWithin(i * 4, first * 4, first * 4 + 4); }
      for (let i = 1; i < N; i++) if (rot[i * 4] * rot[i * 4 - 4] + rot[i * 4 + 1] * rot[i * 4 - 3] + rot[i * 4 + 2] * rot[i * 4 - 2] + rot[i * 4 + 3] * rot[i * 4 - 1] < 0)
        for (let k = 0; k < 4; k++) rot[i * 4 + k] = -rot[i * 4 + k];
      node.position.fromArray(pos, 0); node.quaternion.fromArray(rot, 0); node.scale.setScalar(seen[0]);
      let moves = false;
      for (let i = 1; i < N && !moves; i++) for (let k = 0; k < 4; k++) if (k < 3 && Math.abs(pos[i * 3 + k] - pos[k]) > 1e-6 || Math.abs(rot[i * 4 + k] - rot[k]) > 1e-6) { moves = true; break; }
      if (moves) {
        tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, times, pos));
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, rot));
      }
      if (!seen.every(Boolean)) {
        const scale = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) scale.fill(seen[i], i * 3, i * 3 + 3);
        tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.scale`, times, scale, THREE.InterpolateDiscrete));
        lifetimes.push({ node: node.name, from_s: times[first], to_s: times[seen.lastIndexOf(1)] });
      }
    }

    const actors = await stage.playerActors(take, times, job.t0);
    const actorWrap = new THREE.Group();
    actorWrap.name = unique('player');
    actorWrap.quaternion.copy(TO_YUP);
    actorWrap.add(actors.root);
    scene.add(actorWrap);
    tracks.push(...actors.tracks);

    const lights = view.getShotLights(), display = view.getDisplay(), flashlight = view.getFlashlight();
    const look = structuredClone(job.look ?? take.meta.edits?.look ?? take.meta.look);
    scene.name = 'player_take';
    scene.userData = {
      generator: 'm0clip-ts', mode: 'player', terrain: take.meta.terrain, recorded: take.meta.created,
      localMap: take.meta.localMap && { ...take.meta.localMap }, range_s: [job.t0, job.t1], key_fps: job.fps,
      look, recordedLook: structuredClone(take.meta.look), display, recordedDisplay: structuredClone(take.meta.display),
      flashlight, lights, recordedLights: structuredClone(take.meta.lights), sceneLayouts: take.epochs.length,
      robots: take.entityLifetimes().map(span => ({ id: span.id, robot: span.robot, from_s: take.t[span.from] - job.t0, to_s: take.t[span.to] - job.t0 })),
      partLifetimes: lifetimes,
      limitations: [
        'glTF has no visibility animation: parts outside their lifetime are scaled to zero with step keys.',
        'Native Source lightmaps, tone mapping, browser wireframe and custom shader effects are not reproduced by glTF materials. Camera flashlight state is metadata only, not an exported light.',
        ...actors.limitations,
      ],
    };
    return await finishGlb({ scene, world, view, job, display, lights, times, tracks, unique, detailCleanup: [] });
  } finally {
    restoreHighlights?.();
    await stage.restore();
  }
}
