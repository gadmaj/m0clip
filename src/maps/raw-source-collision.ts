/** Authored brush-entity and studio-prop collision for the raw map physics closure.
 * Only collision documented by the public Source SDK is emitted or treated as
 * absent; every other authored collision is a blocking requirement, never a
 * guessed shape and never silently non-solid. */
import { sourceAbort } from './raw-source-lzma';
import { unrepresentableBrushDetail, type SourceCollision, type SourceModelCollision, type SourceWorld } from './raw-source-geometry';
import type { SourceProps, SourcePropPlacement } from './raw-source-props';
import type { SourceLightingRequirement } from './raw-source-lighting';

/** A placement whose authored collision is documented as absent. */
export type SourcePropCollision = { mode: 'none'; reason: 'solid-none' | 'collision-disabled' | 'ornament' };
export interface SourceEntityCollision {
  /** World-frame metres, appended to the world model's collision. */
  collision: SourceCollision[];
  requirements: SourceLightingRequirement[];
  /** Placements with a decoded model whose collision is documented as absent. */
  props: ReadonlyMap<SourcePropPlacement, SourcePropCollision>;
}

const DYNAMIC_PROPS: Record<string, true> = { prop_dynamic: true, prop_dynamic_override: true, dynamic_prop: true };
// public/const.h SolidType_t SOLID_NONE ("no solid model"); game/server/props.h.
const SOLID_NONE = 0, SF_DYNAMICPROP_DISABLE_COLLISION = 256;

/** Applies a column-major model-local-metres -> world-frame-metres placement. */
function placed(matrix: Float64Array, local: Float64Array): Float64Array {
  if (matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))) throw new Error('Invalid Source collision placement matrix');
  const out = new Float64Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i], y = local[i + 1], z = local[i + 2];
    for (let r = 0; r < 3; r++) out[i + r] = matrix[r] * x + matrix[4 + r] * y + matrix[8 + r] * z + matrix[12 + r];
  }
  return out;
}

export async function assembleSourceEntityCollision(world: Pick<SourceWorld, 'decodeModelCollision'>,
  props: Pick<SourceProps, 'brushes' | 'placements' | 'models'>, options: { signal?: AbortSignal } = {}): Promise<SourceEntityCollision> {
  const { signal } = options;
  sourceAbort(signal);
  const collision: SourceCollision[] = [], requirements: SourceLightingRequirement[] = [];
  const records = new Map<SourcePropPlacement, SourcePropCollision>();
  const block = (code: string, detail: string, path?: string) => requirements.push({ code, detail, blocking: true, ...(path === undefined ? {} : { path }) });

  const models = new Map<number, SourceModelCollision>();
  for (const brush of props.brushes) {
    sourceAbort(signal);
    // SDK game/server/bmodels.cpp: CFuncWall is SOLID_BSP, CFuncIllusionary SOLID_NONE;
    // utils/vbsp/map.cpp moves func_detail brushes into the world.
    if (brush.classname === 'func_wall' || brush.classname === 'func_detail') {
      let model = models.get(brush.model);
      if (!model) { model = await world.decodeModelCollision(brush.model, signal); models.set(brush.model, model); }
      for (const hull of model.hulls) collision.push({ kind: 'entity-brush', entity: brush.entityIndex, model: brush.model,
        brush: hull.brush, contents: hull.contents, vertices: placed(brush.matrix, hull.vertices) });
      for (const thin of model.unrepresentableBrushes) block('brush-collision-unrepresentable',
        unrepresentableBrushDetail(`Entity ${brush.entityIndex} (${brush.classname}) model *${brush.model} brush ${thin.brush}`, thin.contents, thin.widthUnits));
    } else if (brush.classname === 'func_clip_vphysics') {
      block('brush-clip-collision-runtime', `Entity ${brush.entityIndex}: func_clip_vphysics blocks physics objects but not players; one shared collision world cannot separate them.`);
    } else if (brush.classname !== 'func_illusionary' && brush.capability !== 'nonvisual-brush') {
      block('brush-entity-collision-runtime', `Entity ${brush.entityIndex}: ${brush.classname} collision depends on entity simulation (movement, toggling or filtering).`);
    }
  }

  for (const placement of props.placements) {
    sourceAbort(signal);
    // Missing models are already blocking prop-missing-model requirements.
    if (!props.models.has(placement.modelPath)) continue;
    const label = `${placement.kind === 'static-prop' ? 'Static prop' : `Entity ${placement.entityIndex}`} ${placement.index} (${placement.classname})`;
    let reason: SourcePropCollision['reason'] | undefined;
    // SDK game/server/props.cpp: COrnamentProp and SF_DYNAMICPROP_DISABLE_COLLISION add FSOLID_NOT_SOLID.
    if (placement.kind === 'entity-model' && placement.classname === 'prop_dynamic_ornament') reason = 'ornament';
    else if (placement.kind === 'entity-model' && !Object.hasOwn(DYNAMIC_PROPS, placement.classname)) {
      block('entity-model-collision-runtime', `${label}: collision of this entity class depends on entity simulation.`, placement.modelPath);
      continue;
    } else if (placement.solid === SOLID_NONE) reason = 'solid-none';
    else if (placement.kind === 'entity-model') {
      const text = placement.entity?.values.spawnflags;
      const spawnflags = text ? Number(text) : 0;
      if (!Number.isSafeInteger(spawnflags)) throw new Error(`Invalid Source entity spawnflags: ${text}`);
      if (spawnflags & SF_DYNAMICPROP_DISABLE_COLLISION) reason = 'collision-disabled';
    }
    if (!reason) {
      block('prop-vphysics-collision-unsupported', `${label}: solid ${placement.solid} collision (model hull or .phy) is not converted yet.`, placement.modelPath);
      continue;
    }
    records.set(placement, { mode: 'none', reason });
  }
  return { collision, requirements, props: records };
}
