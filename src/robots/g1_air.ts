/** Unitree G1 **Air** spec — the 23-DOF variant: 12 legs + waist yaw + 5 per arm (no waist roll/pitch,
 * no wrist pitch/yaw), with the Air torso (torso_link_23dof_rev_1_0). Compiles `air_scene.xml` of the
 * G1 bundle (g1_23dof.xml, from unitree_ros g1_23dof_rev_1_0).
 *
 * `joint_names` keeps the 29-slot G1 order on purpose: every G1 driver / pack config (control_joints,
 * default_dof_pos, kp/kd/tau) indexes that order. The six slots this model lacks are left unbound by
 * BaseDriver (read as 0, never actuated), matching an Air's lowstate. The worker loads this spec
 * automatically for Air-only policies (`g1.models == ["air"]`), see `specFor` in sim.worker.ts.
 */
import type { RobotSpec } from "../core/types";
import { G1, JOINT_NAMES, TORQUE_LIMIT } from "./g1";

export const G1_AIR: RobotSpec = {
  ...G1,
  robot: "g1_air",
  // Air torso_link sits 1 cm lower on the pelvis (no waist roll/pitch links) and its shoulder pitch
  // joints 1 cm higher in the torso frame: the hook stays between the shoulders, like the EDU's
  hoist_body: "torso_link",
  hoist_offset: [0.004, 0, 0.248],
  joint_names: JOINT_NAMES,
  torque_limit: TORQUE_LIMIT,
  model_dir: "/assets/models/g1",
  scene: "air_scene.xml",
};
