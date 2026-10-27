/** Lightweight launch shell. Keep all runtime imports free of rendering/simulation dependencies. */
import { isTerrain, TERRAINS } from '../sim/terrain';
import type { MapEntry, TerrainName } from '../sim/terrain';
import { KIT_LABELS, KIT_REGIONS } from '../render/robot-kit-data';
import { CHARACTER_CHOICES, characterPhysics, compatibleBody, isBodyVisual, isCharacter, type CharacterId } from '../characters/catalog';
import { decodePmodelId } from '../characters/pmodels';
import { sharedView } from './explore';
import { Pong } from './pong';
import { VisualPicker } from './visual-picker';
import { previewImage, staticPreviewOptions, characterOptions, characterDescription, sourceModelCatalog } from './preview-catalog';
import { SceneProgress, downloadTime, type LoadingSnapshot } from '../loading/progress';
import { observeTransfers, type TransferUpdate } from '../loading/transfers';
import type { PlannedAsset } from '../loading/asset-plan';
import { registerPreviewAsset } from '../loading/preview-assets';
import './launch.css';

export interface LaunchSelection {
  terrain: TerrainName;
  robot: string;
  /** null means preserve linked / remembered paint, not "apply Original". */
  character: CharacterId | null;
  preserveView: boolean;
  robotChanged: boolean;
}
const robots = ['r1', 'r1_air', 'r1_air_edu', 'g1', 'g1_air', 'go2'];
const labels: Record<string, string> = { flat: 'Flat ground', rough: 'Rough ground', slope: 'Slope', stairs: 'Stairs', park: 'Park' };
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

