/** Lightweight selection metadata only. Model binaries are fetched after scene loading begins. */
import { KIT_LABELS, KIT_STYLES, type KitStyle } from '../render/robot-kit-data';
import type { CharacterAttribution, CharacterDefinition, CharacterPhysics } from '../render/characters/types';
import { decodePmodelId, type PmodelId } from './pmodels';
import gingerbreadNotice from '../../public/assets/characters/gingerbread-man/attribution.json';
import wrappedNotice from '../../public/assets/characters/the-wrapped/attribution.json';
import wrappedRig from '../../public/assets/characters/the-wrapped/rig.json';
import skeletonNotice from '../../public/assets/characters/psx-low-poly-skeleton/attribution.json';
import skeletonRig from '../../public/assets/characters/psx-low-poly-skeleton/rig.json';
import ralph from '../../public/assets/characters/ralph/definition.json';
import dragon from '../../public/assets/characters/dragon-wyvern/definition.json';
import solus from '../../public/assets/characters/solus/definition.json';
import psxCharacters from '../../public/assets/characters/characters-psx/catalog.json';
import horror from '../../public/assets/characters/psx-horror-entity/definition.json';
import bot02 from '../../public/assets/characters/bot-02/definition.json';
import ronin01 from '../../public/assets/characters/ronin-01/definition.json';
import malePsx from '../../public/assets/characters/male-psx-yugg0/definition.json';
import psxDog from '../../public/assets/characters/psx-dog/definition.json';

interface ConvertedNotice {
  name: string; creator: string; sourceUrl: string; license: string; licenseUrl: string;
  modifications: string | string[];
}
function notice(value: ConvertedNotice): CharacterAttribution {
  return { title: value.name, creator: value.creator, source: value.sourceUrl,
    license: value.license, licenseUrl: value.licenseUrl,
    modifications: typeof value.modifications === 'string' ? [value.modifications] : value.modifications };
}

export const AUTHORED_CHARACTERS = {
  'gingerbread-man': {
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
  },
  'the-wrapped': {
    id: 'the-wrapped', label: 'The Wrapped', url: '/assets/characters/the-wrapped/the-wrapped-512.glb',
    preview: '/assets/characters/the-wrapped/preview.min.png', attribution: notice(wrappedNotice),
    rig: wrappedRig,
  },
  'psx-low-poly-skeleton': {
    id: 'psx-low-poly-skeleton', label: 'Skeleton',
    url: '/assets/characters/psx-low-poly-skeleton/psx-low-poly-skeleton-512.glb',
    preview: '/assets/characters/psx-low-poly-skeleton/preview.min.png', attribution: notice(skeletonNotice),
    rig: skeletonRig,
  },
  ralph,
  'dragon-wyvern': dragon,
  solus,
  'psx-horror-entity': horror,
  'bot-02': bot02,
  'ronin-01': ronin01,
  'male-psx-yugg0': malePsx,
  'psx-dog': { ...psxDog, physics: 'go2' },
  ...psxCharacters,
} satisfies Record<string, CharacterDefinition>;

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
