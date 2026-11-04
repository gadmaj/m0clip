/** Source Studio models from the person's own game files: decoding (MDL/VVD/VTX/ANI and
 * $includemodel merging) and local-space pose sampling. Data stays native (inches, +Z up, Source
 * UVs, authored winding); see types.ts. */
import { canonicalSourcePath } from '../assets/local-content';
import type { StudioModelData } from './types';

export { StudioFormatError, StudioUnsupportedError } from './binary';
export { loadStudioModel } from './model';
export { createStudioPose, encodeStudioPoseParameter, StudioPoseSampler, studioSequenceCps, studioSequenceDuration } from './sampler';
export type * from './types';

/** Submodel of body part `part` selected by the entity's body value (Source bodygroups). */
export function bodyGroupModel(model: StudioModelData, body: number, part: number): number {
  const p = model.bodyParts[part];
  if (!p) throw new RangeError(`Studio model ${model.path} has no body part ${part}.`);
  return Math.floor(body/p.base) % p.models.length;
}

/** VMT paths Source tries for a texture, in $cdmaterials order (duplicates dropped); the first that
 * exists wins. The VTX root-LOD replacement, when present, replaces the authored name. */
export function studioMaterialCandidates(model: StudioModelData, textureIndex: number): string[] {
  const { textures, searchDirectories, replacements } = model.materials;
  const texture = textures[textureIndex];
  if (!texture) throw new RangeError(`Studio model ${model.path} has no texture ${textureIndex}.`);
  const name = replacements.get(textureIndex) ?? texture.name;
  return [...new Set(searchDirectories.map(dir => canonicalSourcePath(`materials/${dir}/${name}.vmt`)))];
}
