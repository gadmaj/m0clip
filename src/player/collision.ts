/** Swept Source-axis player hulls against the compiled MuJoCo world collision geometry.
 *
 * Everything here works in Source units on Source axes: the map's MuJoCo geoms are carried back
 * through the SourceFrame once, so the player's box stays axis-aligned in Source space even when
 * the app frame is turned by the map's spawn yaw.
 *
 * Solids are the world-welded geoms that take part in collision (contype or conaffinity set) on
 * non-mocap bodies; robots, mocap shadows and visual-only geoms are excluded. Each convex solid is
 * clipped as a brush: the box hull's Minkowski sum with a polytope is bounded by the polytope's face
 * planes, the box axes and every polytope edge crossed with a box axis, each pushed out by the box
 * support. Shapes follow MuJoCo's collision semantics: meshes are their compiled convex hull, planes
 * are infinite half-spaces, and heightfields are the triangular prisms mjc_ConvexHField builds, down
 * to the field's base. Unsupported static shapes are refused instead of approximated.
 *
 * Hits stop DIST_EPSILON in front of the surface, as Source's box traces do. */
import {
  GEOM_BOX, GEOM_CYLINDER, GEOM_HFIELD, GEOM_MESH, GEOM_PLANE, type Engine,
} from '../sim/engine';
import { INCH, appToSourceDirection, appToSourcePoint } from './source-frame';
import type { PlayerCollisionWorld, PlayerTrace, SourceFrame } from './types';

/** Source's coordsize.h DIST_EPSILON: traces stop this far (inches) in front of a solid. */
export const DIST_EPSILON = 1/32;

const KIND_POLY = 0, KIND_CYLINDER = 1, KIND_HFIELD = 2;
/** Leaves per BVH node. */
const LEAF_SIZE = 4;
/** Broad-phase padding: contains every DIST_EPSILON-expanded solid. */
const BROAD_MARGIN = 2*DIST_EPSILON;
/** Unsigned axes closer than this (|cos|) are one separating axis. */
const SAME_AXIS = 1 - 1e-10;
/** Hull faces closer than this (cos) are one coplanar facet; their shared edge is a diagonal. */
const COPLANAR = 1 - 1e-10;
/** Zero-length cross products (parallel edge and axis) carry no separating axis. */
const TINY = 1e-24;
/** Upright cylinders: axis within this of Source ±Z. */
const UPRIGHT = 1 - 1e-12;

interface HfieldData {
  geom: number;
  nrow: number;
  ncol: number;
  /** Local field half-width x, half-depth y, elevation scale z and base depth (metres). */
  size: Float64Array;
  /** Compiled normalized elevations, row 0 at local -y. */
  data: Float32Array;
  /** Source-from-local rotation, row-major. */
  rot: Float64Array;
  /** Source position of the field origin. */
  pos: Float64Array;
}

/** Bounding volume hierarchy over solid leaves, depth-first with the left child adjacent. */
interface Bvh {
  bounds: Float64Array;
  right: Int32Array;
  start: Int32Array;
  count: Int32Array;
  order: Int32Array;
  depth: number;
}

function buildBvh(leafBounds: Float64Array, n: number): Bvh {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const centroid = new Float64Array(3*n);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) centroid[3*i+k] = (leafBounds[6*i+k] + leafBounds[6*i+3+k])/2;
  const bounds: number[] = [], right: number[] = [], start: number[] = [], count: number[] = [];
  let depth = 0;
  const build = (lo: number, hi: number, level: number): number => {
    const id = start.length;
    depth = Math.max(depth, level);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const leaf = order[i];
      for (let k = 0; k < 3; k++) {
        box[k] = Math.min(box[k], leafBounds[6*leaf+k]);
        box[3+k] = Math.max(box[3+k], leafBounds[6*leaf+3+k]);
        cmin[k] = Math.min(cmin[k], centroid[3*leaf+k]);
        cmax[k] = Math.max(cmax[k], centroid[3*leaf+k]);
      }
    }
    bounds.push(...box);
    right.push(-1); start.push(lo); count.push(hi - lo);
    if (hi - lo <= LEAF_SIZE) return id;
    let axis = 0;
    for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
    order.subarray(lo, hi).sort((a, b) => centroid[3*a+axis] - centroid[3*b+axis]);
    const mid = (lo + hi) >> 1;
    count[id] = 0;
    build(lo, mid, level + 1);
    right[id] = build(mid, hi, level + 1);
    return id;
  };
  if (n > 0) build(0, n, 1);
  return { bounds: Float64Array.from(bounds), right: Int32Array.from(right), start: Int32Array.from(start),
    count: Int32Array.from(count), order, depth };
}

/** Construction-time brush planes for one convex polytope given Source-space vertices, facet
 * normals and edge directions. Every candidate axis is used with both signs: any direction's
 * support plane bounds the Minkowski sum, and these axes are the ones that make it exact. */
