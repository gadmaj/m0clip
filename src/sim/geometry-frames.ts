/** Fixed world transforms travel with the model; frame rows retain original geom identity. */
import { matToQuat, validGeometryPartition, type GeometryPartition } from '../core/geometry';

export interface FrameGeometryLayout extends GeometryPartition {
  /** Original Float32 row-major matrices, avoiding a quaternion round-trip in live rendering. */
  readonly fixedXmat: Float32Array;
}

export function createFrameGeometryLayout(bodyid: Int32Array, xpos: ArrayLike<number>, xmat: ArrayLike<number>) {
  const ngeom = bodyid.length;
  if (xpos.length !== ngeom*3 || xmat.length !== ngeom*9) throw new RangeError('Incomplete initial geometry frame.');
  let count = 0;
  for (let g = 0; g < ngeom; g++) if (bodyid[g] === 0) count++;
  const fixedIds = new Uint32Array(count), fixed = new Float32Array(count*7), fixedXmat = new Float32Array(count*9);
  const movingIds = new Uint32Array(ngeom-count);
  let f = 0, m = 0;
  for (let g = 0; g < ngeom; g++) {
    if (bodyid[g] !== 0) { movingIds[m++] = g; continue; }
    fixedIds[f] = g;
    for (let k = 0; k < 3; k++) fixed[f*7+k] = xpos[g*3+k];
    for (let k = 0; k < 9; k++) fixedXmat[f*9+k] = xmat[g*9+k];
    // Match the former recorder's Float32 matrix input before encoding its quaternion.
    matToQuat(fixedXmat, f*9, fixed, f*7+3);
    f++;
  }
  return { layout: { fixedIds, fixed, fixedXmat } satisfies FrameGeometryLayout, movingIds };
}

export function copyMovingGeometry(ids: Uint32Array, sourceXpos: ArrayLike<number>, sourceXmat: ArrayLike<number>,
    xpos: Float32Array, xmat: Float32Array): void {
  if (xpos.length !== ids.length*3 || xmat.length !== ids.length*9) throw new RangeError('Invalid moving geometry frame size.');
  for (let i = 0; i < ids.length; i++) {
    const g = ids[i];
    for (let k = 0; k < 3; k++) xpos[i*3+k] = sourceXpos[g*3+k];
    for (let k = 0; k < 9; k++) xmat[i*9+k] = sourceXmat[g*9+k];
  }
}

/** Main-owned dense buffers: initialize world once, then scatter only current moving rows. */
export class FrameGeometryBuffer {
  readonly xpos: Float32Array;
  readonly xmat: Float32Array;
  readonly partition: GeometryPartition;
  private readonly movingIds: Uint32Array;

  constructor(ngeom: number, layout: FrameGeometryLayout) {
    if (!validGeometryPartition(layout, ngeom) || !(layout.fixedXmat instanceof Float32Array)
        || layout.fixedXmat.length !== layout.fixedIds.length*9) throw new RangeError('Invalid fixed geometry layout.');
    this.xpos = new Float32Array(ngeom*3);
    this.xmat = new Float32Array(ngeom*9);
    this.partition = { fixedIds: layout.fixedIds, fixed: layout.fixed };
    this.movingIds = new Uint32Array(ngeom-layout.fixedIds.length);
    let fixed = 0, moving = 0;
    for (let g = 0; g < ngeom; g++) {
      if (fixed >= layout.fixedIds.length || layout.fixedIds[fixed] !== g) { this.movingIds[moving++] = g; continue; }
      for (let k = 0; k < 3; k++) this.xpos[g*3+k] = layout.fixed[fixed*7+k];
      for (let k = 0; k < 9; k++) this.xmat[g*9+k] = layout.fixedXmat[fixed*9+k];
      fixed++;
    }
  }

  apply(xpos: Float32Array, xmat: Float32Array): void {
    if (xpos.length !== this.movingIds.length*3 || xmat.length !== this.movingIds.length*9)
      throw new RangeError('Incomplete moving geometry frame.');
    for (let i = 0; i < this.movingIds.length; i++) {
      const g = this.movingIds[i];
      for (let k = 0; k < 3; k++) this.xpos[g*3+k] = xpos[i*3+k];
      for (let k = 0; k < 9; k++) this.xmat[g*9+k] = xmat[i*9+k];
    }
  }
}
