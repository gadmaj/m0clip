/** Bundled first-person view models for the physics gun and the spawn tool: original m0clip
 * designs built here from procedural geometry, so Player mode has gloved hands and a tool without
 * any game installation or download. They are not copies of any game's models.
 *
 * Space is the Source eye frame in inches (X forward, Y left, Z up), the frame PlayerView gives
 * every view model. Static parts are merged per material: the tool and both hands move together
 * under one `kick` node, and only the physics gun's claw and the spawn tool's emitter ring and
 * screen move on their own, so a model draws in five or six calls. Materials and the screen
 * texture belong to a DefaultViewModelKit made once per PlayerView and lit through the host's
 * MaterialLighter like Studio models; each rig owns only its merged geometry.
 *
 * Animation is a pure function of the presentation pose (sequence, cycle) and the scene clock, so
 * review and export replay what was recorded. DEFAULT_VIEWMODEL_SEQUENCES is the recorded
 * contract for the bundled ids: changing a sequence's meaning breaks recorded takes. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlayerAnimationLayer, PlayerAnimationPose, PlayerTool } from '../../player/types';
import type { MaterialLighter } from './studio-object';
import { PLAYER_VIEWMODEL_LAYER, type PlayerViewModelRig, type ViewModelAction } from './viewmodel';

export type DefaultViewModelTool = 'physgun' | 'spawn';

/** Stable take identities of the bundled models; never game-file paths. */
export const DEFAULT_VIEWMODEL_PATHS: Readonly<Record<DefaultViewModelTool, string>> = Object.freeze({
  physgun: 'builtin:m0clip/physgun', spawn: 'builtin:m0clip/toolgun',
});

/** Recorded sequence numbers of the bundled models, by index. */
export const DEFAULT_VIEWMODEL_SEQUENCES = Object.freeze(['draw', 'idle', 'attack', 'attack2', 'inspect'] as const);

/** The bundled model id for `tool`, or null when it has none. */
export function defaultViewModelPath(tool: PlayerTool): string | null {
  return tool === 'physgun' || tool === 'spawn' ? DEFAULT_VIEWMODEL_PATHS[tool] : null;
}

/** True for a bundled model id: it must never be read from game files. */
export function isDefaultViewModelPath(path: string): boolean {
  return path === DEFAULT_VIEWMODEL_PATHS.physgun || path === DEFAULT_VIEWMODEL_PATHS.spawn;
}

const SEQUENCE_OF: Readonly<Record<ViewModelAction | 'idle', number>> = { draw: 0, idle: 1, attack: 2, attackHit: 2, attack2: 3, inspect: 4 };
const IDLE = 1;
/** Seconds per sequence, indexed like DEFAULT_VIEWMODEL_SEQUENCES; only idle loops. */
const DURATION: Readonly<Record<DefaultViewModelTool, readonly number[]>> = {
  physgun: [0.7, 4, 0.34, 0.55, 2.6],
  spawn: [0.55, 3.2, 0.28, 0.45, 2.4],
};
/** Rest placement of the grip-top origin in the eye frame (inches) and its yaw/roll (degrees). */
const REST: Readonly<Record<DefaultViewModelTool, { x: number; y: number; z: number; yaw: number; roll: number }>> = {
  physgun: { x: 12.6, y: -6.0, z: -2.9, yaw: 1, roll: -2 },
  spawn: { x: 10.6, y: -4.8, z: -2.2, yaw: 4, roll: -3 },
};

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const EMPTY_PARAMETERS = new Float32Array(0);

// ---- palette (sRGB) ----------------------------------------------------------------------
const GUNMETAL = 0x4a5057, STEEL = 0x9aa1a8, DARK_STEEL = 0x272a2e, COPPER = 0xb4703a, BRASS = 0xa5823f;
const PHYS_SHELL = 0xc7c3b6, PHYS_STRIPE = 0x30343a, POLYMER = 0x1f2022, RUBBER = 0x151515;
const TOOL_SHELL = 0x474a3f, TOOL_PANEL = 0x2c2e28, HAZARD = 0xb8862b;
const GLOVE = 0x2e2924, GLOVE_PAD = 0x171615, GLOVE_STRAP = 0x0f0f0f, SLEEVE = 0x4b4f3b, SLEEVE_BAND = 0x383b2c;

type MaterialKey = 'metal' | 'paint' | 'hands' | 'cyan' | 'amber' | 'screen';

/** Shared materials and the spawn tool's screen texture, created once and lit by the host. */
export class DefaultViewModelKit {
  readonly materials: Readonly<Record<MaterialKey, THREE.MeshStandardMaterial>>;
  readonly screen: THREE.DataTexture;
  private disposedKit = false;

