import { compatibleBody, isBodyVisual, type CharacterId } from '../characters/catalog';
import { KIT_REGIONS, kitRegion, type KitStyle, type RobotModules } from '../render/robot-kit-data';
import type { Appearance } from '../render/scene';
import type { VisualAssetSelection } from './asset-plan';

export interface LaunchVisualSelectionInput {
  terrain: string;
  /** The worker's resolved robot, not the launch request. */
  robot: string;
  character: CharacterId | null;
  sharedAppearance?: Appearance;
  rememberedAppearance?: Appearance;
  queryBody?: string | null;
  sharedHead?: 'stock' | 'ghost';
  rememberedHead?: 'stock' | 'ghost';
  /** Available after model construction; only needed for procedural kit paint. */
  partNames?: readonly string[];
}

export interface ResolvedLaunchVisualSelection extends VisualAssetSelection {
  appearance: Appearance;
}

const KIT_PAINT: Record<Exclude<KitStyle, 'stock'>, readonly number[]> = {
  boxy: [0xd8bd74, 0xe1c991, 0xa59776, 0x665a47, 0xa59776, 0x665a47],
  round: [0xc9eef1, 0x78c5cf, 0x9ed5db, 0x426b80, 0x9ed5db, 0x426b80],
  prism: [0xebc4f8, 0x9b7bc4, 0xb99cdd, 0x51416d, 0xb99cdd, 0x51416d],
};

/** Resolve once before planning AND applying appearance, without loading renderer assets. */
export function resolveLaunchVisualSelection(input: LaunchVisualSelectionInput): ResolvedLaunchVisualSelection {
  const { terrain, robot, character } = input;
  let appearance: Appearance = input.sharedAppearance ?? input.rememberedAppearance ?? { colorway: 'grey', parts: {} };
  let body = appearance.sourceBody ?? 'stock';
  let head = input.sharedHead ?? input.rememberedHead ?? 'stock';
  if (character === null) {
    if (!input.sharedAppearance && isBodyVisual(input.queryBody) && compatibleBody(input.queryBody, robot)) {
      body = input.queryBody;
    }
  } else {
    body = isBodyVisual(character) ? character : 'stock';
    // An explicit character must never inherit a linked/remembered native head.
    head = 'stock';
    if (body === 'stock') {
      const style = character as KitStyle;
      const parts = { ...appearance.parts };
      if (style !== 'stock') {
        for (const name of input.partNames ?? []) {
          const region = kitRegion(name);
          if (region) parts[name] = { color: KIT_PAINT[style][KIT_REGIONS.indexOf(region)], finish: 'satin' };
        }
      }
      const modules = Object.fromEntries(KIT_REGIONS.map(region => [region, style])) as RobotModules;
      appearance = { ...appearance, parts, modules };
    }
  }
  if (!compatibleBody(body, robot)) body = 'stock';
  appearance = { ...appearance, sourceBody: body };
  // Preserve a null-character head preference even while a body/robot suppresses
  // its use. The planner applies the same compatibility gate as SceneView.
  return { terrain, robot, body, head, appearance };
}