function polytopePlanes(verts: ArrayLike<number>, faces: ArrayLike<number>, edges: ArrayLike<number>,
    out: number[]): void {
  const axes: number[] = [];
  const addAxis = (x: number, y: number, z: number) => {
    const len2 = x*x + y*y + z*z;
    if (!(len2 > TINY)) return;
    const inv = 1/Math.sqrt(len2);
    x *= inv; y *= inv; z *= inv;
    for (let i = 0; i < axes.length; i += 3)
      if (Math.abs(axes[i]*x + axes[i+1]*y + axes[i+2]*z) > SAME_AXIS) return;
    axes.push(x, y, z);
  };
  for (let i = 0; i < faces.length; i += 3) addAxis(faces[i], faces[i+1], faces[i+2]);
  addAxis(1, 0, 0); addAxis(0, 1, 0); addAxis(0, 0, 1);
  for (let i = 0; i < edges.length; i += 3) {
    const ex = edges[i], ey = edges[i+1], ez = edges[i+2];
    const len = Math.hypot(ex, ey, ez);
    if (!(len > 0)) continue;
    const x = ex/len, y = ey/len, z = ez/len;
    addAxis(0, z, -y);   // edge × X
    addAxis(-z, 0, x);   // edge × Y
    addAxis(y, -x, 0);   // edge × Z
  }
  for (let a = 0; a < axes.length; a += 3) {
    const x = axes[a], y = axes[a+1], z = axes[a+2];
    let max = -Infinity, min = Infinity;
    for (let v = 0; v < verts.length; v += 3) {
      const d = x*verts[v] + y*verts[v+1] + z*verts[v+2];
      if (d > max) max = d;
      if (d < min) min = d;
    }
    out.push(x, y, z, max, -x, -y, -z, -min);
  }
}

class CollisionWorld implements PlayerCollisionWorld {
  // ---- per-trace state (fields, so traces never allocate) ----
  private sx = 0; private sy = 0; private sz = 0;
  private ex = 0; private ey = 0; private ez = 0;
  private dx = 0; private dy = 0; private dz = 0;
  private invx = 0; private invy = 0; private invz = 0;
  /** Hull centre offset and half extents. */
  private cx = 0; private cy = 0; private cz = 0;
  private hx = 0; private hy = 0; private hz = 0;
  /** Hull-centre start/end. */
  private scx = 0; private scy = 0; private scz = 0;
  private ecx = 0; private ecy = 0; private ecz = 0;
  private qminx = 0; private qminy = 0; private qminz = 0;
  private qmaxx = 0; private qmaxy = 0; private qmaxz = 0;
  private fraction = 1;
  private nx = 0; private ny = 0; private nz = 0;
  private hitGeom = -1;
  private solidGeom = -1;
  private startSolid = false;
  private allSolid = false;
  // ---- per-brush clip state ----
  private enter = -1;
  private leave = 1;
  private startOut = false;
  private getOut = false;
  private bnx = 0; private bny = 0; private bnz = 0;
  // ---- scratch ----
  private readonly stack: Int32Array;
  private readonly prism = new Float64Array(18);
  private readonly prismAxes = new Float64Array(3*29);

  constructor(
    private readonly planes: Float64Array,
    private readonly planeGeoms: Int32Array,
    private readonly polyStart: Int32Array,
    private readonly polyPlanes: Float64Array,
    private readonly cylinders: Float64Array,
    private readonly hfields: readonly HfieldData[],
    private readonly leafKind: Uint8Array,
    private readonly leafIndex: Int32Array,
    private readonly leafGeom: Int32Array,
    private readonly leafBounds: Float64Array,
    private readonly bvh: Bvh,
  ) {
    this.stack = new Int32Array(bvh.depth + 1);
  }