  constructor(light?: MaterialLighter) {
    this.screen = screenTexture();
    // A faint emissive floor keeps silhouettes readable on dark Source maps without flattening the
    // lit shading; vertex colours carry the palette so each material is one draw call per model.
    const floor = new THREE.Color(0x101010);
    this.materials = {
      metal: new THREE.MeshStandardMaterial({ name: 'm0clip_vm_metal', vertexColors: true, metalness: 0.8, roughness: 0.38,
        emissive: floor, emissiveIntensity: 0.5 }),
      paint: new THREE.MeshStandardMaterial({ name: 'm0clip_vm_paint', vertexColors: true, metalness: 0.12, roughness: 0.6,
        emissive: floor, emissiveIntensity: 0.6 }),
      hands: new THREE.MeshStandardMaterial({ name: 'm0clip_vm_hands', vertexColors: true, metalness: 0, roughness: 0.84,
        emissive: floor, emissiveIntensity: 0.5 }),
      cyan: new THREE.MeshStandardMaterial({ name: 'm0clip_vm_core', color: 0x0d3940, emissive: 0x3ce6ff, emissiveIntensity: 1.6,
        metalness: 0, roughness: 0.25 }),
      amber: new THREE.MeshStandardMaterial({ name: 'm0clip_vm_lamp', color: 0x3a2306, emissive: 0xffa526, emissiveIntensity: 1.3,
        metalness: 0, roughness: 0.25 }),
      screen: new THREE.MeshStandardMaterial({ name: 'm0clip_vm_screen', color: 0x050505, emissive: 0xffffff, emissiveMap: this.screen,
        emissiveIntensity: 1.1, metalness: 0, roughness: 0.2 }),
    };
    if (light) for (const material of Object.values(this.materials)) light(material);
  }

  get disposed(): boolean { return this.disposedKit; }

  dispose(): void {
    if (this.disposedKit) return;
    this.disposedKit = true;
    for (const material of Object.values(this.materials)) material.dispose();
    this.screen.dispose();
  }
}

/** Two 64×32 amber pages side by side: the idle readout and the secondary-action page. */
function screenTexture(): THREE.DataTexture {
  const W = 128, H = 32, data = new Uint8Array(W * H * 4);
  const BG = [26, 12, 2], DIM = [120, 64, 10], LIT = [255, 176, 56];
  const put = (x: number, y: number, c: readonly number[]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = ((H - 1 - y) * W + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  };
  const rect = (x0: number, y0: number, w: number, h: number, c: readonly number[]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, c);
  };
  rect(0, 0, W, H, BG);
  for (const page of [0, 64]) {
    const border = page ? LIT : DIM;
    rect(page, 0, 64, 1, border); rect(page, 31, 64, 1, border); rect(page, 0, 1, 32, border); rect(page + 63, 0, 1, 32, border);
  }
  // Page 0: header blocks, a reticle, three readout lines and a level meter.
  let x = 3;
  for (const w of [6, 4, 7, 3, 5, 8]) { rect(x, 3, w, 4, LIT); x += w + 2; }
  for (let a = 0; a < 48; a++) put(Math.round(14 + 6.5 * Math.cos(a / 48 * TAU)), Math.round(20 + 6.5 * Math.sin(a / 48 * TAU)), LIT);
  rect(14, 11, 1, 19, LIT); rect(5, 20, 19, 1, LIT); rect(13, 19, 3, 3, BG); put(14, 20, LIT);
  for (const [row, len, c] of [[11, 26, LIT], [15, 18, DIM], [19, 22, DIM]] as const) rect(29, row, len, 2, c);
  for (let i = 0; i < 8; i++) { const h = [3, 5, 4, 6, 2, 5, 7, 4][i]; rect(29 + i * 4, 29 - h, 3, h, i < 5 ? LIT : DIM); }
  // Page 1: inverted header and two chevrons.
  rect(66, 3, 60, 5, LIT);
  x = 69;
  for (const w of [5, 3, 6, 4]) { rect(x, 4, w, 3, BG); x += w + 3; }
  for (const cx of [80, 96]) for (let i = 0; i < 9; i++) { rect(cx + i, 12 + i, 4, 1, LIT); rect(cx + i, 28 - i, 4, 1, LIT); }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.repeat.set(0.5, 1);
  texture.needsUpdate = true;
  return texture;
}

// ---- construction helpers (build time only) ----------------------------------------------

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Matrix placing a primitive's +Y axis from `a` to `b` (centred between them) with its +X axis
 * toward `side` where possible. */
function along(a: THREE.Vector3, b: THREE.Vector3, side?: THREE.Vector3): THREE.Matrix4 {
  const y = b.clone().sub(a).normalize();
  let x = side ? side.clone().addScaledVector(y, -side.dot(y)) : new THREE.Vector3();
  if (x.lengthSq() < 1e-8) { x = Math.abs(y.x) < 0.9 ? v(1, 0, 0) : v(0, 1, 0); x.addScaledVector(y, -x.dot(y)); }
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(a.clone().add(b).multiplyScalar(0.5));
}

function place(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx * DEG, ry * DEG, rz * DEG, 'ZYX')).setPosition(x, y, z);
}

const scaled = (m: THREE.Matrix4, x: number, y: number, z: number) => m.multiply(new THREE.Matrix4().makeScale(x, y, z));

/** Primitives merged into one geometry with a per-vertex palette colour. */
class Parts {
  private readonly pieces: THREE.BufferGeometry[] = [];

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.clearGroups();
    g.applyMatrix4(matrix);
    const c = new THREE.Color(color), n = g.getAttribute('position').count, rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { rgb[i * 3] = c.r; rgb[i * 3 + 1] = c.g; rgb[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    this.pieces.push(g);
  }

  box(m: THREE.Matrix4, sx: number, sy: number, sz: number, color: number): void { this.add(new THREE.BoxGeometry(sx, sy, sz), m, color); }

  /** Box spanning a→b along its length, cross-section w (toward `side`) × h. */
  beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, side: THREE.Vector3, color: number): void {
    this.add(new THREE.BoxGeometry(w, a.distanceTo(b), h), along(a, b, side), color);
  }

