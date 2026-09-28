/** Unitree G1 robot spec — 29-DOF humanoid.
 *
 * 29 controlled joints in MuJoCo model / ai_sport joint_indices order:
 * Left leg (0..5), right leg (6..11), waist (12..14), left arm (15..21), right arm (22..28).
 *
 * Actuators retain the full "_joint" name and carry no ctrlrange in MJCF,
 * so torque limits come from the spec (`torque_limit`).
 * Requires 2 kHz physics (`sim_dt: 0.0005`) for PD stability with stiff humanoid gains.
 */
import type { RobotSpec } from "../core/types";

export const JOINT_NAMES = [
  // left leg (0-5)
  "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint",
  "left_knee_joint", "left_ankle_pitch_joint", "left_ankle_roll_joint",
  // right leg (6-11)
  "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint",
  "right_knee_joint", "right_ankle_pitch_joint", "right_ankle_roll_joint",
  // waist (12-14)
  "waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint",
  // left arm (15-21)
  "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint",
  "left_elbow_joint", "left_wrist_roll_joint", "left_wrist_pitch_joint",
  "left_wrist_yaw_joint",
  // right arm (22-28)
  "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint",
  "right_elbow_joint", "right_wrist_roll_joint", "right_wrist_pitch_joint",
  "right_wrist_yaw_joint",
];

export const TORQUE_LIMIT = [
  88, 88, 88, 139, 50, 50,          // left leg
  88, 88, 88, 139, 50, 50,          // right leg
  88, 50, 50,                        // waist yaw/roll/pitch
  25, 25, 25, 25, 25, 5, 5,          // left arm
  25, 25, 25, 25, 25, 5, 5,          // right arm
];

export const G1: RobotSpec = {
  robot: "g1",
  anchor_body: "pelvis",
  // the gantry holds the robot at shoulder level (between the shoulder pitch joints), not the waist
  hoist_body: "torso_link",
  hoist_offset: [0.004, 0, 0.238],
  floating_base_joint: "floating_base_joint",
  foot_bodies: ["left_ankle_roll_link", "right_ankle_roll_link"],
  num_act: 29,
  joint_names: JOINT_NAMES,
  model_dir: "/assets/models/g1",
  fall_height: 0.45,
  sim_dt: 0.0005,
  torque_limit: TORQUE_LIMIT,
};
