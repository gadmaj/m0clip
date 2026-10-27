import { authoredCharacter, compatibleBody, isBodyVisual } from '../characters/catalog';
import { decodePmodelId } from '../characters/pmodels';
import { preparePmodelCharacter } from '../characters/prepared-pmodel';
import { DOG_URL } from '../render/source-robot/body';
import { GHOST_HEAD_URL } from '../render/source-robot/head';
import { FLASHLIGHT_URL, prepareFlashlightAsset } from '../render/source-flashlight';
import { catalogueAssetKey, expandAssetUrls } from './catalogue';
import type { StartupAssetCatalogue, VisualAssetPlan, VisualAssetSelection } from './asset-plan';

export { resolveLaunchVisualSelection } from './visual-selection';
export type { LaunchVisualSelectionInput, ResolvedLaunchVisualSelection } from './visual-selection';

/** Original recovery can replace a selected character, never a missing map/runtime asset. */
export class OptionalVisualAssetError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'OptionalVisualAssetError';
  }
}

function requireVisualSizes(catalogue: StartupAssetCatalogue, urls: readonly string[], prepared: VisualAssetPlan['prepared']): void {
  const retained = new Set(prepared.map(asset => catalogueAssetKey(asset.url)));
  for (const url of urls) {
    const key = catalogueAssetKey(url);
    if (!retained.has(key) && (!Object.hasOwn(catalogue.sizes, key) || !Number.isSafeInteger(catalogue.sizes[key]) || catalogue.sizes[key] < 0)) {
      throw new Error(`The startup catalogue has no exact visual payload size for ${key}.`);
    }
  }
}

/** Load-only module. Do not import from the selection shell: native preparation uses Three. */
export async function planVisualAssets(selection: VisualAssetSelection, catalogue: StartupAssetCatalogue): Promise<VisualAssetPlan> {
  const roots = [FLASHLIGHT_URL];
  if (selection.terrain.startsWith('map:')) {
    const id = selection.terrain.slice(4);
    const map = catalogue.mapVisuals[id];
    if (!map) throw new Error(`The startup catalogue has no visual closure for map ${id}.`);
    roots.push(...map);
  }
  const common = expandAssetUrls(catalogue, roots);
  requireVisualSizes(catalogue, common, []);
  const cookie = await prepareFlashlightAsset();
  const characterRoots: string[] = [];
  let prepared: VisualAssetPlan['prepared'] = [];
  let characterUrls: string[];
  try {
    if (!isBodyVisual(selection.body)) throw new Error(`Unknown selected character: ${selection.body}`);
    const body = compatibleBody(selection.body, selection.robot) ? selection.body : 'stock';
    if (body === 'dog') characterRoots.push(DOG_URL);
    else if (body !== 'stock') {
      const definition = authoredCharacter(body);
      if (definition) characterRoots.push(definition.url);
      else {
        const source = decodePmodelId(body);
        if (!source) throw new Error(`Unknown selected character: ${body}`);
        // Use the real parser, not metadata flags or a second MDL dependency parser.
        // Its completed decoded asset transfers into SceneView's ordinary body cache.
        prepared = await preparePmodelCharacter(source);
        characterRoots.push(...prepared.map(asset => asset.url));
      }
    } else if (selection.head === 'ghost' && selection.robot.startsWith('r1')) {
      characterRoots.push(GHOST_HEAD_URL);
    }
    characterUrls = expandAssetUrls(catalogue, characterRoots);
    requireVisualSizes(catalogue, characterUrls, prepared);
  } catch (error) {
    throw new OptionalVisualAssetError(error);
  }
  const urls = [...new Set([...common, ...characterUrls])];
  return { urls, prepared: [cookie, ...prepared] };
}