  cylinder(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, color: number, segments = 14, side?: THREE.Vector3, flatten = 1): void {
    this.add(new THREE.CylinderGeometry(rb, ra, a.distanceTo(b), segments, 1), scaled(along(a, b, side), 1, 1, flatten), color);
  }

  capsule(a: THREE.Vector3, b: THREE.Vector3, r: number, color: number, radial = 10): void {
    this.add(new THREE.CapsuleGeometry(r, Math.max(1e-3, a.distanceTo(b)), 3, radial), along(a, b), color);
  }

  ring(center: THREE.Vector3, axis: THREE.Vector3, radius: number, tube: number, color: number, tubular = 18): void {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(v(0, 0, 1), axis.clone().normalize()));
    this.add(new THREE.TorusGeometry(radius, tube, 6, tubular), m.setPosition(center), color);
  }

  /** Chamfered prism along X from x0 to x1: |y| ≤ halfWidth, z0 ≤ z ≤ z1, edges cut by `chamfer`. */
  prism(x0: number, x1: number, halfWidth: number, z0: number, z1: number, chamfer: number, color: number): void {
    const s = new THREE.Shape(), c = chamfer;
    s.moveTo(-halfWidth + c, z0); s.lineTo(halfWidth - c, z0); s.lineTo(halfWidth, z0 + c); s.lineTo(halfWidth, z1 - c);
    s.lineTo(halfWidth - c, z1); s.lineTo(-halfWidth + c, z1); s.lineTo(-halfWidth, z1 - c); s.lineTo(-halfWidth, z0 + c); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: x1 - x0, bevelEnabled: false, steps: 1 });
    // Shape x → +Y (left), shape y → +Z (up), extrusion → +X (forward).
    this.add(g, new THREE.Matrix4().makeBasis(v(0, 1, 0), v(0, 0, 1), v(1, 0, 0)).setPosition(x0, 0, 0), color);
  }

  sphere(center: THREE.Vector3, r: number, color: number, sx = 1, sy = 1, sz = 1): void {
    this.add(new THREE.SphereGeometry(r, 12, 8), scaled(new THREE.Matrix4().setPosition(center), sx, sy, sz), color);
  }

  merge(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.pieces, false);
    for (const piece of this.pieces) piece.dispose();
    this.pieces.length = 0;
    if (!merged) throw new Error('The bundled view model geometry could not be merged.');
    merged.computeBoundingSphere();
    return merged;
  }
}

// ---- gloved hands ------------------------------------------------------------------------

/** Right-hand layout (inches): wrist at the origin, knuckles along +X, palm facing +Z, thumb
 * toward −Y. Left hands mirror Y. */
const PALM_HALF = 0.55;
const FINGERS = [
  { y: -1.08, x: 3.3, r: 0.4, len: [1.55, 0.98, 0.78] },
  { y: -0.36, x: 3.42, r: 0.42, len: [1.7, 1.08, 0.84] },
  { y: 0.36, x: 3.32, r: 0.4, len: [1.58, 1.02, 0.8] },
  { y: 1.04, x: 3.08, r: 0.35, len: [1.28, 0.82, 0.7] },
] as const;
const THUMB_Y = -1.15, THUMB_R = 0.46;
/** Trigger-finger joint angles from +X toward the palm (degrees, cumulative). */
const TRIGGER_CURL = [12, 70, 112] as const;

type P2 = readonly [number, number];

/** Joint centres (x, z) of a finger wrapped around a grip circle in the finger's plane: from
 * `start`, each phalanx ends on the circle, advancing counter-clockwise (direction 1, curling
 * toward +Z) or clockwise. */
function wrapChain(start: P2, center: P2, radius: number, lengths: readonly number[], direction: 1 | -1): P2[] {
  const angle = (p: P2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const onCircle = (a: number): P2 => [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)];
  const points: P2[] = [start];
  let p = start;
  for (const length of lengths) {
    const dx = center[0] - p[0], dz = center[1] - p[1], d = Math.hypot(dx, dz);
    let next: P2;
    if (Math.abs(d - radius) < 1e-6) next = onCircle(angle(p) + direction * 2 * Math.asin(Math.min(1, length / (2 * radius))));
    else {
      const a = (length * length - radius * radius + d * d) / (2 * d), h = Math.sqrt(Math.max(0, length * length - a * a));
      const mx = p[0] + a * dx / d, mz = p[1] + a * dz / d;
      const c1: P2 = [mx - h * dz / d, mz + h * dx / d], c2: P2 = [mx + h * dz / d, mz - h * dx / d], from = angle(p);
      const ahead = (q: P2) => { const s = (angle(q) - from) * direction; return ((s % TAU) + 3 * Math.PI) % TAU - Math.PI; };
      next = onCircle(angle(ahead(c1) >= ahead(c2) ? c1 : c2));
    }
    points.push(next);
    p = next;
  }
  return points;
}

interface HandPlacement {
  /** Grip centre in the tool frame. */
  center: THREE.Vector3;
  /** Tool-frame direction of the hand's +Y (index → little finger side for the right hand). */
  axis: THREE.Vector3;
  /** Tool-frame direction from the grip centre toward the palm. */
  palm: THREE.Vector3;
  gripRadius: number;
  left: boolean;
  trigger: boolean;
  /** Tool-frame direction of the forearm from the wrist toward the elbow. */
  forearm: THREE.Vector3;
}

