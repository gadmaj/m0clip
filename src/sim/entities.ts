/** Robot entities inside one composed MuJoCo scene.
 *
 * A composed scene is still one native model and one data block: every robot shares
 * the same contacts, timestep and global `<option>`. Those come from the world file
 * (the primary robot's scene or the generated world); `<attach>` drops an attached
 * robot's own `<option>`. An entity is the slice that one robot owns. MuJoCo stores a
 * kinematic tree's bodies, joints, dofs and geoms contiguously, so the slice is a set
 * of half-open index ranges.
 */
import type { Engine, EngineScope, HingeSet } from './engine';

/** Immutable ownership record for one robot. Ranges are half-open model indices. */
export interface SceneEntity {
  readonly id: string;
  /** RobotSpec.robot of the variant compiled into this entity. */
  readonly robot: string;
  /** '' for the primary robot, `${id}/` for an attached one. */
  readonly prefix: string;
  /** Top-level body that carries the floating base joint. */
  readonly rootBody: number;
  /** Its name without the prefix. */
  readonly rootBodyName: string;
  readonly freeJoint: number;
  /** Global `<option>` values this robot's bundle authors (`flag.<name>` for `<flag>`) that the
   * scene does not take from it, as authored text. Empty for the primary robot, whose files are
   * the world. An attached robot's entry is omitted only when the world's scene files author the
   * same text; a value equal to MuJoCo's default is still listed. */
  readonly ignoredOptions: Readonly<Record<string, string>>;
  /** qpos address (7 values) and dof address (6 values) of the floating base. */
  readonly rootQpos: number;
  readonly rootDof: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly geomStart: number;
  readonly geomEnd: number;
  readonly jointStart: number;
  readonly jointEnd: number;
  readonly dofStart: number;
  readonly dofEnd: number;
  readonly qposStart: number;
  readonly qposEnd: number;
}

/** One robot's view of a shared engine. Names are the robot's own, unprefixed names.
 * Lookups fail for objects the robot does not own, and clears touch only its ranges.
 * The view owns no native memory: the root Engine is disposed once, by its owner. */
export class EntityEngine implements EngineScope {
  constructor(readonly engine: Engine, readonly entity: SceneEntity) {}

  get prefix(): string { return this.entity.prefix; }
  get qpos(): Float64Array { return this.engine.qpos; }
  get qvel(): Float64Array { return this.engine.qvel; }
  get qfrcApplied(): Float64Array { return this.engine.qfrcApplied; }
  get xfrcApplied(): Float64Array { return this.engine.xfrcApplied; }

  forward() { this.engine.forward(); }

  jointQposAdr(name: string): number { return this.engine.model.jnt_qposadr[this.jointId(name)]; }
  jointDofAdr(name: string): number { return this.engine.model.jnt_dofadr[this.jointId(name)]; }

  bodyId(name: string): number {
    const { entity } = this, id = this.engine.bodyId(entity.prefix + name);
    if (id < entity.bodyStart || id >= entity.bodyEnd) throw new Error(`Body ${name} is not owned by ${entity.id}.`);
    return id;
  }

  actuatorLim(jointName: string): number { return this.engine.actuatorLim(jointName, this.entity.prefix); }

  hinges(): HingeSet { return this.engine.hingesIn(this.entity.jointStart, this.entity.jointEnd, this.entity.prefix); }

  allBodyIds(): number[] {
    const { bodyStart, bodyEnd } = this.entity;
    return Array.from({ length: bodyEnd - bodyStart }, (_, i) => bodyStart + i);
  }

  minGeomZ(bodyIds: Iterable<number>): number { return this.engine.minGeomZ(bodyIds); }

  clearVelocity() { this.engine.qvel.fill(0, this.entity.dofStart, this.entity.dofEnd); }
  clearAppliedTorque() { this.engine.qfrcApplied.fill(0, this.entity.dofStart, this.entity.dofEnd); }
  clearAppliedForce() { this.engine.xfrcApplied.fill(0, 6 * this.entity.bodyStart, 6 * this.entity.bodyEnd); }

  private jointId(name: string): number {
    const { entity } = this, id = this.engine.jointId(entity.prefix + name);
    if (id < entity.jointStart || id >= entity.jointEnd) throw new Error(`Joint ${name} is not owned by ${entity.id}.`);
    return id;
  }
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`).exec(tag)?.[2];
}

/** Name of the top-level body whose subtree holds the free joint `joint`, read from the
 * bundle's MJCF files in manifest order. The caller verifies the result in the compiled model. */
export function freeJointRootBody(xmlFiles: Iterable<string>, joint: string): string {
  for (const xml of xmlFiles) {
    const bodies: (string | undefined)[] = [];
    const text = xml.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of text.matchAll(/<\s*(\/?)\s*(body|joint|freejoint)\b([^>]*?)(\/?)\s*>/g)) {
      const [, close, kind, attrs, selfClosing] = tag;
      if (kind === 'body') {
        if (close) bodies.pop();
        else if (!selfClosing) bodies.push(attribute(attrs, 'name'));
        continue;
      }
      if (close || attribute(attrs, 'name') !== joint) continue;
      if (kind === 'joint' && attribute(attrs, 'type') !== 'free') continue;
      const root = bodies[0];
      if (!root) throw new Error(`Free joint ${joint} is not inside a named body.`);
      return root;
    }
  }
  throw new Error(`No free joint named ${joint} in the robot model.`);
}

/** Global `<option>` attributes authored in MJCF files, in file order, as text. `<flag>` children
 * are keyed `flag.<name>`. A repeated attribute keeps its last value, as repeated sections do. */
export function authoredOptions(xmlFiles: Iterable<string>): Map<string, string> {
  const options = new Map<string, string>();
  const read = (attrs: string, prefix: string) => {
    for (const [, name, , value] of attrs.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/g)) options.set(prefix + name, value);
  };
  for (const xml of xmlFiles) {
    const text = xml.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of text.matchAll(/<\s*option\b([^>]*?)(\/?)\s*>/g)) {
      read(tag[1], '');
      if (tag[2]) continue;
      const start = tag.index + tag[0].length, end = text.indexOf('</option', start);
      if (end < 0) throw new Error('An <option> element is not closed.');
      for (const flag of text.slice(start, end).matchAll(/<\s*flag\b([^>]*?)\/?\s*>/g)) read(flag[1], 'flag.');
    }
  }
  return options;
}