  traceHull(start: ArrayLike<number>, end: ArrayLike<number>,
      mins: ArrayLike<number>, maxs: ArrayLike<number>, out: PlayerTrace): void {
    this.sx = start[0]; this.sy = start[1]; this.sz = start[2];
    this.ex = end[0]; this.ey = end[1]; this.ez = end[2];
    this.dx = this.ex - this.sx; this.dy = this.ey - this.sy; this.dz = this.ez - this.sz;
    this.invx = 1/this.dx; this.invy = 1/this.dy; this.invz = 1/this.dz;
    this.cx = (mins[0] + maxs[0])/2; this.cy = (mins[1] + maxs[1])/2; this.cz = (mins[2] + maxs[2])/2;
    this.hx = (maxs[0] - mins[0])/2; this.hy = (maxs[1] - mins[1])/2; this.hz = (maxs[2] - mins[2])/2;
    if (!(this.hx >= 0 && this.hy >= 0 && this.hz >= 0)) throw new RangeError('Trace hull mins exceed maxs.');
    this.scx = this.sx + this.cx; this.scy = this.sy + this.cy; this.scz = this.sz + this.cz;
    this.ecx = this.ex + this.cx; this.ecy = this.ey + this.cy; this.ecz = this.ez + this.cz;
    this.qminx = Math.min(this.sx, this.ex) + mins[0] - BROAD_MARGIN;
    this.qminy = Math.min(this.sy, this.ey) + mins[1] - BROAD_MARGIN;
    this.qminz = Math.min(this.sz, this.ez) + mins[2] - BROAD_MARGIN;
    this.qmaxx = Math.max(this.sx, this.ex) + maxs[0] + BROAD_MARGIN;
    this.qmaxy = Math.max(this.sy, this.ey) + maxs[1] + BROAD_MARGIN;
    this.qmaxz = Math.max(this.sz, this.ez) + maxs[2] + BROAD_MARGIN;
    this.fraction = 1;
    this.nx = this.ny = this.nz = 0;
    this.hitGeom = this.solidGeom = -1;
    this.startSolid = this.allSolid = false;

    const planes = this.planes;
    for (let i = 0; i < this.planeGeoms.length && !this.allSolid; i++) {
      this.beginBrush();
      if (this.clipPlane(planes[4*i], planes[4*i+1], planes[4*i+2], planes[4*i+3]))
        this.endBrush(this.planeGeoms[i]);
    }
    if (this.bvh.order.length > 0) this.traverse();

    out.startSolid = this.startSolid;
    out.allSolid = this.allSolid;
    if (this.allSolid) {
      out.fraction = 0;
      out.geom = this.solidGeom;
      out.normal[0] = out.normal[1] = out.normal[2] = 0;
      out.end[0] = this.sx; out.end[1] = this.sy; out.end[2] = this.sz;
      return;
    }
    out.fraction = this.fraction;
    out.geom = this.hitGeom >= 0 ? this.hitGeom : this.solidGeom;
    out.normal[0] = this.nx; out.normal[1] = this.ny; out.normal[2] = this.nz;
    if (this.fraction === 1) {
      out.end[0] = this.ex; out.end[1] = this.ey; out.end[2] = this.ez;
    } else {
      out.end[0] = this.sx + this.fraction*this.dx;
      out.end[1] = this.sy + this.fraction*this.dy;
      out.end[2] = this.sz + this.fraction*this.dz;
    }
  }

