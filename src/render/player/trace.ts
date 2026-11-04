/** Ray queries against the rendered static world, for the third-person camera's collision.
 * Triangles are baked once into world space and binned into a uniform grid; queries walk the grid
 * cells along the ray (3D DDA) and test each triangle once (mailbox stamps). Queries allocate
 * nothing. Decorative layers Source doesn't collide with (sky, sprites, overlays, detail props,
 * decals) and invisible nodes are skipped. */
import * as THREE from 'three';

const MAX_CELLS = 1 << 21;

function decorative(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    const d = node.userData;
    if (!node.visible || d.sourceSky || d.sourceSprite || d.sourceOverlay || d.sourceDetail || d.sourceDecal) return true;
  }
  return false;
}

export class WorldRayGrid {
  private readonly tri: Float32Array;
  private readonly cellStart: Uint32Array;
  private readonly cellTris: Uint32Array;
  private readonly stamp: Uint32Array;
  private query = 0;
  private readonly min = new Float64Array(3);
  private readonly dims = new Int32Array(3);
  private readonly size: number;
  readonly triangles: number;

  constructor(objects: readonly THREE.Object3D[]) {
    const soup: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), m = new THREE.Matrix4(), instance = new THREE.Matrix4();
    for (const root of objects) {
      root.updateWorldMatrix(true, true);
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh || decorative(object)) return;
        const geometry = object.geometry as THREE.BufferGeometry, position = geometry.getAttribute('position');
        if (!position) return;
        const index = geometry.getIndex(), count = index ? index.count : position.count;
        const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
        for (let k = 0; k < instances; k++) {
          m.copy(object.matrixWorld);
          if (object instanceof THREE.InstancedMesh) { object.getMatrixAt(k, instance); m.multiply(instance); }
          for (let i = 0; i + 2 < count; i += 3) {
            const i0 = index ? index.getX(i) : i, i1 = index ? index.getX(i + 1) : i + 1, i2 = index ? index.getX(i + 2) : i + 2;
            a.fromBufferAttribute(position, i0).applyMatrix4(m);
            b.fromBufferAttribute(position, i1).applyMatrix4(m);
            c.fromBufferAttribute(position, i2).applyMatrix4(m);
            soup.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
          }
        }
      });
    }
    this.tri = Float32Array.from(soup);
    const n = this.triangles = this.tri.length / 9;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.tri.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], this.tri[i]); hi[k] = Math.max(hi[k], this.tri[i]); }
    if (!n) { lo.fill(0); hi.fill(0); }
    const extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    // About four triangles per occupied cell on average, bounded to MAX_CELLS cells.
    let size = Math.max(0.5, Math.cbrt(Math.max(1e-6, extent[0] * extent[1] * extent[2]) / Math.max(1, n / 4)));
    const cells = () => extent.reduce((p, e) => p * Math.max(1, Math.ceil(e / size)), 1);
    while (cells() > MAX_CELLS) size *= 1.25;
    this.size = size;
    for (let k = 0; k < 3; k++) { this.min[k] = lo[k]; this.dims[k] = Math.max(1, Math.ceil(extent[k] / size)); }
    const total = this.dims[0] * this.dims[1] * this.dims[2];
    const counts = new Uint32Array(total + 1);
    const visit = (t: number, add: (cell: number) => void) => {
      const o = t * 9, r: number[] = [];
      for (let k = 0; k < 3; k++) {
        const v0 = this.tri[o + k], v1 = this.tri[o + 3 + k], v2 = this.tri[o + 6 + k];
        r.push(this.cell(Math.min(v0, v1, v2), k), this.cell(Math.max(v0, v1, v2), k));
      }
      for (let z = r[4]; z <= r[5]; z++) for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++)
        add((z * this.dims[1] + y) * this.dims[0] + x);
    };
    for (let t = 0; t < n; t++) visit(t, cell => counts[cell + 1]++);
    for (let i = 0; i < total; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellTris = new Uint32Array(counts[total]);
    const fill = counts.slice(0, total);
    for (let t = 0; t < n; t++) visit(t, cell => { this.cellTris[fill[cell]++] = t; });
    this.stamp = new Uint32Array(n);
  }

  private cell(v: number, axis: number): number {
    const c = Math.floor((v - this.min[axis]) / this.size);
    return c < 0 ? 0 : c >= this.dims[axis] ? this.dims[axis] - 1 : c;
  }

  /** Ray parameter where the walk leaves cell `c` on `axis`. */
  private boundary(c: number, axis: number, step: number, dir: number, p: number, t0: number): number {
    if (Math.abs(dir) < 1e-12) return Infinity;
    return t0 + (this.min[axis] + (c + (step > 0 ? 1 : 0)) * this.size - p) / dir;
  }

  /** Distance along the unit direction `d` from `o` to the first triangle hit within `max`, or Infinity. */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    if (!this.triangles) return Infinity;
    if (++this.query === 0xffffffff) { this.stamp.fill(0); this.query = 1; }
    const s = this.size, mn = this.min, D = this.dims;
    // Clip the segment to the grid bounds.
    let t0 = 0, t1 = max;
    for (let k = 0; k < 3; k++) {
      const ok = k === 0 ? ox : k === 1 ? oy : oz, dk = k === 0 ? dx : k === 1 ? dy : dz;
      const lo = mn[k], hi = mn[k] + D[k] * s;
      if (Math.abs(dk) < 1e-12) { if (ok < lo || ok > hi) return Infinity; continue; }
      let a = (lo - ok) / dk, b = (hi - ok) / dk;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return Infinity;
    }
    const px = ox + dx * t0, py = oy + dy * t0, pz = oz + dz * t0;
    let x = this.cell(px, 0), y = this.cell(py, 1), z = this.cell(pz, 2);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tx = this.boundary(x, 0, sx, dx, px, t0), ty = this.boundary(y, 1, sy, dy, py, t0), tz = this.boundary(z, 2, sz, dz, pz, t0);
    const ddx = Math.abs(dx) < 1e-12 ? Infinity : s / Math.abs(dx), ddy = Math.abs(dy) < 1e-12 ? Infinity : s / Math.abs(dy),
      ddz = Math.abs(dz) < 1e-12 ? Infinity : s / Math.abs(dz);
    let best = Infinity;
    for (;;) {
      const cell = (z * D[1] + y) * D[0] + x;
      for (let i = this.cellStart[cell], end = this.cellStart[cell + 1]; i < end; i++) {
        const t = this.cellTris[i];
        if (this.stamp[t] === this.query) continue;
        this.stamp[t] = this.query;
        const hit = this.triangle(t, ox, oy, oz, dx, dy, dz);
        if (hit < best) best = hit;
      }
      const exit = Math.min(tx, ty, tz);
      if (best <= exit || exit > t1) break;
      if (tx === exit) { x += sx; tx += ddx; if (x < 0 || x >= D[0]) break; }
      else if (ty === exit) { y += sy; ty += ddy; if (y < 0 || y >= D[1]) break; }
      else { z += sz; tz += ddz; if (z < 0 || z >= D[2]) break; }
    }
    return best <= max ? best : Infinity;
  }

  /** Möller–Trumbore, double-sided (Source traces hit brush faces from either side). */
  private triangle(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const T = this.tri, i = t * 9;
    const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
    const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return Infinity;
    const inv = 1 / det, sx = ox - T[i], sy = oy - T[i + 1], sz = oz - T[i + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return Infinity;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return Infinity;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return d >= 0 ? d : Infinity;
  }
}
