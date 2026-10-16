/** Three.js renderer for a compiled MjModel: build one mesh per geom from the
 * model arrays (primitives + STL mesh buffers), then each frame copy
 * geom_xpos/geom_xmat straight into the mesh matrices. Z-up throughout. */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GEOM_BOX, GEOM_CAPSULE, GEOM_CYLINDER, GEOM_ELLIPSOID, GEOM_MESH,
         GEOM_PLANE, GEOM_SPHERE } from "../sim/engine";
import type { RenderModel } from "../sim/protocol";
import { FINISH, hasPalette, resolve, type Paint, type Region } from "./paint";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// ---- MuJoCo groundplane (matches the bundle's scene.xml) --------------
// texture: builtin checker rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3"
// mark="edge" markrgb="0.8 0.8 0.8", texrepeat="5 5" texuniform → 0.2 m tiles;
// material reflectance="0.2" → blend 20% mirror under an 80%-opaque checker.
const FLOOR_REFLECTANCE = 0.2;

export function checkerTexture(): THREE.CanvasTexture {
  // one MuJoCo texture tile = 2x2 checker cells; mark="edge" draws the light
  // border around the TILE (not each cell), exactly like the builtin checker
  const px = 128;                       // one checker cell
  const cv = document.createElement("canvas");
  cv.width = cv.height = px * 2;
  const g = cv.getContext("2d")!;
  const c1 = "rgb(51,77,102)";          // rgb1 0.2 0.3 0.4
  const c2 = "rgb(26,51,77)";           // rgb2 0.1 0.2 0.3
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? c2 : c1;
      g.fillRect(i * px, j * px, px, px);
    }
  g.strokeStyle = "rgb(204,204,204)";   // markrgb 0.8
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 2 * px - 3, 2 * px - 3);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Reflector (mirror pass) + semi-transparent checker on top ≈ MuJoCo's
 * reflectance blend. Returned as one Object3D the frame sync can position.
 * `?plain` in the URL skips the mirror pass (low-end machines / capture). */
function buildFloor(size: number): THREE.Object3D {
  const plain = new URLSearchParams(location.search).has("plain");
  const group = new THREE.Group();
  if (!plain) {
    const mirror = new Reflector(new THREE.PlaneGeometry(size, size), {
      clipBias: 0.003,
      textureWidth: 1024,
      textureHeight: 1024,
      color: 0x9099a0,
    });
    group.add(mirror);
  }
  const tex = checkerTexture();
  const tile = 0.2;                     // texrepeat="5 5" texuniform → 0.2 m tiles
  tex.repeat.set(size / tile, size / tile);
  const checker = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({
      map: tex, transparent: !plain, opacity: plain ? 1 : 1 - FLOOR_REFLECTANCE,
      roughness: 0.9, metalness: 0.0,
    }));
  checker.position.z = 0.001;
  group.add(checker);
  return group;
}

/** Per-mesh triangle trims — cosmetic geometry to hide from the render.
 * A triangle is dropped when the predicate is true for ALL three vertices
 * (mesh-local coordinates). Example — hide the torso's backpack mounting rail
 * (shell back face ~x=-0.06; rail spans x∈[-0.098,-0.068] in the STL):
 *   waist_yaw_link: (x) => x < -0.068,
 */
const MESH_TRIM: Record<string, (x: number, y: number, z: number) => boolean> = {};

/** Drop trimmed triangles from an indexed geometry (returns the kept index). */
function trimIndex(name: string, vert: Float32Array, face: Uint32Array): Uint32Array {
  const pred = MESH_TRIM[name];
  if (!pred) return face;
  const kept: number[] = [];
  for (let t = 0; t < face.length; t += 3) {
    let drop = true;
    for (let k = 0; k < 3; k++) {
      const i = face[t + k];
      if (!pred(vert[3 * i], vert[3 * i + 1], vert[3 * i + 2])) { drop = false; break; }
    }
    if (!drop) kept.push(face[t], face[t + 1], face[t + 2]);
  }
  return Uint32Array.from(kept);
}

/** Robot-part material from a palette paint. DoubleSide: several R1 linkage
 * STLs have inverted winding and vanish under back-face culling from outside. */
function paintMaterial(p: Paint): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: p.color, side: THREE.DoubleSide, ...FINISH[p.finish],
  });
}

