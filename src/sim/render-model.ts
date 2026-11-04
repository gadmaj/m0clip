import { GEOM_MESH, type Engine } from './engine';
import type { RenderModel, SceneIdentity } from './protocol';

/** Copies the compiled geometry once; Robot and Player scenes use the same renderer boundary. */
export function renderModelFromEngine(engine: Engine, identity: SceneIdentity): RenderModel {
  const model = engine.model;
  const ngeom = model.ngeom, geomType = model.geom_type;
  const dataid = Int32Array.from(model.geom_dataid);
  const meshes: RenderModel['meshes'] = {};
  const vertadr = model.mesh_vertadr, vertnum = model.mesh_vertnum;
  const faceadr = model.mesh_faceadr, facenum = model.mesh_facenum;
  const vert = model.mesh_vert, face = model.mesh_face;
  const pos = model.mesh_pos, quat = model.mesh_quat;
  for (let geom = 0; geom < ngeom; geom++) {
    const mesh = dataid[geom];
    if (geomType[geom] !== GEOM_MESH || mesh < 0 || mesh in meshes) continue;
    meshes[mesh] = {
      name: engine.mj.mj_id2name(model, engine.mj.mjtObj.mjOBJ_MESH.value, mesh) ?? '',
      vert: vert.slice(3 * vertadr[mesh], 3 * (vertadr[mesh] + vertnum[mesh])),
      face: Uint32Array.from(face.subarray(3 * faceadr[mesh], 3 * (faceadr[mesh] + facenum[mesh]))),
      pos: [pos[3 * mesh], pos[3 * mesh + 1], pos[3 * mesh + 2]],
      quat: [quat[4 * mesh], quat[4 * mesh + 1], quat[4 * mesh + 2], quat[4 * mesh + 3]],
    };
  }
  return {
    ...identity,
    type: Int32Array.from(geomType), size: Float64Array.from(model.geom_size),
    rgba: Float32Array.from(model.geom_rgba), group: Int32Array.from(model.geom_group),
    contype: Int32Array.from(model.geom_contype), bodyid: Int32Array.from(model.geom_bodyid),
    dataid, meshes,
    bodyFrames: {parent: Int32Array.from(model.body_parentid), pos: Float64Array.from(model.body_pos), quat: Float64Array.from(model.body_quat)},
    geomFrames: {pos: Float64Array.from(model.geom_pos), quat: Float64Array.from(model.geom_quat)},
    bodyNames: Array.from({length: model.nbody}, (_, id) => engine.mj.mj_id2name(model, engine.mj.mjtObj.mjOBJ_BODY.value, id) ?? ''),
  };
}
