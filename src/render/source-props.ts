/** Authored Source prop display, separate from root/PVS visibility.
 * Distance semantics: Valve Source SDK 2013 cdll_util.cpp ComputeDistanceFade;
 * static-prop/screen semantics: Source CStaticPropMgr / CModelInfoClient.
 * No entity inputs, render effects, hardware profile or physics emulation. */
import * as THREE from 'three';
import type { SourceMapPropView } from '../maps/source';

const METRES = .0254;
const FADES = 1, SCREEN_SPACE_FADE = 32, NO_FORCED_FADE = 0x800;
type MaterialSet = THREE.Material | THREE.Material[];
export interface SourcePropView extends SourceMapPropView {
  /** Native FOV-distance adjustment, NOT forcedFadeScale. One is the normal view. */
  distanceScale?: number;
  /** Actual render viewport height in pixels; required for active screen fades. */
  viewportHeight?: number;
  /** Native per-view pixel-width policy; absent means explicitly disabled. */
  viewScreenFade?: readonly [number, number];
}
/** Fixed for one display's lifetime. Forced screen fades need private material
 * state; prepare it only when a positive level or viewer policy can enable them. */
export interface SourcePropPolicy { forcedScreenFade: boolean }
interface Placement {
  kind: 'static-prop' | 'entity-model'; flags: number; modelFlags: number;
  fadeMinDistance: number; fadeMaxDistance: number; forcedFadeScale: number;
  baselineVisible: boolean;
  render: { mode: number; amount: number; initiallyDisabled: boolean; receiveShadow: boolean };
  modelRenderBounds: [number[], number[]];
  modelBounds: [number[], number[]];
}
interface MaterialState { material: THREE.Material; transparent: boolean; depthWrite: boolean }
interface MeshState {
  mesh: THREE.Mesh; visible: boolean; castShadow: boolean; receiveShadow: boolean;
  original?: MaterialSet; replacement?: MaterialSet;
}
interface Entry {
  root: THREE.Object3D; placement: Placement;
  center: THREE.Vector3; radius: number; canFade: boolean; forced: boolean; alpha: { value: number };
  meshes: MeshState[]; materials: MaterialState[];
}
interface Group { root: THREE.Object3D; inverse: THREE.Matrix4; camera: THREE.Vector3; entries: Entry[] }

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function placement(value: unknown): Placement {
  const p = value as Placement;
  if (!p || (p.kind !== 'static-prop' && p.kind !== 'entity-model') || !Number.isSafeInteger(p.flags)
    || !Number.isSafeInteger(p.modelFlags) || !finite(p.fadeMinDistance) || !finite(p.fadeMaxDistance)
    || !finite(p.forcedFadeScale) || typeof p.baselineVisible !== 'boolean' || !p.render
    || !Number.isSafeInteger(p.render.mode) || !finite(p.render.amount) || typeof p.render.initiallyDisabled !== 'boolean'
    || typeof p.render.receiveShadow !== 'boolean' || !Array.isArray(p.modelBounds) || p.modelBounds.length !== 2
    || p.modelBounds.some(v => !Array.isArray(v) || v.length !== 3 || !v.every(finite))
    || p.modelBounds[0].some((v, i) => v > p.modelBounds[1][i])
    || !Array.isArray(p.modelRenderBounds) || p.modelRenderBounds.length !== 2
    || p.modelRenderBounds.some(v => !Array.isArray(v) || v.length !== 3 || !v.every(finite))
    || p.modelRenderBounds[0].some((v, i) => v > p.modelRenderBounds[1][i]))
    throw new TypeError('Invalid Source prop display metadata');
  return p;
}
function byte(value: number): number { return Math.max(0, Math.min(255, Math.trunc(value))); }

/** Quantized Source squared-distance alpha. Static lump minima are squared as
 * authored; only entities swap endpoints and expand a negative min by 400 units. */