/** A gloved hand and sleeved forearm gripping a cylinder; returns the trigger contact point (tool
 * frame) when the index finger rests on a trigger. */
function gloveHand(parts: Parts, h: HandPlacement): THREE.Vector3 | null {
  const cx = 3.0, cz = PALM_HALF + h.gripRadius;
  const y = h.axis.clone().normalize(), z = h.palm.clone().normalize().negate();
  const x = new THREE.Vector3().crossVectors(y, z);
  const mirror = new THREE.Matrix4().makeScale(1, h.left ? -1 : 1, 1);
  const world = new THREE.Matrix4().makeBasis(x, y, z).setPosition(h.center).multiply(new THREE.Matrix4().makeTranslation(-cx, 0, -cz));
  const toTool = world.clone().multiply(mirror);
  /** Right-hand local matrix → tool frame; mirror·M·mirror keeps winding and normals for the left hand. */
  const local = (m: THREE.Matrix4) => toTool.clone().multiply(m).multiply(mirror);
  const point = (px: number, py: number, pz: number) => v(px, py, pz).applyMatrix4(toTool);
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, color: number) => parts.add(g, local(m), color);
  const capsule = (a: THREE.Vector3, b: THREE.Vector3, r: number, color: number) =>
    add(new THREE.CapsuleGeometry(r, Math.max(1e-3, a.distanceTo(b)), 3, 9), along(a, b), color);
  const ellipsoid = (px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: number) =>
    add(new THREE.SphereGeometry(1, 14, 10), scaled(new THREE.Matrix4().setPosition(px, py, pz), sx, sy, sz), color);

  // Palm, heel and knuckle ridge.
  ellipsoid(1.8, 0, 0, 1.75, 1.5, 0.62, GLOVE);
  ellipsoid(0.75, 0.25, 0.1, 0.95, 1.2, 0.6, GLOVE);
  capsule(v(3.15, -1.15, -0.05), v(3.0, 1.05, -0.05), 0.5, GLOVE);
  // Back-of-hand padding: knuckle guard and a plate, slightly proud of the leather.
  add(new THREE.BoxGeometry(0.85, 2.55, 0.3), place(3.0, -0.05, -0.5, 0, 6, 0), GLOVE_PAD);
  add(new THREE.BoxGeometry(1.5, 2.1, 0.22), place(1.7, 0.05, -0.6, 0, -4, 0), GLOVE_PAD);

  let trigger: THREE.Vector3 | null = null;
  const center: P2 = [cx, cz], wrap = h.gripRadius;
  for (let f = 0; f < FINGERS.length; f++) {
    const finger = FINGERS[f], fy = finger.y;
    let joints: P2[];
    if (f === 0 && h.trigger) {
      joints = [[finger.x, 0]];
      for (let k = 0; k < 3; k++) {
        const [px, pz] = joints[k], a = TRIGGER_CURL[k] * DEG;
        joints.push([px + finger.len[k] * Math.cos(a), pz + finger.len[k] * Math.sin(a)]);
      }
    } else joints = wrapChain([finger.x, 0], center, wrap + finger.r, finger.len, 1);
    for (let k = 0; k < 3; k++) {
      const r = finger.r * (1 - 0.06 * k);
      capsule(v(joints[k][0], fy, joints[k][1]), v(joints[k + 1][0], fy, joints[k + 1][1]), r, GLOVE);
    }
    if (f === 0 && h.trigger) {
      // Contact where the distal pad crosses the grip's centre plane; the trigger sits just behind it.
      const [ax, az] = joints[2], [bx, bz] = joints[3];
      const t = Math.min(1, Math.max(0, (cz - az) / (bz - az || 1e-6)));
      const qx = ax + (bx - ax) * t, dx = bx - ax, dz = bz - az, n = Math.hypot(dx, dz) || 1;
      const inner = finger.r * 0.88 + 0.14;
      trigger = point(qx - dz / n * inner, fy, cz);
    }
  }
  // Thumb: thenar base, then two phalanges wrapping the far side of the grip the other way.
  const thumbRadius = wrap + THUMB_R;
  const t1: P2 = [cx + thumbRadius * Math.cos(-150 * DEG), cz + thumbRadius * Math.sin(-150 * DEG)];
  const thumb = wrapChain(t1, center, thumbRadius, [1.2, 0.95], -1);
  capsule(v(0.75, -0.95, 0.22), v(t1[0], THUMB_Y, t1[1]), 0.5, GLOVE);
  for (let k = 0; k < 2; k++)
    capsule(v(thumb[k][0], THUMB_Y, thumb[k][1]), v(thumb[k + 1][0], THUMB_Y, thumb[k + 1][1]), THUMB_R * (1 - 0.08 * k), GLOVE);
  // Gauntlet cuff and wrist strap.
  add(new THREE.CylinderGeometry(1.24, 1.08, 2.0, 14, 1), scaled(along(v(0.45, 0, 0), v(-1.55, 0, 0.04), v(0, 1, 0)), 1, 1, 0.8), GLOVE);
  add(new THREE.CylinderGeometry(1.14, 1.14, 0.32, 14, 1), scaled(along(v(0.12, 0, 0), v(-0.2, 0, 0.01), v(0, 1, 0)), 1, 1, 0.84), GLOVE_STRAP);
  // Sleeve along the forearm direction, with a cuff band over the gauntlet.
  const wrist = point(-1.2, 0, 0.03), dir = h.forearm.clone().normalize(), across = y.clone();
  const elbow = wrist.clone().addScaledVector(dir, 15);
  parts.cylinder(wrist, elbow, 1.36, 1.8, SLEEVE, 14, across, 0.86);
  parts.cylinder(wrist.clone().addScaledVector(dir, -0.15), wrist.clone().addScaledVector(dir, 0.55), 1.46, 1.48, SLEEVE_BAND, 14, across, 0.86);
  return trigger;
}

