/** Metadata-only robot/policy resolution, shared by launch and live robot selection. */
import type { PolicyEntry, RobotSpec } from '../core/types';
import { getSpec, SPECS } from '../robots';

export const robotFamily = (robot: string) =>
  robot.startsWith('r1') ? 'r1' : robot.startsWith('g1') ? 'g1' : robot;

export const r1Models = (entry: PolicyEntry): string[] =>
  entry.models?.length ? entry.models : [entry.robot === 'r1_air' ? 'air' : 'edu'];

/** Equal compiled models can still have different controlled joints (R1 EDU 24 / EDU 20). */
export const modelKey = (spec: RobotSpec) => `${spec.model_dir}/${spec.scene ?? 'scene.xml'}`;

/** Resolve a deliberate policy change or handover using the existing pack variant rules. */
export function specFor(entry: PolicyEntry, robot: string, keep = false): string {
  if (!(entry.robot in SPECS)) return robot;
  if (robotFamily(entry.robot) === 'r1') {
    if (entry.robot !== 'r1_air') return entry.robot;
    const models = r1Models(entry);
    // R1 dual-model packs always keep an already selected Air body.
    const air = (models.length === 1 && models[0] === 'air') ||
      (models.includes('air') && robot === 'r1_air');
    return air ? 'r1_air' : 'r1_air_edu';
  }
  if (entry.robot !== 'g1') return entry.robot;
  const models = entry.models ?? [];
  if (models.length === 1 && models[0] === 'air') return 'g1_air';
  if (keep && models.includes('air') && robotFamily(robot) === 'g1') return robot;
  return 'g1';
}

/** Preflight without changing any active worker context or loading assets.
 * Keep the complete family catalog: an intentional later policy choice may change hardware.
 * Only an ordinary remembered/default launch may adopt an incompatible pack's model. */
export function selectRobotPolicy(robot: string, entries: PolicyEntry[], preferred?: string, explicit = false) {
  const spec = getSpec(robot);
  const policies = entries.filter(entry => robotFamily(entry.robot) === robotFamily(robot));
  let first = -1, saved = -1, walking = -1;
  for (let i = 0; i < policies.length; i++) {
    const entry = policies[i];
    if (specFor(entry, robot, true) !== robot) continue;
    if (first < 0) first = i;
    if (entry.name === preferred) saved = i;
    if (entry.name === 'amp_locomotion/amp_locomotion') walking = i;
  }
  const index = saved >= 0 ? saved : walking >= 0 ? walking : first;
  if (index >= 0 || !policies.length) return { robot, policies, index };
  if (explicit) {
    throw new Error(`No imported policy supports ${spec.robot} (${spec.num_act}-DOF). Import a compatible policy pack or select another robot.`);
  }
  const fallbackSaved = policies.findIndex(entry => entry.name === preferred);
  const fallbackWalk = policies.findIndex(entry => entry.name === 'amp_locomotion/amp_locomotion');
  const fallback = fallbackSaved >= 0 ? fallbackSaved : fallbackWalk >= 0 ? fallbackWalk : 0;
  return { robot: specFor(policies[fallback], robot), policies, index: fallback };
}
