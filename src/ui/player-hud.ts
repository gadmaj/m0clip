/** Player HUD: crosshair, transient tool strip, one context line and the Click to play card.
 * Presentation only. PlayerInputController owns every key, wheel and pointer-lock listener. */
import type { PlayerTool, SceneMode } from '../player/types';
import { VisualPicker } from './visual-picker';
import { previewImage, staticPreviewOptions } from './preview-catalog';
import './player-hud.css';

export interface PlayerHudState {
  /** Live Player input: false during launch, review, export and Robot mode. */
  enabled: boolean;
  locked: boolean;
  tool: PlayerTool;
  /** Tools the runtime actually provides; others never appear. */
  tools: readonly PlayerTool[];
  /** The Physics gun holds an object. */
  holding: boolean;
  /** Robot the Spawn gun places; null when none is chosen. */
  spawnLabel: string | null;
}
export interface PlayerHudCallbacks {
  /** Runs inside the trusted click or key activation; call PlayerInputController.requestLock(). */
  requestLock(): void;
  /** Explicit choice from the pictured spawn gallery. */
  spawnRobot(value: string): void;
}
export interface SpawnRobotOption { value: string; label: string }

export const PLAYER_TOOL_LABELS: Readonly<Record<Exclude<PlayerTool, 'none'>, string>> = {
  knife: 'Knife', physgun: 'Physics gun', spawn: 'Spawn gun',
};
const SLOTS = ['knife', 'physgun', 'spawn'] as const;
const STRIP_MS = 1500;
const NOTICE_MS = 2500;
/** A granted lock arrives well within this; an unfocused Chrome window may never answer at all. */
const LOCK_WAIT_MS = 1000;

export class PlayerHud {
  readonly root = document.createElement('div');
  private readonly strip = document.createElement('ol');
  private readonly slots = new Map<PlayerTool, HTMLLIElement>();
  private readonly context = document.createElement('p');
  private readonly card = document.createElement('div');
  private readonly play = document.createElement('button');
  private readonly playNote = document.createElement('p');
  private readonly spawnChoice = document.createElement('div');
  private readonly spawnSelect = document.createElement('select');
  private readonly spawnPicker: VisualPicker;
  private readonly finePointer = matchMedia('(any-pointer: fine)');
  private mode: SceneMode = 'robot';
  private readonly state: PlayerHudState = { enabled: false, locked: false, tool: 'none', tools: [], holding: false, spawnLabel: null };
  private stripTimer?: number;
  private noticeTimer?: number;
  private lockTimer?: number;
  private notice = '';
  /** The last capture request failed; cleared by the next successful lock. */
  private lockMissed = false;

  constructor(viewport: HTMLElement, private readonly callbacks: PlayerHudCallbacks) {
    this.root.id = 'player-hud';
    this.root.hidden = true;
    const crosshair = document.createElement('div');
    crosshair.className = 'player-crosshair';
    crosshair.setAttribute('aria-hidden', 'true');
    this.strip.className = 'player-tools';
    this.strip.setAttribute('aria-label', 'Tools');
    SLOTS.forEach((tool, index) => {
      const slot = document.createElement('li');
      const key = document.createElement('kbd');
      key.textContent = String(index + 1);
      const name = document.createElement('span');
      name.textContent = PLAYER_TOOL_LABELS[tool];
      slot.append(key, name);
      slot.hidden = true;
      this.slots.set(tool, slot);
      this.strip.append(slot);
    });
    this.context.className = 'player-context';
    this.context.setAttribute('role', 'status');
    this.context.setAttribute('aria-live', 'polite');

    this.card.className = 'player-play';
    this.play.type = 'button';
    this.play.id = 'player-play';
    this.play.className = 'btn primary';
    this.play.textContent = 'Click to play';
    this.play.addEventListener('click', () => this.callbacks.requestLock());
    this.playNote.className = 'player-play-note';
    this.playNote.setAttribute('role', 'status');
    this.spawnChoice.className = 'player-spawn';
    const spawnLabel = document.createElement('label');
    spawnLabel.htmlFor = 'player-spawn-trigger';
    spawnLabel.textContent = 'Spawn robot';
    this.spawnSelect.id = 'player-spawn';
    this.spawnChoice.append(spawnLabel, this.spawnSelect);
    this.card.append(this.play, this.playNote, this.spawnChoice);
    this.root.append(crosshair, this.strip, this.context, this.card);
    viewport.append(this.root);
    this.spawnSelect.addEventListener('change', () => this.callbacks.spawnRobot(this.spawnSelect.value));
    this.spawnPicker = new VisualPicker(this.spawnSelect, { id: 'player-spawn', label: 'Spawn robot', title: 'Choose a robot to spawn',
      preview: value => previewImage('robot', value) });
    this.finePointer.addEventListener('change', this.renderCard);
    this.renderCard();
  }

  /** Robot mode keeps every Robot control; Player hides Robot-only ones (data-robot-only). */
  setMode(mode: SceneMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    document.body.dataset.sceneMode = mode;
    this.render();
  }

