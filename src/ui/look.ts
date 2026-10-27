/** Shared live and take appearance controls. Temporary take edits never update live preferences. */
import { robotLightSettings, type RobotLight } from "../render/robot-light";
import type { Finish } from "../render/paint";
import { FINISH } from "../render/paint";
import type { PartOverride } from "../render/scene";
import type { SourceAntialiasing } from '../render/source-color';
import { KIT_REGIONS, KIT_STYLES, KIT_LABELS, kitRegion, type KitStyle } from '../render/robot-kit-data';
import { STUDIO, type Appearance, type Colorway, type Lighting, type SceneView, type HeadVisual } from "../render/scene";
import { VisualPicker, type VisualPickerConfig } from './visual-picker';
import { previewImage, characterOptions, characterDescription, sourceModelCatalog } from './preview-catalog';
import { characterPhysics, compatibleBody, isBodyVisual, isCharacter } from '../characters/catalog';
import { ShotLightsPanel } from './shot-lights';
import { validShotLights, type ShotLight } from '../record/post';
import { resolveLaunchVisualSelection } from '../loading/visual-selection';

/** Sun / ambient a map ships (Source light_environment), from its bundle manifest. */
export interface MapLight { azimuth: number; elevation: number; color: number; intensity: number; ambient: number; ambientColor: number }

export type Preset = "auto" | "studio" | "daylight" | "overcast" | "night" | "map" | "custom";
export interface LookState { preset: Preset; custom: Lighting; antialiasing?: SourceAntialiasing }
const PRESETS: Record<Exclude<Preset, "auto" | "map" | "custom">, Lighting> = {
  studio: STUDIO,
  daylight: { sunAzimuth: 135, sunElevation: 50, sunIntensity: 2.6, sunColor: 0xfff1dc, ambient: 0.9,
              skyColor: 0xbcd6ff, groundColor: 0x5a4c3a, fill: 0.25, reflections: 0.4, exposure: 1,
              shadows: true, background: 0x9ec3e6 },
  overcast: { sunAzimuth: 120, sunElevation: 70, sunIntensity: 0.6, sunColor: 0xe8edf2, ambient: 1.4,
              skyColor: 0xdde3ea, groundColor: 0x4a4f55, fill: 0.4, reflections: 0.7, exposure: 1,
              shadows: true, background: 0x8a929b },
  night:    { sunAzimuth: 210, sunElevation: 40, sunIntensity: 0.3, sunColor: 0x8fa8ff, ambient: 0.25,
              skyColor: 0x26324f, groundColor: 0x07080c, fill: 0.15, reflections: 0.15, exposure: 1.15,
              shadows: true, background: 0x05070b },
};
const PRESET_LABEL: Record<Preset, string> = {
  auto: "Auto (noclip.website lighting on maps)", studio: "Studio", daylight: "Daylight", overcast: "Overcast",
  night: "Night", map: "Map (noclip.website lighting)", custom: "Custom",
};
const LIGHT_KEY = "ume-lighting", PAINT_KEY = "ume-appearance", HEAD_KEY = "ume-head-visuals";
const FINISH_LABEL: Record<Finish, string> = {
  gloss: "Gloss", satin: "Satin", matte: "Matte", rubber: "Rubber", metal: "Brushed metal",
  gunmetal: "Gunmetal", mirror: "Mirror (iridescent)",
};

const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");
const num = (s: string) => parseInt(s.slice(1), 16);
/** left_x ↔ right_x: the mirror part of a mesh name, or null. */
const mirrorOf = (n: string) => (/left/.test(n) ? n.replace(/left/g, "right") : /right/.test(n) ? n.replace(/right/g, "left") : null);
const load = <T>(k: string, d: T): T => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) ?? "{}") }; } catch { return d; } };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function row(label: string, ...kids: Node[]): HTMLElement {
  const r = el("div", "lk-row");
  r.append(el("label", "", label), ...kids);
  return r;
}
function fold(title: string): { root: HTMLDetailsElement; body: HTMLElement } {
  const root = el("details", "fold");
  const body = el("div", "fold-body");
  root.append(el("summary", "", title), body);
  return { root, body };
}