/** Keep useful asset paths, never URL credentials, search parameters or fragments. */
function transferName(value: string): string {
  try {
    const url = new URL(value, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin === location.origin ? '' : url.host}${url.pathname}` : 'Asset';
  } catch { return 'Asset'; }
}
const transferStates: Record<TransferUpdate['state'], string> = { loading: 'Active', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

class LaunchController {
  readonly selection: LaunchSelection;
  private root!: HTMLElement;
  private status!: HTMLElement;
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
  private progress = new SceneProgress();
  private loadGeneration = 0;
  private progressTimer?: number;
  private stopTransfers?: () => void;
  private transferRoot!: HTMLElement;
  private meter!: HTMLProgressElement;
  private bytes!: HTMLElement;
  private eta!: HTMLElement;
  private details!: HTMLDetailsElement;
  private detailStatus!: HTMLElement;
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
    const terrain = this.shared?.terrain ?? (query && isTerrain(`map:${query}`) ? `map:${query}` as TerrainName : undefined)
      ?? (isTerrain(prefs.terrain) ? prefs.terrain : 'map:nt_ghost_ctg');
    const rememberedRobot = typeof prefs.robot === 'string' && robots.includes(prefs.robot) ? prefs.robot : 'r1';
    const robot = this.shared?.robot ?? (isBodyVisual(body) && !compatibleBody(body, rememberedRobot) ? characterPhysics(body)! : rememberedRobot);
    this.selection = { terrain, robot, character: null, preserveView: !!this.shared, robotChanged: false };
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
  onEnter(callback: () => void) { this.callbacks.push(callback); }
  onFailure(callback: () => void) { this.failureCallbacks.push(callback); }
  ownsKey(code: string) { return this.heldKeys.has(code); }

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
          <label for="launch-character-trigger">Character</label><select id="launch-character"></select>
          <p id="launch-appearance-note"></p><label for="launch-robot-trigger">Robot physics</label><select id="launch-robot"></select>
          <div class="launch-actions"><button id="launch-back" class="btn" type="button">Back</button><button id="launch-load" class="btn primary" type="button">Load scene</button></div>
        </section>
        <section id="launch-loading-step" aria-labelledby="launch-loading-title" hidden><h2 id="launch-loading-title">Loading</h2>
          <p id="launch-context"></p>
          <div id="launch-transfer" class="launch-transfer" title="Selected scene asset payload. The maximum is fixed before scene downloads; browser caching can reduce network traffic.">
            <div class="launch-transfer-heading"><span id="launch-bytes">Planning scene assets…</span><span id="launch-eta"></span></div>
            <div id="launch-load-stage" class="launch-load-stage" data-game="waiting">
              <progress id="launch-progress" max="1" aria-label="Scene assets" aria-describedby="launch-bytes launch-eta"></progress>
              <div class="launch-morph" aria-hidden="true"><i class="morph-left"></i><i class="morph-middle"></i><i class="morph-right"></i><i class="morph-ball"></i></div>
              <div id="launch-pong-controls" hidden>
                <canvas id="launch-pong" tabindex="0" role="application" aria-label="Pong" aria-describedby="launch-pong-help" title="Move: ↑ ↓ / W S, mouse or touch. Space / P pauses."></canvas>
              </div>
            </div>
          </div>
          <p id="launch-status" role="status" aria-live="polite"></p><p id="launch-map-progress" role="status"></p>
          <details id="launch-details" class="launch-details" hidden>
            <summary>Details</summary>
            <div class="launch-detail-content">
              <p id="launch-detail-status"></p>
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
    this.mapPicker = new VisualPicker(map,{id:'launch-map',label:'Map',preview:value=>previewImage(value.startsWith('map:')?'map':'terrain',value)});
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
    this.renderCharacters(); this.renderMaps();
    const step = (name: string) => { for (const id of ['map', 'character', 'loading']) this.root.querySelector<HTMLElement>(`#launch-${id}-step`)!.hidden = id !== name; };
    this.root.querySelector<HTMLButtonElement>('#launch-next')!.onclick = () => { step('character'); this.characterPicker!.button.focus(); };
    this.root.querySelector<HTMLButtonElement>('#launch-back')!.onclick = () => { step('map'); this.mapPicker.button.focus(); };
    this.root.querySelector<HTMLButtonElement>('#launch-load')!.onclick = () => {
      if (this.loading) return;
      this.loading = true; this.root.dataset.loading = 'true'; step('loading'); this.context.textContent = this.describe();
      this.context.title = this.context.textContent;
      this.startProgress();
      this.phase('Starting renderer and physics…');
      this.status.tabIndex = -1; this.status.focus({ preventScroll: true });
      void load().catch(error => this.fail(error));
    };
    this.enter.onclick = () => {
      if (this.failed || !this.simulation || !this.visuals || !this.frame) return;
      this.showing = false; this.cancelPong(); this.root.hidden = true;
      this.details.open = false; this.details.hidden = true;
      this.stopTransfers?.(); this.stopTransfers = undefined;
      window.clearInterval(this.progressTimer); this.progressTimer = undefined;
      this.mapPicker.dispose(); this.robotPicker.dispose(); this.characterPicker?.dispose();
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
    const map = terrain.startsWith('map:') ? this.maps.find(entry => `map:${entry.id}` === terrain)?.name ?? terrain.slice(4) : labels[terrain];
    return `${map} · ${this.selection.robot.toUpperCase()} · ${this.selection.character ? CHARACTER_CHOICES.find(choice=>choice.id===this.selection.character)?.label ?? decodePmodelId(this.selection.character)?.name ?? this.selection.character : this.keptAppearanceLabel}`;
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
      ...this.maps.map(map => ({ value: `map:${map.id}`, label: `${map.name} · ${map.game}`, group:map.game })),
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
    for (const option of this.root.querySelectorAll<HTMLOptionElement>('option[data-preview]')) {
      if (option.dataset.preview) registerPreviewAsset(option.dataset.preview);
    }
    this.stopTransfers?.();
    window.clearInterval(this.progressTimer);
    this.details.open = false; this.details.hidden = false;
    this.detailRows.clear(); this.detailTransfers.replaceChildren();
    this.detailStatus.textContent = ''; this.detailReadiness.textContent = '';
    this.detailBytes.textContent = ''; this.detailCounts.textContent = '';
    this.detailsDirty = true;
    this.loadGeneration = this.progress.begin(performance.now());
    this.loadingStarted = performance.now();
    this.schedulePong();
    const generation = this.loadGeneration;
    this.stopTransfers = observeTransfers(`page:${generation}`, updates => this.receiveTransfers(generation, updates));
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
    const bytes = snapshot.frozen ? `${left} MB LEFT · ${loaded} / ${known} MB`
      : `Planning scene assets… · ${loaded} MB received`;
    if (this.bytes.textContent !== bytes) { this.bytes.textContent = bytes; this.bytes.title = bytes; }
    this.transferRoot.dataset.state = ready ? 'ready' : this.failed ? 'error' : snapshot.active ? 'loading' : 'preparing';
    if (snapshot.frozen) {
      this.meter.max = Math.max(1, snapshot.knownTotal);
      this.meter.value = snapshot.knownTotal === 0 ? 1 : snapshot.loaded;
    } else this.meter.removeAttribute('value');
    this.meter.setAttribute('aria-valuetext', this.failed ? 'Loading interrupted' : ready ? 'Scene ready' : bytes);

    const eta = this.failed ? ''
      : ready ? ''
      : !snapshot.frozen ? 'ETA pending'
      : snapshot.remaining === 0 ? 'Preparing scene…'
      : snapshot.stalled ? 'Waiting for data…'
      : snapshot.etaSeconds !== null ? `~${downloadTime(snapshot.etaSeconds)} download`
      : snapshot.active > 0 ? 'Measuring speed…'
      : 'Assets incomplete';
    if (this.eta.textContent !== eta) this.eta.textContent = eta;
    this.renderDetails(snapshot);
  }

  private renderDetails(snapshot: LoadingSnapshot) {
    // No resource iteration, URL parsing or detail DOM updates while collapsed.
    if (!this.details.open || !this.detailsDirty) return;
    this.detailsDirty = false;
    const message = `${this.status.textContent ?? ''} ${this.root.querySelector('#launch-map-progress')!.textContent ?? ''}`.trim()
      .replace(/(?:https?:\/\/|\/)[^\s<>"']+/g, transferName);
    if (this.detailStatus.textContent !== message) this.detailStatus.textContent = message;
    const readiness = `Simulation: ${this.simulation ? 'ready' : 'pending'} · Visuals: ${this.visuals ? 'ready' : 'pending'} · First frame: ${this.frame ? 'ready' : 'pending'}`;
    if (this.detailReadiness.textContent !== readiness) this.detailReadiness.textContent = readiness;
    const bytes = `${snapshot.loaded} B received · ${snapshot.knownTotal} B ${snapshot.frozen ? 'fixed maximum' : 'discovered'}${snapshot.unknown ? ` · ${snapshot.unknown} sizes pending` : ''}${snapshot.unexpected ? ` · ${snapshot.unexpected} catalogue mismatches` : ''}`;
    if (this.detailBytes.textContent !== bytes) this.detailBytes.textContent = bytes;
    const counts = { loading: 0, done: 0, failed: 0, cancelled: 0 };
    for (const transfer of this.progress.transfers()) {
      counts[transfer.state]++;
      let elements = this.detailRows.get(transfer.id);
      if (!elements) {
        const row = document.createElement('li');
        const name = document.createElement('span'); name.className = 'launch-detail-name';
        name.textContent = transferName(transfer.url); name.title = name.textContent;
        const state = document.createElement('span');
        const bytes = document.createElement('span'); bytes.className = 'launch-detail-size';
        row.append(name, state, bytes); this.detailTransfers.append(row);
        elements = { row, state, bytes }; this.detailRows.set(transfer.id, elements);
      }
      if (elements.row.dataset.state !== transfer.state) elements.row.dataset.state = transfer.state;
      if (elements.state.textContent !== transferStates[transfer.state]) elements.state.textContent = transferStates[transfer.state];
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
    this.enter.disabled = true; this.status.textContent = message;
    this.detailsDirty = true;
    this.renderProgress();
  }
  mapProgress(message: string) {
    if (!this.showing || this.failed || !this.root) return;
    this.root.querySelector('#launch-map-progress')!.textContent = message;
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
    this.status.textContent = error instanceof Error ? error.message : String(error);
    this.status.dataset.kind = 'error';
    this.detailsDirty = true;
    this.root.querySelector<HTMLButtonElement>('#launch-reload')!.hidden = false;
    const original = this.root.querySelector<HTMLButtonElement>('#launch-original')!;
    original.hidden = !recover; original.disabled = false;
    this.renderProgress();
    original.onclick = recover ? async () => {
      if (this.failed !== failure) return;
      original.disabled = true;
      this.status.textContent = 'Loading Original robot…';
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
      this.status.textContent = 'Ready'; this.enter.disabled = false;
      this.cancelPong();
    }
    this.renderProgress();
  }
}

export const launch = new LaunchController();