/** The trigger frame under the housing, the trigger blade and a guard in front of it, all in the
 * tool's centre plane (`at` is the trigger contact, `grip` the grip axis). */
function triggerGroup(parts: Parts, at: THREE.Vector3, grip: THREE.Vector3): void {
  const down = grip.clone().negate(), front = at.x + 1.4, low = at.z - 0.95;
  parts.box(place((at.x - 0.6 + front + 0.15) / 2, 0, (at.z + 0.35 + 0.05) / 2), front + 0.75 - at.x, 0.64, 0.05 - at.z - 0.35, POLYMER);
  parts.beam(at.clone().addScaledVector(down, -0.45), at.clone().addScaledVector(down, 0.35), 0.24, 0.3, v(0, 1, 0), DARK_STEEL);
  parts.beam(at.clone().addScaledVector(down, 0.3), at.clone().addScaledVector(down, 0.62).add(v(0.22, 0, 0)), 0.22, 0.26, v(0, 1, 0), DARK_STEEL);
  parts.capsule(v(front, 0, 0.05), v(front, 0, low), 0.13, DARK_STEEL, 8);
  parts.capsule(v(front, 0, low), v(at.x + 0.15, 0, low - 0.12), 0.13, DARK_STEEL, 8);
}

/** Grip axis (up the grip) for a grip raked back by `rake` degrees. */
const gripAxis = (rake: number) => v(Math.sin(rake * DEG), 0, Math.cos(rake * DEG));

// ---- the two tools -----------------------------------------------------------------------

interface Built {
  meshes: [THREE.BufferGeometry, MaterialKey][];
  claw?: { geometry: THREE.BufferGeometry; pivot: THREE.Vector3 };
  ring?: { geometry: THREE.BufferGeometry; pivot: THREE.Vector3 };
  screen?: { geometry: THREE.BufferGeometry };
}

const PHYS_AXIS_Z = 1.45;