export class LookPanel {
  private preset: Preset;
  private custom: Lighting;
  private antialiasing: SourceAntialiasing;
  private mapLight: MapLight | null = null;
  private mapLightPending = false;
  private lightBody: HTMLElement;
  private paintBody: HTMLElement;
  private paintFold: HTMLDetailsElement;
  private shotLights: ShotLightsPanel;
  private liveLights: ShotLight[] | null = null;
  private liveLook: LookState | null = null;
  private shotChanged: (() => void) | null = null;
  private shotReset: (() => void) | null = null;
  private readOnly = false;
  private robot = "";
  private paints: Record<string, Appearance>;
  private heads: Record<string, HeadVisual>;
  private selected = "";
  private linked = true;
  private headLocked = false;
  private sourceBodyLinkApplied = false;
  private modulesOpen = false;
  private lightPickers: VisualPicker[] = [];
  private paintPickers: VisualPicker[] = [];
  /** Keep the requested Pick state while export temporarily blocks pointer editing. */
  private pickEnabled = false;
  get picking(): boolean { return this.pickEnabled && !this.readOnly; }

  constructor(parent: HTMLElement, readonly view: SceneView) {
    const saved = load(LIGHT_KEY, { preset: "auto" as Preset, custom: STUDIO, antialiasing: 'fxaa' as SourceAntialiasing });
    this.antialiasing=['fxaa','msaa4','none'].includes(saved.antialiasing)?saved.antialiasing:'fxaa';
    // Upgrade pre-Source lighting preferences once; future explicit choices still persist.
    if (!localStorage.getItem('ume-source-lighting-default-v3')) {
      saved.preset = 'auto';
      localStorage.setItem('ume-source-lighting-default-v3', '1');
    }
    this.preset = saved.preset;
    this.custom = { ...STUDIO, ...saved.custom };
    this.paints = (() => { try { return JSON.parse(localStorage.getItem(PAINT_KEY) ?? "{}"); } catch { return {}; } })();
    this.heads = load(HEAD_KEY, {});
    const L = fold("Lighting"), P = fold("Robot appearance");
    this.lightBody = L.body;
    this.paintBody = P.body;
    this.paintFold = P.root;
    parent.append(L.root, P.root);
    this.view.onHeadVisualChange = () => this.renderPaint();
    this.applyLighting();
    this.renderLighting();
    try {
      const lights: unknown = JSON.parse(localStorage.getItem('ume-live-lights') ?? '[]');
      if (validShotLights(lights)) this.view.setShotLights(lights);
    } catch { /* damaged light preferences leave the scene unmodified */ }
    this.shotLights = new ShotLightsPanel(this.view, () => {
      if (this.liveLook) this.shotChanged?.();
      else localStorage.setItem('ume-live-lights', JSON.stringify(this.view.getShotLights()));
    }, () => {
      if (this.liveLook) this.shotReset?.();
      else {
        this.view.setShotLights([]);
        localStorage.setItem('ume-live-lights', '[]');
        this.shotLights.show(this.readOnly, false);
      }
    });
    parent.append(this.shotLights.root);
    this.shotLights.show(false, false);
  }

  // ---- lighting ----------------------------------------------------------------
  getState(): LookState { return { preset: this.preset, custom: { ...this.custom }, antialiasing: this.antialiasing }; }

  setState(state: LookState) {
    if (this.readOnly) return;
    this.preset = state.preset;
    this.custom = { ...STUDIO, ...state.custom };
    this.antialiasing=state.antialiasing??'fxaa';
    this.applyLighting();
    this.renderLighting();
  }

  /** Keep the first live snapshot when switching directly between reviewed takes. */
  beginShotEdit(look: LookState, changed: () => void, reset: () => void, lights: readonly ShotLight[] = []): void {
    if (this.readOnly) return;
    this.liveLook ??= this.getState();
    this.liveLights ??= this.view.getShotLights();
    this.shotChanged = changed;
    this.shotReset = reset;
    this.setState(look);
    this.view.setShotLights(lights);
    this.renderPaint();
    this.shotLights.show(this.readOnly, true);
  }

  endShotEdit(): void {
    if (this.readOnly) return;
    const live = this.liveLook;
    if (live) this.setState(live);
    this.liveLook = null;
    this.shotChanged = null;
    this.shotReset = null;
    if (this.liveLights) this.view.setShotLights(this.liveLights);
    this.liveLights = null;
    this.shotLights.show(this.readOnly, false);
    this.renderLighting();
    this.renderPaint();
  }

  /** Encoding lock; rebuilding also disposes galleries attached to document.body. */
  setReadOnly(on: boolean): void {
    this.readOnly = on;
    if (!on && this.mapLightPending) {
      this.mapLightPending = false;
      this.applyLighting();
    }
    this.renderLighting();
    this.renderPaint();
    this.shotLights?.setReadOnly(on);
  }

