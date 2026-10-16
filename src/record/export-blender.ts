/** Scene export of a take for Blender (or any DCC): a binary glTF (.glb) holding every rendered part
 * of the robot and terrain as its own named object with its own materials, the motion as keyframed
 * world transforms, and optionally the shot camera with its lens, animated along its path.
 *
 * MuJoCo is Z-up and glTF is Y-up, so poses are converted on the way out (Blender's importer
 * converts back): objects arrive in Blender with clean world transforms and no wrapper rotation. */
import * as THREE from "three";
import { checkerTexture, type SceneView } from "../render/scene";
import type { RenderModel } from "../sim/protocol";
import { GEOM_STRIDE, type Take } from "./take";
import type { Shot, ShotPath } from "./shot";

export interface GlbJob {
  fps: number;              // key rate; keys are in seconds, so motion plays at true speed at any scene rate
  t0: number; t1: number;
  camera: { path: ShotPath; shot: Shot; aspect: number } | null;
  floor: boolean;           // ground plane (terrain geoms are always included)
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
  const N = Math.max(2, Math.round((job.t1 - job.t0) * job.fps) + 1);
  const times = Float32Array.from({ length: N }, (_, i) => Math.min(i / job.fps, job.t1 - job.t0));
  const ng = take.meta.ngeom;
  const poses = new Float32Array(N * ng * GEOM_STRIDE);
  const tmp = new Float32Array(ng * GEOM_STRIDE);
  for (let i = 0; i < N; i++) {
    take.geomPoseAt(job.t0 + times[i], tmp);
    poses.set(tmp, i * ng * GEOM_STRIDE);
  }

  const scene = new THREE.Scene();
  scene.name = `${take.meta.robot}_take`;
  scene.userData = {
    generator: "unitree-mujoco-web", robot: take.meta.robot, model: take.meta.model,
    terrain: take.meta.terrain, policy: take.meta.policy, recorded: take.meta.created,
    range_s: [job.t0, job.t1], key_fps: job.fps,
  };
  const robot = new THREE.Group(), world = new THREE.Group();
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
    node.userData = { geom, body: model.bodyNames[body] ?? "", mesh: meshName ?? "" };
    const pos: number[] = [], rot: number[] = [];
    let moves = false;
    for (let i = 0; i < N; i++) {
      const o = (i * ng + geom) * GEOM_STRIDE;
      pos.push(...yUp(poses[o], poses[o + 1], poses[o + 2]));
      q.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 3]).premultiply(TO_YUP);
      pushQuat(rot, q);
      if (i && !moves) {
        const p0 = geom * GEOM_STRIDE;
        for (let k = 0; k < GEOM_STRIDE; k++) if (Math.abs(poses[o + k] - poses[p0 + k]) > 1e-6) { moves = true; break; }
      }
    }
    node.position.fromArray(pos, 0);
    node.quaternion.fromArray(rot, 0);
    (body > 0 ? robot : world).add(node);
    if (moves) {
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, times, pos));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, rot));
    }
  }

  if (job.floor) {
    const tex = checkerTexture();
    tex.repeat.set(20 / 0.2, 20 / 0.2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }));
    floor.name = unique("ground");
    floor.quaternion.copy(TO_YUP);
    world.add(floor);
  }

  if (job.camera) {
    const { path, shot, aspect } = job.camera;
    const cam = new THREE.PerspectiveCamera(45, aspect, 0.05, 200);
    path.apply(cam, job.t0, aspect);
    const shotCam = new THREE.PerspectiveCamera(cam.fov, aspect, 0.05, 200);
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
  const glb = await new GLTFExporter().parseAsync(scene, {
    binary: true, trs: true, onlyVisible: true, animations: tracks.length ? [clip] : [],
  });
  return new Blob([glb as ArrayBuffer], { type: "model/gltf-binary" });
}
