/** Unitree R1 **Air** specs — the 20-DOF variant (no waist, no wrist roll).
 *
 * `R1_AIR` compiles the genuine Air model, `air_scene.xml` of the R1 bundle (r1_air.xml, from unitree_ros
 * r1_air_description: torso + head are part of the pelvis link, Air shoulders / forearms-with-hands).
 * The worker loads it for Air-only packs (`robot: r1_air` or `models: [air]`), see `specFor` in
 * sim.worker.ts. There is no torso_link: the anchor is the pelvis (with the waist held at 0 on the EDU
 * model, torso_link and pelvis share their orientation, so motion-tracking obs are unchanged).
 *
 * `R1_AIR_EDU` runs a 20-DOF policy on the 24-DOF EDU model (the pre-Air-model behaviour, used for
 * packs that declare `models: [air, edu]` / `[edu]`): the absent waist / wrist_roll joints are held
 * near-rigid via extra_kp/extra_kd (the runner holds any hinge not in joint_names). */
import type { RobotSpec } from "../core/types";
import { R1_ANKLE_PAIRS } from "./r1";

export const JOINT_NAMES = [
  "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint",
  "left_knee_joint", "left_ankle_pitch_joint", "left_ankle_roll_joint",
  "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint",
  "right_knee_joint", "right_ankle_pitch_joint", "right_ankle_roll_joint",
  "left_shoulder_pitch_joint", "left_shoulder_roll_joint",
  "left_shoulder_yaw_joint", "left_elbow_joint",
  "right_shoulder_pitch_joint", "right_shoulder_roll_joint",
  "right_shoulder_yaw_joint", "right_elbow_joint",
];

export const R1_AIR: RobotSpec = {
  robot: "r1_air",
  anchor_body: "pelvis",
  // the EDU hoist holds torso_link's origin, 0.049 m above the waist-roll axis: same point on the Air
  hoist_body: "pelvis",
  hoist_offset: [0.0325, 0, 0.049],
  floating_base_joint: "floating_base_joint",
  foot_bodies: ["left_ankle_roll_link", "right_ankle_roll_link"],
  num_act: 20,
  joint_names: JOINT_NAMES,
  model_dir: "/assets/models/r1",
  scene: "air_scene.xml",
  fall_height: 0.40,
  sim_dt: 0.002,
  ankle_pairs: R1_ANKLE_PAIRS,
};

export const R1_AIR_EDU: RobotSpec = {
  robot: "r1_air_edu",
  anchor_body: "torso_link",
  floating_base_joint: "floating_base_joint",
  foot_bodies: ["left_ankle_roll_link", "right_ankle_roll_link"],
  num_act: 20,
  joint_names: JOINT_NAMES,
  model_dir: "/assets/models/r1",
  fall_height: 0.40,
  sim_dt: 0.002,
  extra_kp: 400.0,
  extra_kd: 10.0,
  ankle_pairs: R1_ANKLE_PAIRS,
};