  revealShotEdit(): void {
    if (!this.liveLook) return;
    this.paintFold.open = true;
    this.shotLights?.reveal();
    const summary = this.paintFold.querySelector('summary');
    summary?.focus({ preventScroll: true });
    summary?.scrollIntoView({ block: 'nearest' });
  }

  private get appearanceLocked(): boolean { return this.readOnly || this.headLocked; }

  private lockControls(body: HTMLElement): void {
    for (const control of body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button'))
      control.disabled = true;
  }

  /** The terrain's own light (null off a map), available through the Map preset. */
  setMapLight(l: MapLight | null) {
    this.mapLight = l;
    if (this.readOnly) { this.mapLightPending = true; return; }
    this.applyLighting();
    this.renderLighting();
  }

  private fromMap(m: MapLight): Lighting {
    return { ...STUDIO, sunAzimuth: m.azimuth, sunElevation: m.elevation, sunColor: m.color,
             sunIntensity: m.intensity, ambient: m.ambient, skyColor: m.ambientColor,
             groundColor: 0x16181c, fill: 0.2, reflections: 0.35, shadows: true, background: 0x0b0e12 };
  }

  private current(): Lighting {
    const p = this.preset;
    if (p === "custom") return this.custom;
    if (p === "auto" || p === "map") return this.mapLight ? this.fromMap(this.mapLight) : STUDIO;
    return PRESETS[p];
  }

  private applyLighting(deliberate = false) {
    if (deliberate && this.readOnly) return;
    this.view.setSourceLighting(this.preset === "auto" || this.preset === "map");
    this.view.setSourceAntialiasing(this.antialiasing);
    this.view.setLighting(this.current());
    if (deliberate) {
      if (this.liveLook) this.shotChanged?.();
      else localStorage.setItem(LIGHT_KEY, JSON.stringify(this.getState()));
    }
  }
  private choice(select: HTMLSelectElement, config: VisualPickerConfig, pickers: VisualPicker[]): HTMLElement {
    const picker = new VisualPicker(select, config);
    pickers.push(picker);
    return picker.root;
  }


  private renderLighting() {
    const b = this.lightBody, l = this.current();
    for (const picker of this.lightPickers) picker.dispose();
    this.lightPickers = [];
    b.replaceChildren();
    b.append(el('div', 'sub', this.liveLook ? 'SHOT' : 'LIVE'));
    const presetSel = el("select");
    for (const p of Object.keys(PRESET_LABEL) as Preset[]) {
      const o = new Option(PRESET_LABEL[p], p);
      o.disabled = p === "map" && !this.mapLight;
      presetSel.add(o);
    }
    presetSel.value = this.preset;
    presetSel.disabled = this.readOnly;
    presetSel.onchange = () => {
      if (this.readOnly) return;
      this.preset = presetSel.value as Preset; this.applyLighting(true); this.renderLighting();
    };
    const presetPicker = new VisualPicker(presetSel, {
      id: 'lighting-preset', label: 'Lighting preset', search: false,
      preview: value => {
        const preset = value as Preset;
        const lighting = preset === 'custom' ? this.custom : preset === 'auto' || preset === 'map'
          ? this.mapLight ? this.fromMap(this.mapLight) : STUDIO : PRESETS[preset];
        return this.view.previewChoice({ kind: 'lighting', value, lighting });
      },
      description: value => value === 'auto' || value === 'map'
        ? 'Uses authored map lighting when available. Preview swatch, not a map screenshot.'
        : 'Lighting preview swatch.',
    });
    this.lightPickers.push(presetPicker);
    b.append(row("Preset", presetPicker.root));
    if(this.mapLight&&(this.preset==='auto'||this.preset==='map')) {
      const aa=el('select');aa.setAttribute('aria-label','Map antialiasing');
      for(const [value,label] of [['fxaa','FXAA (noclip.website default)'],['msaa4','MSAA 4×'],['none','Off']])aa.add(new Option(label,value));
      aa.value=this.antialiasing;
      aa.disabled = this.readOnly;
      aa.onchange=()=>{if(this.readOnly)return;this.antialiasing=aa.value as SourceAntialiasing;this.applyLighting(true);};
      b.append(row('Antialiasing', this.choice(aa, {
        id: 'map-antialiasing', label: 'Map antialiasing', search: false,
        preview: value => this.view.previewChoice({ kind: 'antialiasing', value: value as SourceAntialiasing }),
        description: () => 'Edge preview; map materials are unchanged.',
      }, this.lightPickers)));
    }
    if (this.mapLight && (this.preset === 'auto' || this.preset === 'map')) {
      b.append(el('div', 'sub', "Source lightmaps, model lighting and reflections use noclip.website's shader equations. No fill light or tone mapping. Select another preset to re-light the map."));
      if (this.readOnly) this.lockControls(b);
      return;
    }
    // any edit turns the current look into the Custom preset
    const edit = (patch: Partial<Lighting>) => {
      if (this.readOnly) return;
      this.custom = { ...this.current(), ...patch };
      this.preset = "custom";
      presetSel.value = "custom";
      presetPicker.sync();
      this.applyLighting(true);
    };
    const slider = (label: string, k: keyof Lighting, min: number, max: number, step: number, unit = "") => {
      const r = el("input"), v = el("span", "lk-val");
      r.type = "range"; r.min = String(min); r.max = String(max); r.step = String(step);
      r.value = String(l[k]);
      v.textContent = `${l[k]}${unit}`;
      r.oninput = () => { v.textContent = `${r.value}${unit}`; edit({ [k]: Number(r.value) }); };
      b.append(row(label, r, v));
    };
    const color = (label: string, k: "sunColor" | "skyColor" | "groundColor" | "background") => {
      const c = el("input");
      c.type = "color"; c.value = hex(l[k] as number);
      c.oninput = () => edit({ [k]: num(c.value) });
      return [label, c] as const;
    };
    slider("Sun azimuth", "sunAzimuth", -180, 180, 1, "°");
    slider("Sun height", "sunElevation", 2, 90, 1, "°");
    slider("Sun", "sunIntensity", 0, 5, 0.05);
    slider("Ambient", "ambient", 0, 3, 0.05);
    slider("Fill", "fill", 0, 2, 0.05);
    slider("Reflections", "reflections", 0, 2, 0.05);
    slider("Exposure", "exposure", 0.3, 2.5, 0.05);
    const colors = el("div", "lk-colors");
    for (const [label, c] of [color("Sun", "sunColor"), color("Sky", "skyColor"), color("Ground", "groundColor"),
                              color("Background", "background")]) {
      const w = el("label", "lk-swatch"); w.append(c, label); colors.append(w);
    }
    b.append(colors);
    const sh = el("input"); sh.type = "checkbox"; sh.checked = l.shadows;
    sh.onchange = () => edit({ shadows: sh.checked });
    const shl = el("label", "lk-check"); shl.append(sh, " Shadows (sun)");
    b.append(shl);
    if (this.mapLight) b.append(el("div", "sub", "Auto and Map use the map's baked Source lighting. Other presets re-light it."));
    if (this.readOnly) this.lockControls(b);
  }

  // ---- robot paint -------------------------------------------------------------
  /** A model was (re)built: re-list its parts and re-apply its saved paint. */
  onModel(robot: string, initialHead?: HeadVisual, initialAppearance?: Appearance) {
    if (this.readOnly) return;
    const changed = this.robot !== robot;
    this.robot = robot;
    if (!this.liveLook && initialAppearance) {
      this.paints[robot] = structuredClone(initialAppearance);
      this.sourceBodyLinkApplied = true;
    }
    const requested=new URL(location.href).searchParams.get('body');
    if(!this.liveLook&&!this.sourceBodyLinkApplied&&isBodyVisual(requested)&&compatibleBody(requested,robot)){
      this.sourceBodyLinkApplied=true;this.paints[robot]={...this.app(),sourceBody:requested};
      localStorage.setItem(PAINT_KEY,JSON.stringify(this.paints));
    }
    if (!this.view.partNames().includes(this.selected)) this.selected = "";
    if (!this.liveLook) {
      const head = initialHead ?? (changed ? this.heads[robot] === 'ghost' ? 'ghost' : 'stock' : this.view.getHeadVisual());
      this.view.setAppearance(this.app(), this.headLocked ? undefined : head);
    }
    this.view.highlight(this.picking && this.selected ? this.selected : null);
    this.renderPaint();
  }

  restoreAppearance(robot:string,appearance:Appearance,head?:HeadVisual) {
    if (this.readOnly) return;
    if (!this.liveLook) {
      this.sourceBodyLinkApplied=true;
      this.paints[robot]=structuredClone(appearance);
      localStorage.setItem(PAINT_KEY,JSON.stringify(this.paints));
    }
    if(this.robot===robot){this.view.setAppearance(appearance,head);this.renderPaint();}
  }

  /** A recording fixes the robot shell, not the independently editable added-light rig. */
  setHeadLocked(locked: boolean) {
    this.headLocked = locked;
    this.renderPaint();
    this.shotLights?.setReadOnly(this.readOnly);
  }
  refreshHead() { this.renderPaint(); }

  /** Only deliberate identity choices update the preference; review/rendering never do. */
  private chooseHead(head: HeadVisual, notify = true) {
    if (this.appearanceLocked) return;
    if (!this.liveLook) {
      this.heads[this.robot] = head;
      localStorage.setItem(HEAD_KEY, JSON.stringify(this.heads));
    }
    void this.view.setHeadVisual(head);
    if (notify && this.liveLook) this.shotChanged?.();
  }

  private app(): Appearance {
    if (this.liveLook) return this.view.getAppearance();
    return this.paints[this.robot] ?? { colorway: "grey", parts: {} };
  }

  private savePaint(a: Appearance) {
    if (this.appearanceLocked) return;
    if (!this.liveLook) {
      this.paints[this.robot] = a;
      localStorage.setItem(PAINT_KEY, JSON.stringify(this.paints));
    }
    this.view.setAppearance(a);
    if (this.liveLook) this.shotChanged?.();
  }

  /** Select a part (from the list or a click on the robot). */
  select(name: string) {
    if (this.readOnly) return;
    this.selected = name;
    this.view.highlight(name || null);
    this.renderPaint();
  }

  private renderPaint() {
    const b = this.paintBody, a = this.headLocked ? this.view.getAppearance() : this.app();
    for (const picker of this.paintPickers) picker.dispose();
    this.paintPickers = [];
    b.replaceChildren();
    if (this.headLocked) b.append(el("div", "sub", "Robot appearance is fixed while recording."));
    else if (this.readOnly) b.append(el("div", "sub", "Appearance is locked during export."));
    else if (this.liveLook) b.append(el("div", "sub", "Changes apply to this take only."));
    const bodyState=this.view.getBodyVisualState();
    const stockBody=bodyState.choice==='stock';
    const modules=a.modules??{},styles=KIT_REGIONS.map(r=>modules[r]??'stock');
    const uniform=styles.every(s=>s===styles[0]);
    const character=el('select');character.id='character';character.setAttribute('aria-label','Character');character.disabled=this.appearanceLocked;
    characterOptions(character,stockBody?(uniform?styles[0]:'custom'):bodyState.choice,this.robot,true);
    character.onchange=()=>{
      if(this.appearanceLocked||!isCharacter(character.value))return;
      const value=character.value;
      const body=isBodyVisual(value)?value:'stock';
      if(!compatibleBody(body,this.robot))return;
      if(!this.liveLook){const url=new URL(location.href);url.searchParams.set('body',body);history.replaceState(null,'',url);}
      const resolved = resolveLaunchVisualSelection({ terrain: 'flat', robot: this.robot, character: value,
        rememberedAppearance: this.app(), partNames: this.view.partNames() });
      this.chooseHead('stock', false);
      this.savePaint(resolved.appearance);
      this.renderPaint();
    };
    const characterRow=row('Character',this.choice(character,{
      id:'character',label:'Character',preview:value=>value==='custom'
        ?this.view.previewChoice({kind:'colorway',value:a.colorway}):previewImage('character',value,this.robot),
      description:characterDescription,catalog:sourceModelCatalog(this.robot.startsWith('r1')),
    },this.paintPickers));
    (characterRow.firstElementChild as HTMLLabelElement).htmlFor='character-trigger';b.append(characterRow);
    if(bodyState.available||!stockBody){
      const note=el('div','sub');note.setAttribute('role','status');note.setAttribute('aria-live','polite');
      const label=character.selectedOptions[0]?.label??bodyState.choice;
      note.textContent=bodyState.loading?`Loading ${label} and textures…`:bodyState.error?`Could not load ${label}: ${bodyState.error}`:
        stockBody?'':`Uses ${characterPhysics(bodyState.choice)==='go2'?'Go2':'R1'} physics.`;
      b.append(note);
      if(bodyState.error){const retry=el('button','btn','Retry character download');retry.type='button';retry.disabled=this.appearanceLocked;
        retry.onclick=()=>{if(!this.appearanceLocked)this.view.retrySourceBody();};b.append(retry);}
    }
    if(stockBody) {
      const modular=fold('Mix robot parts');
      modular.root.open=this.modulesOpen;modular.root.ontoggle=()=>{this.modulesOpen=modular.root.open;};
      const available=new Set(this.view.partNames().map(kitRegion));
      for(const region of KIT_REGIONS) {
        if(!available.has(region))continue;
        const select=el('select');select.setAttribute('aria-label',`${region[0].toUpperCase()+region.slice(1)} module`);
        select.disabled=this.appearanceLocked;
        for(const style of KIT_STYLES)select.add(new Option(KIT_LABELS[style],style));
        select.value=modules[region]??'stock';
        select.onchange=()=>{
          if (this.appearanceLocked) return;
          this.modulesOpen=modular.root.open;
          if(region==='head')this.chooseHead('stock', false);
          this.savePaint({...this.app(),modules:{...this.app().modules,[region]:select.value as KitStyle}});this.renderPaint();
        };
        modular.body.append(row(region[0].toUpperCase()+region.slice(1),this.choice(select,{
          id:`module-${region}`,label:`${region[0].toUpperCase()+region.slice(1)} module`,search:false,
          preview:value=>this.view.previewChoice({kind:'module',value:value as KitStyle,region}),
          description:()=>`Changes the ${region} visual style, not collision or joint physics.`,
        },this.paintPickers)));
      }
      modular.body.append(el('div','sub','Mix heads, shells and limbs without changing robot movement or controls. No extra model download.'));
      b.append(modular.root);
    }
    if (stockBody && this.robot.startsWith("r1") && this.view.getHeadVisualState().available) {
      const state = this.view.getHeadVisualState();
      const head = el("select"); head.id = "source-head-visual";
      head.add(new Option("Stock R1", "stock"));
      head.add(new Option("Ghost girlbot (girlbot_head.mdl)", "ghost"));
      head.value = state.choice; head.disabled = !state.available || this.appearanceLocked;
      head.onchange = () => this.chooseHead(head.value as HeadVisual);
      const headRow = row("Head visual", this.choice(head,{
        id:'source-head-visual',label:'Head visual',search:false,
        preview:value=>previewImage('head',value),
        description:value=>value==='ghost'?'Original Ghost girlbot head on a compatible R1.':'Original R1 head geometry.',
      },this.paintPickers));
      (headRow.firstElementChild as HTMLLabelElement).htmlFor = 'source-head-visual-trigger';
      b.append(headRow);
      const note = el("div", "sub");
      note.style.fontSize = "12px"; note.style.color = "var(--text-2)";
      note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
      note.textContent = this.headLocked ? "Head visual is fixed while recording."
        : this.readOnly ? "Head visual is locked during export."
        : state.loading ? "Loading Ghost head and textures…"
        : state.error ? `Could not load the Ghost head: ${state.error}`
        : state.choice === "ghost" ? "Ghost head fitted uniformly to R1. Physics and controls are unchanged. Part paint tints its native texture."
        : "Source head only. Ghost body and arms need rigging to replace moving R1 parts.";
      b.append(note);
      if (state.error) {
        const retry = el("button", "btn", "Retry head download"); retry.type = "button";
        retry.disabled = this.appearanceLocked;
        retry.onclick = () => this.chooseHead("ghost");
        b.append(retry);
      }
    }
    const light = robotLightSettings(a.robotLight);
    const editLight = (patch: Partial<RobotLight>) => {
      if (this.appearanceLocked) return;
      const current = this.app();
      this.savePaint({ ...current, robotLight: robotLightSettings({ ...robotLightSettings(current.robotLight), ...patch }) });
    };
    const dull = el("input"); dull.type = "checkbox"; dull.id = "robot-dull"; dull.checked = light.dull;
    dull.onchange = () => { editLight({ dull: dull.checked }); this.renderPaint(); };
    const dullLabel = el("label", "lk-check"); dullLabel.append(dull, " Dull (no shine or glow)");
    b.append(dullLabel);
    const slider = (label: string, key: "brightness" | "range", min: number, max: number, step: number, suffix = "") => {
      const input = el("input"), output = el("span", "lk-val");
      input.type = "range"; input.id = `robot-light-${key}`;
      input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(light[key]);
      input.disabled = light.dull; output.textContent = `${light[key]}${suffix}`;
      input.oninput = () => { if(this.appearanceLocked)return;light[key] = Number(input.value); output.textContent = `${input.value}${suffix}`; editLight({ [key]: light[key] }); };
      const r = row(label, input, output); (r.firstElementChild as HTMLLabelElement).htmlFor = input.id; b.append(r);
    };
    slider("Robot brightness", "brightness", 0, 100, 0.5);
    const color = el("input"); color.type = "color"; color.id = "robot-light-color"; color.value = hex(light.color); color.disabled = light.dull;
    color.oninput = () => { if(this.appearanceLocked)return;light.color = num(color.value); editLight({ color: light.color }); };
    const cr = row("Light colour", color); (cr.firstElementChild as HTMLLabelElement).htmlFor = color.id; b.append(cr);
    slider("Light reach", "range", 1, 30, 0.5, " m");
    b.append(el("div", "sub", "Brightness 0 turns off the robot light. Higher values make the shell glow and illuminate nearby surfaces."));
    const cw = el("select");
    for (const [v, t] of (!stockBody
      ? [["model","Model colours"],["grey","Grey tint"],["product","Product tint"]]
      : [["grey", "Grey (plain)"], ["product", "Product colours"], ["model", "Model colours"]]) as [Colorway,string][])
      cw.add(new Option(t, v));
    cw.value = !stockBody?(a.sourceBodyColorway??'model'):a.colorway;
    cw.onchange = () => {
      this.savePaint(!stockBody?{...this.app(),sourceBodyColorway:cw.value as Colorway}:{ ...this.app(), colorway: cw.value as Colorway });
      this.renderPaint();
    };
    b.append(row("Colourway", this.choice(cw,{
      id:'robot-colorway',label:'Colourway',search:false,
      preview:value=>this.view.previewChoice({kind:'colorway',value:value as Colorway}),
    },this.paintPickers)));

    const names = this.view.partNames();
    if(this.selected&&!names.includes(this.selected)){this.selected='';this.view.highlight(null);}
    const part = el("select");
    part.add(new Option(names.length ? "Select part" : "No robot loaded", ""));
    for (const n of names) {
      const label=n.replace(/_link$/,'').replaceAll('_',' ');
      const option=new Option(label.charAt(0).toUpperCase()+label.slice(1)+(a.parts[n]?" •":""),n);
      option.title=n;part.add(option);
    }
    part.value = this.selected;
    part.onchange = () => this.select(part.value);
    const pick = el("button", "btn" + (this.pickEnabled ? " on" : ""), "Pick");
    pick.type = "button";
    pick.title = "Click a part of the robot in the viewport to select it";
    pick.onclick = () => { if(this.readOnly)return;this.pickEnabled = !this.pickEnabled; this.view.highlight(this.picking && this.selected ? this.selected : null); this.renderPaint(); };
    const prow = el("div", "lk-inline"); prow.append(this.choice(part,{
      id:'robot-part',label:'Part',
      preview:value=>value
        ?this.view.previewChoice({kind:'part',value})
        :this.view.previewChoice({kind:'colorway',value:!stockBody?(a.sourceBodyColorway??'model'):a.colorway}),
      description:value=>value?'Select this mesh for paint and finish edits.':'No part selected.',
    },this.paintPickers), pick);
    b.append(row("Part", prow));

    if (this.selected) {
      const cur = this.view.partPaint(this.selected);
      const c = el("input"); c.type = "color"; c.id = "robot-part-color"; c.value = hex(cur.color);
      const fin = el("select");
      fin.add(new Option("Original finish", "original"));
      for (const f of Object.keys(FINISH) as Finish[]) fin.add(new Option(FINISH_LABEL[f], f));
      const numericAxes = ["roughness", "metalness", "clearcoat"] as const;
      const custom = new Option("Custom", "custom"); custom.disabled = true; custom.title = "Current values";
      const syncFinish = () => {
        const override = this.app().parts[this.selected] ?? {};
        const preset = override.finish ? FINISH[override.finish] : undefined;
        const isCustom = numericAxes.some(key => override[key] !== undefined &&
          (!preset || override[key] !== preset[key]));
        if (isCustom) {
          if (!fin.contains(custom)) fin.add(custom);
          fin.value = "custom";
        } else {
          custom.remove();
          fin.value = override.finish ?? "original";
        }
      };
      syncFinish();
      const applyDelta = (patch: PartOverride, resetFinish = false) => {
        if (this.appearanceLocked) return;
        const current = this.app(), parts = { ...current.parts };
        const mirrored = this.linked ? mirrorOf(this.selected) : null;
        const targets = [this.selected];
        if (mirrored && names.includes(mirrored)) targets.push(mirrored);
        for (const name of targets) {
          const next = { ...parts[name] };
          if (resetFinish) {
            delete next.finish;
            for (const key of numericAxes) delete next[key];
          }
          Object.assign(next, patch);
          for (const key of ["color", "finish", ...numericAxes] as const)
            if (next[key] === undefined) delete next[key];
          if (Object.keys(next).length) parts[name] = next;
          else delete parts[name];
        }
        this.savePaint({ ...current, parts });
        this.view.highlight(this.selected);
      };
      c.oninput = () => applyDelta({ color: num(c.value) });
      const finishPicker = new VisualPicker(fin, {
        id:'robot-finish',label:'Finish',search:false,
        preview:value=>value === 'original'
          ?this.view.previewChoice({kind:'part',value:this.selected,originalFinish:true})
          :value === 'custom'
            ?this.view.previewChoice({kind:'part',value:this.selected})
            :this.view.previewChoice({kind:'finish',value:value as Finish}),
      });
      this.paintPickers.push(finishPicker);
      const colourRow = row("Colour", c);
      (colourRow.firstElementChild as HTMLLabelElement).htmlFor = c.id;
      b.append(colourRow, row("Finish", finishPicker.root));
      const knob = (label: string, key: typeof numericAxes[number], left: string, right: string) => {
        const input = el("input"), output = el("span", "lk-val");
        input.type = "range"; input.id = `robot-part-${key}`;
        input.min = "0"; input.max = "1"; input.step = "0.01";
        input.value = String(cur[key]!);
        output.textContent = cur[key]!.toFixed(2);
        input.title = `${left} ← → ${right}`;
        input.oninput = () => {
          if (this.appearanceLocked) return;
          output.textContent = Number(input.value).toFixed(2);
          applyDelta({ [key]: Number(input.value) });
          syncFinish();
          finishPicker.sync();
        };
        const r = row(label, input, output);
        (r.firstElementChild as HTMLLabelElement).htmlFor = input.id;
        b.append(r);
      };
      knob("Dullness", "roughness", "shiny", "matte");
      knob("Metalness", "metalness", "plastic", "metal");
      knob("Shine coat", "clearcoat", "none", "lacquered");
      fin.onchange = () => {
        if (this.appearanceLocked || fin.value === "custom") return;
        // Presets supply their own numeric values; Original restores each side's own base.
        applyDelta(fin.value === "original" ? {} : { finish: fin.value as Finish }, true);
        this.renderPaint();
      };
      const toAll = el("button", "btn", "Apply to whole robot");
      toAll.type = "button";
      toAll.title = "Give every part this colour and finish";
      toAll.onclick = () => {
        if (this.appearanceLocked) return;
        const p = this.view.partPaint(this.selected);
        this.savePaint({ ...this.app(), parts: Object.fromEntries(names.map((n) => [n, { ...p }])) });
        this.view.highlight(this.selected);
        this.renderPaint();
      };
      const tr = el("div", "row"); tr.append(toAll); b.append(tr);
      const link = el("input"); link.type = "checkbox"; link.checked = this.linked;
      link.onchange = () => { if(!this.readOnly)this.linked = link.checked; };
      const ll = el("label", "lk-check"); ll.append(link, " Same on both sides (left / right)");
      b.append(ll);
      const reset = el("button", "btn", "Reset part");
      reset.type = "button";
      reset.onclick = () => {
        if (this.appearanceLocked) return;
        const parts = { ...this.app().parts };
        delete parts[this.selected];
        const m = this.linked ? mirrorOf(this.selected) : null;
        if (m) delete parts[m];
        this.savePaint({ ...this.app(), parts });
        this.view.highlight(this.selected);
        this.renderPaint();
      };
      const rr = el("div", "row"); rr.append(reset); b.append(rr);
    }
    const all = el("button", "btn ghost danger", "Reset all colours");
    all.type = "button";
    all.onclick = () => { this.savePaint({ ...this.app(), colorway: "grey", parts: {} }); this.renderPaint(); };
    const n = Object.keys(a.parts).length;
    b.append(el("div", "sub", n ? `${n} part${n > 1 ? "s" : ""} recoloured on this robot.` :
      "Pick a part (list or click), then set its colour and finish."), all);
    if (this.appearanceLocked) this.lockControls(b);
  }
}
