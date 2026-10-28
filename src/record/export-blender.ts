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
import { GEOM_STRIDE } from '../core/geometry';
import type { Take } from "./take";
import type { Shot, ShotPath } from "./shot";
import { prepareLosslessTextures } from "./lossless-textures";
import { expandDetailBatches } from '../render/source-details';
import { losslessImageWriter } from "./lossless-images";
import { SceneCamera, infiniteCameraWriter } from '../render/scene-camera';
import { shotLightObjects } from '../render/shot-lights';
import type { LookState } from '../ui/look';
import type { ShotEdits } from './post';
import { extraSkinningWriter } from '../render/extra-skin';

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
    const glb = await new GLTFExporter().register(images.plugin).register(infiniteCameraWriter).register(extraSkinningWriter).parseAsync(scene, {
      binary: true, trs: true, onlyVisible: true, animations: tracks.length ? [clip] : [],
    });
    return new Blob([glb as ArrayBuffer], { type: "model/gltf-binary" });
  } finally { images.dispose();cleanup();for(const dispose of detailCleanup)dispose(); }
  } finally { restoreHighlights(); }
}
