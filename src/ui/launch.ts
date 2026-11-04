/** Lightweight launch shell. Keep all runtime imports free of rendering/simulation dependencies. */
import { isTerrain, TERRAINS } from '../sim/terrain';
import type { MapEntry, TerrainName } from '../sim/terrain';
import { KIT_LABELS, KIT_REGIONS } from '../render/robot-kit-data';
import { CHARACTER_CHOICES, characterPhysics, compatibleBody, isBodyVisual, isCharacter, type CharacterId } from '../characters/catalog';
import { decodePmodelId, pmodelRecord } from '../characters/pmodels';
import type { SceneMode } from '../player/types';
import { sharedView } from './explore';
import { Pong } from './pong';
import { VisualPicker } from './visual-picker';
import { previewImage, staticPreviewOptions, characterOptions, characterDescription, sourceModelCatalog } from './preview-catalog';
import { previewMedia } from './preview-media';
import { SceneProgress, assetName, detailText, downloadEstimate, loadingPhase, type LoadingSnapshot } from '../loading/progress';
import { observeTransfers, type TransferUpdate } from '../loading/transfers';
import type { PlannedAsset, PriorModuleIntake } from '../loading/asset-plan';
import { registerPreviewAsset } from '../loading/preview-assets';
import './launch.css';
import { inspectLocalMap, loadLocalMap, localMapIntakeState } from './local-map';
import type { MapBundleIndex } from '../maps/bundle';
import type { MapSource } from '../maps/source';
import type { BundleVerificationObserver } from '../maps/bundle-verification';

export interface LaunchSelection {
  terrain: TerrainName;
  localFile?: File;
  localIndex?: MapBundleIndex;
  localSource?: MapSource;
  mode: SceneMode;
  /** Robot mode physics; Player mode keeps it remembered and unused. */
  robot: string;
  /** null means preserve linked / remembered paint, not "apply Original". */
  character: CharacterId | null;
  /** Player model ID, independent of the Robot character. */
  playerBody: string;
  preserveView: boolean;
  robotChanged: boolean;
}
/** Verified Player model supplied by Main (for example local Studio content). */
export interface PlayerBodyOption {
  value: string;
  label: string;
  /** Real thumbnail URL for the gallery. */
  preview: string;
  /** Gallery heading, for example the game it came from. */
  group: string;
  description?: string;
}
export const PICARDIA_PLAYER = 'pmodels:hl:picardia_v1sc';
/** Mode, Player model and Player map only; Robot prefs stay in ume-prefs / ume-appearance. */
const PLAYER_PREFS = 'ume-player';
const DEFAULT_MODE: SceneMode = 'robot';
const robots = ['r1', 'r1_air', 'r1_air_edu', 'g1', 'g1_air', 'go2'];
export const TERRAIN_LABELS: Readonly<Record<string, string>> = { flat: 'Flat ground', rough: 'Rough ground', slope: 'Slope', stairs: 'Stairs', park: 'Park' };
const labels = TERRAIN_LABELS;
/** Catalogue label of a game map, as the launch gallery shows it. */
export const mapEntryLabel = (map: MapEntry) => `${map.name} · ${map.game}`;
const characters = KIT_LABELS;
const stored = (key: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};
function rememberedCharacter(appearance: unknown): CharacterId | null {
  if (!appearance || typeof appearance !== 'object') return 'stock';
  const a = appearance as { sourceBody?: string; modules?: Record<string, string>; parts?: Record<string, unknown> };
  if (isBodyVisual(a.sourceBody) && a.sourceBody !== 'stock') return a.sourceBody;
  const styles = KIT_REGIONS.map(region => a.modules?.[region] ?? 'stock');
  return styles.every(style => style === styles[0]) && Object.hasOwn(characters, styles[0]) ? styles[0] as CharacterId : null;
}