/** Union-find over n items. */
function unionFind(n: number) {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  return { find, union: (a: number, b: number) => { parent[find(a)] = find(b); } };
}

/** Per-triangle group labels for patch / shell regions. Vertices are welded
 * by position (0.1 µm grid) so split normals / seams don't break shells;
 * "patch" additionally only joins faces across edges bending < 20°. */
function groupLabels(F: Float64Array, idx: Uint32Array, scope: "patch" | "shell"): Int32Array {
  const nt = idx.length / 3;
  const weld = new Map<string, number>();
  const vid = new Int32Array(F.length / 3);
  for (let i = 0; i < vid.length; i++) {
    const k = `${Math.round(F[3 * i] * 1e7)},${Math.round(F[3 * i + 1] * 1e7)},${Math.round(F[3 * i + 2] * 1e7)}`;
    let w = weld.get(k);
    if (w === undefined) { w = weld.size; weld.set(k, w); }
    vid[i] = w;
  }
  const uf = unionFind(nt);
  const nrm = new Float64Array(3 * nt);
  for (let t = 0; t < nt; t++) {
    const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
    const ux = F[b] - F[a], uy = F[b + 1] - F[a + 1], uz = F[b + 2] - F[a + 2];
    const vx = F[c] - F[a], vy = F[c + 1] - F[a + 1], vz = F[c + 2] - F[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[3 * t] = nx / l; nrm[3 * t + 1] = ny / l; nrm[3 * t + 2] = nz / l;
  }
  const cosMax = Math.cos((20 * Math.PI) / 180);
  const edgeOwner = new Map<number, number>();
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const p = vid[idx[3 * t + k]], q = vid[idx[3 * t + (k + 1) % 3]];
      const key = p < q ? p * 4194304 + q : q * 4194304 + p;
      const o = edgeOwner.get(key);
      if (o === undefined) { edgeOwner.set(key, t); continue; }
      if (scope === "shell" ||
          nrm[3 * o] * nrm[3 * t] + nrm[3 * o + 1] * nrm[3 * t + 1] + nrm[3 * o + 2] * nrm[3 * t + 2] > cosMax)
        uf.union(o, t);
    }
  }
  const lab = new Int32Array(nt);
  for (let t = 0; t < nt; t++) lab[t] = uf.find(t);
  return lab;
}

/** Split an indexed mesh into material groups: group 0 = triangles no region
 * claims, group i+1 = triangles regions[i] claims (first match wins). Regions
 * test a point + normal in the mesh FILE's frame (`toFile` = the mesh's
 * compile offset); patch / shell regions test each group's area-weighted
 * centroid, mean normal and bbox size once and claim all its triangles.
 * Triangles straddling a per-triangle region boundary are bisected along
 * their longest edge (shared midpoints) down to ~REFINE_EDGE, so boundaries
 * stay crisp even on coarse CAD tessellation. Returns false when no region
 * claims anything (geometry left untouched). */