  private traverse(): void {
    const { bounds, right, start, count, order } = this.bvh, stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0 && !this.allSolid) {
      const node = stack[--sp];
      if (!this.sweepTouches(bounds, 6*node)) continue;
      const n = count[node];
      if (n === 0) {
        stack[sp++] = right[node];
        stack[sp++] = node + 1;
        continue;
      }
      for (let i = start[node], last = start[node] + n; i < last && !this.allSolid; i++) {
        const leaf = order[i];
        if (!this.sweepTouches(this.leafBounds, 6*leaf)) continue;
        switch (this.leafKind[leaf]) {
          case KIND_POLY: this.clipPolytope(this.leafIndex[leaf], this.leafGeom[leaf]); break;
          case KIND_CYLINDER: this.clipCylinder(this.leafIndex[leaf], this.leafGeom[leaf]); break;
          default: this.clipHfield(this.hfields[this.leafIndex[leaf]]);
        }
      }
    }
  }

  /** Whether the swept hull (over the still-open part of the trace) can reach a solid in `b`. */
  private sweepTouches(b: Float64Array, o: number): boolean {
    let t0 = 0, t1 = this.fraction;
    // Expand by the hull: origin positions whose box overlaps the bounds.
    const lx = b[o] - this.cx - this.hx - BROAD_MARGIN, hx = b[o+3] - this.cx + this.hx + BROAD_MARGIN;
    if (this.dx === 0) { if (this.sx < lx || this.sx > hx) return false; }
    else {
      let a = (lx - this.sx)*this.invx, c = (hx - this.sx)*this.invx;
      if (a > c) { const t = a; a = c; c = t; }
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) return false;
    }
    const ly = b[o+1] - this.cy - this.hy - BROAD_MARGIN, hy = b[o+4] - this.cy + this.hy + BROAD_MARGIN;
    if (this.dy === 0) { if (this.sy < ly || this.sy > hy) return false; }
    else {
      let a = (ly - this.sy)*this.invy, c = (hy - this.sy)*this.invy;
      if (a > c) { const t = a; a = c; c = t; }
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) return false;
    }
    const lz = b[o+2] - this.cz - this.hz - BROAD_MARGIN, hz = b[o+5] - this.cz + this.hz + BROAD_MARGIN;
    if (this.dz === 0) return this.sz >= lz && this.sz <= hz;
    let a = (lz - this.sz)*this.invz, c = (hz - this.sz)*this.invz;
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    return t0 <= t1;
  }

  // ---- brush clipping ----

  private beginBrush(): void {
    this.enter = -1;
    this.leave = 1;
    this.startOut = this.getOut = false;
  }

  /** One solid half-space n·x <= d (unit n). False once the trace provably misses the brush. */
  private clipPlane(nx: number, ny: number, nz: number, d: number): boolean {
    const reach = Math.abs(nx)*this.hx + Math.abs(ny)*this.hy + Math.abs(nz)*this.hz + d;
    const d1 = nx*this.scx + ny*this.scy + nz*this.scz - reach;
    const d2 = nx*this.ecx + ny*this.ecy + nz*this.ecz - reach;
    if (d1 > 0) this.startOut = true;
    if (d2 > 0) this.getOut = true;
    // Entirely in front of this plane, or ending at least DIST_EPSILON in front of it.
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return false;
    if (d1 <= 0 && d2 <= 0) return true;
    if (d1 > d2) {
      let f = (d1 - DIST_EPSILON)/(d1 - d2);
      if (f < 0) f = 0;
      if (f > this.enter) { this.enter = f; this.bnx = nx; this.bny = ny; this.bnz = nz; }
    } else {
      let f = (d1 + DIST_EPSILON)/(d1 - d2);
      if (f > 1) f = 1;
      if (f < this.leave) this.leave = f;
    }
    return true;
  }

  private endBrush(geom: number): void {
    if (!this.startOut) {
      this.startSolid = true;
      this.solidGeom = geom;
      if (!this.getOut) this.allSolid = true;
      return;
    }
    if (this.enter < this.leave && this.enter > -1 && this.enter < this.fraction) {
      this.fraction = this.enter < 0 ? 0 : this.enter;
      this.nx = this.bnx; this.ny = this.bny; this.nz = this.bnz;
      this.hitGeom = geom;
    }
  }

  private clipPolytope(poly: number, geom: number): void {
    const p = this.polyPlanes;
    this.beginBrush();
    for (let i = this.polyStart[poly], last = this.polyStart[poly + 1]; i < last; i += 4)
      if (!this.clipPlane(p[i], p[i+1], p[i+2], p[i+3])) return;
    this.endBrush(geom);
  }

  // ---- upright cylinders: the box sweep against a rounded-rectangle prism ----

  /** Cylinder rows: axis x, axis y, bottom z, top z, radius (Source). */
  private clipCylinder(index: number, geom: number): void {
    const c = this.cylinders, o = 5*index;
    const r = c[o+4], hx = this.hx, hy = this.hy;
    // The hull-centre region overlapping the cylinder, relative to the cylinder axis.
    const zlo = c[o+2] - this.hz, zhi = c[o+3] + this.hz;
    const px = this.scx - c[o], py = this.scy - c[o+1], pz = this.scz;
    const startIn = pz >= zlo && pz <= zhi && roundedExcess(px, py, hx, hy) <= r*r;
    const qx = this.ecx - c[o], qy = this.ecy - c[o+1], qz = this.ecz;
    const endIn = qz >= zlo && qz <= zhi && roundedExcess(qx, qy, hx, hy) <= r*r;
    if (startIn) {
      this.startSolid = true;
      this.solidGeom = geom;
      if (!endIn) return;
      this.allSolid = true;
      return;
    }
    const dx = this.dx, dy = this.dy, dz = this.dz;
    if (dx === 0 && dy === 0 && dz === 0) return;
    // Entry into the DIST_EPSILON-expanded region.
    const R = r + DIST_EPSILON, zl = zlo - DIST_EPSILON, zh = zhi + DIST_EPSILON;
    let zin = -Infinity, zout = Infinity, znz = 0;
    if (dz === 0) { if (pz < zl || pz > zh) return; }
    else {
      const a = (zl - pz)/dz, b = (zh - pz)/dz;
      if (a < b) { zin = a; zout = b; znz = -1; } else { zin = b; zout = a; znz = 1; }
    }
    let xyIn = Infinity, xyOut = -Infinity, xnx = 0, xny = 0;
    if (dx === 0 && dy === 0) {
      if (roundedExcess(px, py, hx, hy) > R*R) return;
      xyIn = -Infinity; xyOut = Infinity;
    } else {
      // The rounded rectangle is the union of two crossed rectangles and four corner disks.
      for (let part = 0; part < 6; part++) {
        let tin: number, tout: number, nx: number, ny: number;
        if (part < 2) {
          const ax = part === 0 ? hx + R : hx, ay = part === 0 ? hy : hy + R;
          let inX = -Infinity, outX = Infinity, inY = -Infinity, outY = Infinity;
          if (dx === 0) { if (px < -ax || px > ax) continue; }
          else {
            const a = (-ax - px)/dx, b = (ax - px)/dx;
            if (a < b) { inX = a; outX = b; } else { inX = b; outX = a; }
          }
          if (dy === 0) { if (py < -ay || py > ay) continue; }
          else {
            const a = (-ay - py)/dy, b = (ay - py)/dy;
            if (a < b) { inY = a; outY = b; } else { inY = b; outY = a; }
          }
          tin = Math.max(inX, inY); tout = Math.min(outX, outY);
          if (tin > tout) continue;
          if (inX >= inY) { nx = dx > 0 ? -1 : 1; ny = 0; } else { nx = 0; ny = dy > 0 ? -1 : 1; }
        } else {
          const kx = part & 1 ? hx : -hx, ky = part & 2 ? hy : -hy;
          const fx = px - kx, fy = py - ky;
          const a = dx*dx + dy*dy, b = fx*dx + fy*dy, cc = fx*fx + fy*fy - R*R;
          const disc = b*b - a*cc;
          if (disc < 0) continue;
          const root = Math.sqrt(disc);
          tin = (-b - root)/a; tout = (-b + root)/a;
          nx = (fx + tin*dx)/R; ny = (fy + tin*dy)/R;
        }
        if (tout > xyOut) xyOut = tout;
        if (tin < xyIn) { xyIn = tin; xnx = nx; xny = ny; }
      }
      if (xyIn > xyOut) return;
    }
    let tin: number, nx: number, ny: number, nz: number;
    if (zin >= xyIn) { tin = zin; nx = 0; ny = 0; nz = znz; }
    else { tin = xyIn; nx = xnx; ny = xny; nz = 0; }
    const tout = Math.min(zout, xyOut);
    if (tin > tout || tout < 0) return;
    if (tin < 0) {
      // Starting inside the DIST_EPSILON shell: blocked at once only while approaching the solid.
      // The region is a vertical prism times a z interval, so the distance gradient separates.
      const ux = Math.max(Math.abs(px) - hx, 0), uy = Math.max(Math.abs(py) - hy, 0);
      const u = Math.hypot(ux, uy), over = u - r;
      let gx = 0, gy = 0, gz = 0;
      if (over > 0) { gx = Math.sign(px)*ux/u*over; gy = Math.sign(py)*uy/u*over; }
      if (pz < zlo) gz = pz - zlo; else if (pz > zhi) gz = pz - zhi;
      if (gx*dx + gy*dy + gz*dz >= 0) return;
      const len = Math.hypot(gx, gy, gz);
      tin = 0; nx = gx/len; ny = gy/len; nz = gz/len;
    }
    if (tin > 1 || tin >= this.fraction) return;
    this.fraction = tin;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.hitGeom = geom;
  }

  // ---- heightfields: MuJoCo's per-cell triangular prisms ----

  private clipHfield(h: HfieldData): void {
    const rot = h.rot, pos = h.pos, size = h.size;
    // The swept query box in field-local metres (centre and half extents of its rotated bounds).
    const qcx = (this.qminx + this.qmaxx)/2 - pos[0], qcy = (this.qminy + this.qmaxy)/2 - pos[1],
      qcz = (this.qminz + this.qmaxz)/2 - pos[2];
    const qhx = (this.qmaxx - this.qminx)/2, qhy = (this.qmaxy - this.qminy)/2, qhz = (this.qmaxz - this.qminz)/2;
    const lcx = (rot[0]*qcx + rot[3]*qcy + rot[6]*qcz)*INCH;
    const lcy = (rot[1]*qcx + rot[4]*qcy + rot[7]*qcz)*INCH;
    const lcz = (rot[2]*qcx + rot[5]*qcy + rot[8]*qcz)*INCH;
    const lhx = (Math.abs(rot[0])*qhx + Math.abs(rot[3])*qhy + Math.abs(rot[6])*qhz)*INCH;
    const lhy = (Math.abs(rot[1])*qhx + Math.abs(rot[4])*qhy + Math.abs(rot[7])*qhz)*INCH;
    const lhz = (Math.abs(rot[2])*qhx + Math.abs(rot[5])*qhy + Math.abs(rot[8])*qhz)*INCH;
    const s0 = size[0], s1 = size[1], s2 = size[2], s3 = size[3];
    const zmin = lcz - lhz;
    if (lcx - lhx > s0 || lcx + lhx < -s0 || lcy - lhy > s1 || lcy + lhy < -s1 || zmin > s2 || lcz + lhz < -s3) return;
    const ncol = h.ncol, nrow = h.nrow, data = h.data;
    const cmin = Math.max(0, Math.floor((lcx - lhx + s0)/(2*s0)*(ncol - 1)));
    const cmax = Math.min(ncol - 1, Math.ceil((lcx + lhx + s0)/(2*s0)*(ncol - 1)));
    const rmin = Math.max(0, Math.floor((lcy - lhy + s1)/(2*s1)*(nrow - 1)));
    const rmax = Math.min(nrow - 1, Math.ceil((lcy + lhy + s1)/(2*s1)*(nrow - 1)));
    const stepx = 2*s0/(ncol - 1), stepy = 2*s1/(nrow - 1);
    for (let r = rmin; r < rmax && !this.allSolid; r++) {
      const y0 = stepy*r - s1, y1 = stepy*(r + 1) - s1;
      for (let c = cmin; c < cmax && !this.allSolid; c++) {
        const x0 = stepx*c - s0, x1 = stepx*(c + 1) - s0;
        const h00 = data[r*ncol + c]*s2, h10 = data[r*ncol + c + 1]*s2;
        const h01 = data[(r + 1)*ncol + c]*s2, h11 = data[(r + 1)*ncol + c + 1]*s2;
        // mjc_ConvexHField's vertex stream splits each cell along (c,r)-(c+1,r+1).
        if (h01 >= zmin || h00 >= zmin || h11 >= zmin)
          this.clipPrism(h, x0, y1, h01, x0, y0, h00, x1, y1, h11);
        if (!this.allSolid && (h00 >= zmin || h11 >= zmin || h10 >= zmin))
          this.clipPrism(h, x0, y0, h00, x1, y1, h11, x1, y0, h10);
      }
    }
  }

  /** One field prism: a local top triangle extruded down to the field base. */
  private clipPrism(h: HfieldData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
      x2: number, y2: number, z2: number): void {
    const v = this.prism, rot = h.rot, pos = h.pos, base = -h.size[3];
    const scale = 1/INCH;
    for (let k = 0; k < 6; k++) {
      const lx = k % 3 === 0 ? x0 : k % 3 === 1 ? x1 : x2;
      const ly = k % 3 === 0 ? y0 : k % 3 === 1 ? y1 : y2;
      const lz = k < 3 ? (k === 0 ? z0 : k === 1 ? z1 : z2) : base;
      v[3*k] = (rot[0]*lx + rot[1]*ly + rot[2]*lz)*scale + pos[0];
      v[3*k+1] = (rot[3]*lx + rot[4]*ly + rot[5]*lz)*scale + pos[1];
      v[3*k+2] = (rot[6]*lx + rot[7]*ly + rot[8]*lz)*scale + pos[2];
    }
    const a = this.prismAxes;
    let n = 0;
    // Field vertical (bottom facet and vertical edges) and the hull's own axes.
    const ux = rot[2], uy = rot[5], uz = rot[8];
    a[n++] = ux; a[n++] = uy; a[n++] = uz;
    a[n++] = 1; a[n++] = 0; a[n++] = 0;
    a[n++] = 0; a[n++] = 1; a[n++] = 0;
    a[n++] = 0; a[n++] = 0; a[n++] = 1;
    // Vertical edge × hull axes.
    a[n++] = 0; a[n++] = uz; a[n++] = -uy;
    a[n++] = -uz; a[n++] = 0; a[n++] = ux;
    a[n++] = uy; a[n++] = -ux; a[n++] = 0;
    // Top facet normal.
    const e0x = v[3] - v[0], e0y = v[4] - v[1], e0z = v[5] - v[2];
    const e1x = v[6] - v[0], e1y = v[7] - v[1], e1z = v[8] - v[2];
    a[n++] = e0y*e1z - e0z*e1y; a[n++] = e0z*e1x - e0x*e1z; a[n++] = e0x*e1y - e0y*e1x;
    for (let e = 0; e < 3; e++) {
      const i = 3*e, j = 3*((e + 1) % 3);
      // Top edge, and its bottom counterpart (the top edge with its field-vertical part removed).
      const tx = v[j] - v[i], ty = v[j+1] - v[i+1], tz = v[j+2] - v[i+2];
      const bx = v[9+j] - v[9+i], by = v[10+j] - v[10+i], bz = v[11+j] - v[11+i];
      // Side facet: the bottom edge × field vertical.
      a[n++] = by*uz - bz*uy; a[n++] = bz*ux - bx*uz; a[n++] = bx*uy - by*ux;
      a[n++] = 0; a[n++] = tz; a[n++] = -ty;
      a[n++] = -tz; a[n++] = 0; a[n++] = tx;
      a[n++] = ty; a[n++] = -tx; a[n++] = 0;
      a[n++] = 0; a[n++] = bz; a[n++] = -by;
      a[n++] = -bz; a[n++] = 0; a[n++] = bx;
      a[n++] = by; a[n++] = -bx; a[n++] = 0;
    }
    this.beginBrush();
    for (let i = 0; i < n; i += 3) {
      let x = a[i], y = a[i+1], z = a[i+2];
      const len2 = x*x + y*y + z*z;
      if (!(len2 > TINY)) continue;
      const inv = 1/Math.sqrt(len2);
      x *= inv; y *= inv; z *= inv;
      let max = -Infinity, min = Infinity;
      for (let k = 0; k < 18; k += 3) {
        const d = x*v[k] + y*v[k+1] + z*v[k+2];
        if (d > max) max = d;
        if (d < min) min = d;
      }
      if (!this.clipPlane(x, y, z, max) || !this.clipPlane(-x, -y, -z, -min)) return;
    }
    this.endBrush(h.geom);
  }
}