const transferStates: Record<TransferUpdate['state'], string> = { loading: 'Active', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

class LaunchController {
  readonly selection: LaunchSelection;
  private root!: HTMLElement;
  private status!: HTMLElement;
  /** Latest detailed step or failure cause; the primary status shows only its short label. */
  private phaseMessage = '';
  private context!: HTMLElement;
  private enter!: HTMLButtonElement;
  private pong?: Pong;
  private showing = true;
  private loading = false;
  private failed: { recover: (() => Promise<void>) | undefined } | null = null;
  private simulation = false;
  private visuals = false;
  private frame = false;
  private callbacks: Array<() => void> = [];
  private failureCallbacks: Array<() => void> = [];
  private maps: MapEntry[] = [];
  private shared = sharedView();
  private initialAppearance: unknown;
  private heldKeys = new Set<string>();
  private keptAppearanceLabel = 'Original';
  private mapPicker!: VisualPicker;
  private robotPicker!: VisualPicker;
  private characterPicker?: VisualPicker;
  private playerPicker?: VisualPicker;
  private playerBodies: readonly PlayerBodyOption[] = [];
  /** A remembered non-Source model, restored only once Main lists it again. */
  private pendingPlayerBody: string | null = null;
  private playerBodyChosen = false;
  private modeChosen = false;
  private linkedRobot: boolean;
  /** Last Player map written to ume-player; Robot's map lives only in ume-prefs. */
  private savedPlayerTerrain?: TerrainName;
  private addGameContent?: () => void;
  private progress = new SceneProgress();
  private loadGeneration = 0;
  private preloadedLocalMap?: PriorModuleIntake;
  private localMapVerification = false;
  private progressTimer?: number;
  private stopTransfers?: () => void;
  private transferRoot!: HTMLElement;
  private meter!: HTMLProgressElement;
  private bytes!: HTMLElement;
  private eta!: HTMLElement;
  private details!: HTMLDetailsElement;
  private detailStatus!: HTMLElement;
  private mapStatus!: HTMLElement;
  private localStatus!: HTMLElement;
  /** Map visual and local-file diagnostics; written to Details only while it is open. */
  private mapMessage = '';
  private localMessage = '';
  private detailReadiness!: HTMLElement;
  private detailBytes!: HTMLElement;
  private detailCounts!: HTMLElement;
  private detailTransfers!: HTMLElement;
  private detailsDirty = true;
  private detailRows = new Map<string, { row: HTMLElement; state: HTMLElement; bytes: HTMLElement }>();
  private loadingStarted = 0;
  private gameTimer?: number;
  private morphTimer?: number;
  private gameStage!: HTMLElement;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  constructor() {
    const prefs = stored('ume-prefs'), body = new URLSearchParams(location.search).get('body');
    const query = new URLSearchParams(location.search).get('map');
    // A shared view or ?body= link is an explicit Robot workflow; it never opens in Player mode.
    this.linkedRobot = !!this.shared || isBodyVisual(body);
    const { mode: savedMode, body: savedBody, terrain: savedTerrain } = stored(PLAYER_PREFS);
    const mode: SceneMode = this.linkedRobot ? 'robot' : savedMode === 'player' || savedMode === 'robot' ? savedMode : DEFAULT_MODE;
    // Each mode reopens the last map it ran live; Player never reads or writes Robot's ume-prefs map.
    const rememberedTerrain = mode === 'player' ? savedTerrain : prefs.terrain;
    const terrain = this.shared?.terrain ?? (query && isTerrain(`map:${query}`) ? `map:${query}` as TerrainName : undefined)
      ?? (isTerrain(rememberedTerrain) && !rememberedTerrain.startsWith('map:local-') ? rememberedTerrain : 'map:nt_ghost_ctg');
    const rememberedRobot = typeof prefs.robot === 'string' && robots.includes(prefs.robot) ? prefs.robot : 'r1';
    const robot = this.shared?.robot ?? (isBodyVisual(body) && !compatibleBody(body, rememberedRobot) ? characterPhysics(body)! : rememberedRobot);
    const rememberedBody = typeof savedBody === 'string' ? savedBody : null;
    const playerBody = rememberedBody && decodePmodelId(rememberedBody) ? rememberedBody : PICARDIA_PLAYER;
    if (rememberedBody && rememberedBody !== playerBody) this.pendingPlayerBody = rememberedBody;
    this.selection = { terrain, mode, robot, character: null, playerBody, preserveView: !!this.shared, robotChanged: false };
    this.initialAppearance = this.shared?.appearance ?? stored('ume-appearance')[robot];
    if (!this.shared?.appearance && isBodyVisual(body) && compatibleBody(body, robot)) {
      this.initialAppearance = { ...(this.initialAppearance && typeof this.initialAppearance === 'object' ? this.initialAppearance : {}), sourceBody: body };
    }
    // A key used in Pong or a launch control cannot become robot input just because entry
    // happened between its keydown and keyup (including a held key's auto-repeat).
    window.addEventListener('keydown', event => { if (this.showing) this.heldKeys.add(event.code); }, true);
    window.addEventListener('keyup', event => this.heldKeys.delete(event.code), true);
    window.addEventListener('blur', () => this.heldKeys.clear());
  }

  get active() { return this.showing; }
  get loadingId() { return this.loadGeneration; }
  get priorLocalMapIntake() { return this.preloadedLocalMap; }
  get usesLocalMapVerification() { return this.localMapVerification; }
  /** Capture the load that owns this worker, never a later scene generation. */
  beginLocalMapVerification(): BundleVerificationObserver {
    this.localMapVerification = true;
    const generation = this.loadGeneration;
    return {
      root: url => {
        if (!this.loading || !this.showing || generation !== this.loadGeneration) return;
        this.progress.ownWorkerRoot(generation, url, performance.now());
        this.detailsDirty = true;
      },
      transfers: updates => this.receiveTransfers(generation, updates),
    };
  }
  onEnter(callback: () => void) { this.callbacks.push(callback); }
  onFailure(callback: () => void) { this.failureCallbacks.push(callback); }
  ownsKey(code: string) { return this.heldKeys.has(code); }
  /** Main lists only Player models it has verified locally; the boot shell parses nothing. */
  setPlayerBodies(options: readonly PlayerBodyOption[]) {
    this.playerBodies = options;
    const pending = this.pendingPlayerBody;
    if (pending && !this.playerBodyChosen && options.some(option => option.value === pending)) {
      this.selection.playerBody = pending; this.pendingPlayerBody = null;
    }
    if (this.root && this.showing) this.renderPlayerBodies();
  }
  /** Shows Add game content; the callback runs inside the trusted click. */
  onAddGameContent(callback: () => void) {
    this.addGameContent = callback;
    if (this.root) this.root.querySelector<HTMLButtonElement>('#launch-add-content')!.hidden = false;
  }

  mount(load: () => Promise<unknown>) {
    this.root = document.createElement('section'); this.root.id = 'launch-screen';
    this.root.setAttribute('aria-label', 'Choose your scene');
    this.root.innerHTML = `<div class="launch-shell">
      <header><h1>m0clip</h1></header>
      <div class="launch-choices">
        <section id="launch-map-step" aria-labelledby="launch-map-title"><h2 id="launch-map-title">Pick a map</h2>
          <label for="launch-map-trigger">Map</label><select id="launch-map"></select>
          <p id="launch-catalog-status" role="status">Loading maps…</p><button id="launch-catalog-retry" class="btn" type="button" hidden>Retry map catalog</button>
          <div class="launch-actions"><button id="launch-next" class="btn primary" type="button">Choose character</button></div>
        </section>
        <section id="launch-character-step" aria-labelledby="launch-character-title" hidden><h2 id="launch-character-title">Pick a character</h2>
          <div id="launch-mode" class="seg launch-mode" role="radiogroup" aria-label="Play as">
            <button id="launch-mode-robot" type="button" role="radio" data-mode="robot">Robot</button><button id="launch-mode-player" type="button" role="radio" data-mode="player">Player</button>
          </div>
          <div id="launch-robot-choices">
            <label for="launch-character-trigger">Character</label><select id="launch-character"></select>
            <p id="launch-appearance-note"></p><label for="launch-robot-trigger">Robot physics</label><select id="launch-robot"></select>
          </div>
          <div id="launch-player-choices">
            <label for="launch-player-body-trigger">Player model</label><select id="launch-player-body"></select>
            <button id="launch-add-content" class="btn launch-add-content" type="button" hidden>Add game content…</button>
          </div>
          <div class="launch-actions"><button id="launch-back" class="btn" type="button">Back</button><button id="launch-load" class="btn primary" type="button">Load scene</button></div>
        </section>
        <section id="launch-loading-step" aria-labelledby="launch-loading-title" hidden><h2 id="launch-loading-title">Loading</h2>
          <p id="launch-context"></p>
          <div id="launch-transfer" class="launch-transfer" title="Selected scene asset payload. The maximum is fixed before scene downloads; browser caching can reduce network traffic.">
            <div class="launch-transfer-heading"><span id="launch-bytes">0.0 MB received</span><span id="launch-eta"></span></div>
            <div id="launch-load-stage" class="launch-load-stage" data-game="waiting">
              <progress id="launch-progress" max="1" aria-label="Scene assets" aria-describedby="launch-bytes launch-eta"></progress>
              <div class="launch-morph" aria-hidden="true"><i class="morph-left"></i><i class="morph-middle"></i><i class="morph-right"></i><i class="morph-ball"></i></div>
              <div id="launch-pong-controls" hidden>
                <canvas id="launch-pong" tabindex="0" role="application" aria-label="Pong" aria-describedby="launch-pong-help" title="Move: ↑ ↓ / W S, mouse or touch. Space / P pauses."></canvas>
              </div>
            </div>
          </div>
          <p id="launch-status" role="status" aria-live="polite"></p>
          <details id="launch-details" class="launch-details" hidden>
            <summary>Details</summary>
            <div class="launch-detail-content">
              <p id="launch-detail-status"></p>
              <p id="launch-map-progress"></p>
              <p id="launch-local-progress"></p>
              <p id="launch-detail-readiness"></p>
              <p id="launch-detail-bytes"></p>
              <p id="launch-detail-counts"></p>
              <ul id="launch-detail-transfers" aria-label="Asset transfers"></ul>
            </div>
          </details>
          <p id="launch-pong-help" class="launch-game-help">Arrow up/down or W/S move while the court is focused. Mouse or touch moves the paddle. Space or P pauses. Leaving the court pauses play.</p>
          <div class="launch-actions"><div id="launch-pong-actions" hidden><button id="launch-pong-pause" class="btn" type="button" aria-pressed="false">Play Pong</button></div>
            <button id="launch-enter" class="btn primary" type="button" disabled>Enter scene</button>
            <button id="launch-original" class="btn" type="button" hidden>Use Original robot</button>
            <button id="launch-reload" class="btn" type="button" hidden>Reload</button>
            <button id="launch-cancel-map" class="btn" type="button" hidden>Cancel map</button>
          </div>
        </section>
      </div>
    </div>`;
    document.body.append(this.root);
    this.status = this.root.querySelector('#launch-status')!; this.context = this.root.querySelector('#launch-context')!;
    this.enter = this.root.querySelector('#launch-enter')!;
    this.transferRoot = this.root.querySelector('#launch-transfer')!;
    this.meter = this.root.querySelector('#launch-progress')!;
    this.bytes = this.root.querySelector('#launch-bytes')!;
    this.eta = this.root.querySelector('#launch-eta')!;
    this.gameStage = this.root.querySelector('#launch-load-stage')!;
    this.details = this.root.querySelector('#launch-details')!;
    this.detailStatus = this.root.querySelector('#launch-detail-status')!;
    this.mapStatus = this.root.querySelector('#launch-map-progress')!;
    this.localStatus = this.root.querySelector('#launch-local-progress')!;
    this.detailReadiness = this.root.querySelector('#launch-detail-readiness')!;
    this.detailBytes = this.root.querySelector('#launch-detail-bytes')!;
    this.detailCounts = this.root.querySelector('#launch-detail-counts')!;
    this.detailTransfers = this.root.querySelector('#launch-detail-transfers')!;
    this.details.addEventListener('toggle', () => {
      if (this.details.open) { this.detailsDirty = true; this.renderProgress(); }
    });
    this.reducedMotion.addEventListener('change', () => {
      if (this.reducedMotion.matches && this.gameStage.dataset.game === 'morph') this.revealPong();
    });
    const map = this.root.querySelector<HTMLSelectElement>('#launch-map')!;
    map.onchange = () => { this.selection.terrain = map.value as TerrainName; this.selection.preserveView = false; };
    this.mapPicker = new VisualPicker(map,{id:'launch-map',label:'Map',
      intake:{label:'Open map bundle…',select:async(file,signal)=>{const index=await inspectLocalMap(file,signal);signal.throwIfAborted();this.selection.localFile=file;this.selection.localIndex=index;this.selection.terrain='map:local-pending';this.selection.preserveView=false;this.renderMaps();}},
      preview:(value,label)=>{if(value.startsWith('map:local-')){const note=document.createElement('span');note.textContent=label;return note;}return previewImage(value.startsWith('map:')?'map':'terrain',value);}});
    const robot = this.root.querySelector<HTMLSelectElement>('#launch-robot')!;
    for (const value of robots) robot.add(new Option(value.replace(/_/g,' ').toUpperCase(),value));
    if (!robots.includes(this.selection.robot)) robot.add(new Option(`${this.selection.robot.replace(/_/g, ' ').toUpperCase()} (remembered variant)`, this.selection.robot));
    robot.value = this.selection.robot;
    staticPreviewOptions(robot,'robot');
    robot.onchange = () => {
      this.selection.robot = robot.value; this.selection.robotChanged = true; this.selection.preserveView = false;
      this.initialAppearance = stored('ume-appearance')[robot.value];
      if(this.selection.character && isBodyVisual(this.selection.character) && !compatibleBody(this.selection.character,robot.value))this.selection.character=null;
      this.renderCharacters();
    };
    this.robotPicker = new VisualPicker(robot,{id:'launch-robot',label:'Robot physics',preview:value=>previewImage('robot',value)});
    this.renderCharacters(); this.renderMaps(); this.renderPlayerBodies();
    const addContent = this.root.querySelector<HTMLButtonElement>('#launch-add-content')!;
    addContent.hidden = !this.addGameContent;
    addContent.onclick = () => this.addGameContent?.();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('#launch-mode [role="radio"]')) {
      const mode = button.dataset.mode as SceneMode, other: SceneMode = mode === 'robot' ? 'player' : 'robot';
      button.onclick = () => this.chooseMode(mode);
      // Two radios: every arrow key moves to the other choice and selects it.
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); this.chooseMode(other);
        this.root.querySelector<HTMLButtonElement>(`#launch-mode-${other}`)!.focus();
      };
    }
    this.renderMode();
    const step = (name: string) => { for (const id of ['map', 'character', 'loading']) this.root.querySelector<HTMLElement>(`#launch-${id}-step`)!.hidden = id !== name; };
    this.root.querySelector<HTMLButtonElement>('#launch-next')!.onclick = () => {
      step('character'); (this.selection.mode === 'player' ? this.playerPicker : this.characterPicker)!.button.focus();
    };
    this.root.querySelector<HTMLButtonElement>('#launch-back')!.onclick = () => { step('map'); this.mapPicker.button.focus(); };
    this.root.querySelector<HTMLButtonElement>('#launch-load')!.onclick = async () => {
      if (this.loading) return;
      this.rememberMode();
      this.loading = true; this.root.dataset.loading = 'true'; step('loading'); this.context.textContent = this.describe();
      this.context.title = this.context.textContent;
      this.startProgress();
      this.status.tabIndex = -1; this.status.focus({ preventScroll: true });
      if(this.selection.terrain==='map:local-pending'&&this.selection.localFile){
        const controller=new AbortController(),cancel=this.root.querySelector<HTMLButtonElement>('#launch-cancel-map')!;
        cancel.hidden=false;cancel.onclick=()=>controller.abort();
        this.phase('Verifying local map files…');
        try{
          const source=await loadLocalMap(this.selection.localFile,controller.signal,this.beginLocalMapVerification());
          controller.signal.throwIfAborted();
          this.selection.localSource=source;this.selection.terrain=`map:${source.id}`;this.selection.localFile=undefined;
          const bytes=Array.from(source.payload!.files.values()).reduce((sum,file)=>sum+file.size,0);
          this.localWork(`Local files verified · ${(bytes/1_000_000).toFixed(1)} MB · separate from downloads`);
        }catch(error){
          this.loading=false;delete this.root.dataset.loading;this.cancelPong();
          this.stopTransfers?.();this.stopTransfers=undefined;window.clearInterval(this.progressTimer);this.progressTimer=undefined;
          step('map');
          this.root.querySelector('#launch-catalog-status')!.textContent=controller.signal.aborted?'Map loading cancelled.':`Map not loaded: ${error instanceof Error?error.message:error}`;
          this.mapPicker.button.focus();return;
        }finally{cancel.hidden=true;cancel.onclick=null;}
      }
      this.phase('Starting renderer and physics…');
      try{await load();}catch(error){this.fail(error);}
    };
    this.enter.onclick = () => {
      if (this.failed || !this.simulation || !this.visuals || !this.frame) return;
      this.showing = false; this.cancelPong(); this.root.hidden = true;
      this.details.open = false; this.details.hidden = true;
      this.stopTransfers?.(); this.stopTransfers = undefined;
      window.clearInterval(this.progressTimer); this.progressTimer = undefined;
      this.mapPicker.dispose(); this.robotPicker.dispose(); this.characterPicker?.dispose(); this.playerPicker?.dispose();
      document.getElementById('app')!.inert = false;
      for (const callback of this.callbacks) callback();
      document.querySelector<HTMLCanvasElement>('#viewport canvas')?.focus({ preventScroll: true });
    };
    this.root.querySelector<HTMLButtonElement>('#launch-reload')!.onclick = () => location.reload();
    this.root.querySelector<HTMLButtonElement>('#launch-catalog-retry')!.onclick = () => { void this.loadCatalog(); };
    void this.loadCatalog();
  }

  private describe() {
    const terrain = this.selection.terrain;
    const map = terrain.startsWith('map:local-') && this.selection.localIndex ? this.selection.localIndex.name
      : terrain.startsWith('map:') ? this.maps.find(entry => `map:${entry.id}` === terrain)?.name ?? terrain.slice(4) : labels[terrain];
    if (this.selection.mode === 'player') {
      const body = this.root.querySelector<HTMLSelectElement>('#launch-player-body')!.selectedOptions[0]?.label ?? this.selection.playerBody;
      return `${map} · Player · ${body}`;
    }
    return `${map} · ${this.selection.robot.toUpperCase()} · ${this.selection.character ? CHARACTER_CHOICES.find(choice=>choice.id===this.selection.character)?.label ?? decodePmodelId(this.selection.character)?.name ?? this.selection.character : this.keptAppearanceLabel}`;
  }

  private chooseMode(mode: SceneMode) {
    this.modeChosen = true;
    if (mode === this.selection.mode) return;
    this.selection.mode = mode; this.renderMode();
  }

  private renderMode() {
    const mode = this.selection.mode;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('#launch-mode [role="radio"]')) {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active); button.setAttribute('aria-checked', String(active)); button.tabIndex = active ? 0 : -1;
    }
    this.root.querySelector<HTMLElement>('#launch-robot-choices')!.hidden = mode !== 'robot';
    this.root.querySelector<HTMLElement>('#launch-player-choices')!.hidden = mode !== 'player';
  }

  /** Player models with a real gallery thumbnail; Robot-only retarget characters are not listed. */
  private renderPlayerBodies() {
    const select = this.root.querySelector<HTMLSelectElement>('#launch-player-body')!;
    const groups = new Map<string, HTMLOptGroupElement>();
    const add = (group: string, value: string, label: string, preview: string, title = '') => {
      let parent = groups.get(group);
      if (!parent) { parent = document.createElement('optgroup'); parent.label = group; groups.set(group, parent); select.append(parent); }
      const option = new Option(label, value); option.dataset.preview = preview; option.title = title; parent.append(option);
    };
    select.replaceChildren();
    add('Half-Life', PICARDIA_PLAYER, 'Picardia', pmodelRecord(decodePmodelId(PICARDIA_PLAYER)!).thumbnail);
    for (const body of this.playerBodies) if (body.value !== PICARDIA_PLAYER) add(body.group, body.value, body.label, body.preview, body.description);
    if (!Array.from(select.options).some(option => option.value === this.selection.playerBody)) {
      const remote = decodePmodelId(this.selection.playerBody);
      if (remote) add(remote.game === 'hl' ? 'Half-Life' : 'Sven Co-op', this.selection.playerBody, remote.name, pmodelRecord(remote).thumbnail);
      else {
        // Main no longer lists this local model; keep it remembered for a later listing.
        this.pendingPlayerBody = this.selection.playerBody; this.selection.playerBody = PICARDIA_PLAYER;
      }
    }
    select.value = this.selection.playerBody;
    if (this.playerPicker) { this.playerPicker.sync(true); return; }
    select.onchange = () => {
      this.selection.playerBody = select.value; this.playerBodyChosen = true; this.pendingPlayerBody = null;
      this.renderPlayerBodies();
    };
    const goldsrc = sourceModelCatalog(true);
    this.playerPicker = new VisualPicker(select, { id: 'launch-player-body', label: 'Player model', title: 'Choose a Player model',
      preview: value => {
        const still = Array.from(select.options).find(option => option.value === value)?.dataset.preview;
        if (!still) throw new Error('Preview unavailable');
        return previewMedia({ still });
      },
      catalog: { label: goldsrc.label, load: async (query, offset, signal) => {
        const page = await goldsrc.load(query, offset, signal);
        for (const option of page.options) option.description = 'GoldSrc player model';
        return page;
      } } });
  }

  /** Robot prefs are untouched; a linked Robot view keeps the remembered mode unless the user switched. */
  private rememberMode() {
    const prefs = stored(PLAYER_PREFS);
    const mode = this.linkedRobot && !this.modeChosen ? prefs.mode : this.selection.mode;
    const body = this.pendingPlayerBody ?? this.selection.playerBody;
    try { localStorage.setItem(PLAYER_PREFS, JSON.stringify({ ...prefs, mode, body })); } catch { /* This load still uses the choice. */ }
  }

  /** Player's counterpart of Robot's live ume-prefs map: Main passes the Player map once it runs. */
  rememberPlayerTerrain(terrain: TerrainName) {
    if (terrain === this.savedPlayerTerrain) return;
    this.savedPlayerTerrain = terrain;
    try { localStorage.setItem(PLAYER_PREFS, JSON.stringify({ ...stored(PLAYER_PREFS), terrain })); } catch { /* This session still runs the map. */ }
  }

  private async loadCatalog() {
    const status = this.root.querySelector<HTMLElement>('#launch-catalog-status')!;
    const retry = this.root.querySelector<HTMLButtonElement>('#launch-catalog-retry')!;
    retry.hidden = true; status.textContent = 'Loading maps…';
    try {
      const response = await fetch('/assets/maps/index.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { maps: MapEntry[] };
      if (!Array.isArray(data.maps)) throw new Error('Invalid map catalog');
      this.maps = data.maps.filter(map => typeof map.id === 'string' && isTerrain(`map:${map.id}`) && typeof map.name === 'string' && typeof map.game === 'string');
      this.renderMaps(); status.textContent = '';
    } catch (error) {
      status.textContent = `Map catalog unavailable (${error instanceof Error ? error.message : error}). Built-in terrains and your selected map are still available.`;
      retry.hidden = false;
    }
  }

  private renderMaps() {
    const select = this.root.querySelector<HTMLSelectElement>('#launch-map')!;
    const groups = new Map<string,HTMLOptGroupElement>();
    select.replaceChildren();
    const options = [
      ...this.maps.map(map => ({ value: `map:${map.id}`, label: mapEntryLabel(map), group:map.game })),
      ...(this.selection.localIndex?[{value:'map:local-pending',label:`${this.selection.localIndex.name} · Local file`,group:'Local maps'}]:[]),
      ...TERRAINS.map(terrain => ({ value: terrain, label: labels[terrain], group:'Built-in terrains' })),
    ];
    if (!options.some(option => option.value === this.selection.terrain)) options.unshift({ value: this.selection.terrain, label: `${this.selection.terrain.slice(4)} (selected map)`, group:'Selected map' });
    for (const option of options) {
      let group=groups.get(option.group);
      if(!group){group=document.createElement('optgroup');group.label=option.group;groups.set(option.group,group);select.append(group);}
      group.append(new Option(option.label,option.value));
    }
    select.value = this.selection.terrain;
    staticPreviewOptions(select,'terrain');
    this.mapPicker?.sync(true);
  }

  private renderCharacters() {
    const prior=this.root.querySelector<HTMLSelectElement>('#launch-character')!;
    const select=document.createElement('select');select.id='launch-character';
    if(this.characterPicker){this.characterPicker.root.before(select);this.characterPicker.dispose();}else prior.replaceWith(select);
    const selected = this.selection.character ?? rememberedCharacter(this.initialAppearance);
    characterOptions(select,selected??'custom',this.selection.robot);
    select.onchange=()=>{
      if(!isCharacter(select.value))return;
      this.selection.character=select.value;
      if(isBodyVisual(select.value)&&!compatibleBody(select.value,this.selection.robot)){
        const physics=characterPhysics(select.value)!;
        this.selection.robot=physics;this.selection.robotChanged=true;this.selection.preserveView=false;
        this.initialAppearance=stored('ume-appearance')[physics];
        this.root.querySelector<HTMLSelectElement>('#launch-robot')!.value=physics;this.robotPicker.sync();
      }
      this.renderCharacters();
    };
    this.characterPicker=new VisualPicker(select,{id:'launch-character',label:'Character',
      preview:value=>{
        if(value!=='custom')return previewImage('character',value,this.selection.robot);
        const note=document.createElement('span');note.textContent='Current mix · view after loading';return note;
      },
      description:characterDescription,catalog:sourceModelCatalog(true)});
    const body = this.initialAppearance && typeof this.initialAppearance === 'object' && 'sourceBody' in this.initialAppearance ? this.initialAppearance.sourceBody : undefined;
    const kept = rememberedCharacter(this.initialAppearance);
    this.keptAppearanceLabel = kept ? CHARACTER_CHOICES.find(choice=>choice.id===kept)?.label ?? decodePmodelId(kept)?.name ?? kept : 'Custom appearance';
    const keptHead = (this.selection.preserveView ? this.shared?.sourceHead : undefined) ?? stored('ume-head-visuals')[this.selection.robot];
    if ((!body || body==='stock') && this.selection.robot.startsWith('r1') && keptHead === 'ghost') this.keptAppearanceLabel += ' + Ghost head';
    this.root.querySelector<HTMLElement>('#launch-appearance-note')!.textContent = this.selection.character ? '' : `Current: ${this.keptAppearanceLabel}`;
  }

  private startProgress() {
    const started = performance.now(), intake = localMapIntakeState();
    // Copy before Load's verification; later imports cannot rewrite this scope.
    this.preloadedLocalMap = intake && { complete: intake.complete, before: started };
    this.localMapVerification = false;
    for (const option of this.root.querySelectorAll<HTMLOptionElement>('option[data-preview]')) {
      if (option.dataset.preview) registerPreviewAsset(option.dataset.preview);
    }
    this.stopTransfers?.();
    window.clearInterval(this.progressTimer);
    this.details.open = false; this.details.hidden = false;
    this.detailRows.clear(); this.detailTransfers.replaceChildren();
    this.phaseMessage = this.mapMessage = this.localMessage = '';
    this.detailStatus.textContent = ''; this.detailReadiness.textContent = '';
    this.detailBytes.textContent = ''; this.detailCounts.textContent = '';
    this.mapStatus.textContent = ''; this.localStatus.textContent = '';
    this.detailsDirty = true;
    this.loadGeneration = this.progress.begin(started);
    this.loadingStarted = started;
    this.schedulePong();
    const generation = this.loadGeneration;
    this.stopTransfers = observeTransfers(`page:${generation}`, updates => this.receiveTransfers(generation, updates), started);
    this.progressTimer = window.setInterval(() => this.renderProgress(), 250);
  }

  receiveTransfers(generation: number, updates: TransferUpdate[]) {
    if (!this.loading || !this.showing || generation !== this.loadGeneration) return;
    this.progress.update(generation, updates, performance.now());
    this.detailsDirty = true;
    if (this.progress.hasCatalogueMismatch) this.fail('Scene asset payload differs from this release’s catalogue. Reload to load a matching build.');
  }

  freezeAssets(generation: number, assets: readonly PlannedAsset[], prepared: readonly PlannedAsset[]) {
    if (!this.loading || !this.showing || generation !== this.loadGeneration) return;
    const now = performance.now();
    this.progress.prepared(generation, prepared, now);
    this.progress.freeze(generation, assets, now);
    if (this.progress.hasCatalogueMismatch) throw new Error('Scene asset payload differs from this release’s catalogue. Reload to load a matching build.');
    this.detailsDirty = true;
    this.renderProgress();
  }

  private renderProgress() {
    if (!this.loading || !this.showing) return;
    const snapshot = this.progress.snapshot(performance.now());
    const ready = !this.failed && this.simulation && this.visuals && this.frame;
    const loaded = (snapshot.loaded / 1_000_000).toFixed(1);
    const known = (snapshot.knownTotal / 1_000_000).toFixed(1);
    const left = (snapshot.remaining / 1_000_000).toFixed(1);
    const bytes = snapshot.frozen ? `${left} MB LEFT · ${loaded} / ${known} MB` : `${loaded} MB received`;
    if (this.bytes.textContent !== bytes) { this.bytes.textContent = bytes; this.bytes.title = bytes; }
    this.transferRoot.dataset.state = ready ? 'ready' : this.failed ? 'error' : snapshot.active ? 'loading' : 'preparing';
    if (snapshot.frozen) {
      this.meter.max = Math.max(1, snapshot.knownTotal);
      this.meter.value = snapshot.knownTotal === 0 ? 1 : snapshot.loaded;
    } else this.meter.removeAttribute('value');
    this.meter.setAttribute('aria-valuetext', this.failed ? 'Loading interrupted' : ready ? 'Scene ready' : bytes);

    const eta = this.failed || ready ? '' : downloadEstimate(snapshot);
    if (this.eta.textContent !== eta) this.eta.textContent = eta;
    this.renderDetails(snapshot);
  }

  private renderDetails(snapshot: LoadingSnapshot) {
    // No resource iteration, URL parsing or detail DOM updates while collapsed.
    if (!this.details.open || !this.detailsDirty) return;
    this.detailsDirty = false;
    const message = detailText(this.phaseMessage);
    if (this.detailStatus.textContent !== message) this.detailStatus.textContent = message;
    if (this.mapStatus.textContent !== this.mapMessage) this.mapStatus.textContent = this.mapMessage;
    if (this.localStatus.textContent !== this.localMessage) this.localStatus.textContent = this.localMessage;
    const readiness = `Simulation: ${this.simulation ? 'ready' : 'pending'} · Visuals: ${this.visuals ? 'ready' : 'pending'} · First frame: ${this.frame ? 'ready' : 'pending'}`;
    if (this.detailReadiness.textContent !== readiness) this.detailReadiness.textContent = readiness;
    // Fixed plan only: downloading + queued + stopped is exactly the main row's remaining payload.
    const split = snapshot.frozen ? ` · ${snapshot.activeBytes} B downloading · ${snapshot.queuedBytes} B queued${snapshot.stoppedBytes ? ` · ${snapshot.stoppedBytes} B stopped` : ''}` : '';
    const bytes = `${snapshot.loaded} B received · ${snapshot.knownTotal} B ${snapshot.frozen ? 'fixed maximum' : 'discovered'}${split}${snapshot.unknown ? ` · ${snapshot.unknown} sizes pending` : ''}${snapshot.unexpected ? ` · ${snapshot.unexpected} catalogue mismatches` : ''}`;
    if (this.detailBytes.textContent !== bytes) this.detailBytes.textContent = bytes;
    const counts = { loading: 0, done: 0, failed: 0, cancelled: 0 };
    for (const transfer of this.progress.transfers()) {
      counts[transfer.state]++;
      let elements = this.detailRows.get(transfer.id);
      if (!elements) {
        const row = document.createElement('li');
        const name = document.createElement('span'); name.className = 'launch-detail-name';
        name.textContent = assetName(transfer.url); name.title = name.textContent;
        const state = document.createElement('span');
        const bytes = document.createElement('span'); bytes.className = 'launch-detail-size';
        row.append(name, state, bytes); this.detailTransfers.append(row);
        elements = { row, state, bytes }; this.detailRows.set(transfer.id, elements);
      }
      if (elements.row.dataset.state !== transfer.state) elements.row.dataset.state = transfer.state;
      const state = transfer.status === undefined ? transferStates[transfer.state] : `${transferStates[transfer.state]} · HTTP ${transfer.status}`;
      if (elements.state.textContent !== state) elements.state.textContent = state;
      const amount = `${transfer.loaded} B received${transfer.total === null ? ' · response size unadvertised' : ` / ${transfer.total} B known`}`;
      if (elements.bytes.textContent !== amount) elements.bytes.textContent = amount;
    }
    const summary = `${counts.loading} active · ${counts.done} completed · ${counts.failed} failed · ${counts.cancelled} cancelled`;
    if (this.detailCounts.textContent !== summary) this.detailCounts.textContent = summary;
  }

  private schedulePong() {
    window.clearTimeout(this.gameTimer);
    if (!this.loading || !this.showing || this.failed || (this.simulation && this.visuals && this.frame)) return;
    // The easter egg belongs to an unfinished load, never time spent choosing a scene.
    this.gameTimer = window.setTimeout(() => {
      this.gameTimer = undefined;
      if (!this.showing || this.failed || (this.simulation && this.visuals && this.frame)) return;
      if (this.reducedMotion.matches) this.revealPong();
      else {
        this.gameStage.dataset.game = 'morph';
        this.morphTimer = window.setTimeout(() => this.revealPong(), 1100);
      }
    }, Math.max(0, 30001 - (performance.now() - this.loadingStarted)));
  }

  private revealPong() {
    window.clearTimeout(this.morphTimer); this.morphTimer = undefined;
    if (!this.showing || this.failed || (this.simulation && this.visuals && this.frame)) return;
    this.gameStage.dataset.game = 'pong';
    this.root.querySelector<HTMLElement>('#launch-pong-controls')!.hidden = false;
    this.root.querySelector<HTMLElement>('#launch-pong-actions')!.hidden = false;
    this.pong = new Pong(this.root.querySelector('#launch-pong')!, this.root.querySelector('#launch-pong-pause')!, !this.reducedMotion.matches);
  }

  private cancelPong() {
    window.clearTimeout(this.gameTimer); this.gameTimer = undefined;
    window.clearTimeout(this.morphTimer); this.morphTimer = undefined;
    const focused = document.activeElement?.id;
    this.pong?.stop();
    this.gameStage.dataset.game = 'waiting';
    this.root.querySelector<HTMLElement>('#launch-pong-controls')!.hidden = true;
    this.root.querySelector<HTMLElement>('#launch-pong-actions')!.hidden = true;
    if (this.showing && (focused === 'launch-pong' || focused === 'launch-pong-pause')) {
      (this.enter.disabled ? this.status : this.enter).focus({ preventScroll: true });
    }
  }

  phase(message: string) {
    if (!this.showing || this.failed || !this.status) return;
    this.simulation = false; this.visuals = false; this.frame = false;
    this.enter.disabled = true; this.phaseMessage = message;
    const label = loadingPhase(message);
    // One short label: repeated detailed steps of the same phase do not re-announce.
    if (this.status.textContent !== label) this.status.textContent = label;
    this.detailsDirty = true;
    this.renderProgress();
  }
  localWork(message: string) {
    this.localMessage = message;
    this.detailsDirty = true;
  }
  mapProgress(message: string) {
    if (!this.showing || this.failed) return;
    this.mapMessage = message;
    this.detailsDirty = true;
  }
  fail(error: unknown, recover?: () => Promise<void>) {
    // Keep the first primary error; only a primary failure can replace a cosmetic one.
    if (!this.showing || !this.status || (this.failed && (!this.failed.recover || recover))) return;
    const failure = this.failed = { recover };
    this.enter.disabled = true;
    this.cancelPong();
    if (!recover) {
      this.stopTransfers?.(); this.stopTransfers = undefined;
      for (const callback of this.failureCallbacks) callback();
    }
    // The primary line says what to do; the actual cause stays in Details. Write it once
    // now, even collapsed, so it is present the moment Details opens.
    const fallback = this.selection.mode === 'player' ? 'Picardia' : 'Original robot';
    // An HTTP error on a selected asset is the actual cause; a loader's later symptom
    // (an invalid WebAssembly body, a missing model) follows it.
    const http = this.progress.httpFailures().map(({ url, status }) => `${assetName(url)} returned HTTP ${status}.`).join(' ');
    const cause = error instanceof Error ? error.message : String(error);
    this.phaseMessage = http ? `${http} ${cause}` : cause;
    this.detailStatus.textContent = detailText(this.phaseMessage);
    this.status.textContent = recover ? `Scene didn’t load. Use ${fallback} or Reload.` : 'Scene didn’t load. Reload to try again.';
    this.status.dataset.kind = 'error';
    this.detailsDirty = true;
    this.root.querySelector<HTMLButtonElement>('#launch-reload')!.hidden = false;
    const original = this.root.querySelector<HTMLButtonElement>('#launch-original')!;
    original.hidden = !recover; original.disabled = false; original.textContent = `Use ${fallback}`;
    this.renderProgress();
    original.onclick = recover ? async () => {
      if (this.failed !== failure) return;
      original.disabled = true;
      this.status.textContent = `Loading ${fallback}…`;
      this.detailsDirty = true; this.renderProgress();
      try {
        await recover();
        if (this.failed !== failure) return;
        this.failed = null;
        delete this.status.dataset.kind;
        this.context.textContent = this.describe();
        this.context.title = this.context.textContent;
        this.root.querySelector<HTMLButtonElement>('#launch-reload')!.hidden = true;
        original.hidden = true; original.onclick = null;
        this.updateReady();
        this.schedulePong();
      } catch (error) {
        if (this.failed === failure) this.fail(error);
      }
    } : null;
  }
  simulationReady() { this.simulation = true; this.updateReady(); }
  visualsReady() { this.visuals = true; this.updateReady(); }
  firstFrame() { if (!this.frame) { this.frame = true; this.updateReady(); } }
  private updateReady() {
    if (!this.showing || !this.status) return;
    this.detailsDirty = true;
    if (this.failed) { this.renderProgress(); return; }
    if (this.simulation && this.visuals && this.frame) {
      this.status.textContent = this.phaseMessage = 'Ready'; this.enter.disabled = false;
      this.cancelPong();
    }
    this.renderProgress();
  }
}

export const launch = new LaunchController();