const REFINE_EDGE = 0.0008;   // m
const REFINE_DEPTH = 14;
function splitRegions(geo: THREE.BufferGeometry, regions: Region[], toFile: THREE.Matrix4): boolean {
  const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
  const nrmAttr = geo.getAttribute("normal") as THREE.BufferAttribute;
  const idx = geo.getIndex()!.array as Uint32Array;
  const nt0 = idx.length / 3;
  // growable vertex store: compiled-frame position, vertex normal, file-frame position
  const P: number[] = Array.from(posAttr.array as Float32Array);
  const N: number[] = Array.from(nrmAttr.array as Float32Array);
  const F: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(toFile);
    F.push(v.x, v.y, v.z);
  }
  // group-scope verdicts: verdict[r][t] for each original triangle t
  const verdict: (Uint8Array | null)[] = regions.map(() => null);
  const labels: Partial<Record<"patch" | "shell", Int32Array>> = {};
  const F64 = Float64Array.from(F);
  regions.forEach((rg, r) => {
    const scope = rg.scope ?? "tri";
    if (scope === "tri") return;
    const lab = labels[scope] ??= groupLabels(F64, idx, scope);
    const acc = new Map<number, number[]>();   // area, cx, cy, cz, nx, ny, nz, min xyz, max xyz
    for (let t = 0; t < nt0; t++) {
      const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
      const ux = F64[b] - F64[a], uy = F64[b + 1] - F64[a + 1], uz = F64[b + 2] - F64[a + 2];
      const vx = F64[c] - F64[a], vy = F64[c + 1] - F64[a + 1], vz = F64[c + 2] - F64[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ar = Math.hypot(nx, ny, nz) / 2;
      let g = acc.get(lab[t]);
      if (!g) { g = [0, 0, 0, 0, 0, 0, 0, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; acc.set(lab[t], g); }
      g[0] += ar;
      for (let k = 0; k < 3; k++) g[1 + k] += ar * (F64[a + k] + F64[b + k] + F64[c + k]) / 3;
      g[4] += nx / 2; g[5] += ny / 2; g[6] += nz / 2;
      for (const i of [a, b, c]) for (let k = 0; k < 3; k++) {
        g[7 + k] = Math.min(g[7 + k], F64[i + k]); g[10 + k] = Math.max(g[10 + k], F64[i + k]);
      }
    }
    const ok = new Map<number, boolean>();
    for (const [l, g] of acc) {
      const w = g[0] || 1, nl = Math.hypot(g[4], g[5], g[6]) || 1;
      ok.set(l, rg.test(g[1] / w, g[2] / w, g[3] / w, g[4] / nl, g[5] / nl, g[6] / nl,
                        g[10] - g[7], g[11] - g[8], g[12] - g[9]));
    }
    verdict[r] = Uint8Array.from(lab, (l) => (ok.get(l) ? 1 : 0));
  });
  const mids = new Map<number, number>();
  const mid = (a: number, b: number): number => {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    let m = mids.get(key);
    if (m === undefined) {
      m = P.length / 3;
      for (let k = 0; k < 3; k++) {
        P.push((P[3 * a + k] + P[3 * b + k]) / 2);
        F.push((F[3 * a + k] + F[3 * b + k]) / 2);
        N.push((N[3 * a + k] + N[3 * b + k]) / 2);
      }
      mids.set(key, m);
    }
    return m;
  };
  let tri0 = 0;   // original triangle being placed (group verdicts)
  const cls = (x: number, y: number, z: number, n: THREE.Vector3) =>
    regions.findIndex((rg, r) => verdict[r]
      ? verdict[r]![tri0] === 1
      : rg.test(x, y, z, n.x, n.y, n.z, 0, 0, 0));
  const buckets: number[][] = [[], ...regions.map(() => [])];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const place = (a: number, b: number, c: number, depth: number) => {
    const ax = F[3 * a], ay = F[3 * a + 1], az = F[3 * a + 2];
    const bx = F[3 * b], by = F[3 * b + 1], bz = F[3 * b + 2];
    const cx = F[3 * c], cy = F[3 * c + 1], cz = F[3 * c + 2];
    e1.set(bx - ax, by - ay, bz - az); e2.set(cx - ax, cy - ay, cz - az);
    n.crossVectors(e1, e2).normalize();
    const k = cls((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3, n);
    const lab = e1.length(), lca = e2.length(), lbc = Math.hypot(cx - bx, cy - by, cz - bz);
    if (depth < REFINE_DEPTH && Math.max(lab, lca, lbc) > REFINE_EDGE &&
        (cls(ax, ay, az, n) !== k || cls(bx, by, bz, n) !== k || cls(cx, cy, cz, n) !== k)) {
      // bisect the longest edge (cheap on the long slivers CAD exports produce)
      if (lab >= lca && lab >= lbc) { const m = mid(a, b); place(a, m, c, depth + 1); place(m, b, c, depth + 1); }
      else if (lbc >= lca) { const m = mid(b, c); place(a, b, m, depth + 1); place(a, m, c, depth + 1); }
      else { const m = mid(c, a); place(a, b, m, depth + 1); place(m, b, c, depth + 1); }
      return;
    }
    buckets[k + 1].push(a, b, c);
  };
  for (let t = 0; t < nt0; t++) { tri0 = t; place(idx[3 * t], idx[3 * t + 1], idx[3 * t + 2], 0); }
  if (buckets.slice(1).every((b) => b.length === 0)) return false;
  if (P.length > posAttr.array.length) {
    geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(P), 3));
    const nn = Float32Array.from(N);
    for (let i = 0; i < nn.length; i += 3) {       // re-normalise averaged normals
      const l = Math.hypot(nn[i], nn[i + 1], nn[i + 2]) || 1;
      nn[i] /= l; nn[i + 1] /= l; nn[i + 2] /= l;
    }
    geo.setAttribute("normal", new THREE.BufferAttribute(nn, 3));
  }
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(buckets.flat()), 1));
  let start = 0;
  buckets.forEach((b, i) => { geo.addGroup(start, b.length, i); start += b.length; });
  return true;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private geomMeshes: (THREE.Object3D | null)[] = [];
  private floors: THREE.Object3D[] = [];
  private readonly tmp = new THREE.Matrix4();
  /** set while an export owns the canvas size (beginOffscreen … endOffscreen) */
  private offscreen: { ratio: number; background: THREE.Scene["background"]; fog: THREE.Scene["fog"] } | null = null;

  constructor(readonly container: HTMLElement) {
    // preserveDrawingBuffer: screenshots and video export read the canvas anytime;
    // alpha: transparent-background renders (the scene background keeps it opaque otherwise)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e12);
    this.scene.fog = new THREE.Fog(0x0b0e12, 8, 30);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(2.2, -2.2, 1.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.7);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x1a2028, 0.8);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(2, 1, 4);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xcfd8e6, 0.7);   // camera-side fill
    fill.position.set(-2, -3, 2.5);
    this.scene.add(fill);
    // neutral studio environment map — gives the plastic its highlights
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize() {
    if (this.offscreen) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** (Re)build the per-geom meshes from a RenderModel sent by the sim worker. */
  build(desc: RenderModel) {
    for (const m of this.geomMeshes) {
      if (!m) continue;
      this.scene.remove(m);
      m.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const mat of [o.material].flat()) (mat as THREE.Material).dispose();
        }
      });
    }
    this.geomMeshes = [];
    this.floors = [];
    for (let g = 0; g < desc.ngeom; g++) {
      const a = desc.rgba[4 * g + 3];
      const isMesh = desc.type[g] === GEOM_MESH;
      // skip hidden geoms, high-group collision shadows, and — on robot bodies
      // — every colliding geom: those are physics-only shapes (mesh duplicates,
      // the torso/feet collision boxes) that would poke through the shell.
      // Worldbody geoms (terrain) always render.
      if (a <= 0 || desc.group[g] >= 3 ||
          (desc.bodyid[g] > 0 && desc.contype[g] !== 0)) {
        this.geomMeshes.push(null); continue;
      }
      if (desc.type[g] === GEOM_PLANE) {
        const floor = buildFloor(40);
        floor.matrixAutoUpdate = false;
        this.scene.add(floor);
        this.floors.push(floor);
        this.geomMeshes.push(floor);
        continue;
      }
      const geo = this.buildGeometry(desc, g);
      if (!geo) { this.geomMeshes.push(null); continue; }
      const meshName = isMesh ? desc.meshes[desc.dataid[g]]?.name ?? "" : "";
      // Robots with a palette (R1, Go2) paint every mesh part by name with a
      // colour + finish from the product colourway; others (G1) use the
      // model's own rgba.
      const painted = isMesh && hasPalette(desc.robot);
      let mesh: THREE.Mesh;
      if (painted) {
        const { paint, regions } = resolve(desc.robot, meshName);
        const md = desc.meshes[desc.dataid[g]];
        const toFile = new THREE.Matrix4().compose(
          new THREE.Vector3(...md.pos),
          new THREE.Quaternion(md.quat[1], md.quat[2], md.quat[3], md.quat[0]),
          new THREE.Vector3(1, 1, 1));
        const split = regions.length > 0 && splitRegions(geo, regions, toFile);
        mesh = new THREE.Mesh(geo, split
          ? [paint, ...regions.map((r) => r.paint)].map(paintMaterial)
          : paintMaterial(paint));
        mesh.visible = !paint.hidden;
      } else {
        mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: new THREE.Color(desc.rgba[4 * g], desc.rgba[4 * g + 1], desc.rgba[4 * g + 2]),
          transparent: a < 1, opacity: a,
          metalness: 0.05, roughness: isMesh ? 0.6 : 0.8,
        }));
      }
      mesh.matrixAutoUpdate = false;
      mesh.userData.meshName = painted ? meshName : null;
      this.scene.add(mesh);
      this.geomMeshes.push(mesh);
    }
  }

  /** Project a pointer event onto the horizontal plane z=`z` (world xy). */
  groundPoint(ev: PointerEvent | MouseEvent, z = 0): [number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), hit)
      ? [hit.x, hit.y] : null;
  }

  // ---- leash rope (drag policies) --------------------------------------
  private leashLine: THREE.Line | null = null;

  /** Draw (or hide, with null) a sagging rope from the robot's collar to the
   * pull anchor. Both points in world coordinates. */
  setLeash(from: [number, number, number] | null, to?: [number, number, number]) {
    if (!from || !to) {
      if (this.leashLine) this.leashLine.visible = false;
      return;
    }
    const N = 16;
    if (!this.leashLine) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position",
        new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
      this.leashLine = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: 0xffc07a, transparent: true, opacity: 0.9 }));
      this.leashLine.frustumCulled = false;
      this.scene.add(this.leashLine);
    }
    this.leashLine.visible = true;
    const pos = (this.leashLine.geometry.getAttribute("position") as THREE.BufferAttribute);
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const sag = Math.max(0.03, 0.25 - 0.15 * Math.min(len, 1.5)); // taut when far
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pos.setXYZ(i,
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t - sag * 4 * t * (1 - t));
    }
    pos.needsUpdate = true;
  }

  // ---- virtual hoist (suspension harness) -----------------------------
  private hoistGroup: THREE.Group | null = null;
  private hoistLine: THREE.Line | null = null;
  private hoistRing: THREE.Mesh | null = null;
  private hoistGantry: THREE.Mesh | null = null;

  /** Draw (or hide, with null) overhead suspension cable and hook. */
  setHoist(anchor: [number, number, number] | null) {
    if (!anchor) {
      if (this.hoistGroup) this.hoistGroup.visible = false;
      return;
    }
    if (!this.hoistGroup) {
      this.hoistGroup = new THREE.Group();

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      this.hoistLine = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: 0xffee55, transparent: true, opacity: 0.85 }));
      this.hoistLine.frustumCulled = false;
      this.hoistGroup.add(this.hoistLine);

      const ringGeo = new THREE.TorusGeometry(0.04, 0.008, 8, 16);
      ringGeo.rotateX(Math.PI / 2);
      this.hoistRing = new THREE.Mesh(ringGeo,
        new THREE.MeshStandardMaterial({ color: 0xffaa00, roughness: 0.3, metalness: 0.8 }));
      this.hoistGroup.add(this.hoistRing);

      const gantryGeo = new THREE.BoxGeometry(0.14, 0.14, 0.03);
      this.hoistGantry = new THREE.Mesh(gantryGeo,
        new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.5, metalness: 0.6 }));
      this.hoistGroup.add(this.hoistGantry);

      this.scene.add(this.hoistGroup);
    }
    this.hoistGroup.visible = true;
    const topZ = Math.max(2.2, anchor[2] + 1.4);
    const pos = this.hoistLine!.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, anchor[0], anchor[1], topZ);
    pos.setXYZ(1, anchor[0], anchor[1], anchor[2]);
    pos.needsUpdate = true;

    this.hoistRing!.position.set(anchor[0], anchor[1], anchor[2]);
    this.hoistGantry!.position.set(anchor[0], anchor[1], topZ);
  }

  /** Raycast a pointer event to the robot part under the cursor (or null). */
  pickPart(ev: PointerEvent | MouseEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = this.geomMeshes.filter(
      (o): o is THREE.Mesh => o instanceof THREE.Mesh && o.visible && !!o.userData.meshName);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? (hit.object.userData.meshName as string) : null;
  }

  private buildGeometry(desc: RenderModel, g: number): THREE.BufferGeometry | null {
    const s0 = desc.size[3 * g], s1 = desc.size[3 * g + 1], s2 = desc.size[3 * g + 2];
    switch (desc.type[g]) {
      case GEOM_SPHERE: return new THREE.SphereGeometry(s0, 24, 16);
      case GEOM_ELLIPSOID: {
        const geo = new THREE.SphereGeometry(1, 24, 16);
        geo.scale(s0, s1, s2);
        return geo;
      }
      case GEOM_CAPSULE: {
        const geo = new THREE.CapsuleGeometry(s0, 2 * s1, 8, 16);
        geo.rotateX(Math.PI / 2);       // three capsule axis Y -> mujoco Z
        return geo;
      }
      case GEOM_CYLINDER: {
        const geo = new THREE.CylinderGeometry(s0, s0, 2 * s1, 24);
        geo.rotateX(Math.PI / 2);
        return geo;
      }
      case GEOM_BOX: return new THREE.BoxGeometry(2 * s0, 2 * s1, 2 * s2);
      case GEOM_MESH: {
        const m = desc.meshes[desc.dataid[g]];
        if (!m) return null;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(m.vert, 3));
        geo.setIndex(new THREE.BufferAttribute(trimIndex(m.name, m.vert, m.face), 1));
        geo.computeVertexNormals();
        return geo;
      }
      default: return null;            // hfield/sdf: not rendered yet
    }
  }

  /** Apply a frame of geom world transforms from the sim worker. */
  sync(xpos: Float32Array, xmat: Float32Array) {
    for (let g = 0; g < this.geomMeshes.length; g++) {
      const mesh = this.geomMeshes[g];
      if (!mesh) continue;
      const p = 3 * g, r = 9 * g;
      this.tmp.set(
        xmat[r], xmat[r + 1], xmat[r + 2], xpos[p],
        xmat[r + 3], xmat[r + 4], xmat[r + 5], xpos[p + 1],
        xmat[r + 6], xmat[r + 7], xmat[r + 8], xpos[p + 2],
        0, 0, 0, 1);
      mesh.matrix.copy(this.tmp);
    }
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Render through `cam` into the largest centred rect of the given aspect (letterboxed), the way
   * an export with that camera will frame it. Returns the rect in CSS pixels, top-left origin. */
  renderFramed(cam: THREE.PerspectiveCamera, aspect: number): { x: number; y: number; w: number; h: number } {
    const r = this.renderer, size = r.getSize(new THREE.Vector2());
    let w = size.x, h = size.x / aspect;
    if (h > size.y) { h = size.y; w = h * aspect; }
    const x = (size.x - w) / 2, y = (size.y - h) / 2;
    r.setScissorTest(false);
    r.setClearColor(0x050607, 1);
    r.clear();
    r.setClearColor(0x000000, 0);
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    r.render(this.scene, cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    return { x, y, w, h };
  }

  // ---- export rendering ------------------------------------------------
  /** Give the canvas a `w`×`h` backing store (CSS size untouched) for frame-accurate rendering.
   * Transparent drops the background and fog; `floor` false hides the ground plane. */
  beginOffscreen(w: number, h: number, opts: { transparent?: boolean; floor?: boolean } = {}) {
    const r = this.renderer;
    if (!this.offscreen)
      this.offscreen = { ratio: r.getPixelRatio(), background: this.scene.background, fog: this.scene.fog };
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    const gl = r.getContext();
    if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) {
      this.endOffscreen();
      throw new Error(`the GPU cannot render ${w}×${h} (got ${gl.drawingBufferWidth}×${gl.drawingBufferHeight})`);
    }
    this.scene.background = opts.transparent ? null : this.offscreen.background;
    this.scene.fog = opts.transparent ? null : this.offscreen.fog;
    r.setClearColor(0x000000, 0);
    for (const f of this.floors) f.visible = opts.floor !== false;
  }

  /** Render through another camera (export frames at the offscreen size, the recorded-camera view). */
  renderWith(cam: THREE.Camera) { this.renderer.render(this.scene, cam); }

  endOffscreen() {
    const o = this.offscreen;
    if (!o) return;
    this.offscreen = null;
    this.scene.background = o.background;
    this.scene.fog = o.fog;
    for (const f of this.floors) f.visible = true;
    this.renderer.setPixelRatio(o.ratio);
    this.resize();
  }

  /** The rendered parts for a scene export: every visible geom mesh (ground planes excluded) with
   * its geom index. Their matrices are whatever the last sync() put there. */
  exportParts(): { geom: number; mesh: THREE.Mesh }[] {
    const out: { geom: number; mesh: THREE.Mesh }[] = [];
    this.geomMeshes.forEach((m, geom) => {
      if (m instanceof THREE.Mesh && m.visible) out.push({ geom, mesh: m });
    });
    return out;
  }

  /** Keep the camera orbiting around the robot base. */
  follow(x: number, y: number, z: number) {
    const t = this.controls.target;
    const dx = x - t.x, dy = y - t.y;
    t.set(x, y, z);
    this.camera.position.x += dx;
    this.camera.position.y += dy;
  }
}
