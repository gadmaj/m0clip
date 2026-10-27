import { loadPmodel, pmodelId, type PmodelRef } from './pmodels';
import { loadGoldSrcCharacter } from '../render/characters/goldsrc';
import type { CharacterAsset } from '../render/characters/types';
import type { PlannedAsset } from '../loading/asset-plan';

interface PreparedPmodel {
  asset: CharacterAsset;
  resources: PlannedAsset[];
}

// Only explicit startup selections enter this cache. Ownership transfers to the
// scene's bounded body cache, which already disposes assets on eviction.
const prepared = new Map<string, Promise<PreparedPmodel>>();

function prepare(ref: PmodelRef): Promise<PreparedPmodel> {
  const id = pmodelId(ref);
  const existing = prepared.get(id);
  if (existing) return existing;
  const resources: PlannedAsset[] = [];
  const pending: Promise<PreparedPmodel> = loadPmodel(ref, undefined, asset => resources.push(asset))
    .then(loadGoldSrcCharacter)
    .then(asset => ({ asset, resources }))
    .catch((error: unknown) => {
      if (prepared.get(id) === pending) prepared.delete(id);
      throw error;
    });
  prepared.set(id, pending);
  return pending;
}

/** The real decoder discovers texture/sequence dependencies, retaining its result. */
export async function preparePmodelCharacter(ref: PmodelRef): Promise<PlannedAsset[]> {
  return (await prepare(ref)).resources;
}

/** Scene loader: consume the exact prepared asset, or perform an ordinary later selection. */
export async function loadPreparedPmodelCharacter(ref: PmodelRef): Promise<CharacterAsset> {
  const id = pmodelId(ref);
  const pending = prepare(ref);
  const result = await pending;
  if (prepared.get(id) === pending) prepared.delete(id);
  return result.asset;
}

/** Release unconsumed startup resources after cancellation, failure or Original recovery. */
export function discardPreparedPmodelCharacters(): void {
  for (const pending of prepared.values()) {
    void pending.then(result => result.asset.dispose(), () => {});
  }
  prepared.clear();
}
