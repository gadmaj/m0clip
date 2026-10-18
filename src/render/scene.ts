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
import { FINISH, hasPalette, resolve, type Finish, type Paint, type Region } from "./paint";
import { sourceMaterial, sourceVertexMaterial } from "./source-lighting";
import { SourceAmbient, type SourceAmbientData } from "./source-ambient";
import { SourceLightStyles } from "./source-lightstyles";
import { patchSourceMaterial, SourceMaterials, type MaterialResources, type PropLightCache } from "./source-materials";
import { SourceNativeTextures, sourceNativeCube } from './source-vtf';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { RobotIllumination, robotLightSettings, type RobotLight } from "./robot-light";
import { SourceFlashlight } from "./source-flashlight";
import { SourceSky3D, type SourceVisibilityData } from './source-sky3d';
import { SourceVisibility } from './source-visibility';
import { SourceColor } from './source-color';
import { sourceSpriteState } from './source-sprites';
import { SceneCamera } from './scene-camera';
import { setSourceTexturesEnabled } from './source-textures';
import { DogBody, loadDog, type DogAsset, type BodyVisualState } from './source-robot/body';
import { DogRetarget } from './source-robot/retarget';
import { fadeOpacity } from './robot-fade';
import { loadGhostHead, R1_HEAD_PART, type SourceHeadAsset, type SourceHeadOverride } from "./source-robot/head";

export type HeadVisual = "stock" | "ghost";
export interface HeadVisualState { choice: HeadVisual; available: boolean; loading: boolean; error: string | null }

/** How the robot is painted: one plain grey (default), the product colourway from paint.ts, or the
 * model file's own rgba — then per-part overrides on top, keyed by mesh (STL) name. */
export type Colorway = "grey" | "product" | "model";
/** A part's paint: colour + finish preset, optionally fine-tuned (roughness 0 = mirror-shiny … 1 =
 * dull matte; metalness; clearcoat = a glossy lacquer layer on top). */
export interface PartPaint { color: number; finish: Finish; roughness?: number; metalness?: number; clearcoat?: number }
export interface Appearance { colorway: Colorway; parts: Record<string, PartPaint>; robotLight?: RobotLight; sourceBody?: 'stock' | 'dog'; sourceBodyColorway?: Colorway }
export const GREY: PartPaint = { color: 0x9a9da2, finish: "satin" };

/** Scene lighting. Angles in degrees (azimuth CCW from +x, elevation above the horizon), colours
 * as 0xRRGGBB, intensities as three.js light intensities. */
