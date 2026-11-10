/** Source's initial entity draw state for converted map props. A StartDisabled
 * prop_dynamic (or rendermode none) never draws until map logic enables it, and
 * m0clip does not run map logic. NeoTokyo maps pair such props with a visible
 * copy at the same origin: a disabled take-off/landing "rabbitfrog" over its idle
 * twin. Drawing both doubles the craft and its clip flies through the idle copy.
 *
 * Hidden placements stay loaded (their clips still bind); the root is invisible,
 * so it never draws, is never picked and never enters camera collision.
 *
 * Converted props carry `sourceBaselineVisible` on every prop node. The raw-source
 * importer's `sourcePlacement.baselineVisible` is applied by SourceProps instead.
 * Released maps converted before either field use the exact BSP-derived table below. */
import type * as THREE from 'three';

interface LegacyHidden {
  node: string;
  prop: string;
  position: readonly [number, number, number];
  /** Its own converted clip, or null when the placement has none. */
  clip: { loop: boolean; duration: number } | null;
}
export interface SourceBaselineDocument {
  scene: THREE.Object3D;
  animations: readonly THREE.AnimationClip[];
  parser: { json: { animations?: readonly { name?: string; extras?: { loop?: unknown } }[] } };
}

const EPSILON = 1e-6;
const RABBITFROG = 'models/nt/props_vehicles/rabbitfrog_dynamic.mdl';
const takeoff = { loop: false, duration: 9.966666221618652 }, takeoffShort = { loop: false, duration: 9.699999809265137 };
const landing = { loop: false, duration: 8.666666984558105 }, landingA = { loop: false, duration: 10 };
const frog = (node: string, position: LegacyHidden['position'], clip: LegacyHidden['clip']): LegacyHidden =>
  ({ node: `prop_dynamic:${node}:rabbitfrog_dynamic`, prop: RABBITFROG, position, clip });

/** Every StartDisabled studio-model entity in the released maps' BSP entity lumps,
 * identified by converted node name, model, origin and clip. */
const LEGACY_HIDDEN: Readonly<Record<string, readonly LegacyHidden[]>> = {
  nt_bullet_tdm: [{ node: 'prop_dynamic:421:bullettrain01', prop: 'models/nt/props_skybox/bullettrain01.mdl',
    position: [7.711439999999997, 118.67518048, -3.2258], clip: { loop: true, duration: 40 } }], // timer: run
  nt_dawn_ctg: [frog('732', [44.861734, 79.2988, -0.31282640000000006], landingA)], // hopperland
  nt_decom_ctg: [
    frog('566', [163.41497787095233, 34.56949593805573, 4.049332397839419], landing), // hopperland2
    frog('572', [4.882565253025308, -17.68050785628337, 1.8079093978394192], landing), // hopperland
  ],
  nt_dusk_ctg: [frog('725', [44.861734, 79.2988, -0.31282640000000006], landingA)], // hopperland
  nt_engage_ctg: [
    frog('863', [63.2076206, 115.63959599999998, 0.22270720000000002], takeoffShort), // hop_takeoff
    frog('865', [9.2795598, 7.782305999999997, 0.22270720000000002], takeoffShort), // hop_takeoff3
    frog('880', [59.0316066, 108.71047600000001, 0.019507200000000016], takeoff), // hop_takeoff1
    frog('883', [5.322696999999999, 4.086351999999997, 0.019507200000000016], takeoff), // hop_takeoff4
  ],
  nt_rise_ctg: [
    frog('813', [19.634845159999998, 32.007200399999995, 7.741112279999999], landing), // hopperland
    frog('847', [20.43245596, -2.511551999999999, 0.019507200000000016], takeoff), // hop_takeoff
  ],
  nt_saitama_ctg: [
    { node: 'prop_dynamic:1047:light1_off', prop: 'models/nt/props_light/light1_off.mdl',
      position: [61.141863999999984, 52.158216740000015, -4.201973769169019], clip: null },
    { node: 'prop_dynamic:1048:light1_off', prop: 'models/nt/props_light/light1_off.mdl',
      position: [43.260263999999985, 52.97101674000001, -4.201973769169019], clip: null },
    frog('1092', [7.948929999999994, 7.530416740000001, -0.8368293691690195], landingA), // hopperland
  ],
  nt_shrine_ctg: [
    frog('785', [112.14922959999998, -100.94902339999999, 0.01370575584914413], takeoff), // hop_takeoff1
    frog('786', [120.79564359999998, -93.81667799999998, 0.16610575584914414], takeoffShort), // hop_takeoff
    frog('788', [6.380835599999998, -4.807457999999999, -0.016654864150855948], takeoffShort), // hop_takeoff3
    frog('790', [7.5845416000000005, 1.1783059999999972, 0.008745135849144051], takeoff), // hop_takeoff4
  ],
  nt_skyline_ctg: [
    frog('1623', [-3.8924484000000246, 122.35891199999999, 2.8643072], takeoff), // hop_takeoff4
    frog('1624', [-3.0251908000000234, 115.17271859999998, 2.8643072], takeoffShort), // hop_takeoff3
  ],
};

