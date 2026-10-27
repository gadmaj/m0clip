/** Control panel — plain DOM, no framework. The app wires callbacks; the panel
 * owns only presentation. The slide-out policy-manager column (import / list /
 * delete packs) is part of this class too. */
import type { RemoteActionGroup } from "../core/types";
import type { FsmState } from "../sim/fsm";
import { STATES } from "../sim/fsm";
import type { PackInfo, PolicyInfo } from "../sim/protocol";
import { TERRAINS, type MapEntry, type TerrainName } from "../sim/terrain";
import { policyPresentation } from './policy-names';
import { TerrainPicker } from './terrain-picker';
import { VisualPicker } from './visual-picker';
import { previewImage, staticPreviewOptions, policyPreview } from './preview-catalog';

export interface PanelCallbacks {
  onRobot(robot: string): void;
  onTerrain(t: TerrainName): void;
  onPolicy(name: string): void;
  onState(s: FsmState): void;
  onReset(): void;
  onRecenter(): void;
  onZeroCmd(): void;
  onScreenshot(): void;
  onRecordToggle(): void;
  onOpenTimeline(): void;
  onExportSetup(): void;
  onOpenShots(): void;
  onLoadTake(file: File): void;
  onLoadCsv(file: File, fps: number): void;
  onStopPlayback(): void;
  onImportPack(file: File): void;
  onDeletePack(id: string): void;
  onDeleteAllPacks(): void;
  onHoist(on: boolean): void;
  onNoclip(on: boolean): void;
  onFlashlight(on: boolean): void;
  onRemote(combo: string): void;
}

/** One line of the status block: key, value, and whether to highlight the value. */
export type StatusRow = [key: string, value: string, highlight?: boolean];

/** FSM states as shown in the segmented control: short label, tooltip, one-line description. */
const STATE_UI: Record<FsmState, { label: string; title: string; desc: string }> = {
  zero_torque: { label: "Zero", title: "ZeroTorque — motors off (0)", desc: "Motors off" },
  damping: { label: "Damp", title: "Damping — joint damping only (1)", desc: "Joint damping only" },
  lock: { label: "Lock", title: "Lock — hold the current pose (2)", desc: "Holding the captured pose" },
  stance: { label: "Stance", title: "Stance — hold the policy's home pose (3)", desc: "Holding the home pose" },
  policy: { label: "Policy", title: "Policy — run the selected policy (4)", desc: "Running the policy" },
};

/** 16 px stroke icons (inline SVG, currentColor). */
const ICON = {
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  upload: '<path d="M8 10.5V3M5 6l3-3 3 3M3 10.5V13h10v-2.5"/>',
  box: '<path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5L8 7.5 13.5 5M8 7.5v6"/>',
  file: '<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/>',
  timeline: '<path d="M2.5 4.5h11M2.5 11.5h11M5 2.5v4M10 9.5v4M7.5 6.5v3"/>',
};
function icon(name: keyof typeof ICON, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

type TagOf<S extends string> = S extends `${infer T}.${string}` ? T : S;
type ElOf<S extends string> =
  TagOf<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagOf<S>] : HTMLElement;