  /** Change-driven: unchanged state touches no DOM. */
  update(next: Readonly<PlayerHudState>) {
    const state = this.state;
    let toolsChanged = next.tools.length !== state.tools.length;
    for (let index = 0; !toolsChanged && index < next.tools.length; index++) toolsChanged = next.tools[index] !== state.tools[index];
    const toolChanged = next.tool !== state.tool;
    if (!toolsChanged && !toolChanged && next.enabled === state.enabled && next.locked === state.locked
      && next.holding === state.holding && next.spawnLabel === state.spawnLabel) return;
    const locking = next.locked && !state.locked;
    if (locking) { this.lockMissed = false; window.clearTimeout(this.lockTimer); this.lockTimer = undefined; }
    state.enabled = next.enabled; state.locked = next.locked; state.tool = next.tool;
    state.holding = next.holding; state.spawnLabel = next.spawnLabel;
    if (toolsChanged) state.tools = next.tools.slice();
    if (toolsChanged || toolChanged || locking) this.showStrip();
    this.render();
  }

  setSpawnRobots(options: readonly SpawnRobotOption[], selected: string | null) {
    this.spawnSelect.replaceChildren(...options.map(option => new Option(option.label, option.value)));
    staticPreviewOptions(this.spawnSelect, 'robot');
    if (selected !== null) this.spawnSelect.value = selected;
    this.spawnPicker.sync();
    this.renderCard();
  }

  /** Q: releases the pointer so the gallery can be used. */
  openSpawnMenu() {
    if (!this.spawnSelect.options.length) { this.showNotice('No robots to spawn'); return; }
    if (document.pointerLockElement) document.exitPointerLock();
    this.spawnPicker.button.click();
  }

  unavailable(tool: PlayerTool) {
    if (tool !== 'none') this.showNotice(`${PLAYER_TOOL_LABELS[tool]} unavailable`);
  }

  /** Pointer lock was refused (commonly: the browser window was not focused). One notice, no retry. */
  lockFailed() {
    window.clearTimeout(this.lockTimer); this.lockTimer = undefined;
    this.lockMissed = true;
    this.renderCard();
  }

  /** Called for every lock request: one that neither locks nor errors gets the same notice once. */
  lockRequested() {
    window.clearTimeout(this.lockTimer);
    this.lockTimer = window.setTimeout(() => {
      this.lockTimer = undefined;
      if (this.mode === 'player' && this.state.enabled && !this.state.locked) this.lockFailed();
    }, LOCK_WAIT_MS);
  }

  showNotice(message: string) {
    window.clearTimeout(this.noticeTimer);
    this.notice = message;
    this.noticeTimer = window.setTimeout(() => { this.notice = ''; this.noticeTimer = undefined; this.renderContext(); }, NOTICE_MS);
    this.renderContext();
  }

  dispose() {
    window.clearTimeout(this.stripTimer); window.clearTimeout(this.noticeTimer); window.clearTimeout(this.lockTimer);
    this.finePointer.removeEventListener('change', this.renderCard);
    this.spawnPicker.dispose();
    this.root.remove();
    delete document.body.dataset.sceneMode;
    document.body.removeAttribute('data-player-locked');
  }

  private showStrip() {
    window.clearTimeout(this.stripTimer);
    this.strip.dataset.show = 'true';
    this.stripTimer = window.setTimeout(() => { delete this.strip.dataset.show; this.stripTimer = undefined; }, STRIP_MS);
  }

  private render() {
    const { enabled, locked, tool, tools } = this.state;
    const live = this.mode === 'player' && enabled;
    this.root.hidden = !live;
    this.root.toggleAttribute('data-locked', live && locked);
    // Pointer lock hides the workspace it makes unreachable; Esc unlocks and restores it.
    document.body.toggleAttribute('data-player-locked', live && locked);
    for (const [slotTool, slot] of this.slots) {
      slot.hidden = !tools.includes(slotTool);
      slot.classList.toggle('active', slotTool === tool);
    }
    this.renderCard();
    this.renderContext();
  }

  private readonly renderCard = () => {
    const live = this.mode === 'player' && this.state.enabled;
    this.card.hidden = !live || this.state.locked;
    // Pointer lock needs a mouse; touch controls are not provided, so do not offer a dead button.
    const pointer = this.finePointer.matches && 'requestPointerLock' in HTMLElement.prototype;
    this.play.hidden = !pointer;
    const note = !pointer ? 'Player controls need a mouse and keyboard.'
      : this.lockMissed ? 'Click the scene again to capture the mouse.' : 'Esc releases the mouse.';
    if (this.playNote.textContent !== note) this.playNote.textContent = note;
    this.spawnChoice.hidden = !this.state.tools.includes('spawn') || !this.spawnSelect.options.length;
  };

  private renderContext() {
    const { locked, tool, holding, spawnLabel } = this.state;
    const text = this.notice || (!locked ? ''
      : tool === 'knife' ? 'F Inspect · Wheel ↓ Jump'
      : tool === 'physgun' ? holding ? 'Wheel Nearer / farther' : ''
      : tool === 'spawn' ? spawnLabel ? `${spawnLabel} · Q Change robot` : 'Q Choose robot'
      : '');
    if (this.context.textContent !== text) this.context.textContent = text;
  }
}
