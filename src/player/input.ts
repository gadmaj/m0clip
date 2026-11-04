import { PLAYER_BUTTON, type PlayerInputFrame, type PlayerTool } from './types';

const MOVEMENT_KEYS: Readonly<Record<string, true>> = {KeyW: true, KeyA: true, KeyS: true,
  KeyD: true, Space: true, ControlLeft: true, ControlRight: true, ShiftLeft: true, ShiftRight: true};
const TOOL_SLOTS = ['knife', 'physgun', 'spawn'] as const;
const LOOK_DEGREES = .022 * 3;

export interface PlayerInputActions {
  blocked(): boolean;
  /** The frame is borrowed: postMessage clones it synchronously; do not retain it. */
  input(frame: PlayerInputFrame): void;
  tool(tool: PlayerTool): void;
  unavailable(tool: PlayerTool): void;
  inspect(): void;
  spawnMenu(): void;
  holdDistance(direction: number): void;
  locked(locked: boolean): void;
  thirdPerson(held: boolean): void;
  lockError(error: unknown): void;
  /** A lock request started: Enter scene, the play card or a click on the scene. */
  lockRequested(): void;
}

/** Owns Player input only. App's central keyboard gate calls key() after modal routing. */
export class PlayerInputController {
  private enabled = false;
  private dirty = false;
  private readonly keys = new Set<string>();
  private mouseButtons = 0;
  private pendingPressed = 0;
  private pendingWheelJump = false;
  private available: readonly PlayerTool[] = [];
  private selected: PlayerTool = 'none';
  private holdingObject = false;
  private third = false;
  private readonly frame: PlayerInputFrame = {sequence: 0, yaw: 0, pitch: 0,
    forward: 0, side: 0, held: 0, pressed: 0, wheelJump: false, thirdPerson: false};

  constructor(private readonly canvas: HTMLCanvasElement,
      private readonly actions: PlayerInputActions) {
    canvas.addEventListener('pointerdown', this.pointerDown);
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('pointercancel', this.pointerCancel);
    window.addEventListener('mousemove', this.mouseMove);
    window.addEventListener('wheel', this.wheel, {passive: false});
    window.addEventListener('contextmenu', this.contextMenu);
    document.addEventListener('pointerlockchange', this.lockChange);
    window.addEventListener('blur', this.blur);
    document.addEventListener('visibilitychange', this.visibility);
  }

