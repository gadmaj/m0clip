/** Look of the scene: lighting (presets + every knob, shadows) and the robot's paint (colourway +
 * per-part colour / finish, picked from a list or by clicking the robot). Both persist per browser;
 * paint is kept per robot model. */
import { robotLightSettings, type RobotLight } from "../render/robot-light";
import type { Finish } from "../render/paint";
import { FINISH } from "../render/paint";
import type { PartPaint } from "../render/scene";
import { GREY, STUDIO, type Appearance, type Colorway, type Lighting, type SceneView, type HeadVisual } from "../render/scene";

/** Sun / ambient a map ships (Source light_environment), from its bundle manifest. */
export interface MapLight { azimuth: number; elevation: number; color: number; intensity: number; ambient: number; ambientColor: number }

export type Preset = "auto" | "studio" | "daylight" | "overcast" | "night" | "map" | "custom";
export interface LookState { preset: Preset; custom: Lighting }
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
const LIGHT_KEY = "ume-lighting", PAINT_KEY = "ume-appearance";
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
  private mapLight: MapLight | null = null;
  private lightBody: HTMLElement;
  private paintBody: HTMLElement;
  private robot = "";
  private paints: Record<string, Appearance>;
  private selected = "";
  private linked = true;
  private headLocked = false;
  private sourceBodyLinkApplied = false;
  /** clicking the robot picks a part while on */
  picking = false;

  constructor(parent: HTMLElement, readonly view: SceneView) {
    const saved = load(LIGHT_KEY, { preset: "auto" as Preset, custom: STUDIO });
    // Upgrade pre-Source lighting preferences once; future explicit choices still persist.
    if (!localStorage.getItem('ume-source-lighting-default-v3')) {
      saved.preset = 'auto';
      localStorage.setItem('ume-source-lighting-default-v3', '1');
    }
    this.preset = saved.preset;
    this.custom = { ...STUDIO, ...saved.custom };
    this.paints = (() => { try { return JSON.parse(localStorage.getItem(PAINT_KEY) ?? "{}"); } catch { return {}; } })();
    // Return an earlier Dog preview to the neutral R1 shell once. Explicit model
    // selections, body links and saved views still retain the optional Dog model.
    if(!localStorage.getItem('ume-stock-body-default-v1')) {
      for(const [robot,paint] of Object.entries(this.paints)) {
        if(robot.startsWith('r1')&&paint?.sourceBody==='dog')this.paints[robot]={...paint,sourceBody:'stock'};
      }
      localStorage.setItem(PAINT_KEY,JSON.stringify(this.paints));
      localStorage.setItem('ume-stock-body-default-v1','1');
    }
    const L = fold("Lighting"), P = fold("Robot appearance");
    this.lightBody = L.body;
    this.paintBody = P.body;
    parent.append(L.root, P.root);
    this.view.onHeadVisualChange = () => this.renderPaint();
    this.applyLighting();
    this.renderLighting();
  }

  // ---- lighting ----------------------------------------------------------------
  getState(): LookState { return { preset: this.preset, custom: { ...this.custom } }; }

  setState(state: LookState) {
    this.preset = state.preset;
    this.custom = { ...STUDIO, ...state.custom };
    this.applyLighting();
    this.renderLighting();
  }

  /** The terrain's own light (null off a map), available through the Map preset. */
  setMapLight(l: MapLight | null) {
    this.mapLight = l;
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

  private applyLighting() {
    this.view.setSourceLighting(this.preset === "auto" || this.preset === "map");
    this.view.setLighting(this.current());
    localStorage.setItem(LIGHT_KEY, JSON.stringify({ preset: this.preset, custom: this.custom }));
  }

  private renderLighting() {
    const b = this.lightBody, l = this.current();
    b.replaceChildren();
    const presetSel = el("select");
    for (const p of Object.keys(PRESET_LABEL) as Preset[]) {
      const o = new Option(PRESET_LABEL[p], p);
      o.disabled = p === "map" && !this.mapLight;
      presetSel.add(o);
    }
    presetSel.value = this.preset;
    presetSel.onchange = () => { this.preset = presetSel.value as Preset; this.applyLighting(); this.renderLighting(); };
    b.append(row("Preset", presetSel));
    if (this.mapLight && (this.preset === 'auto' || this.preset === 'map')) {
      b.append(el('div', 'sub', "Original Source lightmaps, model lighting and reflections, using noclip.website's shader equations. No added fill light or tone mapping. Choose another preset to re-light the map."));
      return;
    }
    // any edit turns the current look into the Custom preset
    const edit = (patch: Partial<Lighting>) => {
      this.custom = { ...this.current(), ...patch };
      this.preset = "custom";
      presetSel.value = "custom";
      this.applyLighting();
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
  }

  // ---- robot paint -------------------------------------------------------------
  /** A model was (re)built: re-list its parts and re-apply its saved paint. */
  onModel(robot: string) {
    this.robot = robot;
    const requested=new URL(location.href).searchParams.get('body');
    if(!this.sourceBodyLinkApplied&&robot.startsWith('r1')&&(requested==='dog'||requested==='stock')){
      this.sourceBodyLinkApplied=true;this.paints[robot]={...this.app(),sourceBody:requested};
      localStorage.setItem(PAINT_KEY,JSON.stringify(this.paints));
    }
    if (!this.view.partNames().includes(this.selected)) this.selected = "";
    this.view.setAppearance(this.app());
    this.view.highlight(this.picking && this.selected ? this.selected : null);
    this.renderPaint();
  }

  restoreAppearance(robot:string,appearance:Appearance) {
    this.sourceBodyLinkApplied=true;
    this.paints[robot]=structuredClone(appearance);
    localStorage.setItem(PAINT_KEY,JSON.stringify(this.paints));
    if(this.robot===robot){this.view.setAppearance(this.paints[robot]);this.renderPaint();}
  }

  /** A take records one fixed robot shell; changes resume after recording/review. */
  setHeadLocked(locked: boolean) { this.headLocked = locked; this.renderPaint(); }
  refreshHead() { this.renderPaint(); }

  private app(): Appearance {
    return this.paints[this.robot] ?? { colorway: "grey", parts: {} };
  }

  private savePaint(a: Appearance) {
    this.paints[this.robot] = a;
    localStorage.setItem(PAINT_KEY, JSON.stringify(this.paints));
    this.view.setAppearance(a);
  }

  /** Select a part (from the list or a click on the robot). */
  select(name: string) {
    this.selected = name;
    this.view.highlight(name || null);
    this.renderPaint();
  }

  private renderPaint() {
    const b = this.paintBody, a = this.headLocked ? this.view.getAppearance() : this.app();
    b.replaceChildren();
    if (this.headLocked) b.append(el("div", "sub", "Robot appearance is fixed while recording or reviewing a take."));
    const bodyState=this.view.getBodyVisualState();
    if(bodyState.available){
      const select=el('select');select.id='source-body-visual';
      select.add(new Option('Stock R1','stock'));select.add(new Option('Dog · Half-Life 2 (dog.mdl)','dog'));
      select.value=bodyState.choice;select.disabled=this.headLocked;
      select.onchange=()=>{
        const choice=select.value as 'stock'|'dog',url=new URL(location.href);
        url.searchParams.set('body',choice);history.replaceState(null,'',url);
        this.savePaint({...a,sourceBody:choice});
      };
      const bodyRow=row('Robot model',select);(bodyRow.firstElementChild as HTMLLabelElement).htmlFor=select.id;b.append(bodyRow);
      const note=el('div','sub');note.setAttribute('role','status');note.setAttribute('aria-live','polite');
      note.textContent=bodyState.loading?'Loading Dog and its original textures…':bodyState.error?`Could not load Dog: ${bodyState.error}`:
        bodyState.choice==='dog'?'Original Dog mesh and skeleton, following R1’s movement. Native proportions are retained; robot physics stay R1.':
        'Choose the original R1 shell or an articulated Source robot model.';
      b.append(note);
      if(bodyState.error){const retry=el('button','btn','Retry robot download');retry.type='button';retry.disabled=this.headLocked;
        retry.onclick=()=>this.view.retrySourceBody();b.append(retry);}
    }
    if (bodyState.choice!=='dog' && this.robot.startsWith("r1") && this.view.getHeadVisualState().available) {
      const state = this.view.getHeadVisualState();
      const head = el("select"); head.id = "source-head-visual";
      head.add(new Option("Stock R1", "stock"));
      head.add(new Option("Ghost girlbot (girlbot_head.mdl)", "ghost"));
      head.value = state.choice; head.disabled = !state.available || this.headLocked;
      head.onchange = () => { void this.view.setHeadVisual(head.value as HeadVisual); };
      const headRow = row("Head visual", head);
      (headRow.firstElementChild as HTMLLabelElement).htmlFor = head.id;
      b.append(headRow);
      const note = el("div", "sub");
      note.style.fontSize = "12px"; note.style.color = "var(--text-2)";
      note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
      note.textContent = this.headLocked ? "Head visual is fixed while recording or reviewing a take."
        : state.loading ? "Loading the original Ghost head and textures…"
        : state.error ? `Could not load the Ghost head: ${state.error}`
        : state.choice === "ghost" ? "Original Ghost head, fitted uniformly to R1. Physics and controls stay the same. Part paint tints its native texture."
        : "Optional original Source head. The connected Ghost body and arms need rigging before they can replace moving R1 parts.";
      b.append(note);
      if (state.error) {
        const retry = el("button", "btn", "Retry head download"); retry.type = "button";
        retry.disabled = this.headLocked;
        retry.onclick = () => { void this.view.setHeadVisual("ghost"); };
        b.append(retry);
      }
    }
    const light = robotLightSettings(a.robotLight);
    const editLight = (patch: Partial<RobotLight>) => {
      a.robotLight = robotLightSettings({ ...light, ...patch });
      this.savePaint({ ...a, robotLight: a.robotLight });
    };
    const dull = el("input"); dull.type = "checkbox"; dull.id = "robot-dull"; dull.checked = light.dull;
    dull.onchange = () => { editLight({ dull: dull.checked }); this.renderPaint(); };
    const dullLabel = el("label", "lk-check"); dullLabel.append(dull, " Completely dull (no shine or glow)");
    b.append(dullLabel);
    const slider = (label: string, key: "brightness" | "range", min: number, max: number, step: number, suffix = "") => {
      const input = el("input"), output = el("span", "lk-val");
      input.type = "range"; input.id = `robot-light-${key}`;
      input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(light[key]);
      input.disabled = light.dull; output.textContent = `${light[key]}${suffix}`;
      input.oninput = () => { light[key] = Number(input.value); output.textContent = `${input.value}${suffix}`; editLight({ [key]: light[key] }); };
      const r = row(label, input, output); (r.firstElementChild as HTMLLabelElement).htmlFor = input.id; b.append(r);
    };
    slider("Robot brightness", "brightness", 0, 100, 0.5);
    const color = el("input"); color.type = "color"; color.id = "robot-light-color"; color.value = hex(light.color); color.disabled = light.dull;
    color.oninput = () => { light.color = num(color.value); editLight({ color: light.color }); };
    const cr = row("Light colour", color); (cr.firstElementChild as HTMLLabelElement).htmlFor = color.id; b.append(cr);
    slider("Light reach", "range", 1, 30, 0.5, " m");
    b.append(el("div", "sub", "Brightness 0 turns off the robot light. Higher values make the shell glow and illuminate nearby surfaces."));
    const cw = el("select");
    for (const [v, t] of (bodyState.choice==='dog'
      ? [["model","Source colours"],["grey","Grey tint"],["product","R1 product tint"]]
      : [["grey", "Grey (plain)"], ["product", "Product colours"], ["model", "Model colours"]]) as [Colorway,string][])
      cw.add(new Option(t, v));
    cw.value = bodyState.choice==='dog'?(a.sourceBodyColorway??'model'):a.colorway;
    cw.onchange = () => this.savePaint(bodyState.choice==='dog'?{...a,sourceBodyColorway:cw.value as Colorway}:{ ...a, colorway: cw.value as Colorway });
    b.append(row("Colourway", cw));

    const names = this.view.partNames();
    if(this.selected&&!names.includes(this.selected)){this.selected='';this.view.highlight(null);}
    const part = el("select");
    part.add(new Option(names.length ? "— choose a part —" : "no robot loaded", ""));
    for (const n of names) part.add(new Option(n + (a.parts[n] ? " •" : ""), n));
    part.value = this.selected;
    part.onchange = () => this.select(part.value);
    const pick = el("button", "btn" + (this.picking ? " on" : ""), "Pick");
    pick.type = "button";
    pick.title = "Click a part of the robot in the viewport to select it";
    pick.onclick = () => { this.picking = !this.picking; this.view.highlight(this.picking && this.selected ? this.selected : null); this.renderPaint(); };
    const prow = el("div", "lk-inline"); prow.append(part, pick);
    b.append(row("Part", prow));

    if (this.selected) {
      const cur = a.parts[this.selected] ?? GREY;
      const c = el("input"); c.type = "color"; c.value = hex(cur.color);
      const fin = el("select");
      for (const f of Object.keys(FINISH) as Finish[]) fin.add(new Option(FINISH_LABEL[f], f));
      fin.value = cur.finish;
      const base = FINISH[cur.finish];
      const knob = (label: string, k: "roughness" | "metalness" | "clearcoat", left: string, right: string) => {
        const r = el("input"), v = el("span", "lk-val");
        r.type = "range"; r.min = "0"; r.max = "1"; r.step = "0.01";
        r.value = String(cur[k] ?? base[k]);
        v.textContent = Number(r.value).toFixed(2);
        r.title = `${left} ← → ${right}`;
        r.oninput = () => { v.textContent = Number(r.value).toFixed(2); set(); };
        b.append(row(label, r, v));
        return r;
      };
      const read = (): PartPaint => ({ color: num(c.value), finish: fin.value as Finish,
        roughness: Number(rough.value), metalness: Number(metal.value), clearcoat: Number(coat.value) });
      const set = () => {
        const p = read();
        const parts = { ...a.parts, [this.selected]: p };
        const m = this.linked ? mirrorOf(this.selected) : null;
        if (m && names.includes(m)) parts[m] = p;
        this.savePaint({ ...a, parts });
        this.view.highlight(this.selected);
      };
      c.oninput = set;
      b.append(row("Colour", c), row("Finish", fin));
      const rough = knob("Dullness", "roughness", "shiny", "matte");
      const metal = knob("Metalness", "metalness", "plastic", "metal");
      const coat = knob("Shine coat", "clearcoat", "none", "lacquered");
      // a finish preset resets the three knobs to its own values
      fin.onchange = () => {
        const f = FINISH[fin.value as Finish];
        rough.value = String(f.roughness); metal.value = String(f.metalness); coat.value = String(f.clearcoat);
        set();
        this.renderPaint();
      };
      const toAll = el("button", "btn", "Apply to whole robot");
      toAll.type = "button";
      toAll.title = "Give every part this colour and finish";
      toAll.onclick = () => {
        const p = read();
        this.savePaint({ ...a, parts: Object.fromEntries(names.map((n) => [n, p])) });
        this.view.highlight(this.selected);
        this.renderPaint();
      };
      const tr = el("div", "row"); tr.append(toAll); b.append(tr);
      const link = el("input"); link.type = "checkbox"; link.checked = this.linked;
      link.onchange = () => { this.linked = link.checked; };
      const ll = el("label", "lk-check"); ll.append(link, " Same on both sides (left / right)");
      b.append(ll);
      const reset = el("button", "btn", "Reset part");
      reset.type = "button";
      reset.onclick = () => {
        const parts = { ...a.parts };
        delete parts[this.selected];
        const m = this.linked ? mirrorOf(this.selected) : null;
        if (m) delete parts[m];
        this.savePaint({ ...a, parts });
        this.view.highlight(this.selected);
        this.renderPaint();
      };
      const rr = el("div", "row"); rr.append(reset); b.append(rr);
    }
    const all = el("button", "btn ghost danger", "Reset all colours");
    all.type = "button";
    all.onclick = () => { this.savePaint({ colorway: "grey", parts: {} }); this.renderPaint(); };
    const n = Object.keys(a.parts).length;
    b.append(el("div", "sub", n ? `${n} part${n > 1 ? "s" : ""} recoloured on this robot.` :
      "Pick a part (list or click), then set its colour and finish."), all);
    if (this.headLocked) for (const control of b.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")) control.disabled = true;
  }
}
