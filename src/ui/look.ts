/** Look of the scene: lighting (presets + every knob, shadows) and the robot's paint (colourway +
 * per-part colour / finish, picked from a list or by clicking the robot). Both persist per browser;
 * paint is kept per robot model. */
import type { Finish } from "../render/paint";
import { FINISH } from "../render/paint";
import type { PartPaint } from "../render/scene";
import { GREY, STUDIO, type Appearance, type Colorway, type Lighting, type SceneView } from "../render/scene";

/** Sun / ambient a map ships (Source light_environment), from its bundle manifest. */
export interface MapLight { azimuth: number; elevation: number; color: number; intensity: number; ambient: number; ambientColor: number }

type Preset = "auto" | "studio" | "daylight" | "overcast" | "night" | "map" | "custom";
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
  auto: "Auto (map's own light, else studio)", studio: "Studio", daylight: "Daylight", overcast: "Overcast",
  night: "Night", map: "Map (light_environment)", custom: "Custom",
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
  /** clicking the robot picks a part while on */
  picking = false;

  constructor(parent: HTMLElement, readonly view: SceneView) {
    const saved = load(LIGHT_KEY, { preset: "auto" as Preset, custom: STUDIO });
    this.preset = saved.preset;
    this.custom = { ...STUDIO, ...saved.custom };
    this.paints = (() => { try { return JSON.parse(localStorage.getItem(PAINT_KEY) ?? "{}"); } catch { return {}; } })();
    const L = fold("Lighting"), P = fold("Robot colours");
    this.lightBody = L.body;
    this.paintBody = P.body;
    parent.append(L.root, P.root);
    this.applyLighting();
    this.renderLighting();
  }

  // ---- lighting ----------------------------------------------------------------
  /** The terrain's own light (null off a map); "Auto" follows it. */
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
    if (p === "map" || p === "auto") return this.mapLight ? this.fromMap(this.mapLight) : STUDIO;
    return PRESETS[p];
  }

  private applyLighting() {
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
    if (this.mapLight) b.append(el("div", "sub", "This map ships its own sun (light_environment): the Auto and Map presets use it."));
  }

  // ---- robot paint -------------------------------------------------------------
  /** A model was (re)built: re-list its parts and re-apply its saved paint. */
  onModel(robot: string) {
    this.robot = robot;
    if (!this.view.partNames().includes(this.selected)) this.selected = "";
    this.view.setAppearance(this.app());
    this.view.highlight(this.picking && this.selected ? this.selected : null);
    this.renderPaint();
  }

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
    const b = this.paintBody, a = this.app();
    b.replaceChildren();
    const cw = el("select");
    for (const [v, t] of [["grey", "Grey (plain)"], ["product", "Product colours"], ["model", "Model colours"]] as const)
      cw.add(new Option(t, v));
    cw.value = a.colorway;
    cw.onchange = () => this.savePaint({ ...a, colorway: cw.value as Colorway });
    b.append(row("Colourway", cw));

    const names = this.view.partNames();
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
  }
}