function buildPhysgun(): Built {
  const metal = new Parts(), paint = new Parts(), hands = new Parts(), glow = new Parts(), claw = new Parts();
  const X = v(1, 0, 0), Y = v(0, 1, 0), axis = (x: number) => v(x, 0, PHYS_AXIS_Z);
  // Housing: off-white shell, gunmetal spine and dark side armour with core light strips.
  paint.prism(-1.2, 9.0, 1.3, 0, 2.8, 0.45, PHYS_SHELL);
  metal.prism(-0.4, 7.2, 0.72, 2.75, 3.4, 0.22, GUNMETAL);
  for (const s of [-1, 1]) {
    paint.box(place(2.6, s * 1.31, 1.55), 4.4, 0.1, 1.45, PHYS_STRIPE);
    glow.box(place(2.6, s * 1.37, 1.55), 3.4, 0.06, 0.18, 0);
    for (const bx of [0.7, 4.5]) metal.cylinder(v(bx, s * 1.3, 2.05), v(bx, s * 1.42, 2.05), 0.14, 0.14, STEEL, 8);
    for (let k = 0; k < 4; k++) paint.box(place(4.9 + k * 0.5, s * 0.98, 2.84), 0.22, 0.42, 0.1, POLYMER);
  }
  // Rear energy cell over the wrist line, banded in copper with a core window.
  metal.cylinder(v(-4.6, 0, 2.15), v(-1.0, 0, 2.15), 1.05, 1.05, GUNMETAL, 16);
  metal.cylinder(v(-4.95, 0, 2.15), v(-4.6, 0, 2.15), 0.82, 0.95, DARK_STEEL, 16);
  for (const bx of [-4.2, -1.5]) metal.ring(v(bx, 0, 2.15), X, 1.06, 0.12, COPPER);
  glow.ring(v(-2.85, 0, 2.15), X, 1.06, 0.09, 0);
  paint.box(place(-1.1, 0, 1.4), 0.6, 1.6, 1.4, PHYS_STRIPE);
  // Barrel: glowing core in an open cage of rails and copper coils.
  glow.cylinder(axis(8.8), axis(14.5), 0.6, 0.6, 0, 12, Y);
  for (let k = 0; k < 4; k++) {
    const a = (45 + 90 * k) * DEG, off = v(0, Math.cos(a) * 1.18, Math.sin(a) * 1.18);
    metal.beam(axis(8.7).add(off), axis(14.6).add(off), 0.3, 0.3, v(0, -Math.sin(a), Math.cos(a)), STEEL);
  }
  for (let k = 0; k < 5; k++) metal.ring(axis(9.6 + k), X, 1.0, 0.2, COPPER, 16);
  metal.cylinder(axis(8.5), axis(9.1), 1.42, 1.42, DARK_STEEL, 16);
  metal.cylinder(axis(14.2), axis(14.85), 1.42, 1.3, DARK_STEEL, 16);
  metal.ring(axis(14.85), X, 1.32, 0.16, GUNMETAL);
  glow.sphere(axis(15.0), 0.48, 0);
  // Foregrip on two mounts for the support hand.
  for (const [x0, x1] of [[3.2, 3.8], [7.7, 8.3]]) paint.box(place((x0 + x1) / 2, 0, -0.75), x1 - x0, 0.9, 1.5, POLYMER);
  paint.cylinder(v(3.0, 0, -2.0), v(8.5, 0, -2.0), 0.78, 0.78, RUBBER, 14, Y);
  for (const x of [3.0, 8.5]) metal.cylinder(v(x - 0.12, 0, -2.0), v(x + 0.12, 0, -2.0), 0.84, 0.84, DARK_STEEL, 14, Y);
  // Pistol grip.
  const up = gripAxis(14), gripCenter = up.clone().multiplyScalar(-2.35);
  paint.add(new THREE.CapsuleGeometry(0.9, 3.55, 3, 12), scaled(along(up.clone().multiplyScalar(-3.85), up.clone().multiplyScalar(-0.3), Y), 0.82, 1, 1), POLYMER);
  metal.cylinder(up.clone().multiplyScalar(-4.75), up.clone().multiplyScalar(-4.45), 0.95, 0.95, DARK_STEEL, 14, Y, 0.85);
  // Hands.
  const triggerAt = gloveHand(hands, { center: gripCenter, axis: up.clone().negate(), palm: v(0, -1, 0), gripRadius: 0.9, left: false,
    trigger: true, forearm: v(-0.95, -0.17, -0.26) });
  gloveHand(hands, { center: v(5.8, 0, -2.0), axis: X.clone(), palm: v(0, -0.4, -0.92), gripRadius: 0.78, left: true,
    trigger: false, forearm: v(-0.43, 0.7, -0.57) });
  if (triggerAt) triggerGroup(paint, triggerAt, up);
  // Claw: three prongs around the muzzle, built about its own pivot so it can flare open.
  for (let k = 0; k < 3; k++) {
    const a = (90 + 120 * k) * DEG, r = v(0, Math.cos(a), Math.sin(a)), t = v(0, -Math.sin(a), Math.cos(a));
    const at = (x: number, radius: number) => v(x, 0, 0).addScaledVector(r, radius);
    claw.beam(at(-0.2, 1.05), at(0.9, 1.05), 0.55, 0.5, t, DARK_STEEL);
    claw.beam(at(0.6, 1.35), at(2.8, 2.0), 0.42, 0.34, t, GUNMETAL);
    claw.beam(at(2.75, 2.0), at(3.9, 1.25), 0.34, 0.3, t, STEEL);
    claw.beam(at(3.8, 1.3), at(4.15, 0.95), 0.28, 0.26, t, STEEL);
  }
  claw.ring(v(0.05, 0, 0), X, 1.3, 0.18, DARK_STEEL);
  return {
    meshes: [[metal.merge(), 'metal'], [paint.merge(), 'paint'], [hands.merge(), 'hands'], [glow.merge(), 'cyan']],
    claw: { geometry: claw.merge(), pivot: axis(14.85) },
  };
}

const TOOL_AXIS_Z = 1.1;

