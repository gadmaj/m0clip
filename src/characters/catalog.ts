/** Lightweight selection metadata only. Model binaries are fetched after scene loading begins. */
import { KIT_LABELS, KIT_STYLES, type KitStyle } from '../render/robot-kit-data';
import type { CharacterAttribution, CharacterDefinition, CharacterPhysics } from '../render/characters/types';
import { decodePmodelId, type PmodelId } from './pmodels';
const generated = import.meta.glob<unknown>([
  '../../public/assets/characters/{gingerbread-man,the-wrapped,psx-low-poly-skeleton}/attribution.json',
  '../../public/assets/characters/{the-wrapped,psx-low-poly-skeleton}/rig.json',
  '../../public/assets/characters/{ralph,dragon-wyvern,solus,psx-horror-entity,bot-02,ronin-01,male-psx-yugg0,psx-dog}/definition.json',
  '../../public/assets/characters/characters-psx/catalog.json',
], { eager: true, import: 'default' });

function metadata<T>(path: string): T | undefined {
  return generated[`../../public/assets/characters/${path}`] as T | undefined;
}
const gingerbreadNotice = metadata<ConvertedNotice>('gingerbread-man/attribution.json');
const wrappedNotice = metadata<ConvertedNotice>('the-wrapped/attribution.json');
const wrappedRig = metadata<CharacterDefinition['rig']>('the-wrapped/rig.json');
const skeletonNotice = metadata<ConvertedNotice>('psx-low-poly-skeleton/attribution.json');
const skeletonRig = metadata<CharacterDefinition['rig']>('psx-low-poly-skeleton/rig.json');
const ralph = metadata<CharacterDefinition>('ralph/definition.json');
const dragon = metadata<CharacterDefinition>('dragon-wyvern/definition.json');
const solus = metadata<CharacterDefinition>('solus/definition.json');
const psxCharacters = metadata<Record<string, CharacterDefinition>>('characters-psx/catalog.json');
const horror = metadata<CharacterDefinition>('psx-horror-entity/definition.json');
const bot02 = metadata<CharacterDefinition>('bot-02/definition.json');
const ronin01 = metadata<CharacterDefinition>('ronin-01/definition.json');
const malePsx = metadata<CharacterDefinition>('male-psx-yugg0/definition.json');
const psxDog = metadata<CharacterDefinition>('psx-dog/definition.json');

interface ConvertedNotice {
  name: string; creator: string; sourceUrl: string; license: string; licenseUrl: string;
  modifications: string | string[];
}
function notice(value: ConvertedNotice): CharacterAttribution {
  return { title: value.name, creator: value.creator, source: value.sourceUrl,
    license: value.license, licenseUrl: value.licenseUrl,
    modifications: typeof value.modifications === 'string' ? [value.modifications] : value.modifications };
}

export const AUTHORED_CHARACTERS: Record<string, CharacterDefinition> = {};

