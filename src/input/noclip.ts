/** FPS navigation adapted from noclip.website Camera.ts / InputManager.ts.
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip.
 * Source's scene multiplier is 1/20; our maps use metres rather than inches.
 * Acceleration and drag use elapsed time so the feel survives different refresh rates. */
import * as THREE from 'three';

const CAMERA_MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9']);
const CAMERA_STOP_KEYS = new Set(['Numpad5', 'Numpad0']);
export const isCameraMovementKey = (code: string) => CAMERA_MOVE_KEYS.has(code);
export const isCameraKey = (code: string) => CAMERA_MOVE_KEYS.has(code) || CAMERA_STOP_KEYS.has(code)
  || code === 'NumpadAdd' || code === 'NumpadSubtract';

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyQ', 'KeyE', 'PageUp', 'PageDown', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'Backslash', 'IntlBackslash', 'KeyX', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyO', ...CAMERA_MOVE_KEYS, ...CAMERA_STOP_KEYS, 'NumpadAdd', 'NumpadSubtract']);
const UP = new THREE.Vector3(0, 0, 1);

/** Integrate one axis, including the short ramp to top speed and exponential release drag. */
export function flightAxis(velocity: number, input: number, cap: number, dt: number): [number, number] {
  if (dt <= 0) return [velocity, 0];
  if (input) {
    velocity = THREE.MathUtils.clamp(velocity, -cap, cap);
    const target = input * cap, acceleration = cap * 0.2 * 60;
    const ramp = Math.min(dt, Math.abs(target - velocity) / acceleration);
    const next = velocity + Math.sign(target - velocity) * acceleration * ramp;
    return [next, (velocity + next) * 0.5 * ramp + next * (dt - ramp)];
  }
  const decay = -Math.log(0.8) * 60;
  const next = velocity * Math.exp(-decay * dt);
  return [Math.abs(next) < 0.1 * 60 / 20 * 0.0254 ? 0 : next, (velocity - next) / decay];
}

export class NoclipFlight {
  active = false;
  hover = false;
  speed = 60;
  readonly velocity = new THREE.Vector3();
  private keys = new Set<string>();
  private shiftHeld = false;
  private controlHeld = false;
  private localVelocity = [0, 0, 0];
  private mouse = new THREE.Vector2();
  private buttons = 0;
  private pointer: number | null = null;
  private previous = new THREE.Vector2();
  private lookDistance = 1;
  private right = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private delta = new THREE.Vector3();
  private rotation = new THREE.Quaternion();
  private axisRotation = new THREE.Quaternion();