  get active() { return this.enabled; }
  get locked() { return this.enabled && document.pointerLockElement === this.canvas; }
  get yaw() { return this.frame.yaw; }
  get pitch() { return this.frame.pitch; }
  get thirdPerson() { return this.third; }
  get tool() { return this.selected; }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    if (!enabled) {
      this.reset();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    }
    this.enabled = enabled;
    if (enabled) this.dirty = true;
  }

  setLook(yaw: number, pitch: number) {
    this.frame.yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
    this.frame.pitch = Math.max(-89, Math.min(89, pitch));
    this.dirty = true;
  }

  setAvailableTools(tools: readonly PlayerTool[]) {
    this.available = tools;
    if (!tools.includes(this.selected)) this.selectTool('none');
  }

  setHoldingObject(holding: boolean) { this.holdingObject = holding; }

  selectTool(tool: PlayerTool) {
    if (tool !== 'none' && !this.available.includes(tool)) {
      this.actions.unavailable(tool);
      return;
    }
    if (tool === this.selected) return;
    this.selected = tool;
    this.pendingWheelJump = false;
    this.pendingPressed &= ~(PLAYER_BUTTON.attack | PLAYER_BUTTON.attack2);
    this.mouseButtons = 0;
    this.holdingObject = false;
    this.dirty = true;
    this.actions.tool(tool);
  }

  /** Call within Enter scene or the canvas's trusted pointer gesture. */
  requestLock() {
    if (!this.enabled || this.actions.blocked() || this.locked) return;
    try {
      const request = this.canvas.requestPointerLock();
      this.actions.lockRequested();
      if (request) void request.catch(error => this.actions.lockError(error));
    } catch (error) { this.actions.lockError(error); }
  }

  /** Key-up always reaches this method, even when another UI owns key-down. */
  key(event: KeyboardEvent, down: boolean): boolean {
    if (!this.enabled) return false;
    const code = event.code;
    if (!down) {
      const had = this.keys.delete(code);
      if (code === 'KeyX') this.setThird(false);
      if (had) this.dirty = true;
      return MOVEMENT_KEYS[code] === true || code === 'KeyX';
    }
    if (this.actions.blocked() || !this.locked) return false;
    // Auto-repeat cannot re-arm a key held across blur, a modal or pointer unlock.
    if (event.repeat && !this.keys.has(code)) return MOVEMENT_KEYS[code] === true || code === 'KeyX';
    if (MOVEMENT_KEYS[code] === true) {
      if (!this.keys.has(code)) {
        this.keys.add(code);
        if (code === 'Space') this.pendingPressed |= PLAYER_BUTTON.jump;
        this.dirty = true;
      }
      event.preventDefault();
      return true;
    }
    if (code === 'KeyX') {
      if (!event.repeat) { this.keys.add(code); this.setThird(true); }
      event.preventDefault();
      return true;
    }
    if (event.repeat) return false;
    const tool = code === 'Digit1' ? TOOL_SLOTS[0] : code === 'Digit2' ? TOOL_SLOTS[1] : code === 'Digit3' ? TOOL_SLOTS[2] : null;
    if (tool) this.selectTool(tool);
    else if (code === 'KeyQ') this.actions.spawnMenu();
    else if (code === 'KeyF' && this.selected === 'knife') this.actions.inspect();
    else return false;
    event.preventDefault();
    return true;
  }

  /** At most one changed sample per presentation frame; held input persists in the worker. */
  update() {
    if (!this.enabled || !this.dirty) return;
    if (this.actions.blocked()) { this.reset(); return; }
    const keys = this.keys, frame = this.frame;
    frame.forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    frame.side = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    frame.held = this.mouseButtons
      | (keys.has('Space') ? PLAYER_BUTTON.jump : 0)
      | (keys.has('ControlLeft') || keys.has('ControlRight') ? PLAYER_BUTTON.duck : 0)
      | (keys.has('ShiftLeft') || keys.has('ShiftRight') ? PLAYER_BUTTON.run : 0);
    frame.pressed = this.pendingPressed;
    frame.wheelJump = this.pendingWheelJump;
    frame.thirdPerson = this.third;
    frame.sequence++;
    this.actions.input(frame);
    this.pendingPressed = 0;
    this.pendingWheelJump = false;
    this.dirty = false;
  }

  /** One release path for focus, lock, modal, review, scene and mode transitions. */
  reset() {
    this.keys.clear();
    this.mouseButtons = 0;
    this.pendingPressed = 0;
    this.pendingWheelJump = false;
    this.holdingObject = false;
    this.setThird(false);
    this.frame.forward = this.frame.side = this.frame.held = this.frame.pressed = 0;
    this.frame.wheelJump = this.frame.thirdPerson = false;
    this.dirty = false;
    if (this.enabled) { this.frame.sequence++; this.actions.input(this.frame); }
  }

  private setThird(held: boolean) {
    if (held === this.third) return;
    this.third = held;
    this.dirty = true;
    this.actions.thirdPerson(held);
  }

  private readonly pointerDown = (event: PointerEvent) => {
    if (!this.enabled || this.actions.blocked()) return;
    if (!this.locked) { this.requestLock(); return; }
    const bit = event.button === 0 ? PLAYER_BUTTON.attack : event.button === 2 ? PLAYER_BUTTON.attack2 : 0;
    if (!bit) return;
    this.mouseButtons |= bit;
    this.pendingPressed |= bit;
    this.dirty = true;
    event.preventDefault();
  };
  private readonly pointerUp = (event: PointerEvent) => {
    const bit = event.button === 0 ? PLAYER_BUTTON.attack : event.button === 2 ? PLAYER_BUTTON.attack2 : 0;
    if (this.mouseButtons & bit) { this.mouseButtons &= ~bit; this.dirty = true; }
  };
  private readonly pointerCancel = () => { if (this.enabled) this.reset(); };
  private readonly mouseMove = (event: MouseEvent) => {
    if (!this.locked || this.actions.blocked()) return;
    this.setLook(this.frame.yaw - event.movementX * LOOK_DEGREES,
      this.frame.pitch + event.movementY * LOOK_DEGREES);
  };
  private readonly wheel = (event: WheelEvent) => {
    if (!this.locked || this.actions.blocked() || event.deltaY === 0) return;
    event.preventDefault();
    if (this.selected === 'physgun' && this.holdingObject) {
      this.actions.holdDistance(event.deltaY < 0 ? 1 : -1);
    } else if (this.selected === 'knife' && event.deltaY > 0) {
      this.pendingWheelJump = true;
      this.dirty = true;
    } else if (this.available.length) {
      const choices = this.available;
      const at = choices.indexOf(this.selected);
      this.selectTool(choices[(at + (event.deltaY > 0 ? 1 : -1) + choices.length) % choices.length]);
    }
  };
  private readonly contextMenu = (event: Event) => { if (this.locked) event.preventDefault(); };
  private readonly lockChange = () => {
    if (!this.enabled) return;
    if (!this.locked) this.reset();
    this.actions.locked(this.locked);
  };
  private readonly blur = () => { if (this.enabled) this.reset(); };
  private readonly visibility = () => { if (document.hidden && this.enabled) this.reset(); };

  dispose() {
    this.setEnabled(false);
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    window.removeEventListener('pointerup', this.pointerUp);
    window.removeEventListener('pointercancel', this.pointerCancel);
    window.removeEventListener('mousemove', this.mouseMove);
    window.removeEventListener('wheel', this.wheel);
    window.removeEventListener('contextmenu', this.contextMenu);
    document.removeEventListener('pointerlockchange', this.lockChange);
    window.removeEventListener('blur', this.blur);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
