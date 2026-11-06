import { PLAYER_BUTTON, type PlayerInputFrame, type PlayerTool } from './types';

// Crouch is C, not Source's Ctrl: Chrome reserves Ctrl+W (close tab) outside fullscreen Keyboard Lock,
// so crouch-walking with Ctrl closed the page in QA.
const MOVEMENT_KEYS: Readonly<Record<string, true>> = {KeyW: true, KeyA: true, KeyS: true,
  KeyD: true, Space: true, KeyC: true, ShiftLeft: true, ShiftRight: true};
const TOOL_SLOTS = ['knife', 'physgun', 'spawn'] as const;
const LOOK_DEGREES = .022 * 3;

/** Signed wheel clicks, positive downward. Chrome merges fast clicks into one event; its legacy
 * wheelDelta stays 120 per click. With Shift held (running), Chrome on Windows and Linux reports
 * a vertical wheel on the horizontal axis. */
function wheelClicks(event: WheelEvent): number {
  const horizontal = event.deltaY === 0 && event.shiftKey;
  const delta = horizontal ? event.deltaX : event.deltaY;
  if (delta === 0) return 0;
  const legacyEvent = event as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  const legacy = horizontal ? legacyEvent.wheelDeltaX : legacyEvent.wheelDeltaY;
  const clicks = typeof legacy === 'number' && legacy !== 0 ? Math.max(1, Math.round(Math.abs(legacy) / 120)) : 1;
  return delta > 0 ? clicks : -clicks;
}

function mouseBit(button: number): number {
  return button === 0 ? PLAYER_BUTTON.attack : button === 2 ? PLAYER_BUTTON.attack2 : 0;
}

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

/** Owns Player input only. App's central keyboard gate calls key() after modal routing.
 * Every change is sent once, in a microtask after the event that caused it, so controls do not
 * wait for the next rendered frame. */
export class PlayerInputController {
  private enabled = false;
  private dirty = false;
  private flushQueued = false;
  /** Something was sent since the last release frame: a press may still be queued in the worker
   * even after a neutral frame, so only a release frame clears this. */
  private live = false;
  private readonly keys = new Set<string>();
  private mouseButtons = 0;
  private pendingPressed = 0;
  private available: readonly PlayerTool[] = [];
  private selected: PlayerTool = 'none';
  private holdingObject = false;
  private third = false;
  private readonly frame: PlayerInputFrame = {sequence: 0, yaw: 0, pitch: 0,
    forward: 0, side: 0, held: 0, pressed: 0, reset: false, thirdPerson: false};

  constructor(private readonly canvas: HTMLCanvasElement,
      private readonly actions: PlayerInputActions) {
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('mousedown', this.mouseDown);
    window.addEventListener('mouseup', this.mouseUp);
    window.addEventListener('pointercancel', this.pointerCancel);
    window.addEventListener('mousemove', this.mouseMove);
    window.addEventListener('wheel', this.wheel, {passive: false});
    document.addEventListener('pointerlockchange', this.lockChange);
    window.addEventListener('blur', this.blur);
    document.addEventListener('visibilitychange', this.visibility);
    canvas.addEventListener('contextmenu', this.contextMenu);
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
    if (enabled) this.changed();
  }

  setLook(yaw: number, pitch: number) {
    this.frame.yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
    this.frame.pitch = Math.max(-89, Math.min(89, pitch));
    this.changed();
  }

  /** The worker's tool list; it reports its own tool, so nothing is requested here. */
  setAvailableTools(tools: readonly PlayerTool[]) {
    this.available = tools;
    if (!tools.includes(this.selected)) this.confirmTool('none');
  }

  setHoldingObject(holding: boolean) { this.holdingObject = holding; }

  /** The person's choice: asks the worker for the tool. */
  selectTool(tool: PlayerTool) {
    if (tool !== 'none' && !this.available.includes(tool)) {
      this.actions.unavailable(tool);
      return;
    }
    if (tool === this.selected) return;
    this.adopt(tool);
    this.actions.tool(tool);
  }

  /** Adopt the tool the worker reports without requesting it again. */
  confirmTool(tool: PlayerTool) {
    if (tool !== this.selected) this.adopt(tool);
  }