/** Tiny DOM builder: el("div.a.b", {title: "x"}, child, "text"). */
function el<S extends string>(spec: S, attrs: Record<string, string> | null = null,
                              ...kids: (Node | string)[]): ElOf<S> {
  const [tag, ...cls] = spec.split(".");
  const e = document.createElement(tag) as ElOf<S>;
  if (cls.length) e.className = cls.join(" ");
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** Button with an optional leading icon and trailing key hint. */
function button(label: string, opts: { cls?: string; icon?: keyof typeof ICON; key?: string;
                                       title?: string; onclick?: () => void } = {}): HTMLButtonElement {
  const b = el("button.btn", { type: "button" });
  if (opts.cls) b.classList.add(...opts.cls.split(" "));
  if (opts.icon) b.insertAdjacentHTML("beforeend", icon(opts.icon));
  if (label) b.append(el("span.lbl", null, label));
  if (opts.key) b.append(el("kbd", null, opts.key));
  if (opts.title) b.title = opts.title;
  if (opts.onclick) b.onclick = opts.onclick;
  return b;
}

function block(root: HTMLElement, title: string, meta?: Node | string): HTMLElement {
  const sec = el("section.blk");
  const h = el("div.blk-h", null, el("h2", null, title));
  if (meta !== undefined) h.append(el("span.meta", null, meta));
  sec.append(h);
  root.append(sec);
  return sec;
}

export class Panel {
  private robotSel!: HTMLSelectElement;
  private robotPicker!: VisualPicker;
  private terrainSel!: HTMLSelectElement;
  private terrainPicker!: TerrainPicker;
  private policySel!: HTMLSelectElement;
  private policyPicker!:VisualPicker;
  private stateBtns = new Map<FsmState, HTMLButtonElement>();
  private stateDesc!: HTMLElement;
  private statusEl!: HTMLElement;
  private padDebugEl!: HTMLElement;
  private recBtn!: HTMLButtonElement;
  private screenshotBtn!:HTMLButtonElement;
  private screenshotInfo!:HTMLElement;
  private recInfo!: HTMLElement;
  private timelineBtn!: HTMLButtonElement;
  private hoistBtn!: HTMLButtonElement;
  private noclipBtn!: HTMLButtonElement;
  private noclipOn = false;
  private flashlightBtn!: HTMLButtonElement;
  private flashlightKey!: HTMLElement;
  private flashlightOn = false;
  private remoteEl!: HTMLElement;
  private remoteKey = "";
  private hoistOn = false;
  private pbBar!: HTMLElement;
  private pbName!: HTMLElement;
  private packListEl!: HTMLElement;
  private mgrCountEl!: HTMLElement;
  private delAllBtn!: HTMLButtonElement;
  private mgrEl!: HTMLElement;
  private mgrToggleBtn!: HTMLButtonElement;
  private packCount = 0;
  private reviewing = false;
  private liveSections: HTMLElement[] = [];
  private liveControls: (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[] = [];
  private liveDisabled = new WeakMap<HTMLElement, boolean>();
  private reviewScope!: HTMLElement;
  padDebugOpen: () => boolean = () => false;

  constructor(root: HTMLElement, mgrRoot: HTMLElement, robots: string[],
              readonly cb: PanelCallbacks) {
    root.innerHTML = "";
    this.mgrEl = mgrRoot;
    this.buildManager(mgrRoot);

    // header: title + policy-pack manager toggle
    this.mgrToggleBtn = button("", { cls: "ghost", icon: "box", title: "Policy packs: import, list, delete",
                                     onclick: () => this.toggleManager() });
    this.mgrToggleBtn.setAttribute("aria-controls", "policy-manager");
    root.append(el("header.p-head", null,
      el("h1", null, "Play"), this.mgrToggleBtn));
    this.updateMgrToggle();
    this.reviewScope = el('div.blk.sub', { role: 'note' });
    this.reviewScope.hidden = true;
    root.append(this.reviewScope);

    // setup: robot → terrain → policy
    const setup = el("section.blk");
    const form = el("div.form");
    const field = (id: string, label: string, opts: string[], onchange: (v: string) => void) => {
      const sel = el("select", { id: `sel-${id}` });
      for (const o of opts) sel.add(new Option(o, o));
      sel.onchange = () => onchange(sel.value);
      form.append(el("label", { for: `sel-${id}` }, label), sel);
      return sel;
    };
    this.robotSel = field("robot", "Robot", robots, (v) => cb.onRobot(v));
    staticPreviewOptions(this.robotSel,'robot');
    this.robotPicker = new VisualPicker(this.robotSel,{id:'robot',label:'Robot',preview:value=>previewImage('robot',value)});
    form.querySelector('label[for="sel-robot"]')!.setAttribute('for','robot-trigger');
    this.terrainSel = field("terrain", "Map", TERRAINS, (v) => cb.onTerrain(v as TerrainName));
    this.terrainPicker = new TerrainPicker(this.terrainSel);
    form.append(this.terrainPicker.root);
    form.querySelector('label[for="sel-terrain"]')!.setAttribute('for', 'terrain-trigger');
    this.policySel = field("policy", "Policy", [], (v) => { this.clearPolicyCompletion(); cb.onPolicy(v); });
    this.policySel.setAttribute('aria-describedby', 'policy-description');
    this.policyPicker=new VisualPicker(this.policySel,{id:'policy',label:'Policy',title:'Choose a policy',
      preview:name=>{
        const robot=Array.from(this.policySel.options).find(option=>option.value===name)?.dataset.previewRobot;
        return robot?policyPreview(name,robot):el('span',null,'Motion preview unavailable');
      }});
    this.policyPicker.button.setAttribute('aria-describedby','policy-description');
    form.querySelector('label[for="sel-policy"]')!.setAttribute('for','policy-trigger');
    setup.append(form);
    const policyDescription=el('div.sub', { id: 'policy-description', role:'status', 'aria-live':'polite', 'aria-atomic':'true', style: 'font-size:12px;color:var(--text-2);overflow-wrap:anywhere' });
    policyDescription.hidden=true;
    setup.append(policyDescription);
    root.append(setup);
    this.liveSections.push(setup);

    // FSM state: segmented control
    const stateBlk = block(root, "State", el("span", null, el("kbd", null, "0"), "–", el("kbd", null, "4")));
    const seg = el("div.seg", { role: "radiogroup", "aria-label": "FSM state" });
    for (const s of STATES) {
      const b = el("button", { type: "button", role: "radio", "aria-checked": "false", title: STATE_UI[s].title },
                   STATE_UI[s].label);
      b.onclick = () => cb.onState(s);
      seg.append(b);
      this.stateBtns.set(s, b);
    }
    this.stateDesc = el("div.sub", null, "");
    stateBlk.append(seg, this.stateDesc);
    this.liveSections.push(stateBlk);

    // simulation controls
    const sim = block(root, "Simulation");
    this.hoistBtn = button("Hoist", { key: "H", title: "Overhead gantry: hang the robot from a support (H)",
                                      onclick: () => this.cb.onHoist(!this.hoistOn) });
    this.hoistBtn.setAttribute("aria-pressed", "false");
    this.noclipBtn = button("Noclip", { key: "N", title: "Fly the robot through walls; toggle physics (N)",
                                        onclick: () => this.cb.onNoclip(!this.noclipOn) });
    this.noclipBtn.setAttribute("aria-pressed", "false");
    this.flashlightKey = el('kbd', null, 'F');
    this.flashlightBtn = button("Flashlight", { title: "Toggle the camera flashlight (F)",
      onclick: () => this.cb.onFlashlight(!this.flashlightOn) });
    this.flashlightBtn.append(this.flashlightKey);
    this.flashlightBtn.setAttribute("aria-pressed", "false");
    this.screenshotBtn=button('Screenshot',{title:'Save a PNG after the scene finishes loading',onclick:cb.onScreenshot});
    this.screenshotBtn.id='capture-screenshot';this.screenshotBtn.setAttribute('aria-busy','false');this.screenshotBtn.setAttribute('aria-describedby','screenshot-status');
    this.screenshotInfo=el('div.screenshot-status',{id:'screenshot-status',role:'status'});
    const resetButton = button("Reset", { key: "R", title: "Reset the robot pose (R)", onclick: cb.onReset });
    const stopButton = button("Stop", { key: "Space", title: "Zero the command and re-arm the gamepad (Space)", onclick: cb.onZeroCmd });
    const recenterButton = button("Recenter", { key: "C", title: "Recenter the camera (C)", onclick: cb.onRecenter });
    this.liveControls.push(resetButton, stopButton, recenterButton, this.hoistBtn, this.noclipBtn);
    sim.append(el('div.sub', null, 'LIVE'));
    sim.append(
      el("div.row", null,
        resetButton,
        recenterButton,
        stopButton),
      el("div.row", null,
        this.hoistBtn,
        this.noclipBtn),
      el("div.row", null,
        this.flashlightBtn,
        this.screenshotBtn),this.screenshotInfo,
      el("div.sub.navigation-help", null, "Arrows or numpad start camera flight. Numpad 8/2/4/6 move, 9/3 up/down, 5 stops; +/− change speed. Drag to look; Shift faster, Backslash for precision, X for level flight. N exits."));

    // recording: motion + inputs into a take → timeline → video / Blender export
    const rec = block(root, "Recording", el("kbd", null, "V"));
    rec.dataset.workspace = 'capture';
    this.recBtn = button("Record", { key: "V", title: "Record the robot's motion and your inputs (V)",
                                     onclick: cb.onRecordToggle });
    this.recBtn.prepend(el("span.dot"));
    this.timelineBtn = button("Timeline", { icon: "timeline", title: "Open the last take on the timeline",
                                            onclick: cb.onOpenTimeline });
    this.timelineBtn.disabled = true;
    const takeInput = el("input", { type: "file", accept: ".zip,.take.zip", style: "display:none" });
    takeInput.onchange = () => {
      const f = takeInput.files?.[0];
      if (f) cb.onLoadTake(f);
      takeInput.value = "";
    };
    this.recInfo = el("div.sub", { id: "record-status", role: "status" }, "Recording and playback shortcuts: Help.");
    const shotsButton = button("Shots", { title: "Open shots stored in this browser", onclick: cb.onOpenShots });
    shotsButton.id = "open-shots";
    shotsButton.setAttribute("aria-haspopup", "dialog");
    rec.append(el("div.row", null, this.recBtn, this.timelineBtn, shotsButton,
                  button("Open take", { icon: "file", title: "Open a saved take (.take.zip)", onclick: () => takeInput.click() })),
               takeInput, this.recInfo);
    const outputButton = button("Camera / output", { title: "Configure camera, video and data output", onclick: cb.onExportSetup });
    outputButton.id = 'capture-output-settings'; outputButton.setAttribute('aria-haspopup', 'dialog');
    rec.append(el('div.row', null, outputButton));

    // remote-controller moves of the active policy (505 / 805 fight modes, 801/802 speed levels); hidden
    // when none. Placed below the fixed controls so those never shift when a policy brings moves.
    this.remoteEl = el("section.blk", { style: "display:none" });
    root.append(this.remoteEl);
    this.liveSections.push(this.remoteEl);

    // kinematic reference clip (mimic)
    const clip = block(root, "Reference clip", "kinematic, no physics");
    clip.dataset.workspace = 'capture';
    this.liveSections.push(clip);
    const fileInput = el("input", { type: "file", accept: ".csv,.txt", style: "display:none" });
    const fpsInput = el("input", { type: "number", value: "30", min: "1", title: "Clip frame rate",
                                   "aria-label": "Clip frame rate (fps)" });
    const fileBtn = button("Load CSV…", { icon: "file",
      title: "Rows: base pos (3), quat xyzw (4), joint angles — 24 (R1) or 20 (R1 Air) joints",
      onclick: () => fileInput.click() });
    fileBtn.style.justifyContent = "flex-start";
    fileInput.onchange = () => {
      const f = fileInput.files?.[0];
      if (f) cb.onLoadCsv(f, Number(fpsInput.value) || 30);
      fileInput.value = "";     // allow re-loading the same file
    };
    clip.append(el("div.row", null, fileBtn, el("div.fps", null, fpsInput, el("span", null, "fps"))), fileInput);
    this.pbName = el("span");
    this.pbBar = el("div.pb", null, this.pbName,
      button("Stop", { cls: "ghost", onclick: cb.onStopPlayback }));
    clip.append(this.pbBar);

    // status
    const st = block(root, "Status");
    st.dataset.workspace = 'inspector';
    this.statusEl = el("div", { id: "status" });
    st.append(this.statusEl);

    // gamepad debug + key reference (collapsed)
    const dbg = el("details.fold", null, el("summary", null, "Gamepad debug"));
    dbg.dataset.workspace = 'inspector';
    this.padDebugEl = el("div.pad-debug");
    dbg.append(el("div.fold-body", null, this.padDebugEl));
    root.append(dbg);
    this.padDebugOpen = () => dbg.open;

    const keys = el("details.fold", null, el("summary", null, "Live keys and gamepad"));
    keys.dataset.workspace = 'inspector';
    const k = (...ks: string[]) => {
      const dt = el("dt");
      ks.forEach((x, i) => { if (i) dt.append(" "); dt.append(x === "/" ? "/" : el("kbd", null, x)); });
      return dt;
    };
    keys.append(el("div.fold-body", null,
      el("dl.keys", null,
        k("W", "A", "S", "D"), el("dd", null, "Hold to move forward / turn"),
        k("Q", "E"), el("dd", null, "Hold to strafe"),
        k("Shift"), el("dd", null, "Full speed while held (default half)"),
        k("0", "/", "4"), el("dd", null, "FSM state"),
        k("[", "]"), el("dd", null, "Previous / next policy"),
        k("G", "/", "Shift+G"), el("dd", null, "Next / previous move"),
        k("R"), el("dd", null, "Reset"),
        k("C"), el("dd", null, "Recenter camera"),
        k("H"), el("dd", null, "Toggle hoist"),
        k("N"), el("dd", null, "Toggle noclip: drag look, WASD fly, E / Q up / down"),
        k("Arrows"), el("dd", null, "Start camera flight and move"),
        k("Numpad"), el("dd", null, "8/2 forward/back, 4/6 left/right, 9/3 up/down, 5 stop"),
        k("F"), el("dd", null, "Toggle camera flashlight"),
        k("V"), el("dd", null, "Start / stop recording a take"),
        k("Space"), el("dd", null, "Stop and re-arm the pad")),
      el("p.keys-note", null,
        "Gamepad: left stick vx / vy, right stick yaw. LT+Up stance, LT+B damping, RT+A policy, " +
        "RT+Left / Right switch policy. LB / RB / LT / RT act as the robot remote's L1 / R1 / L2 / R2; " +
        "a policy's own move combos take precedence over the app combo they shadow.")));
    root.append(keys);

    // Keep the canonical gallery roots, inputs and capture state outside the advanced panels.
    const actions = el("section", { id: "scene-actions", "aria-label": "Scene actions" });
    const choices = el("div.scene-choices");
    for (const picker of [this.terrainPicker, this.robotPicker]) {
      const label = form.querySelector<HTMLLabelElement>(`label[for="${picker.button.id}"]`)!;
      // Each root includes its original hidden select and all gallery listeners.
      choices.append(el("div.scene-choice", null, label, picker.root));
    }
    this.liveSections.push(choices);
    rec.querySelector(".blk-h")!.remove();
    rec.className = "scene-capture";
    rec.removeAttribute("data-workspace");
    rec.querySelector(".row")!.append(this.screenshotBtn);
    rec.append(this.screenshotInfo);
    this.recBtn.setAttribute("aria-describedby", "record-status");
    actions.append(choices, rec);
    document.getElementById("viewport")!.after(actions);

    // Move the existing navigation buttons, retaining ids and wireNavigation's handlers.
    const tools = el("details.fold", null, el("summary", null, "Workspace tools"));
    const toolsBody = el("div.fold-body.workspace-tools");
    for (const id of ["reset-workspace", "toggle-inspector", "toggle-panels", "fullscreen"]) {
      toolsBody.append(document.getElementById(id)!);
    }
    tools.append(toolsBody);
    root.append(tools);
    this.liveSections.push(this.mgrEl.querySelector<HTMLElement>('.pm-body')!);
    this.setReviewScope(false);
  }

  /** Recorded tracks cannot be re-simulated by changing live controls. */
  setReviewScope(reviewing: boolean): void {
    this.reviewing = reviewing;
    const reason = reviewing ? 'LIVE · Recorded motion is fixed. Close timeline to change live settings.' : 'LIVE';
    this.reviewScope.textContent = reason;
    this.reviewScope.hidden = !reviewing;
    const playBody = this.reviewScope.parentElement!;
    for (const section of this.liveSections) {
      let label = section.querySelector<HTMLElement>(':scope > .live-scope');
      if (!label) { label = el('div.sub.live-scope', { style: 'grid-column:1 / -1' }); section.prepend(label); }
      label.textContent = playBody.contains(section) ? 'LIVE' : reason;
      label.title = reviewing ? reason : '';
      for (const control of section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
        if (reviewing) {
          if (!this.liveDisabled.has(control)) this.liveDisabled.set(control, control.disabled);
          control.disabled = true;
        } else if (this.liveDisabled.has(control)) {
          control.disabled = this.liveDisabled.get(control)!;
          this.liveDisabled.delete(control);
        }
      }
    }
    for (const control of this.liveControls) {
      if (reviewing) {
        if (!this.liveDisabled.has(control)) this.liveDisabled.set(control, control.disabled);
        control.disabled = true;
        control.setAttribute('aria-description', reason);
      } else {
        if (this.liveDisabled.has(control)) {
          control.disabled = this.liveDisabled.get(control)!;
          this.liveDisabled.delete(control);
        }
        control.removeAttribute('aria-description');
      }
    }
    this.robotPicker.sync(); this.terrainPicker.sync(); this.policyPicker.sync();
    this.flashlightBtn.title = reviewing ? 'SHOT · Camera flashlight' : 'LIVE · Camera flashlight (F)';
    this.flashlightKey.hidden = reviewing;
  }

  /** Buttons for the active policy's remote actions, grouped and named (status.actions); each shows
   * the robot remote-controller combo it sends. */
  setRemoteActions(groups?: RemoteActionGroup[]) {
    const key = JSON.stringify(groups ?? []);
    if (key === this.remoteKey) return;
    this.remoteKey = key;
    this.remoteEl.innerHTML = "";
    this.remoteEl.style.display = groups?.length ? "block" : "none";
    if (!groups?.length) return;
    this.remoteEl.append(el("div.blk-h", null, el("h2", null, "Moves"),
      el("span.meta", null, el("kbd", null, "G"), el("kbd", null, "Shift+G"))));
    for (const g of groups) {
      const grid = el("div.mv-grid");
      for (const it of g.items) {
        const b = el("button.btn.mv", { type: "button", title: `${it.label} — remote ${it.combo}` },
          el("span.mv-l", null, it.label), el("span.mv-c", null, it.combo));
        b.onclick = () => this.cb.onRemote(it.combo);
        grid.append(b);
      }
      this.remoteEl.append(el("div.mv-group", null, el("h3", null, g.group), grid));
    }
    this.setReviewScope(this.reviewing);
  }

  /** Modal note shown when a policy that needs special control is selected. */
  showNotice(title: string, text: string) {
    document.getElementById("policy-notice")?.remove();
    const prevFocus = document.activeElement as HTMLElement | null;
    const ok = button("Close", { cls: "primary" });
    const dlg = el("div.dlg", { role: "dialog", "aria-modal": "true", "aria-labelledby": "policy-notice-title" },
      el("h3", { id: "policy-notice-title" }, title),
      el("div.dlg-body", null, text),
      el("div.dlg-foot", null, ok));
    const bg = el("div", { id: "policy-notice" }, dlg);
    const close = () => { bg.remove(); prevFocus?.focus?.(); };
    ok.onclick = close;
    bg.onclick = (e) => { if (e.target === bg) close(); };
    bg.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.body.append(bg);
    ok.focus();
  }

  // ---- policy manager (slide-out column) -----------------------------
  private buildManager(root: HTMLElement) {
    root.innerHTML = "";
    this.mgrCountEl = el("span.muted");
    const close = button("", { cls: "ghost icon", icon: "close", title: "Close",
                               onclick: () => this.toggleManager(false) });
    close.setAttribute("aria-label", "Close policy packs");
    root.append(el("header.p-head", null, el("h1", null, "Policy packs ", this.mgrCountEl), close));

    const zipInput = el("input", { type: "file", accept: ".zip", style: "display:none" });
    zipInput.multiple = true;
    zipInput.onchange = () => {
      for (const f of Array.from(zipInput.files ?? [])) this.cb.onImportPack(f);
      zipInput.value = "";
    };
    const importBtn = button("Import .zip…", { cls: "primary", icon: "upload",
      title: "Import policy packs or pack bundles (.zip); supports multiple files",
      onclick: () => zipInput.click() });
    importBtn.style.width = "100%";

    this.delAllBtn = button("Delete all packs", { cls: "ghost danger", icon: "trash",
      title: "Delete every imported pack from this browser",
      onclick: () => {
        if (confirm("Delete all imported policy packs? This cannot be undone.")) this.cb.onDeleteAllPacks();
      } });
    this.delAllBtn.style.width = "100%";
    this.packListEl = el("div");
    const foot = el("div.pm-foot", null, this.delAllBtn);
    this.delAllBtn.parentElement!.style.display = "none";

    root.append(el("div.pm-body", null, importBtn, zipInput,
      el("div.pm-note", null, "Packs are stored in this browser (IndexedDB). Only the current robot's packs are listed."),
      this.packListEl, foot));
  }

  private toggleManager(force?: boolean) {
    const open = force ?? this.mgrEl.classList.contains("hidden");
    this.mgrEl.classList.toggle("hidden", !open);
    this.updateMgrToggle();
  }

  private updateMgrToggle() {
    const open = !this.mgrEl.classList.contains("hidden");
    const b = this.mgrToggleBtn;
    b.querySelector(".lbl")?.remove();
    b.append(el("span.lbl", null, this.packCount ? `Packs ${this.packCount}` : "Import packs"));
    b.classList.toggle("on", open);
    b.classList.toggle("need", !this.packCount && !open);
    b.setAttribute("aria-expanded", String(open));
  }

  // ---- state pushed from the app --------------------------------------
  setRobots(robots: string[], active: string) {
    this.clearPolicyCompletion();
    this.robotSel.innerHTML = "";
    for (const r of robots) this.robotSel.add(new Option(r, r));
    this.robotSel.value = active;
    staticPreviewOptions(this.robotSel,'robot');
    this.robotPicker.sync();
  }

  private clearPolicyCompletion() {
    const description=document.getElementById('policy-description')!;
    if(description.dataset.completedFor===undefined)return;
    delete description.dataset.completedFor;
    description.textContent=policyPresentation(this.policySel.value).description;
    description.hidden=!description.textContent;
  }

  showPolicyFinished(policy:string,active:string) {
    if(this.policySel.value!==active)return;
    const description=document.getElementById('policy-description')!;
    description.dataset.completedFor=active;
    description.textContent=`${policyPresentation(policy).title} finished.`;
    description.hidden=false;
  }

  setPolicies(entries: PolicyInfo[], active: string, robot = "") {
    this.policySel.innerHTML = "";
    const description = document.getElementById('policy-description')!;
    if (!entries.length) {
      delete description.dataset.completedFor;
      description.hidden=false;
      description.textContent = 'Import a policy pack to add motions for this robot.';
      const o = new Option("No policies — import a pack", "");
      o.disabled = true;
      o.selected = true;
      this.policySel.add(o);
      this.policyPicker.sync();
      return;
    }
    // group by obs-scheme label; G1 / R1 packs with variants (R1: declared, else from the pack robot)
    // are listed Air-only first, then Air + EDU, then EDU-only (label prefix says which)
    const fam = robot.toUpperCase() || "G1";
    const variant = (e: PolicyInfo): [number, string] => {
      const m = e.models;
      if (!m?.length) return [3, ""];
      const air = m.includes("air"), edu = m.includes("edu");
      return air && !edu ? [0, `${fam} Air · `] : air && edu ? [1, `${fam} Air + EDU · `] : [2, `${fam} EDU · `];
    };
    const ordered = [...entries].sort((a, b) =>
      variant(a)[0] - variant(b)[0] || (a.fsmId ?? 1e9) - (b.fsmId ?? 1e9) || a.name.localeCompare(b.name));
    const byGroup = new Map<string, PolicyInfo[]>();
    for (const e of ordered) {
      const g = variant(e)[1] + policyPresentation(e.name).category;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(e);
    }
    for (const [g, list] of byGroup) {
      const grp = document.createElement("optgroup");
      grp.label = g;
      // prefix the FSM id the policy runs as on the robot, e.g. "[802] cpy_walk_run_29dofs/actor"
      for (const e of list) {
        const presentation = policyPresentation(e.name);
        const option = new Option(presentation.label, e.name);
        option.dataset.label=presentation.title;
        option.dataset.previewRobot=e.previewRobot;
        option.title = e.fsmId===undefined?presentation.description:presentation.description?`${presentation.description} · State ${e.fsmId}`:`State ${e.fsmId}`;
        grp.appendChild(option);
      }
      this.policySel.appendChild(grp);
    }
    this.policySel.value = active;
    const presentation = policyPresentation(active);
    this.policySel.title = presentation.label;
    if(description.dataset.completedFor!==active){
      delete description.dataset.completedFor;
      description.textContent=presentation.description;
      description.hidden=!description.textContent;
    }
    this.policyPicker.sync(true);
  }

  setPacks(packs: PackInfo[]) {
    this.packCount = packs.length;      // reflected on the manager toggle
    this.updateMgrToggle();
    this.mgrCountEl.textContent = packs.length ? String(packs.length) : "";
    this.delAllBtn.parentElement!.style.display = packs.length ? "block" : "none";

    this.packListEl.innerHTML = "";
    if (!packs.length) {
      this.packListEl.append(el("div.empty", null, "No packs imported for this robot."));
      return;
    }
    // group by robot variant for scanability
    const byRobot = new Map<string, PackInfo[]>();
    for (const p of packs) {
      if (!byRobot.has(p.robot)) byRobot.set(p.robot, []);
      byRobot.get(p.robot)!.push(p);
    }
    for (const [robot, list] of [...byRobot].sort()) {
      this.packListEl.append(el("div.pack-robot", null, robot.toUpperCase().replace("_", " "),
                                el("span", null, String(list.length))));
      for (const p of list.sort((a, b) => a.id.localeCompare(b.id))) this.packListEl.append(this.packCard(p));
    }
    this.setReviewScope(this.reviewing);
  }

  private packCard(p: PackInfo): HTMLElement {
    const meta = el("div.pack-meta", { title: p.checkpoints.join(", ") },
      `${p.checkpoints.length} ${p.checkpoints.length===1?'checkpoint':'checkpoints'}`);
    const del = button("", { cls: "ghost icon pack-del", icon: "trash", title: `Delete ${p.id}`,
      onclick: () => {
        const many = p.checkpoints.length > 1
          ? ` and its ${p.checkpoints.length} checkpoints (${p.checkpoints.join(", ")})` : "";
        if (confirm(`Delete "${p.id}"${many}?`)) this.cb.onDeletePack(p.id);
      } });
    del.setAttribute("aria-label", `Delete ${p.id}`);
    return el("div.pack-card", null,
      el("div.pack-info", null, el("div.pack-name", { title: p.id }, policyPresentation(p.id).label), meta), del);
  }

  get terrain(): TerrainName { return this.terrainSel.value as TerrainName; }

  setTerrain(t: TerrainName) { this.terrainSel.value = t; this.terrainPicker.sync(); }

  /** Converted game maps as extra terrains, one group per game (value `map:<id>`). */
  setMaps(maps: MapEntry[]) {
    const cur = this.terrainSel.value;
    this.terrainSel.querySelectorAll("optgroup").forEach((g) => g.remove());
    const byGame = new Map<string, MapEntry[]>();
    for (const m of [...maps].sort((a, b) => a.id.localeCompare(b.id))) byGame.set(m.game, [...(byGame.get(m.game) ?? []), m]);
    for (const [game, list] of byGame) {
      const g = document.createElement("optgroup");
      g.label = game;
      for (const m of list) g.appendChild(new Option(m.id.endsWith('.bsp') ? m.id : `${m.id}.bsp`, `map:${m.id}`));
      this.terrainSel.appendChild(g);
    }
    this.terrainSel.value = cur;
    this.terrainPicker.sync(true);
  }

  setState(s: FsmState) {
    for (const [k, b] of this.stateBtns) {
      b.classList.toggle("active", k === s);
      b.setAttribute("aria-checked", String(k === s));
    }
    this.stateDesc.textContent = STATE_UI[s]?.desc ?? s;
  }

  /** Key / value lines, monospace. Rendered as inline spans so innerText stays one line per row. */
  setStatus(rows: StatusRow[]) {
    const key = JSON.stringify(rows);
    if (key === this.statusEl.dataset.k) return;
    this.statusEl.dataset.k = key;
    this.statusEl.replaceChildren(...rows.map(([k, v, hl]) =>
      el("div", null, el("span.k", null, k.padEnd(8)), el(hl ? "span.v.hl" : "span.v", null, v))));
  }

  setPadDebug(text: string) { this.padDebugEl.textContent = text; }

  setRecording(on: boolean) {
    this.recBtn.querySelector(".lbl")!.textContent = on ? "Stop" : "Record";
    this.recBtn.classList.toggle("recording", on);
    this.recBtn.title = on ? "Stop recording and open the timeline (V)" : "Record the robot's motion and your inputs (V)";
  }

  /** Line under the record buttons: live length while recording, else the last take. */
  setRecordInfo(text: string) { this.recInfo.textContent = text; }

  setScreenshotState(pending:boolean,message:string){
    this.screenshotBtn.disabled=pending;this.screenshotBtn.setAttribute('aria-busy',String(pending));
    this.screenshotBtn.querySelector('.lbl')!.textContent=pending?'Preparing…':'Screenshot';
    this.screenshotBtn.setAttribute('aria-label',pending?'Preparing screenshot':'Screenshot');
    this.screenshotInfo.textContent=message;
  }

  setTakeAvailable(on: boolean) { this.timelineBtn.disabled = !on; }

  setPlayback(name: string | null) {
    this.pbBar.style.display = name ? "flex" : "none";
    if (name) { this.pbName.textContent = `Playing ${name}`; this.pbName.title = name; }
  }

  setHoist(on: boolean) {
    this.hoistOn = on;
    this.hoistBtn.classList.toggle("on", on);
    this.hoistBtn.setAttribute("aria-pressed", String(on));
  }

  setNoclip(on: boolean) {
    this.noclipOn = on;
    this.noclipBtn.classList.toggle("on", on);
    this.noclipBtn.setAttribute("aria-pressed", String(on));
  }

  setFlashlight(on: boolean) {
    this.flashlightOn = on;
    this.flashlightBtn.classList.toggle("on", on);
    this.flashlightBtn.setAttribute("aria-pressed", String(on));
  }
}