  constructor(private camera: THREE.PerspectiveCamera, private target: THREE.Vector3,
              private canvas: HTMLCanvasElement, private stopped: () => void) {
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '3D viewport');
    canvas.addEventListener('pointerdown', e => {
      if (!this.active) return;
      e.preventDefault(); canvas.focus();
      this.buttons = e.buttons; this.pointer = e.pointerId; this.previous.set(e.clientX, e.clientY);
      if (!document.pointerLockElement) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* Pointer lock can take over during this event. */ }
      }
      if (e.pointerType === 'mouse' && !document.pointerLockElement) {
        const request = canvas.requestPointerLock?.();
        request?.catch(() => { /* Drag-to-look still works when pointer lock is unavailable. */ });
      }
    });
    document.addEventListener('pointermove', e => {
      if (!this.active || (!this.buttons && this.pointer === null)) return;
      if (document.pointerLockElement !== canvas && e.pointerId !== this.pointer) return;
      const locked = document.pointerLockElement === canvas;
      const dx = locked ? e.movementX : e.clientX - this.previous.x;
      const dy = locked ? e.movementY : e.clientY - this.previous.y;
      this.previous.set(e.clientX, e.clientY);
      if (Math.abs(dx) <= 200 && Math.abs(dy) <= 200) this.mouse.add(new THREE.Vector2(dx, dy));
    });
    const release = (e: PointerEvent) => {
      if (!this.active) return;
      this.buttons = e.buttons;
      if (this.buttons) return;
      if (this.pointer !== null && canvas.hasPointerCapture(this.pointer)) canvas.releasePointerCapture(this.pointer);
      this.pointer = null;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
    document.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => this.stop());
    document.addEventListener('pointerlockchange', () => {
      if (this.active && !document.pointerLockElement && this.pointer !== null) this.stop();
    });
    canvas.addEventListener('contextmenu', e => { if (this.active) e.preventDefault(); });
    canvas.addEventListener('wheel', e => {
      if (!this.active) return;
      e.preventDefault(); this.speed = THREE.MathUtils.clamp(this.speed - Math.sign(e.deltaY) * 4, 1, 200);
    }, { passive: false });
    window.addEventListener('blur', () => this.stop());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); });
    document.addEventListener('focusin', e => {
      if (e.target instanceof HTMLElement && e.target.closest('input,select,textarea,[contenteditable="true"]')) this.stop();
    });
  }

  setActive(on: boolean) {
    this.stop(); this.active = on;
    this.lookDistance = Math.max(0.1, this.camera.position.distanceTo(this.target));
    this.canvas.tabIndex = 0;
    this.canvas.style.cursor = on ? 'crosshair' : '';
  }

  stop() {
    this.keys.clear(); this.shiftHeld = this.controlHeld = false; this.localVelocity.fill(0); this.velocity.set(0, 0, 0); this.mouse.set(0, 0);
    this.buttons = 0;
    if (this.pointer !== null && this.canvas.hasPointerCapture(this.pointer)) this.canvas.releasePointerCapture(this.pointer);
    this.pointer = null;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (this.active) this.stopped();
  }

  key(e: KeyboardEvent, down: boolean): boolean {
    if (!this.active) return false;
    if (e.code === 'Escape') { this.stop(); return false; }
    if (!KEYS.has(e.code)) return false;
    this.shiftHeld = e.shiftKey; this.controlHeld = e.ctrlKey;
    // Keep browser shortcuts available. Ctrl+Space is noclip.website's downward movement.
    if (down && (e.metaKey || e.altKey || (e.ctrlKey && e.code !== 'Space'
        && !e.code.startsWith('Control') && !e.code.startsWith('Shift')))) return false;
    if (CAMERA_STOP_KEYS.has(e.code)) {
      if (down && !e.repeat) this.stop();
      e.preventDefault(); return true;
    }
    if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
      if (down) this.speed = THREE.MathUtils.clamp(this.speed + (e.code === 'NumpadAdd' ? 4 : -4), 1, 200);
      e.preventDefault(); return true;
    }
    if (down) {
      // A stop must hold until the next physical press, even if a held key keeps repeating.
      if (!e.repeat) this.keys.add(e.code);
      if (e.code === 'KeyX' && !e.repeat) this.hover = !this.hover;
    } else this.keys.delete(e.code);
    e.preventDefault();
    return true;
  }

  update(dt: number): THREE.Vector3 {
    this.velocity.set(0, 0, 0);
    if (!this.active || dt <= 0) return this.velocity;
    dt = Math.min(dt, 0.1);
    const held = (...codes: string[]) => codes.some(c => this.keys.has(c));
    const shift = this.shiftHeld || held('ShiftLeft', 'ShiftRight');
    const cap = this.speed * 60 / 20 * 0.0254 * (shift ? 5 : held('Backslash', 'IntlBackslash') ? 0.1 : 1);
    // Match the reference controller's priority when opposite directions overlap.
    const right = held('KeyD', 'ArrowRight', 'Numpad6'), left = held('KeyA', 'ArrowLeft', 'Numpad4');
    const forward = held('KeyW', 'ArrowUp', 'Numpad8') || (this.buttons & 3) === 3;
    const backward = held('KeyS', 'ArrowDown', 'Numpad2');
    const down = held('KeyQ', 'KeyC', 'PageDown', 'Numpad1', 'Numpad3') || (held('Space') && (this.controlHeld || held('ControlLeft', 'ControlRight')));
    const up = held('Space', 'KeyE', 'PageUp', 'Numpad7', 'Numpad9');
    const input = [left ? -1 : right ? 1 : 0, forward ? 1 : backward ? -1 : 0, down ? -1 : up ? 1 : 0];
    const move = input.map((v, i) => {
      const [next, distance] = flightAxis(this.localVelocity[i], v, cap, dt);
      this.localVelocity[i] = next; return distance;
    });
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.camera.getWorldDirection(this.forward);
    if (this.hover) {
      this.forward.z = this.right.z = 0;
      this.forward.normalize(); this.right.normalize();
    }
    this.delta.copy(this.right).multiplyScalar(move[0]).addScaledVector(this.forward, move[1]).addScaledVector(UP, move[2]);
    this.camera.position.add(this.delta);
    this.velocity.copy(this.delta).divideScalar(dt);
    const angle = (shift ? 0.1 : 0.02) * dt * 60;
    const yaw = -this.mouse.x / 500 + (held('KeyJ') ? 1 : held('KeyL') ? -1 : 0) * angle;
    const pitch = -this.mouse.y / 500 + (held('KeyI') ? 1 : held('KeyK') ? -1 : 0) * angle;
    const roll = (held('KeyU') ? -1 : held('KeyO') ? 1 : 0) * angle;
    // noclip composes yaw * pitch * roll around the frame's original basis.
    // Premultiplying each separately reverses that order and adds unwanted banking.
    this.rotation.identity();
    if (yaw) this.rotation.multiply(this.axisRotation.setFromAxisAngle(UP, yaw));
    if (pitch) this.rotation.multiply(this.axisRotation.setFromAxisAngle(this.right, pitch));
    if (roll) this.rotation.multiply(this.axisRotation.setFromAxisAngle(this.forward, -roll));
    this.camera.quaternion.premultiply(this.rotation);
    this.camera.quaternion.normalize(); this.mouse.set(0, 0);
    this.camera.getWorldDirection(this.forward);
    this.target.copy(this.camera.position).addScaledVector(this.forward, this.lookDistance);
    this.camera.updateMatrixWorld();
    return this.velocity;
  }
}