function distanceAlpha(p: Placement, distanceSquared: number): number {
  let min = p.fadeMinDistance, max = p.fadeMaxDistance;
  if (p.kind === 'entity-model') {
    if (min <= 0 && max <= 0) return 255;
    if (min > max) { const swap = min; min = max; max = swap; }
    if (min < 0) min = Math.max(0, max - 400);
  } else if (!(p.flags & FADES) || p.flags & SCREEN_SPACE_FADE) return 255;
  min = Math.fround(min * min); max = Math.fround(max * max);
  if (p.kind === 'entity-model') {
    if (distanceSquared <= min) return 255;
    if (distanceSquared >= max) return 0;
  } else {
    if (distanceSquared >= max) return 0;
    if (distanceSquared <= min) return 255;
  }
  return byte(Math.fround(Math.fround(255 / (max - min)) * Math.fround(max - distanceSquared)));
}
function screenAlpha(width: number, min: number, max: number): number {
  if (width <= min) return 0;
  if (max < 0 || width >= max) return 255;
  return byte(Math.fround(Math.fround(255 / (max - min)) * Math.fround(width - min)));
}
function validateRange(range: readonly [number, number] | undefined): void {
  if (range && (range.length !== 2 || !range.every(finite))) throw new TypeError('Invalid Source screen fade policy');
}

/** Bind the owning glTF scenes BEFORE merging/reparenting or patching materials.
 * The owning scene is the metre/source-frame boundary, not a prop's scaled root.
 * Register generated Source materials with bindMaterial AFTER their shader setup;
 * no patched material is cloned. update is absolute/view-dependent, not dt-based.
 * Only placements that can actually fade get private material copies; static
 * placements keep the loader's shared materials and are skipped by update. */
export class SourceProps {
  private readonly groups: Group[] = [];
  private readonly owners = new Map<THREE.Mesh, Entry>();
  private readonly owned = new Set<THREE.Material>();
  private readonly bindings = new Map<THREE.Material, { entry: Entry; compile: THREE.Material['onBeforeCompile']; key: THREE.Material['customProgramCacheKey'] }>();
  private readonly camera = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly top = new THREE.Vector4();
  private readonly bottom = new THREE.Vector4();
  private readonly viewProjection = new THREE.Matrix4();

  constructor(roots: readonly THREE.Object3D[], policy: SourcePropPolicy) {
    if (typeof policy?.forcedScreenFade !== 'boolean') throw new TypeError('Invalid Source prop display policy');
    try {
      for (const root of roots) {
        const group: Group = { root, inverse: new THREE.Matrix4(), camera: new THREE.Vector3(), entries: [] };
        this.groups.push(group);
        root.traverse(object => {
          if (object.userData.sourcePlacement === undefined) return;
          const p = placement(object.userData.sourcePlacement);
          if (typeof object.userData.castShadow !== 'boolean' || typeof object.userData.receiveShadow !== 'boolean')
            throw new TypeError('Invalid Source prop shadow metadata');
          const min = p.modelBounds[0], max = p.modelBounds[1];
          const center = new THREE.Vector3((min[0] + max[0]) * METRES / 2,
            (min[1] + max[1]) * METRES / 2, (min[2] + max[2]) * METRES / 2);
          const renderMin = p.modelRenderBounds[0], renderMax = p.modelRenderBounds[1];
          const entry: Entry = { root: object, placement: p, center,
            radius: Math.hypot(renderMax[0] - renderMin[0], renderMax[1] - renderMin[1], renderMax[2] - renderMin[2]) * METRES / 2,
            alpha: { value: 1 }, canFade: false, forced: false, meshes: [], materials: [] };
          group.entries.push(entry);
          const variants = new Map<THREE.Material, THREE.Material>();
          const distance = p.kind === 'entity-model' ? p.fadeMinDistance > 0 || p.fadeMaxDistance > 0 : !!(p.flags & FADES);
          entry.forced = p.forcedFadeScale > 0 && (p.kind !== 'static-prop' || !(p.modelFlags & NO_FORCED_FADE));
          // forcedFadeScale defaults to 1, so a forced-only placement gets private
          // material state only when this display can enable a forced screen fade.
          // A permanently hidden placement never draws and needs none.
          const canFade = this.baseline(entry) && (distance || entry.forced && policy.forcedScreenFade);
          entry.canFade = canFade;
          object.traverse(child => {
            if (!(child instanceof THREE.Mesh)) return;
            if (this.owners.has(child)) throw new Error('Overlapping Source prop ownership');
            const state: MeshState = { mesh: child, visible: child.visible, castShadow: child.castShadow, receiveShadow: child.receiveShadow };
            entry.meshes.push(state); this.owners.set(child, entry);
            child.castShadow = object.userData.castShadow;
            child.receiveShadow = object.userData.receiveShadow;
            child.visible = state.visible && this.baseline(entry);
            if (canFade) {
              const clone = (material: THREE.Material) => {
                let copy = variants.get(material);
                if (!copy) { copy = material.clone(); variants.set(material, copy); this.owned.add(copy); }
                return copy;
              };
              state.original = child.material;
              state.replacement = Array.isArray(child.material) ? child.material.map(clone) : clone(child.material);
              child.material = state.replacement;
            }
          });
        });
        if (!group.entries.length) this.groups.pop();
      }
    } catch (error) { this.dispose(); throw error; }
  }