if (gingerbreadNotice) {
  AUTHORED_CHARACTERS['gingerbread-man'] = {
    id: 'gingerbread-man', label: 'Gingerbread Man',
    url: '/assets/characters/gingerbread-man/gingerbread-man-512.glb',
    preview: '/assets/characters/gingerbread-man/preview.min.png',
    attribution: notice(gingerbreadNotice),
    rig: {
      root: 'spine01', alignment: [0.5, 0.5, 0.5, 0.5],
      bindings: {
        spine01: ['pelvis'], spine02: ['torso_link'],
        neck: ['head_pitch_link', 'torso_link'], head: ['head_yaw_link', 'head_pitch_link', 'torso_link'],
        'upper_arm.L': ['left_shoulder_yaw_link'], 'forearm.L': ['left_elbow_link'],
        'hand.L': ['left_wrist_roll_link', 'left_elbow_link'],
        'upper_arm.R': ['right_shoulder_yaw_link'], 'forearm.R': ['right_elbow_link'],
        'hand.R': ['right_wrist_roll_link', 'right_elbow_link'],
        'hip.L': ['left_hip_yaw_link'], 'chin.L': ['left_knee_link'], 'foot.L': ['left_ankle_roll_link'],
        'hip.R': ['right_hip_yaw_link'], 'chin.R': ['right_knee_link'], 'foot.R': ['right_ankle_roll_link'],
      },
      aim: {
        'upper_arm.L': 'forearm.L', 'forearm.L': 'hand.L', 'upper_arm.R': 'forearm.R', 'forearm.R': 'hand.R',
        'hip.L': 'chin.L', 'chin.L': 'foot.L', 'hip.R': 'chin.R', 'chin.R': 'foot.R',
      },
      feet: ['foot.L', 'foot.R'],
    },
  };
}
if (wrappedNotice && wrappedRig) {
  AUTHORED_CHARACTERS['the-wrapped'] = {
    id: 'the-wrapped', label: 'The Wrapped', url: '/assets/characters/the-wrapped/the-wrapped-512.glb',
    preview: '/assets/characters/the-wrapped/preview.min.png', attribution: notice(wrappedNotice),
    rig: wrappedRig,
  };
}
if (skeletonNotice && skeletonRig) {
  AUTHORED_CHARACTERS['psx-low-poly-skeleton'] = {
    id: 'psx-low-poly-skeleton', label: 'Skeleton',
    url: '/assets/characters/psx-low-poly-skeleton/psx-low-poly-skeleton-512.glb',
    preview: '/assets/characters/psx-low-poly-skeleton/preview.min.png', attribution: notice(skeletonNotice),
    rig: skeletonRig,
  };
}
if (ralph) AUTHORED_CHARACTERS.ralph = ralph;
if (dragon) AUTHORED_CHARACTERS['dragon-wyvern'] = dragon;
if (solus) AUTHORED_CHARACTERS.solus = solus;
if (horror) AUTHORED_CHARACTERS['psx-horror-entity'] = horror;
if (bot02) AUTHORED_CHARACTERS['bot-02'] = bot02;
if (ronin01) AUTHORED_CHARACTERS['ronin-01'] = ronin01;
if (malePsx) AUTHORED_CHARACTERS['male-psx-yugg0'] = malePsx;
if (psxDog) AUTHORED_CHARACTERS['psx-dog'] = { ...psxDog, physics: 'go2' };
if (psxCharacters) Object.assign(AUTHORED_CHARACTERS, psxCharacters);

export type AuthoredCharacterId = keyof typeof AUTHORED_CHARACTERS;
export type BodyVisual = 'stock' | 'dog' | AuthoredCharacterId | PmodelId;
export type CharacterId = KitStyle | Exclude<BodyVisual, 'stock'>;
export interface CharacterChoice { id: CharacterId; label: string }
export const CHARACTER_CHOICES: readonly CharacterChoice[] = [
  ...KIT_STYLES.map(id => ({ id, label: KIT_LABELS[id] })),
  { id: 'dog', label: 'Dog · Half-Life 2' },
  { id: 'pmodels:hl:picardia_v1sc', label: 'Picardia' },
  ...Object.entries(AUTHORED_CHARACTERS).map(([id, definition]) => ({
    id: id as AuthoredCharacterId, label: definition.label,
  })),
];
export function authoredCharacter(id: string): CharacterDefinition | undefined {
  return Object.hasOwn(AUTHORED_CHARACTERS, id) ? AUTHORED_CHARACTERS[id as AuthoredCharacterId] : undefined;
}
export function isBodyVisual(value: unknown): value is BodyVisual {
  return typeof value === 'string' && (value === 'stock' || value === 'dog'
    || Object.hasOwn(AUTHORED_CHARACTERS, value) || decodePmodelId(value) !== null);
}
export function isCharacter(value: unknown): value is CharacterId {
  return isBodyVisual(value) || typeof value === 'string' && (KIT_STYLES as readonly string[]).includes(value);
}
export function characterPhysics(character: CharacterId): CharacterPhysics | null {
  return (KIT_STYLES as readonly string[]).includes(character) ? null : authoredCharacter(character)?.physics ?? 'r1';
}
export function compatibleBody(body: BodyVisual | undefined, robot: string): boolean {
  if (!body || body === 'stock') return true;
  const physics = characterPhysics(body);
  return physics === null || (physics === 'r1' ? robot.startsWith('r1') : robot === physics);
}