export interface Lighting {
  sunAzimuth: number; sunElevation: number; sunIntensity: number; sunColor: number;
  ambient: number; skyColor: number; groundColor: number;
  fill: number;            // camera-side fill light
  reflections: number;     // studio environment map intensity
  exposure: number;        // tone-mapping exposure
  shadows: boolean;
  background: number;
}
export interface SceneDisplay { textures: boolean; wireframe: boolean; map: boolean; robot: boolean; decals: boolean }
export const STUDIO: Lighting = {
  sunAzimuth: 27, sunElevation: 61, sunIntensity: 1.5, sunColor: 0xffffff,
  ambient: 0.8, skyColor: 0xdfeaf5, groundColor: 0x1a2028, fill: 0.7, reflections: 0.55,
  exposure: 1, shadows: false, background: 0x0b0e12,
};

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
  readonly camera: SceneCamera;
  readonly controls: OrbitControls;
  private geomMeshes: (THREE.Object3D | null)[] = [];
  readonly hemi = new THREE.HemisphereLight(0xdfeaf5, 0x1a2028, 0.8);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  readonly fill = new THREE.DirectionalLight(0xcfd8e6, 0.7);
  private lighting: Lighting = { ...STUDIO };
  private flashlight = new SourceFlashlight();
  private robotLight = new RobotIllumination();
  private dullMaterials = new Map<string, THREE.Material[]>();
  private patchDynamicLighting(material: THREE.Material, robot = false) {
    this.flashlight.patch(material); this.robotLight.patch(material, robot);
  }
  private robotMaterial(material: THREE.Material) {
    if (this.appearance.robotLight?.dull) this.dullMaterial(material);
    else if (material instanceof THREE.MeshStandardMaterial && this.appearance.robotLight?.brightness) {
      material.emissive.setHex(this.appearance.robotLight.color);
      material.emissiveIntensity = this.appearance.robotLight.brightness * .2;
    }
  }
  private dullMaterial(material: THREE.Material) {
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    material.roughness = 1; material.metalness = 0; material.envMapIntensity = 0;
    material.emissive.setHex(0); material.emissiveIntensity = 0;
    if (material instanceof THREE.MeshPhysicalMaterial) {
      material.clearcoat = 0; material.specularIntensity = 0; material.sheen = 0; material.iridescence = 0;
    }
  }
  private display: SceneDisplay = { textures: true, wireframe: false, map: true, robot: true, decals: true };
  private originalMaps = new WeakMap<THREE.Material, THREE.Texture | null>();
  private originalVisibility = new WeakMap<THREE.Object3D, boolean>();
  private robotFade = 1;
  private robotFadeFrom = 1;
  private robotFadeTarget = 1;
  private robotFadeStart = 0;
  private robotFadeOverride: number | null = null;
  private fadeMaterials = new WeakMap<THREE.Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  private placementMarker: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null = null;

  setRobotHidden(hidden: boolean) {
    this.updateRobotFade(); this.robotFadeFrom = this.robotFade;
    this.robotFadeTarget = hidden ? 0 : 1; this.robotFadeStart = performance.now();
  }
  getRobotOpacityOverride() { return this.robotFadeOverride; }
  setRobotOpacityOverride(value: number | null) { this.robotFadeOverride = value; this.updateRobotFade(); }
  getRobotOpacity() { return this.robotFade; }
  getRobotFadeState() { return { from: this.robotFadeFrom, target: this.robotFadeTarget,
    elapsed: Math.max(0, (performance.now() - this.robotFadeStart) / 1000) }; }
  private updateRobotFade() {
    this.robotFade = this.robotFadeOverride ?? fadeOpacity(this.robotFadeFrom, this.robotFadeTarget, (performance.now() - this.robotFadeStart) / 1000);
    this.sourceBody?.visibility(this.robotFade,this.display.robot);
    for (const object of this.geomMeshes) {
      if (!(object instanceof THREE.Mesh) || !object.userData.robotGeom) continue;
      object.visible = this.display.robot && (this.originalVisibility.get(object) ?? true) && !this.sourceBody && this.robotFade > 0;
      for (const material of [object.material].flat()) {
        if (!this.fadeMaterials.has(material)) this.fadeMaterials.set(material, {
          opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite,
        });
        const original = this.fadeMaterials.get(material)!;
        const fading = this.robotFade > 0 && this.robotFade < 1;
        const transparent = original.transparent || fading;
        if (transparent !== material.transparent) { material.transparent = transparent; material.needsUpdate = true; }
        material.depthWrite = fading ? false : original.depthWrite;
        material.opacity = fading ? original.opacity * this.robotFade : original.opacity;
      }
    }
  }

  /** Pick solid world geometry, excluding decorative props, decals and the hidden robot. */
  pickPlacement(ndc: THREE.Vector2): { point: THREE.Vector3; normal: THREE.Vector3; valid: boolean } | null {
    const ray = new THREE.Raycaster(); this.camera.updateMatrixWorld(); ray.setFromCamera(ndc, this.camera);
    this.scene.updateMatrixWorld(true);
    const targets: THREE.Object3D[] = this.terrainVisual ? [this.terrainVisual] : this.geomMeshes.filter(
      (object): object is THREE.Object3D => !!object && !object.userData.robotGeom);
    for (const hit of ray.intersectObjects(targets, true)) {
      let node: THREE.Object3D | null = hit.object, excluded = false;
      while (node) {
        if (!node.visible || node.userData.sourceProp || node.userData.sourceBrush || node.userData.sourceSprite || node.userData.sourceSky
            || node.userData.sourceOverlay || node.userData.sourceDetail) { excluded = true; break; }
        node = node.parent;
      }
      if (excluded || !hit.face) continue;
      const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      return { point: hit.point, normal, valid: normal.z >= .6 };
    }
    return null;
  }
  showPlacement(point: THREE.Vector3 | null, normal?: THREE.Vector3, valid = false) {
    if (!point) { if (this.placementMarker) this.placementMarker.visible = false; return; }
    if (!this.placementMarker) {
      this.placementMarker = new THREE.Mesh(new THREE.RingGeometry(.18, .24, 48),
        new THREE.MeshBasicMaterial({ color: 0xe0a23c, transparent: true, opacity: .95, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      this.scene.add(this.placementMarker);
    }
    this.placementMarker.visible = true;
    this.placementMarker.position.copy(point).addScaledVector(normal ?? THREE.Object3D.DEFAULT_UP, .008);
    this.placementMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal ?? THREE.Object3D.DEFAULT_UP);
    this.placementMarker.material.color.setHex(valid ? 0xe0a23c : 0xe5484d);
  }

  setFlashlight(on: boolean) { this.flashlight.set(on); }

  private displayMaterial(m: THREE.Material) {
    if (!(m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshBasicMaterial)) return;
    if(setSourceTexturesEnabled(m,this.display.textures)){
      if(m.wireframe!==this.display.wireframe){m.wireframe=this.display.wireframe;m.needsUpdate=true}
      return;
    }
    if (!this.originalMaps.has(m)) this.originalMaps.set(m, m.map);
    const map = this.display.textures ? this.originalMaps.get(m)! : null;
    if (m.map !== map || m.wireframe !== this.display.wireframe) {
      m.map = map; m.wireframe = this.display.wireframe; m.needsUpdate = true;
    }
  }

  setDisplay(display: SceneDisplay) {
    this.display = { ...display, decals: display.decals ?? true };
    if (this.terrainVisual) {
      this.terrainVisual.visible = display.map;
      this.terrainVisual.traverse(object => { if (object.userData.sourceOverlay) object.visible = this.display.decals; });
    }
    for (const o of this.geomMeshes) {
      if (!o) continue;
      if (o.userData.robotGeom) {
        if (!this.originalVisibility.has(o)) this.originalVisibility.set(o, o.visible);
        o.visible = display.robot && this.originalVisibility.get(o)! && !this.sourceBody;
      }
      o.traverse((child) => {
        if (child instanceof THREE.Mesh) for (const m of [child.material].flat()) this.displayMaterial(m);
      });
    }
    this.sourceBody?.eachMaterial(material=>this.displayMaterial(material));
    this.sourceBody?.visibility(this.robotFade,display.robot);
    for (const m of this.terrainMaterials)
      for (const material of [...[m.original].flat(), ...[m.source].flat()]) this.displayMaterial(material);
  }
  /** robot meshes by mesh name: the materials each colourway gives them */
  private parts = new Map<string, { mesh: THREE.Mesh; product: THREE.Material | THREE.Material[]; model: THREE.Material }>();
  private appearance: Appearance = { colorway: "grey", parts: {} };
  private paintCache = new Map<string, THREE.MeshPhysicalMaterial>();
  private highlighted: string | null = null;
  private highlightMaterials = new Map<string, THREE.Material>();
  private robotModel = "";
  private renderModel: RenderModel | null = null;
  private lastRobotPose: {xpos:Float32Array;xmat:Float32Array} | null = null;
  private sourceBody: DogBody | null = null;
  private bodyAsset: DogAsset | null = null;
  private bodyLoad: Promise<DogAsset> | null = null;
  private bodyRequest: Promise<void> | null = null;
  private bodyGeneration = 0;
  private bodyLoading = false;
  private bodyError: string | null = null;

  getBodyVisualState(): BodyVisualState {
    return {choice:this.appearance.sourceBody??'stock',applied:this.sourceBody?'dog':'stock',
      available:!!this.renderModel&&DogRetarget.available(this.renderModel),loading:this.bodyLoading,error:this.bodyError};
  }
  async waitForRobotVisuals() {
    if(this.appearance.sourceBody==='dog') {
      if(!this.getBodyVisualState().available)throw new Error('Dog requires a supported R1 model.');
      if(this.bodyRequest)await this.bodyRequest;
      if(!this.sourceBody)throw new Error(this.bodyError??'The Source robot body has not finished loading.');
    } else await this.waitForSourceHead();
  }
  retrySourceBody(){this.bodyError=null;this.bodyRequest=this.updateSourceBody();}
  private async updateSourceBody() {
    const state=this.getBodyVisualState();
    if(state.choice==='stock'||!state.available) {
      const changed=!!this.sourceBody||this.bodyLoading||!!this.bodyError;
      ++this.bodyGeneration;this.sourceBody?.dispose();this.sourceBody=null;this.bodyLoading=false;this.bodyError=null;
      if(changed){this.setDisplay(this.display);this.onHeadVisualChange?.();}return;
    }
    if(this.sourceBody){this.sourceBody.updateMaterials();return;}
    if(this.bodyLoading)return;
    const generation=++this.bodyGeneration;
    this.bodyLoading=true;this.bodyError=null;this.onHeadVisualChange?.();
    try {
      this.bodyLoad??=loadDog().catch(error=>{this.bodyLoad=null;throw error});
      this.bodyAsset=await this.bodyLoad;
      if(generation!==this.bodyGeneration||this.appearance.sourceBody!=='dog')return;
      this.sourceBody=this.bodyAsset.create(this.renderModel!,(part,material)=>{
        const cw=this.appearance.sourceBodyColorway??'model';
        const paint=this.appearance.parts[part]??(cw==='grey'?GREY:
          cw==='product'?resolve(this.robotModel,part).paint:undefined);
        if(paint){material.color.setHex(paint.color);const finish=FINISH[paint.finish];
          material.roughness=paint.roughness??finish.roughness;material.metalness=paint.metalness??finish.metalness;
          material.clearcoat=paint.clearcoat??finish.clearcoat??0;material.emissive.multiply(material.color);}
        if(this.highlighted===part){material.emissive.setHex(0xe0a23c);material.emissiveIntensity=.35;}
        this.robotMaterial(material);
        if(this.appearance.robotLight?.brightness&&!this.appearance.robotLight?.dull)material.emissiveMap=null;
        this.sourceAmbient.patch(material);this.patchDynamicLighting(material,true);this.displayMaterial(material);
      });
      if(this.lastRobotPose)this.sourceBody.sync(this.lastRobotPose.xpos,this.lastRobotPose.xmat);
      this.scene.add(this.sourceBody.root);this.setDisplay(this.display);
    }catch(error){if(generation===this.bodyGeneration)this.bodyError=error instanceof Error?error.message:String(error)}
    if(generation===this.bodyGeneration){this.bodyLoading=false;this.onHeadVisualChange?.();}
  }
  exportSourceBody(poses:Float32Array,ngeom:number,times:Float32Array){return this.sourceBody?.export(poses,ngeom,times)??null;}
  private headChoice: HeadVisual = "stock";
  private headAsset: SourceHeadAsset | null = null;
  private headLoad: Promise<SourceHeadAsset> | null = null;
  private headOverride: SourceHeadOverride | null = null;
  private headToFile: THREE.Matrix4 | null = null;
  private headGeneration = 0;
  private headLoading = false;
  private headError: string | null = null;
  onHeadVisualChange: (() => void) | null = null;

  getHeadVisual(): HeadVisual { return this.headChoice; }
  /** Applied geometry, suitable for take metadata: a failed download remains stock. */
  getSourceHead(): HeadVisual { return this.headOverride ? "ghost" : "stock"; }
  async setSourceHead(kind: HeadVisual): Promise<void> {
    await this.setHeadVisual(kind);
    if (kind === "ghost" && !this.headOverride) throw new Error(this.headError ?? "The Ghost head is only available on R1.");
  }
  async waitForSourceHead(): Promise<void> {
    if (this.headChoice !== "ghost" || !this.getHeadVisualState().available) return;
    if (this.headLoading && this.headLoad) await this.headLoad;
    // setHeadVisual registered its completion before this waiter.
    if (!this.headOverride) throw new Error(this.headError ?? "The Ghost head has not finished loading.");
  }
  getHeadVisualState(): HeadVisualState {
    return { choice: this.headChoice, available: this.robotModel.startsWith("r1") && this.parts.has(R1_HEAD_PART),
      loading: this.headLoading, error: this.headError };
  }

  /** Cosmetic only: never changes the robot's physics, geom indices or controls. */
  async setHeadVisual(choice: HeadVisual): Promise<void> {
    const generation = ++this.headGeneration;
    this.headChoice = choice;
    this.headLoading = false; this.headError = null;
    this.headOverride?.restore(); this.headOverride = null;
    this.onHeadVisualChange?.();
    if (choice !== "ghost" || !this.getHeadVisualState().available) return;
    this.headLoading = true; this.onHeadVisualChange?.();
    try {
      this.headLoad ??= loadGhostHead().catch((error: unknown) => { this.headLoad = null; throw error; });
      const asset = await this.headLoad;
      this.headAsset = asset;
      // Robot/map rebuilds and a switch back to stock invalidate in-flight requests.
      if (generation !== this.headGeneration || this.headChoice !== "ghost") return;
      this.headLoading = false;
      this.applyHeadVisual();
    } catch (error) {
      if (generation !== this.headGeneration) return;
      this.headLoading = false;
      this.headError = error instanceof Error ? error.message : String(error);
    }
    if (generation === this.headGeneration) this.onHeadVisualChange?.();
  }

  private applyHeadVisual() {
    if (this.headChoice !== "ghost" || !this.headAsset || !this.headToFile || !this.getHeadVisualState().available) return;
    const part = this.parts.get(R1_HEAD_PART)!;
    this.headOverride?.restore();
    this.headOverride = this.headAsset.apply(part.mesh, this.headToFile, material => {
      const native = material as THREE.MeshPhysicalMaterial;
      const paint = this.appearance.parts[R1_HEAD_PART];
      if (paint) {
        native.color.setHex(paint.color);
        native.roughness = paint.roughness ?? FINISH[paint.finish].roughness;
        native.metalness = paint.metalness ?? FINISH[paint.finish].metalness;
        native.clearcoat = paint.clearcoat ?? FINISH[paint.finish].clearcoat;
      }
      if (this.highlighted === R1_HEAD_PART) {
        native.emissive.setHex(0xe0a23c); native.emissiveIntensity = .35;
      }
      this.robotMaterial(material);
      this.sourceAmbient.patch(material);
      this.patchDynamicLighting(material, true);
      this.displayMaterial(material);
    });
  }
  private floors: THREE.Object3D[] = [];
  private readonly tmp = new THREE.Matrix4();
  /** set while an export owns the canvas size (beginOffscreen … endOffscreen) */
  private offscreen: { ratio: number; background: THREE.Scene["background"]; fog: THREE.Scene["fog"]; transparent: boolean } | null = null;

  constructor(readonly container: HTMLElement) {
    // preserveDrawingBuffer: screenshots and video export read the canvas anytime;
    // alpha: transparent-background renders (the scene background keeps it opaque otherwise)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e12);

    this.camera = new SceneCamera(45, 1, 0.05, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(2.2, -2.2, 1.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.7);
    this.controls.enableDamping = true;

    const hemi = this.hemi;
    this.scene.add(hemi);
    const dir = this.sun;
    dir.position.set(2, 1, 4);
    dir.shadow.mapSize.set(2048, 2048);
    Object.assign(dir.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 40 });
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.02;
    this.scene.add(dir, dir.target);
    this.renderer.toneMapping = THREE.NeutralToneMapping;   // exposure control; ~neutral at 1
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const fill = this.fill;                                    // camera-side fill
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
    ++this.bodyGeneration;this.sourceBody?.dispose();this.sourceBody=null;this.bodyLoading=false;this.bodyError=null;
    this.renderModel=desc;this.lastRobotPose=null;
    ++this.headGeneration;
    this.headOverride?.restore(); this.headOverride = null;
    this.headToFile = null; this.headLoading = false; this.headError = null;
    this.robotModel = desc.robot;
    for (const material of this.highlightMaterials.values()) material.dispose();
    this.highlightMaterials.clear();
    for (const materials of this.dullMaterials.values()) for (const material of materials) material.dispose();
    this.dullMaterials.clear();
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
    this.parts.clear();
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
        floor.traverse((o) => {
          o.receiveShadow = true;
          if (o instanceof THREE.Mesh) for (const m of [o.material].flat()) this.patchDynamicLighting(m);
        });
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
      if (desc.robot.startsWith("r1") && meshName === R1_HEAD_PART) {
        const md = desc.meshes[desc.dataid[g]];
        this.headToFile = new THREE.Matrix4().compose(new THREE.Vector3(...md.pos),
          new THREE.Quaternion(md.quat[1], md.quat[2], md.quat[3], md.quat[0]), new THREE.Vector3(1, 1, 1));
      }
      const robotPart = isMesh && desc.bodyid[g] > 0;           // terrain keeps its rgba
      const painted = robotPart && hasPalette(desc.robot);
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
      mesh.userData.meshName = robotPart ? meshName : null;
      mesh.userData.robotGeom = desc.bodyid[g] > 0;
      mesh.castShadow = robotPart;
      mesh.receiveShadow = true;
      for (const m of [mesh.material].flat()) this.patchDynamicLighting(m);
      if (robotPart && !this.parts.has(meshName)) {
        const model = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(desc.rgba[4 * g], desc.rgba[4 * g + 1], desc.rgba[4 * g + 2]),
          side: THREE.DoubleSide, ...FINISH.satin });
        this.parts.set(meshName, { mesh, product: mesh.material, model });
        this.applyPart(meshName);
      }
      this.scene.add(mesh);
      this.geomMeshes.push(mesh);
    }
    this.setDisplay(this.display);
    void this.setHeadVisual(this.headChoice);
    this.bodyRequest=this.updateSourceBody();
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
    if(this.sourceBody&&this.sourceBody.root.visible){
      const hit=ray.intersectObjects(this.sourceBody.meshes,false)[0];
      return hit?(hit.object.userData.sourcePartNames[hit.face?.materialIndex??0]??null):null;
    }
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
    this.lastRobotPose={xpos,xmat};this.sourceBody?.sync(xpos,xmat);
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

  getSourceTime() { return this.sourceAnimationTime ?? Math.max(0, (performance.now() - this.sourceAnimationStart) / 1000); }
  setSourceTime(time: number | null) { this.sourceAnimationTime = time; }
  getVisualRevision(){return `${this.terrainGeneration}:${this.bodyGeneration}:${this.headGeneration}`;}

  /** Share map clipping with the live camera, shot preview and exported camera. */
  configureCamera(camera:THREE.Camera){
    if(camera instanceof SceneCamera)camera.setSourceProjection(this.sourceColorMap);
  }

  private prepareSourceView(camera: THREE.Camera) {
    this.configureCamera(camera);
    this.updateRobotFade();
    this.robotLight.visibility(this.display.robot ? this.robotFade : 0);
    const base = this.geomMeshes.find(object => object?.userData.robotGeom);
    if (base) this.robotLight.position.value.setFromMatrixPosition(base.matrix);
    const time = this.getSourceTime();
    if (this.sourceLighting) this.sourceStyles?.update(time);
    this.sourceMaterials.update(time);
    this.sourceMixer?.setTime(time);
    for (const sky of this.sourceSky) {
      sky.position.copy(camera.position); sky.visible = !this.offscreen?.transparent;
    }
    for (const sprite of this.sourceSprites) {
      sprite.quaternion.copy(camera.quaternion);
      const state=sourceSpriteState(sprite.userData.sourceRenderMode,sprite.position.distanceTo(camera.position));
      sprite.scale.setScalar(state.scale);
      // SpriteInstance sets $alpha to its distance fade immediately before drawing,
      // superseding the entity renderamt. Keep the authored amount in node metadata.
      for (const material of [sprite.material].flat()) material.opacity=state.alpha;
    }
    for (const detail of this.sourceDetails) detail.rotation.set(0, 0,
      Math.atan2(camera.position.y - detail.position.y, camera.position.x - detail.position.x) - Math.PI / 2);
  }

  render() {
    if (this.controls.enabled) this.controls.update();
    this.prepareSourceView(this.camera);
    this.flashlight.renderDepth(this.renderer, this.scene, this.camera);
    this.renderSourceScene(this.camera);
  }

  /** Source renders the miniature sky world first, then clears depth for the main world. */
  private renderSourceScene(camera: THREE.Camera) {
    const draw=()=>this.drawSourceScene(camera);
    if(this.sourceLighting&&this.sourceColorMap&&this.terrainVisual) {
      this.sourceColor.render(this.renderer,draw,this.sourceAmbient.linearOutput,!!this.offscreen?.transparent);
    }else draw();
  }

  private drawSourceScene(camera: THREE.Camera) {
    const sky = this.sourceSky3D, renderer = this.renderer;
    const drawWorld = () => renderer.render(this.scene,camera);
    const drawVisibleWorld = () => this.sourceVisibility && this.display.map
      ? this.sourceVisibility.draw(camera,drawWorld) : drawWorld();
    if (!sky || !this.display.map || this.offscreen?.transparent) {
      drawVisibleWorld(); return;
    }
    sky.prepare(camera,this.display.decals);
    sky.scene.background = this.scene.background;
    sky.scene.environment = this.scene.environment;
    sky.scene.environmentIntensity = this.scene.environmentIntensity;
    for (const [source, clone] of this.sourceSkyLights) {
      clone.copy(source,false); clone.castShadow = false;
    }
    const brightness = this.robotLight.brightness.value, autoClear = renderer.autoClear;
    const background = this.scene.background, visible = this.sourceSky.map(s => s.visible);
    try {
      this.robotLight.brightness.value = 0;
      this.flashlight.withoutLight(() => renderer.render(sky.scene,sky.camera));
      this.robotLight.brightness.value = brightness;
      renderer.clearDepth();
      renderer.autoClear = false; this.scene.background = null;
      for (const mesh of this.sourceSky) mesh.visible = false;
      drawVisibleWorld();
    } finally {
      this.robotLight.brightness.value = brightness;
      renderer.autoClear = autoClear; this.scene.background = background;
      this.sourceSky.forEach((mesh,index) => mesh.visible = visible[index]);
    }
  }

  /** Render through `cam` into the largest centred rect of the given aspect (letterboxed), the way
   * an export with that camera will frame it. Returns the rect in CSS pixels, top-left origin. */
  renderFramed(cam: THREE.PerspectiveCamera, aspect: number): { x: number; y: number; w: number; h: number } {
    this.prepareSourceView(cam);
    this.flashlight.renderDepth(this.renderer, this.scene, cam);
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
    this.renderSourceScene(cam);
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
      this.offscreen = { ratio: r.getPixelRatio(), background: this.scene.background, fog: this.scene.fog, transparent: !!opts.transparent };
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
  renderWith(cam: THREE.Camera) {
    this.prepareSourceView(cam);
    this.flashlight.renderDepth(this.renderer, this.scene, cam);
    this.renderSourceScene(cam);
  }

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
      if (!(m instanceof THREE.Mesh)) return;
      if(this.sourceBody&&m.userData.robotGeom)return;
      const faded = m.userData.robotGeom && this.display.robot && (this.originalVisibility.get(m) ?? true) && this.robotFade < 1;
      if (!m.visible && !faded) return;
      // glTF has no native per-object opacity animation. Keep complete opaque
      // robot geometry for DCC export even when the viewport's fade hides it.
      if (faded) {
        const copy = m.clone();
        const materials = [m.material].flat().map(material => {
          const original = this.fadeMaterials.get(material), result = material.clone();
          if (original) { result.opacity = original.opacity; result.transparent = original.transparent; result.depthWrite = original.depthWrite; }
          return result;
        });
        copy.material = Array.isArray(m.material) ? materials : materials[0]; copy.visible = true;
        out.push({ geom, mesh: copy });
      } else out.push({ geom, mesh: m });
    });
    return out;
  }

  // ---- robot appearance --------------------------------------------------
  /** Robot mesh (STL) names in the scene, sorted. */
  partNames(): string[] { return this.sourceBody?.partNames()??[...this.parts.keys()].sort(); }

  setAppearance(a: Appearance) {
    this.appearance = { ...a, sourceBody:a.sourceBody==='dog'?'dog':'stock', robotLight: robotLightSettings(a.robotLight) };
    this.robotLight.set(this.appearance.robotLight);
    for (const name of this.parts.keys()) this.applyPart(name);
    if(this.bodyLoading&&this.appearance.sourceBody==='dog')return;
    this.bodyRequest=this.updateSourceBody();
  }

  getAppearance(): Appearance { return structuredClone(this.appearance); }

  private paintMat(p: PartPaint): THREE.MeshPhysicalMaterial {
    const key = `${p.color}/${p.finish}/${p.roughness}/${p.metalness}/${p.clearcoat}`;
    let m = this.paintCache.get(key);
    if (!m) {
      m = paintMaterial(p);
      if (p.roughness !== undefined) m.roughness = p.roughness;
      if (p.metalness !== undefined) m.metalness = p.metalness;
      if (p.clearcoat !== undefined) m.clearcoat = p.clearcoat;
      this.paintCache.set(key, m);
    }
    return m;
  }

  // ---- terrain visual (textured map glTF) -----------------------------------
  private terrainVisual: THREE.Object3D | null = null;
  private sourceLighting = true;
  private sourceExposure = { value: 1 };
  private sourceMixer: THREE.AnimationMixer | null = null;
  private sourceSky: THREE.Mesh[] = [];
  private sourceSky3D: SourceSky3D | null = null;
  private sourceVisibility: SourceVisibility | null = null;
  private sourceSkyLights: [THREE.Light, THREE.Light][] = [];
  private sourceSprites: THREE.Mesh[] = [];
  private sourceDetails: THREE.Mesh[] = [];
  private sourceAnimationStart = 0;
  private sourceAnimationTime: number | null = null;
  private sourceAmbient = new SourceAmbient();
  private sourceColor=new SourceColor();
  private sourceColorMap=false;
  private sourceStyles: SourceLightStyles | null = null;
  private sourceMaterials=new SourceMaterials();
  private terrainMaterials: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[];
                              source: THREE.Material | THREE.Material[] }[] = [];

  /** Auto / Map use Source's baked lighting; other presets deliberately re-light the scene. */
  setSourceLighting(on: boolean) {
    this.sourceLighting = on;
    for (const m of this.terrainMaterials) m.mesh.material = on ? m.source : m.original;
    const active = on && this.terrainMaterials.length > 0;
    this.sourceAmbient.enabled.value = active && this.sourceAmbient.available ? 1 : 0;
    this.hemi.visible = this.fill.visible = this.sun.visible = !active;
    this.scene.environmentIntensity = active ? 0 : this.lighting.reflections;
    // Source supplies its own diffuse, specular and gamma output. Never pass that
    // through the studio tone mapper or supplement it with a soft shadowed sun.
    this.renderer.toneMapping = active ? THREE.NoToneMapping : THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = !active && this.lighting.shadows;
    this.sourceExposure.value = this.sourceAmbient.exposure.value = this.flashlight.exposure.value = active ? 1 : this.lighting.exposure;
  }

  updateRobotLighting(x: number, y: number, z: number) { this.sourceAmbient.sample(x, y, z); }
  private terrainUrl: string | null = null;
  private terrainRequest: Promise<void> = Promise.resolve();
  private terrainGeneration=0;

  waitForTerrainVisuals(): Promise<void> { return this.terrainRequest; }

  /** Show a converted map's textured scene (null removes it). Its positions are already in the
   * MuJoCo frame, so it goes in as-is; the map's collision lives in MuJoCo, not here. */
  setTerrainVisual(url: string | null, progress?: (phase: string, loaded: number, total: number) => void): Promise<void> {
    if (url === this.terrainUrl) return this.terrainRequest;
    this.terrainRequest = this.loadTerrainVisual(url, progress);
    return this.terrainRequest;
  }

  private async loadTerrainVisual(url: string | null, progress?: (phase: string, loaded: number, total: number) => void) {
    const generation=++this.terrainGeneration,current=()=>generation===this.terrainGeneration;
    const report=(phase:string,loaded:number,total:number)=>{if(current())progress?.(phase,loaded,total)};
    this.sourceMaterials.dispose();
    const context=this.sourceMaterials=new SourceMaterials();
    this.terrainUrl = url;
    this.sourceColorMap=!!url&&new URL(url,location.href).pathname.endsWith('/nt_ghost_ctg/visual.glb');
    this.configureCamera(this.camera);
    this.sourceColor.reset();
    this.sourceSky3D = null; this.sourceSkyLights = [];
    this.sourceVisibility = null;
    this.sourceStyles = null;
    this.sourceMixer?.stopAllAction();this.sourceMixer=null;
    this.sourceSky=[];this.sourceSprites=[];this.sourceDetails=[];
    this.sourceAmbient.styleValue = () => 1;
    this.sourceAmbient.setData(null);
    this.setSourceLighting(this.sourceLighting);
    if (this.terrainVisual) {
      this.scene.remove(this.terrainVisual);
      this.terrainMaterials = [];
      this.terrainVisual = null;
    }
    this.setSourceLighting(this.sourceLighting);
    if (!url) return;
    try {
    const ambient = fetch(new URL('lighting.json', new URL(url, location.href)))
      .then((r) => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() as Promise<SourceAmbientData> : null)
      .catch(() => null);
    const styles = SourceLightStyles.load(new URL('lightstyles.json', new URL(url, location.href))).then(styles=>{
      for(const texture of styles?.textures.values()??[])context.own(texture);return styles;
    }).catch((e) => {
      console.warn('Source light styles failed to load', e);
      return null;
    });
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const nativeTextures=new Map<GLTFParser,SourceNativeTextures>();
    const load=async(path:string,phase:string)=>{
      const result=await loader.loadAsync(path,e=>report(phase,e.loaded,e.total));
      const native=new SourceNativeTextures(result.parser,context,this.renderer);nativeTextures.set(result.parser,native);
      const pending:Promise<void>[]=[];
      result.scene.traverse(object=>{if(object instanceof THREE.Mesh){
        context.own(object.geometry);
        for(const material of [object.material].flat()){
          context.own(material);
          for(const [name,value] of Object.entries(material))if(value instanceof THREE.Texture){
            context.own(value);const index=result.parser.associations.get(value)?.textures;
            if(index!==undefined)pending.push(native.restore(value,index).then(texture=>{(material as unknown as Record<string,unknown>)[name]=texture;}));
          }
        }
      }});
      await Promise.all(pending);
      return result;
    };
    const manifest = fetch(new URL('manifest.json', new URL(url, location.href))).then(r => r.json());
    const visibility = manifest.then(async (m: { visibility?: string }) => {
      if (m.visibility !== 'visibility.json') return null;
      const response = await fetch(new URL(m.visibility,new URL(url,location.href)));
      if (!response.ok) throw new Error('Source visibility data failed to load');
      return response.json() as Promise<SourceVisibilityData>;
    });
    const props = manifest
      .then((manifest: { props?: { visual?: string } }) => manifest.props?.visual === 'props.glb'
        ? load(new URL('props.glb', new URL(url, location.href)).href,'models') : null);
    const [gltf, propGltf, visibilityData] = await Promise.all([load(url,'map textures'), props, visibility]);
    report('preparing materials', 0, 0);
    const sourceStyles = await styles;
    if (!current()) return;
    let mixer:THREE.AnimationMixer|null=null;
    const sky:THREE.Mesh[]=[],sprites:THREE.Mesh[]=[],details:THREE.Mesh[]=[];
    if (propGltf?.animations.length) {
      mixer = new THREE.AnimationMixer(propGltf.scene);
      for (const clip of propGltf.animations) mixer.clipAction(clip).play();
      const ownedMixer=mixer;context.own({dispose:()=>{ownedMixer.stopAllAction();ownedMixer.uncacheRoot(propGltf.scene)}});
    }
    const materialParsers = new Map<THREE.Material, typeof gltf.parser>();
    if (propGltf) {
      propGltf.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          for (const m of [o.material].flat()) materialParsers.set(m, propGltf.parser);
        }
      });
      gltf.scene.add(propGltf.scene);
    }
    const cubes = new Map<string, Promise<THREE.CubeTexture>>();
    const effects = async (source: THREE.MeshBasicMaterial, original: THREE.MeshStandardMaterial, mesh: THREE.Mesh) => {
      const parser = materialParsers.get(original) ?? gltf.parser;
      const metadata = original.userData.sourceMaterial;
      if (!metadata) return;
      const texture = async (index: unknown,colorSpace:string=THREE.NoColorSpace) => {
        if (typeof index !== 'number') return undefined;
        const value = await nativeTextures.get(parser)!.get(index,colorSpace);
        if(!value.userData.sourceNativeTexture){value.anisotropy=Math.min(16,this.renderer.capabilities.getMaxAnisotropy());value.needsUpdate=true;}
        return value;
      };
      const [normal, mask, exponent, selfIllum, frames, lightmaps, base2, detail] = await Promise.all([
        texture(metadata.bumpmapIndex), texture(metadata.envmapmaskIndex),
        texture(metadata.phongexponenttextureIndex), texture(metadata.selfillummaskIndex),
        Promise.all((metadata.animationFrames ?? []).map((index:number)=>nativeTextures.get(parser)!.get(index,THREE.SRGBColorSpace))),
        Promise.all((original.userData.sourceBumpLightmaps ?? []).map((index: number) => texture(index) as Promise<THREE.Texture>)),
        texture(metadata.basetexture2Index,THREE.SRGBColorSpace), texture(metadata.detailIndex),
      ]);
      for (const lightmap of lightmaps) {
        lightmap.flipY = false; lightmap.wrapS = lightmap.wrapT = THREE.ClampToEdgeWrapping;
        lightmap.minFilter = lightmap.magFilter = THREE.LinearFilter;
        lightmap.generateMipmaps = false; lightmap.needsUpdate = true;
      }
      if (base2) { base2.colorSpace = THREE.SRGBColorSpace; base2.needsUpdate = true; }
      for (const frame of frames) {context.own(frame);frame.colorSpace = THREE.SRGBColorSpace;}
      const resources: MaterialResources = { normal, mask, exponent, selfIllum, frames, lightmaps, base2, detail };
      let node: THREE.Object3D | null = mesh;
      while (node?.parent && !node.userData.sourceLighting && !node.userData.sourceOrigin) node = node.parent;
      const cache = node?.userData.sourceLighting as PropLightCache | undefined;
      const faces = (metadata.envmapFaces ?? node?.userData.sourceCubeFaces) as number[] | undefined;
      let cube: THREE.CubeTexture | undefined;
      if (faces) {
        // Texture indices are local to each glTF; the world and props reuse IDs.
        const key = (parser === gltf.parser ? 'world:' : 'props:') + faces.join(',');
        if (!cubes.has(key)) cubes.set(key, Promise.all(faces.map(i=>nativeTextures.get(parser)!.get(i,THREE.SRGBColorSpace))).then(textures => {
          for(const texture of textures)context.own(texture);
          const value = context.own(sourceNativeCube(textures));
          return value;
        }));
        cube = await cubes.get(key);
      }
      patchSourceMaterial(source, original, resources, cache, cube, node?.userData.sourceOrigin, node?.userData.sourceYaw, mesh.geometry.hasAttribute('tangent'),context);
    };
    const variants:SceneView['terrainMaterials'] = [];
    const pending: Promise<void>[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.receiveShadow = true;
        o.castShadow = true;
        for (const m of [o.material].flat()) {
          const t = (m as THREE.MeshStandardMaterial).map;
          if (t&&!t.userData.sourceNativeTexture) t.anisotropy = Math.min(16,this.renderer.capabilities.getMaxAnisotropy());
        }
        pending.push((async () => {
          const original = o.material;
          const materials = await Promise.all([original].flat().map(async (m) => {
            if (!(m instanceof THREE.MeshStandardMaterial)) return m;
            const vertexScale = m.userData.sourceVertexLighting;
            if (typeof vertexScale === 'number') {
              const source = context.own(sourceVertexMaterial(m, vertexScale, this.sourceExposure,this.sourceAmbient.linearOutput,o.userData.sourceSky===true));
              if (o.userData.sourceSky) {
                source.depthWrite = false; source.depthTest = false;
                o.frustumCulled = false; o.renderOrder = -10000; o.castShadow = false; sky.push(o);
              } else if (o.userData.sourceSprite) {
                source.transparent = true; source.depthWrite = false; source.blending = THREE.AdditiveBlending;
                m.transparent = true; m.depthWrite = false; m.blending = THREE.AdditiveBlending;
                o.castShadow = false; sprites.push(o);
              } else if (o.userData.sourceDetail) { details.push(o); }
              else await effects(source, m, o);
              if (!o.userData.sourceSky && !o.userData.sourceSprite && !o.userData.sourceDetail && !m.userData.sourceUnlit) {
                this.patchDynamicLighting(source); this.patchDynamicLighting(m);
              }
              return source;
            }
            const index = m.userData.sourceLightmap;
            if (typeof index !== 'number') return m;
            const lightmap = (!m.userData.sourcePropBrush ? sourceStyles?.textures.get(index) : null)
              ?? await (materialParsers.get(m) ?? gltf.parser).getDependency('texture', index) as THREE.Texture;
            context.own(lightmap);
            const source = context.own(sourceMaterial(m, lightmap, this.sourceExposure,this.sourceAmbient.linearOutput));
            await effects(source, m, o);
            this.patchDynamicLighting(source);
            this.patchDynamicLighting(m);
            return source;
          }));
          const source = Array.isArray(original) ? materials : materials[0];
          variants.push({ mesh: o, original: o.userData.sourceSky || o.userData.sourceSprite || o.userData.sourceDetail ? source : original, source });
        })());
      }
    });
    const [, ambientData] = await Promise.all([Promise.all(pending), ambient]);
    if (!current()) return;
    const mainVisibility=visibilityData?context.own(new SourceVisibility(visibilityData,gltf.scene)):null;
    let sky3D:SourceSky3D|null=null;
    let skyLights:[THREE.Light,THREE.Light][]=[];
    if (visibilityData?.sky) {
      const byMesh = new Map(variants.map(v => [v.mesh,v]));
      sky3D = context.own(new SourceSky3D(visibilityData,gltf.scene,(original,clone) => {
        const variant = byMesh.get(original);
        if (variant) variants.push({...variant,mesh:clone});
      }));
      skyLights = [this.hemi,this.sun,this.fill].map(light => [light,light.clone()]);
      for (const [, light] of skyLights) sky3D.scene.add(light);
    }
    this.sourceSky=sky;this.sourceSprites=sprites;this.sourceDetails=details;
    this.sourceMixer=mixer;this.sourceAnimationStart=performance.now();
    this.sourceVisibility=mainVisibility;this.sourceSky3D=sky3D;this.sourceSkyLights=skyLights;
    this.terrainMaterials = variants;
    this.sourceStyles = sourceStyles;
    this.sourceAmbient.styleValue = sourceStyles?.value ?? (() => 1);
    this.sourceAmbient.setData(ambientData);
    this.setSourceLighting(this.sourceLighting);
    this.terrainVisual = gltf.scene;
    this.scene.add(gltf.scene);
    this.setDisplay(this.display);
    }catch(error){context.dispose();if(current())throw error;}
  }

  /** The terrain's textured visual (for scene exports), or null. */
  get terrainObject(): THREE.Object3D | null { return this.terrainVisual; }

  private applyPart(name: string) {
    const e = this.parts.get(name);
    if (!e) return;
    if (name === R1_HEAD_PART) { this.headOverride?.restore(); this.headOverride = null; }
    this.highlightMaterials.get(name)?.dispose(); this.highlightMaterials.delete(name);
    const o = this.appearance.parts[name], cw = this.appearance.colorway;
    let mat: THREE.Material | THREE.Material[] = o ? this.paintMat(o)
      : cw === "product" ? e.product : cw === "model" ? e.model : this.paintMat(GREY);
    if (name === this.highlighted) {
      const hl = (Array.isArray(mat) ? mat[0] : mat as THREE.MeshPhysicalMaterial).clone() as THREE.MeshPhysicalMaterial;
      hl.emissive = new THREE.Color(0xe0a23c);
      hl.emissiveIntensity = 0.35;
      mat = hl;
      this.highlightMaterials.set(name, hl);
    }
    for (const previous of this.dullMaterials.get(name) ?? []) previous.dispose();
    this.dullMaterials.delete(name);
    if (this.appearance.robotLight?.dull || this.appearance.robotLight?.brightness) {
      const copies = [mat].flat().map(material => { const copy = material.clone(); this.robotMaterial(copy); return copy; });
      this.dullMaterials.set(name, copies);
      mat = Array.isArray(mat) ? copies : copies[0];
    }
    e.mesh.material = mat;
    for (const m of [mat].flat()) {
      this.sourceAmbient.patch(m);
      this.patchDynamicLighting(m, true);
      this.displayMaterial(m);
    }
    if (name === R1_HEAD_PART) this.applyHeadVisual();
  }

  /** Tint one part so the editor shows what is selected (null clears). */
  highlight(name: string | null) {
    const prev = this.highlighted;
    this.highlighted = name;
    if (prev) this.applyPart(prev);
    if (name) this.applyPart(name);
    this.sourceBody?.updateMaterials();
  }

  // ---- lighting --------------------------------------------------------------
  getLighting(): Lighting { return { ...this.lighting }; }

  setLighting(l: Lighting) {
    this.sourceExposure.value = l.exposure;
    this.sourceAmbient.exposure.value = l.exposure;
    this.flashlight.exposure.value = l.exposure;
    this.lighting = { ...l };
    this.sun.color.set(l.sunColor);
    this.sun.intensity = l.sunIntensity;
    this.hemi.color.set(l.skyColor);
    this.hemi.groundColor.set(l.groundColor);
    this.hemi.intensity = l.ambient;
    this.fill.intensity = l.fill;
    this.scene.environmentIntensity = l.reflections;
    this.setSourceLighting(this.sourceLighting);
    this.renderer.toneMappingExposure = l.exposure;
    this.renderer.shadowMap.enabled = l.shadows && !(this.sourceLighting && this.terrainMaterials.length > 0);
    this.sun.castShadow = l.shadows;
    const bg = new THREE.Color(l.background);
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(bg);
    if (this.scene.fog) this.scene.fog.color.copy(bg);
    if (this.offscreen?.background instanceof THREE.Color) this.offscreen.background.copy(bg);
    this.scene.traverse((o) => {                 // shadow-map on/off changes the shader variants
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of [m].flat()) x.needsUpdate = true;
    });
    this.aimSun();
  }

  /** Keep the sun (and its shadow frustum) centred on the camera target. */
  private aimSun() {
    const l = this.lighting, t = this.controls.target, D = Math.PI / 180;
    const az = l.sunAzimuth * D, el = l.sunElevation * D;
    this.sun.position.set(t.x + 12 * Math.cos(el) * Math.cos(az), t.y + 12 * Math.cos(el) * Math.sin(az),
                          t.z + 12 * Math.sin(el));
    this.sun.target.position.copy(t);
    this.sun.target.updateMatrixWorld();
  }

  /** Keep the camera orbiting around the robot base. */
  follow(x: number, y: number, z: number) {
    this.sourceAmbient.sample(x, y, z);
    const t = this.controls.target;
    const dx = x - t.x, dy = y - t.y, dz = z - t.z;
    t.set(x, y, z);
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;
    this.aimSun();
  }
}