  owns(mesh: THREE.Mesh): boolean { return this.owners.has(mesh); }

  /** Register private fading PBR and Source variants. Ordinary shadow reception
   * stays on each mesh; it does not bypass projected flashlight depth. */
  bindMaterial(mesh: THREE.Mesh, material: THREE.Material): void {
    const entry = this.owners.get(mesh);
    if (!entry || !entry.canFade) return;
    const bound = this.bindings.get(material);
    if (bound) {
      if (bound.entry !== entry) throw new Error('Source prop material shared across placements');
      return;
    }
    const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
    const program = key.call(material);
    this.bindings.set(material, { entry, compile, key });
    entry.materials.push({ material, transparent: material.transparent, depthWrite: material.depthWrite });
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      shader.uniforms.sourcePropAlpha = entry.alpha;
      // Apply AFTER Three's OPAQUE alpha override. Never overwrite material/proxy
      // opacity or texture alpha, and never let another placement own this uniform.
      shader.fragmentShader = 'uniform float sourcePropAlpha;\n' + shader.fragmentShader.replace('#include <opaque_fragment>',
        '#include <opaque_fragment>\ngl_FragColor.a *= sourcePropAlpha;');
    };
    material.customProgramCacheKey = () => program + '-source-prop-display-v1';
    material.needsUpdate = true;
  }

  /** Sky copies intentionally share an instance's material. Register in the
   * SourceSky3D linkedMaterial callback; update with the actual sky camera before
   * its draw, and again with the main camera before the main draw. */
  linkClone(original: THREE.Mesh, clone: THREE.Mesh): void {
    const entry = this.owners.get(original);
    if (!entry) return;
    if (this.owners.has(clone)) throw new Error('Duplicate Source prop clone binding');
    const state = entry.meshes.find(value => value.mesh === original)!;
    entry.meshes.push({ mesh: clone, visible: state.visible, castShadow: clone.castShadow, receiveShadow: clone.receiveShadow });
    this.owners.set(clone, entry);
    clone.castShadow = original.castShadow; clone.receiveShadow = original.receiveShadow;
    clone.visible = state.visible && this.baseline(entry) && entry.alpha.value > 0;
  }

  private baseline(entry: Entry): boolean {
    const p = entry.placement, r = p.render;
    return p.baselineVisible && !r.initiallyDisabled && r.mode !== 6 && r.mode !== 10 && (r.mode === 0 || r.amount !== 0);
  }

  update(camera: THREE.Camera, view?: SourcePropView): void {
    if (!this.groups.length) return;
    const factor = view?.distanceScale ?? 1;
    if (!finite(factor) || factor < 0) throw new RangeError('Invalid Source prop FOV distance scale');
    validateRange(view?.levelScreenFade); validateRange(view?.viewScreenFade);
    const level = view?.levelScreenFade, perView = view?.viewScreenFade;
    const levelActive = !!level && level[0] > 0, viewActive = !!perView && perView[0] > 0;
    camera.updateWorldMatrix(true, false);
    this.camera.setFromMatrixPosition(camera.matrixWorld);
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (const group of this.groups) {
      group.root.updateWorldMatrix(true, false);
      group.inverse.copy(group.root.matrixWorld).invert();
      group.camera.copy(this.camera).applyMatrix4(group.inverse);
      const unit = METRES * Math.cbrt(Math.abs(group.root.matrixWorld.determinant()));
      for (const entry of group.entries) {
        // Entries without private state keep their constructed constant display.
        if (!entry.canFade) {
          if (entry.forced && (levelActive || viewActive) && this.baseline(entry))
            throw new RangeError('Source prop forced screen fade was not prepared for this display');
          continue;
        }
        const p = entry.placement;
        entry.root.updateWorldMatrix(true, false);
        this.origin.setFromMatrixPosition(entry.root.matrixWorld);
        this.center.copy(p.kind === 'entity-model' ? entry.center : this.origin);
        if (p.kind === 'entity-model') this.center.applyMatrix4(entry.root.matrixWorld);
        this.center.applyMatrix4(group.inverse);
        const d = Math.fround(this.center.distanceToSquared(group.camera) / (METRES * METRES) * factor * factor);
        let alpha = distanceAlpha(p, d);
        const screenAuthored = p.kind === 'static-prop' && !!(p.flags & FADES) && !!(p.flags & SCREEN_SPACE_FADE);
        const forced = entry.forced;
        if (screenAuthored || forced && (levelActive || viewActive)) {
          const height = view?.viewportHeight;
          // A zero-pixel draw has zero projected width; only absent/invalid height is refused.
          if (!finite(height) || height < 0) throw new RangeError('Source prop screen fade requires actual viewport height');
          this.scale.setFromMatrixScale(entry.root.matrixWorld);
          const radius = entry.radius * Math.max(Math.abs(this.scale.x), Math.abs(this.scale.y), Math.abs(this.scale.z));
          this.top.set(this.origin.x + this.up.x * radius, this.origin.y + this.up.y * radius, this.origin.z + this.up.z * radius, 1).applyMatrix4(this.viewProjection);
          this.bottom.set(this.origin.x - this.up.x * radius, this.origin.y - this.up.y * radius, this.origin.z - this.up.z * radius, 1).applyMatrix4(this.viewProjection);
          const y1 = this.top.y * (this.top.w >= .001 * unit ? 1 / this.top.w : 1000 / unit);
          const y2 = this.bottom.y * (this.bottom.w >= .001 * unit ? 1 / this.bottom.w : 1000 / unit);
          // Source's legacy ComputePixelWidthOfSphere is TWICE pixel diameter.
          const width = Math.fround(height * Math.abs(y2 - y1));
          if (screenAuthored) alpha = Math.min(alpha, screenAlpha(width, p.fadeMinDistance, p.fadeMaxDistance));
          if (forced) {
            const scaled = Math.fround(width / p.forcedFadeScale);
            if (levelActive) alpha = Math.min(alpha, screenAlpha(scaled, level![0], Math.max(level![0], level![1])));
            if (viewActive) alpha = Math.min(alpha, screenAlpha(scaled, perView![0], Math.max(perView![0], perView![1])));
          }
        }
        entry.alpha.value = alpha / 255;
        const visible = this.baseline(entry) && alpha > 0;
        for (const state of entry.meshes) state.mesh.visible = state.visible && visible;
        for (const state of entry.materials) {
          const transparent = alpha < 255 || state.transparent;
          if (state.material.transparent !== transparent) { state.material.transparent = transparent; state.material.needsUpdate = true; }
          state.material.depthWrite = alpha < 255 ? false : state.depthWrite;
        }
      }
    }
  }

  dispose(): void {
    for (const group of this.groups) for (const entry of group.entries) {
      for (const state of entry.meshes) {
        state.mesh.visible = state.visible; state.mesh.castShadow = state.castShadow; state.mesh.receiveShadow = state.receiveShadow;
        if (state.original) {
          const active = state.mesh.material;
          const registered = Array.isArray(active) ? active.every(material => this.bindings.get(material)?.entry === entry)
            : this.bindings.get(active)?.entry === entry;
          if (active === state.replacement || registered) state.mesh.material = state.original;
        }
      }
      for (const state of entry.materials) { state.material.transparent = state.transparent; state.material.depthWrite = state.depthWrite; }
    }
    for (const [material, binding] of this.bindings) {
      material.onBeforeCompile = binding.compile; material.customProgramCacheKey = binding.key;
      material.needsUpdate = true;
    }
    this.bindings.clear(); this.owners.clear(); this.groups.length = 0;
    for (const material of this.owned) material.dispose();
    this.owned.clear();
  }
}