function clipOf(document: SourceBaselineDocument, node: string): LegacyHidden['clip'] {
  const definitions = document.parser.json.animations ?? [];
  const index = definitions.findIndex(definition => definition.name === `${node}:animation`);
  if (index < 0) return null;
  const loop = definitions[index].extras?.loop, clip = document.animations[index];
  if (typeof loop !== 'boolean' || !clip) throw new TypeError(`Invalid Source prop clip for ${node}`);
  return { loop, duration: clip.duration };
}

function matches(entry: LegacyHidden, object: THREE.Object3D, clip: LegacyHidden['clip']): boolean {
  return object.userData.sourceProp === entry.prop && object.userData.sourceClass === 'prop_dynamic'
    && entry.position.every((value, i) => Math.abs(object.position.getComponent(i) - value) <= EPSILON)
    && (entry.clip === null ? clip === null
      : clip !== null && clip.loop === entry.clip.loop && Math.abs(clip.duration - entry.clip.duration) <= EPSILON);
}

/** Hide initially disabled props before any clone, pick grid or prop display binds
 * the documents. `releasedMapId` is null for local maps: only released data uses
 * the legacy table. Returns the number of hidden placements. */
export function applySourceBaseline(releasedMapId: string | null, documents: readonly SourceBaselineDocument[]): number {
  const props: THREE.Object3D[] = [];
  let flagged = 0, placements = 0;
  for (const document of documents) document.scene.traverse(object => {
    if (object.userData.sourcePlacement !== undefined) placements++;
    if (typeof object.userData.sourceProp !== 'string') return;
    props.push(object);
    if (object.userData.sourceBaselineVisible !== undefined) flagged++;
  });
  if (placements) return 0;
  if (flagged) {
    if (flagged !== props.length) throw new TypeError('Converted Source props have incomplete baseline visibility');
    let hidden = 0;
    for (const object of props) {
      const visible = object.userData.sourceBaselineVisible;
      if (typeof visible !== 'boolean') throw new TypeError('Invalid Source prop baseline visibility');
      if (!visible) { object.visible = false; hidden++; }
    }
    return hidden;
  }
  const entries = releasedMapId === null ? undefined : LEGACY_HIDDEN[releasedMapId];
  if (!entries) return 0;
  // Validate the whole table before hiding anything: different data must not lose a visible twin.
  const targets = entries.map(entry => {
    const found: { object: THREE.Object3D; document: SourceBaselineDocument }[] = [];
    for (const document of documents) document.scene.traverse(object => {
      if (object.userData.name === entry.node) found.push({ object, document });
    });
    if (found.length !== 1 || !matches(entry, found[0].object, clipOf(found[0].document, entry.node)))
      throw new Error(`Converted Source map ${releasedMapId} does not match its recorded disabled prop ${entry.node}`);
    return found[0].object;
  });
  for (const object of targets) object.visible = false;
  return targets.length;
}