function buildToolgun(): Built {
  const metal = new Parts(), paint = new Parts(), hands = new Parts(), glow = new Parts(), ring = new Parts();
  const X = v(1, 0, 0), Y = v(0, 1, 0), axis = (x: number) => v(x, 0, TOOL_AXIS_Z);
  // Receiver with a top rail, hazard band, side lamps and vents.
  paint.prism(-2.4, 5.6, 0.82, 0, 2.0, 0.3, TOOL_SHELL);
  metal.prism(-1.6, 5.2, 0.42, 1.95, 2.3, 0.1, GUNMETAL);
  for (let k = 0; k < 6; k++) metal.box(place(-0.9 + k * 1.0, 0, 2.36), 0.42, 0.88, 0.14, DARK_STEEL);
  paint.box(place(4.75, 0, 1.0), 0.32, 1.7, 2.04, HAZARD);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) glow.box(place(0.9 + k * 0.62, s * 0.84, 1.45), 0.36, 0.05, 0.2, 0);
    for (let k = 0; k < 4; k++) paint.box(place(2.8 + k * 0.42, s * 0.83, 0.8), 0.18, 0.06, 0.9, TOOL_PANEL);
    metal.cylinder(v(3.9, s * 0.8, 1.55), v(3.9, s * 0.9, 1.55), 0.12, 0.12, STEEL, 8);
  }
  metal.box(place(-2.65, 0, 1.25, 0, -12, 0), 0.5, 0.7, 0.9, DARK_STEEL);
  // Screen pod on the rear, tilted back toward the eye.
  const pod = place(-1.75, 0, 2.95, 0, 32, 0);
  metal.box(pod.clone(), 1.0, 2.0, 1.45, DARK_STEEL);
  metal.box(pod.clone().multiply(place(0.25, 0, -0.85)), 0.5, 0.8, 0.5, GUNMETAL);
  // Emitter barrel, shroud and amber lens over an under-barrel coil block.
  metal.cylinder(axis(5.5), axis(8.6), 0.42, 0.42, STEEL, 14, Y);
  metal.cylinder(axis(8.0), axis(8.9), 0.58, 0.52, DARK_STEEL, 14, Y);
  glow.cylinder(axis(8.88), axis(8.98), 0.44, 0.44, 0, 14, Y);
  glow.sphere(axis(9.05), 0.3, 0);
  paint.prism(5.2, 7.9, 0.55, 0.12, 0.72, 0.15, TOOL_PANEL);
  for (let k = 0; k < 3; k++) metal.ring(v(5.8 + k * 0.6, 0, 0.42), X, 0.36, 0.09, COPPER, 12);
  // Pistol grip with a base plate and back-strap ribs.
  const up = gripAxis(17), gripCenter = up.clone().multiplyScalar(-2.3);
  paint.add(new THREE.CapsuleGeometry(0.88, 3.45, 3, 12), scaled(along(up.clone().multiplyScalar(-3.6), up.clone().multiplyScalar(-0.15), Y), 0.82, 1, 1), POLYMER);
  metal.cylinder(up.clone().multiplyScalar(-4.5), up.clone().multiplyScalar(-4.2), 0.95, 0.95, DARK_STEEL, 14, Y, 0.85);
  const back = v(-Math.cos(17 * DEG), 0, Math.sin(17 * DEG));
  for (let k = 0; k < 4; k++) {
    const c = up.clone().multiplyScalar(-1.2 - k * 0.7).addScaledVector(back, 0.82);
    paint.box(new THREE.Matrix4().makeBasis(back, Y, up).setPosition(c), 0.12, 1.0, 0.3, RUBBER);
  }
  const triggerAt = gloveHand(hands, { center: gripCenter, axis: up.clone().negate(), palm: v(0, -1, 0), gripRadius: 0.88, left: false,
    trigger: true, forearm: v(-0.94, -0.2, -0.28) });
  if (triggerAt) triggerGroup(paint, triggerAt, up);
  // Spinning emitter ring with three fins.
  ring.ring(v(0, 0, 0), X, 0.72, 0.11, BRASS, 16);
  for (let k = 0; k < 3; k++) {
    const a = (90 + 120 * k) * DEG, r = v(0, Math.cos(a), Math.sin(a));
    ring.beam(v(0, 0, 0).addScaledVector(r, 0.45), v(0, 0, 0).addScaledVector(r, 1.0), 0.3, 0.1, X, BRASS);
  }
  // Screen face: a plane on the pod's rear face, texture u to the viewer's right, v up.
  const screen = new THREE.PlaneGeometry(1.75, 1.25);
  screen.applyMatrix4(pod.clone().multiply(new THREE.Matrix4().makeBasis(v(0, -1, 0), v(0, 0, 1), v(-1, 0, 0)).setPosition(-0.51, 0, 0.02)));
  screen.computeBoundingSphere();
  return {
    meshes: [[metal.merge(), 'metal'], [paint.merge(), 'paint'], [hands.merge(), 'hands'], [glow.merge(), 'amber']],
    ring: { geometry: ring.merge(), pivot: axis(6.9) },
    screen: { geometry: screen },
  };
}