/** Squared distance from (x, y) to the axis-aligned rectangle with half extents (hx, hy). */
function roundedExcess(x: number, y: number, hx: number, hy: number): number {
  const ux = Math.max(Math.abs(x) - hx, 0), uy = Math.max(Math.abs(y) - hy, 0);
  return ux*ux + uy*uy;
}

/** Build the player collision world from the compiled model's static collision geoms. Construction
 * allocates; PlayerCollisionWorld.traceHull does not. */
export function collisionFromEngine(eng: Engine, frame: SourceFrame): PlayerCollisionWorld {
  // MuJoCo's generated typings expose model tables untyped; each is bound to its native array type here.
  const m = eng.model;
  const ngeom = m.ngeom;
  const type: Int32Array = m.geom_type, bodyid: Int32Array = m.geom_bodyid, dataid: Int32Array = m.geom_dataid;
  const contype: Int32Array = m.geom_contype, conaffinity: Int32Array = m.geom_conaffinity;
  const size: Float64Array = m.geom_size;
  const weldid: Int32Array = m.body_weldid, rootid: Int32Array = m.body_rootid, mocapid: Int32Array = m.body_mocapid;
  const meshVert: Float32Array = m.mesh_vert, meshVertadr: Int32Array = m.mesh_vertadr;
  const graph: Int32Array = m.mesh_graph, graphadr: Int32Array = m.mesh_graphadr;
  const hfSize: Float64Array = m.hfield_size, hfNrow: Int32Array = m.hfield_nrow, hfNcol: Int32Array = m.hfield_ncol;
  const hfAdr: Int32Array = m.hfield_adr, hfData: Float32Array = m.hfield_data;
  const xpos = eng.geomXpos, xmat = eng.geomXmat;

  const planes: number[] = [], planeGeoms: number[] = [];
  const polyStart: number[] = [0], polyPlanes: number[] = [];
  const cylinders: number[] = [];
  const hfields: HfieldData[] = [];
  const leafKind: number[] = [], leafIndex: number[] = [], leafGeom: number[] = [], leafBounds: number[] = [];

  const point = new Float64Array(3), dir = new Float64Array(3);
  /** Source point of a geom-local point (metres). */
  const local = (g: number, lx: number, ly: number, lz: number, out: Float64Array, o: number) => {
    const r = 9*g;
    point[0] = xpos[3*g] + xmat[r]*lx + xmat[r+1]*ly + xmat[r+2]*lz;
    point[1] = xpos[3*g+1] + xmat[r+3]*lx + xmat[r+4]*ly + xmat[r+5]*lz;
    point[2] = xpos[3*g+2] + xmat[r+6]*lx + xmat[r+7]*ly + xmat[r+8]*lz;
    appToSourcePoint(frame, point, point);
    out[o] = point[0]; out[o+1] = point[1]; out[o+2] = point[2];
  };
  /** Source direction of geom-local axis `k`. */
  const axis = (g: number, k: number, out: number[] | Float64Array, o: number) => {
    const r = 9*g;
    dir[0] = xmat[r+k]; dir[1] = xmat[r+3+k]; dir[2] = xmat[r+6+k];
    appToSourceDirection(frame, dir, dir);
    out[o] = dir[0]; out[o+1] = dir[1]; out[o+2] = dir[2];
  };
  const addLeaf = (kind: number, index: number, g: number, verts: ArrayLike<number>) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      x0 = Math.min(x0, verts[i]); y0 = Math.min(y0, verts[i+1]); z0 = Math.min(z0, verts[i+2]);
      x1 = Math.max(x1, verts[i]); y1 = Math.max(y1, verts[i+1]); z1 = Math.max(z1, verts[i+2]);
    }
    leafKind.push(kind); leafIndex.push(index); leafGeom.push(g); leafBounds.push(x0, y0, z0, x1, y1, z1);
  };
  const addPolytope = (g: number, verts: Float64Array, faces: ArrayLike<number>, edges: ArrayLike<number>) => {
    polytopePlanes(verts, faces, edges, polyPlanes);
    addLeaf(KIND_POLY, polyStart.length - 1, g, verts);
    polyStart.push(polyPlanes.length);
  };

  for (let g = 0; g < ngeom; g++) {
    if ((contype[g] | conaffinity[g]) === 0) continue;                 // visual-only
    const b = bodyid[g];
    if (weldid[b] !== 0 || mocapid[rootid[b]] >= 0) continue;           // robots, props, mocap shadows
    const s = 3*g;
    switch (type[g]) {
      case GEOM_PLANE: {
        const n = [0, 0, 0];
        axis(g, 2, n, 0);
        local(g, 0, 0, 0, point, 0);
        planes.push(n[0], n[1], n[2], n[0]*point[0] + n[1]*point[1] + n[2]*point[2]);
        planeGeoms.push(g);
        break;
      }
      case GEOM_BOX: {
        const verts = new Float64Array(24);
        for (let k = 0; k < 8; k++)
          local(g, k & 1 ? size[s] : -size[s], k & 2 ? size[s+1] : -size[s+1], k & 4 ? size[s+2] : -size[s+2], verts, 3*k);
        const axes: number[] = [];
        for (let k = 0; k < 3; k++) axis(g, k, axes, 3*k);
        addPolytope(g, verts, axes, axes);
        break;
      }
      case GEOM_MESH: {
        const mesh = dataid[g], adr = graphadr[mesh];
        if (mesh < 0 || adr < 0) throw new Error(`Player collision needs the compiled convex hull of mesh geom ${g}.`);
        const numvert = graph[adr], numface = graph[adr+1];
        const globalIds = adr + 2 + numvert;
        const faceIds = adr + 2 + 2*numvert + numvert + 3*numface;
        const vbase = meshVertadr[mesh];
        const vertex = (id: number, out: Float64Array, o: number) =>
          local(g, meshVert[3*(vbase + id)], meshVert[3*(vbase + id)+1], meshVert[3*(vbase + id)+2], out, o);
        const verts = new Float64Array(3*numvert);
        for (let i = 0; i < numvert; i++) vertex(graph[globalIds + i], verts, 3*i);
        // Facet normals from the hull triangles; keep only edges between non-coplanar triangles.
        const faces = new Float64Array(3*numface), tri = new Float64Array(9);
        const edgeFaces = new Map<number, number[]>(), stride: number = m.mesh_vertnum[mesh];
        for (let f = 0; f < numface; f++) {
          for (let k = 0; k < 3; k++) vertex(graph[faceIds + 3*f + k], tri, 3*k);
          const ax = tri[3] - tri[0], ay = tri[4] - tri[1], az = tri[5] - tri[2];
          const bx = tri[6] - tri[0], by = tri[7] - tri[1], bz = tri[8] - tri[2];
          let nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
          const len = Math.hypot(nx, ny, nz);
          if (len > 0) { nx /= len; ny /= len; nz /= len; }
          faces[3*f] = nx; faces[3*f+1] = ny; faces[3*f+2] = nz;
          for (let k = 0; k < 3; k++) {
            const i = graph[faceIds + 3*f + k], j = graph[faceIds + 3*f + (k + 1) % 3];
            const key = Math.min(i, j)*stride + Math.max(i, j);
            const list = edgeFaces.get(key);
            if (list) list.push(f); else edgeFaces.set(key, [f]);
          }
        }
        const edges: number[] = [], a = new Float64Array(3), c = new Float64Array(3);
        for (const [key, list] of edgeFaces) {
          if (list.length === 2) {
            const f = 3*list[0], h = 3*list[1];
            if (faces[f]*faces[h] + faces[f+1]*faces[h+1] + faces[f+2]*faces[h+2] > COPLANAR) continue;
          }
          vertex(Math.floor(key/stride), a, 0);
          vertex(key % stride, c, 0);
          edges.push(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        }
        addPolytope(g, verts, faces, edges);
        break;
      }
      case GEOM_CYLINDER: {
        const up = [0, 0, 0];
        axis(g, 2, up, 0);
        if (Math.abs(up[2]) < UPRIGHT)
          throw new Error(`Player collision supports only upright cylinders; geom ${g} is tilted.`);
        const centre = new Float64Array(3);
        local(g, 0, 0, 0, centre, 0);
        const r = size[s]/INCH, half = size[s+1]/INCH;
        const index = cylinders.length/5;
        cylinders.push(centre[0], centre[1], centre[2] - half, centre[2] + half, r);
        addLeaf(KIND_CYLINDER, index, g,
          [centre[0] - r, centre[1] - r, centre[2] - half, centre[0] + r, centre[1] + r, centre[2] + half]);
        break;
      }
      case GEOM_HFIELD: {
        const id = dataid[g], nrow = hfNrow[id], ncol = hfNcol[id];
        if (nrow < 2 || ncol < 2) throw new Error(`Player collision needs a heightfield grid on geom ${g}.`);
        const fieldSize = Float64Array.from(hfSize.subarray(4*id, 4*id + 4));
        const rot = new Float64Array(9), col = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          axis(g, k, col, 0);
          rot[k] = col[0]; rot[3+k] = col[1]; rot[6+k] = col[2];
        }
        const pos = new Float64Array(3);
        local(g, 0, 0, 0, pos, 0);
        const corners = new Float64Array(24);
        for (let k = 0; k < 8; k++)
          local(g, k & 1 ? fieldSize[0] : -fieldSize[0], k & 2 ? fieldSize[1] : -fieldSize[1],
            k & 4 ? fieldSize[2] : -fieldSize[3], corners, 3*k);
        const index = hfields.length;
        hfields.push({ geom: g, nrow, ncol, size: fieldSize, rot, pos,
          data: hfData.slice(hfAdr[id], hfAdr[id] + nrow*ncol) });
        addLeaf(KIND_HFIELD, index, g, corners);
        break;
      }
      default:
        throw new Error(`Player collision does not support static geom ${g} of MuJoCo type ${type[g]}.`);
    }
  }

  const bounds = Float64Array.from(leafBounds);
  return new CollisionWorld(Float64Array.from(planes), Int32Array.from(planeGeoms), Int32Array.from(polyStart),
    Float64Array.from(polyPlanes), Float64Array.from(cylinders), hfields, Uint8Array.from(leafKind),
    Int32Array.from(leafIndex), Int32Array.from(leafGeom), bounds, buildBvh(bounds, leafKind.length));
}