  /** A new tool starts with its buttons up; movement and a queued jump are kept. */
  private adopt(tool: PlayerTool) {
    this.selected = tool;
    this.pendingPressed &= ~(PLAYER_BUTTON.attack | PLAYER_BUTTON.attack2);
    this.mouseButtons = 0;
    this.holdingObject = false;
    this.changed();
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
      if (had) this.changed();
      return MOVEMENT_KEYS[code] === true || code === 'KeyX';
    }
    if (this.actions.blocked() || !this.locked) return false;
    // Auto-repeat cannot re-arm a key held across blur, a modal or pointer unlock.
    if (event.repeat && !this.keys.has(code)) return MOVEMENT_KEYS[code] === true || code === 'KeyX';
    if (MOVEMENT_KEYS[code] === true) {
      if (!this.keys.has(code)) {
        this.keys.add(code);
        if (code === 'Space') this.pendingPressed |= PLAYER_BUTTON.jump;
        this.changed();
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

  /** Send the input if it changed. App also calls this every animation frame: while input is
   * blocked it releases everything once. Held input persists in the worker between sends. */
  update() {
    if (!this.enabled) return;
    if (this.actions.blocked()) { this.reset(); return; }
    if (!this.dirty) return;
    const keys = this.keys, frame = this.frame;
    frame.forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    frame.side = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    frame.held = this.mouseButtons
      | (keys.has('Space') ? PLAYER_BUTTON.jump : 0)
      | (keys.has('KeyC') ? PLAYER_BUTTON.duck : 0)
      | (keys.has('ShiftLeft') || keys.has('ShiftRight') ? PLAYER_BUTTON.run : 0);
    frame.pressed = this.pendingPressed;
    frame.thirdPerson = this.third;
    this.pendingPressed = 0;
    this.dirty = false;
    this.send();
  }

  /** One release path for focus, lock, modal, review, scene and mode transitions. The worker drops
   * held buttons and any press it has not simulated yet; nothing is sent if nothing was sent since
   * the last release. */
  reset() {
    this.keys.clear();
    this.mouseButtons = 0;
    this.pendingPressed = 0;
    this.holdingObject = false;
    this.setThird(false);
    this.dirty = false;
    const frame = this.frame;
    frame.forward = frame.side = frame.held = frame.pressed = 0;
    frame.thirdPerson = false;
    if (!this.enabled || !this.live) return;
    frame.reset = true;
    this.send();
    frame.reset = false;
    this.live = false;
  }

  private send() {
    const frame = this.frame;
    frame.sequence++;
    this.actions.input(frame);
    this.live ||= frame.forward !== 0 || frame.side !== 0 || frame.held !== 0 || frame.pressed !== 0 || frame.thirdPerson;
  }

  private changed() {
    this.dirty = true;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(this.flush);
  }

  private readonly flush = () => {
    this.flushQueued = false;
    this.update();
  };

  private setThird(held: boolean) {
    if (held === this.third) return;
    this.third = held;
    this.changed();
    this.actions.thirdPerson(held);
  }

  /** A left click captures the mouse; buttons count once it is captured. */
  private readonly pointerDown = (event: PointerEvent) => {
    if (event.button === 0 && this.enabled && !this.actions.blocked() && !this.locked) this.requestLock();
  };
  /** mousedown/mouseup, unlike pointerdown/pointerup, fire for a button pressed or released while
   * another is held, so chorded clicks cannot leave one stuck down. */
  private readonly mouseDown = (event: MouseEvent) => {
    if (!this.locked || this.actions.blocked()) return;
    const bit = mouseBit(event.button);
    if (!bit) return;
    event.preventDefault();
    if (this.mouseButtons & bit) return;
    this.mouseButtons |= bit;
    this.pendingPressed |= bit;
    this.changed();
  };
  private readonly mouseUp = (event: MouseEvent) => {
    const bit = mouseBit(event.button);
    if (this.mouseButtons & bit) { this.mouseButtons &= ~bit; this.changed(); }
  };
  private readonly pointerCancel = () => { if (this.enabled) this.reset(); };
  private readonly mouseMove = (event: MouseEvent) => {
    if (!this.locked || this.actions.blocked()) return;
    this.setLook(this.frame.yaw - event.movementX * LOOK_DEGREES,
      this.frame.pitch + event.movementY * LOOK_DEGREES);
  };
  private readonly wheel = (event: WheelEvent) => {
    if (!this.locked || this.actions.blocked()) return;
    const clicks = wheelClicks(event);
    if (clicks === 0) return;
    event.preventDefault();
    if (event.altKey) {
      // Alt+wheel sets the physics gun's reach: up pushes a held object farther.
      if (this.selected === 'physgun' && this.holdingObject) this.actions.holdDistance(-clicks);
    } else if (clicks > 0) {
      // Down is a jump press with every tool. Clicks inside one tick make one jump, as in Source.
      this.pendingPressed |= PLAYER_BUTTON.jump;
      this.changed();
    } else if (!this.holdingObject && this.available.length) {
      // Up steps back through the tools; while an object is held it would drop it instead.
      const choices = this.available, at = Math.max(0, choices.indexOf(this.selected));
      this.selectTool(choices[((at + clicks) % choices.length + choices.length) % choices.length]);
    }
  };
  /** The scene's right button is the secondary action, never the browser menu; other UI keeps it.
   * While locked, every mouse event targets the canvas. */
  private readonly contextMenu = (event: Event) => { if (this.enabled) event.preventDefault(); };
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
    this.canvas.removeEventListener('mousedown', this.mouseDown);
    window.removeEventListener('mouseup', this.mouseUp);
    window.removeEventListener('pointercancel', this.pointerCancel);
    window.removeEventListener('mousemove', this.mouseMove);
    window.removeEventListener('wheel', this.wheel);
    this.canvas.removeEventListener('contextmenu', this.contextMenu);
    document.removeEventListener('pointerlockchange', this.lockChange);
    window.removeEventListener('blur', this.blur);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