// ---- rig -----------------------------------------------------------------------------------

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => { const c = 1.5; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
const smooth = (a: number, b: number, t: number) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
/** A sharp rise then a decay that returns to zero at the end of the sequence. */
const kick = (t: number, rise: number) => Math.min(1, t / rise) * (1 - t) ** 2;

/** A bundled view model; see the file comment. */
export class DefaultViewModelRig implements PlayerViewModelRig {
  readonly builtin = true;
  readonly path: string;
  readonly object = new THREE.Group();
  readonly pose: { sequence: number; cycle: number; poseParameters: Float32Array; layers: PlayerAnimationLayer[] };
  readonly limitations: readonly string[] = [];
  private readonly kickNode = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly claw: THREE.Mesh | null = null;
  private readonly ring: THREE.Mesh | null = null;
  private readonly durations: readonly number[];
  private readonly euler = new THREE.Euler(0, 0, 0, 'ZYX');
  private disposed = false;

  private constructor(readonly tool: DefaultViewModelTool, private readonly kit: DefaultViewModelKit) {
    if (kit.disposed) throw new Error('The bundled view model materials were already released.');
    this.path = DEFAULT_VIEWMODEL_PATHS[tool];
    this.durations = DURATION[tool];
    this.object.name = 'player_viewmodel';
    this.object.matrixAutoUpdate = false;
    this.kickNode.name = `player_viewmodel_${tool}`;
    this.object.add(this.kickNode);
    const built = tool === 'physgun' ? buildPhysgun() : buildToolgun();
    for (const [geometry, key] of built.meshes) {
      const mesh = this.mesh(geometry, key);
      mesh.matrixAutoUpdate = false;
    }
    if (built.claw) { this.claw = this.mesh(built.claw.geometry, 'metal'); this.claw.position.copy(built.claw.pivot); }
    if (built.ring) { this.ring = this.mesh(built.ring.geometry, 'metal'); this.ring.position.copy(built.ring.pivot); }
    if (built.screen) this.mesh(built.screen.geometry, 'screen').matrixAutoUpdate = false;
    this.object.traverse(o => o.layers.set(PLAYER_VIEWMODEL_LAYER));
    this.pose = { sequence: SEQUENCE_OF.draw, cycle: 0, poseParameters: EMPTY_PARAMETERS, layers: [] };
  }

  static create(tool: DefaultViewModelTool, kit: DefaultViewModelKit): DefaultViewModelRig {
    return new DefaultViewModelRig(tool, kit);
  }

  private mesh(geometry: THREE.BufferGeometry, key: MaterialKey): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, this.kit.materials[key]);
    mesh.name = `${this.kickNode.name}_${key}`;
    mesh.castShadow = false; mesh.receiveShadow = false;
    this.kickNode.add(mesh);
    return mesh;
  }

  /** Plays the action's sequence from its start; every action has one. */
  start(action: ViewModelAction | 'idle'): boolean {
    this.pose.sequence = SEQUENCE_OF[action];
    this.pose.cycle = 0;
    return true;
  }

  /** Advances the live animation; a finished action returns to idle, idle loops. */
  advance(dt: number): void {
    const pose = this.pose;
    pose.cycle += Math.max(0, dt) / this.durations[pose.sequence];
    if (pose.cycle < 1) return;
    if (pose.sequence === IDLE) pose.cycle -= Math.floor(pose.cycle);
    else this.start('idle');
  }

  /** Poses the model from a presentation pose and the scene clock. Pure. */
  apply(pose: PlayerAnimationPose, clock: number): void {
    const seq = pose.sequence, t = Math.min(1, Math.max(0, pose.cycle));
    if (!Number.isInteger(seq) || seq < 0 || seq >= DEFAULT_VIEWMODEL_SEQUENCES.length)
      throw new Error(`${this.path} has no sequence ${seq}.`);
    if (pose.poseParameters.length !== 0)
      throw new Error(`${this.path} has no pose parameters; the presentation has ${pose.poseParameters.length}.`);
    const physgun = this.tool === 'physgun', rest = REST[this.tool];
    // Offsets in inches (eye frame) and degrees: lift raises the muzzle, roll turns the left side up.
    let px = 0, py = 0, pz = 0, yaw = 0, lift = 0, roll = 0, flare = 0, close = 0, spin = 0, page = 0;
    switch (seq) {
      case 0: { // draw: raised from below the view, turning upright
        const e = easeOutBack(t), d = 1 - easeOut(t);
        px = -2.5 * d; py = -1.2 * d; pz = -8.5 * d; lift = -48 * (1 - e); roll = 28 * (1 - e); yaw = -6 * d;
        flare = physgun ? 0.6 * smooth(0.55, 0.8, t) * (1 - smooth(0.8, 1, t)) : 0;
        spin = physgun ? 0 : TAU * easeOut(t);
        break;
      }
      case 1: { // idle: slow breathing that loops on the cycle
        const a = TAU * t;
        pz = 0.07 * Math.sin(a); px = 0.04 * Math.sin(2 * a); lift = 0.35 * Math.sin(a + 1); roll = 0.45 * Math.sin(a + 2);
        close = physgun ? 0.03 * Math.sin(a) : 0;
        break;
      }
      case 2: { // attack: recoil with a core flare (physics gun) or a trigger pulse (spawn tool)
        const k = kick(t, physgun ? 0.12 : 0.1);
        px = (physgun ? -1.1 : -0.8) * k; lift = (physgun ? 4 : 6) * k; roll = -1.5 * k;
        flare = physgun ? k : 1.4 * k;
        spin = physgun ? 0 : TAU / 3 * easeOut(t);
        break;
      }
      case 3: { // attack2: the physics gun pulls back and clamps; the spawn tool tilts to its screen
        const g = Math.sin(Math.PI * t);
        if (physgun) { px = -0.7 * g; lift = 2 * g; close = 0.14 * g; flare = 0.5 * g; }
        else { roll = 20 * g; pz = 0.5 * g; py = -0.3 * g; page = t > 0.18 && t < 0.82 ? 1 : 0; flare = 0.5 * g; }
        break;
      }
      default: { // inspect: turn the left side up toward the eye and back, away from the crosshair
        const w = smooth(0, 0.25, t) * (1 - smooth(0.75, 1, t));
        roll = 42 * w + 5 * Math.sin(TAU * 2 * t) * w; lift = 3 * w; yaw = -12 * w; py = -0.6 * w; pz = 0.4 * w; px = -0.6 * w;
        break;
      }
    }
    this.kickNode.position.set(rest.x + px, rest.y + py, rest.z + pz);
    this.kickNode.quaternion.setFromEuler(this.euler.set((rest.roll + roll) * DEG, -lift * DEG, (rest.yaw + yaw) * DEG, 'ZYX'));
    const pulse = Math.sin(TAU * 0.9 * clock);
    if (physgun) {
      const claw = this.claw!, open = 1 + 0.22 * flare - close;
      claw.scale.set(1, open, open);
      claw.rotation.x = 12 * DEG * flare;
      this.kit.materials.cyan.emissiveIntensity = 1.6 + 0.3 * pulse + 2.4 * flare;
    } else {
      this.ring!.rotation.x = (1.7 * clock) % TAU + spin;
      this.kit.materials.amber.emissiveIntensity = 1.3 + 0.15 * pulse + 2.2 * flare;
      this.kit.screen.offset.x = page * 0.5;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
  }
}
