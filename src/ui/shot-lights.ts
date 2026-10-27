import type { SceneView } from '../render/scene';
import { MAX_SHOT_LIGHTS, validShotLights, type ShotLight, type ShotLightKind } from '../record/post';
import { VisualPicker } from './visual-picker';
import './shot-lights.css';

const KINDS: Record<ShotLightKind, string> = { point: 'Point', spot: 'Spot', directional: 'Directional' };
const DESCRIPTIONS: Record<ShotLightKind, string> = {
  point: 'Emits in every direction. Intensity falls with distance squared; measured in candela.',
  spot: 'Emits inside an aimed cone. Intensity falls with distance squared; measured in candela.',
  directional: 'Parallel rays with constant intensity, measured in lux. Position and aim set direction only.',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

/** Geometry diagrams, not simulated lighting or map screenshots. Loaded only by the gallery. */
function diagram(kind: ShotLightKind): HTMLElement {
  const root = element('div', 'shot-light-diagram');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 200 120');
  svg.setAttribute('aria-hidden', 'true');
  const paths: Record<ShotLightKind, string> = {
    point: '<circle cx="100" cy="60" r="8"/><path d="M100 42V15m0 0-4 7m4-7 4 7M100 78v27m0 0-4-7m4 7 4-7M82 60H35m0 0 7-4m-7 4 7 4M118 60h47m0 0-7-4m7 4-7 4M87 47 59 19m0 0 2 8m-2-8 8 2M113 73l28 28m0 0-8-2m8 2-2-8M113 47l28-28m0 0-8 2m8-2-2 8M87 73l-28 28m0 0 2-8m-2 8 8-2"/>',
    spot: '<circle cx="38" cy="60" r="7"/><path class="shot-light-cone" d="m45 60 115-44v88Z"/><path d="M55 60h100m0 0-9-5m9 5-9 5M56 55l90-31m0 0-6 7m6-7-10-1M56 65l90 31m0 0-6-7m6 7-10 1"/><path class="shot-light-guide" d="M160 16q20 44 0 88"/>',
    directional: '<path d="M27 28h146m0 0-10-6m10 6-10 6M27 60h146m0 0-10-6m10 6-10 6M27 92h146m0 0-10-6m10 6-10 6"/>',
  };
  svg.innerHTML = paths[kind];
  root.append(svg);
  return root;
}

/** Shared live/shot editor; commits a complete validated physical-light snapshot. */
export class ShotLightsPanel {
  readonly root = element('details', 'fold shot-lights');
  private readonly body = element('div', 'fold-body');
  private readonly summary = element('summary', '', 'Shot lights');
  private readonly status = element('div', 'sub shot-light-status');
  private readonly list = element('div', 'shot-light-list');
  private pickers: VisualPicker[] = [];
  private active = false;
  private readOnly = false;
  private shot = false;
  private selected = '';
  private createKind: ShotLightKind = 'point';
  private invalid = new Set<HTMLInputElement>();
  private addButton: HTMLButtonElement | null = null;

  constructor(private view: SceneView, private changed: () => void, private reset: () => void) {
    this.root.hidden = true;
    this.root.append(this.summary, this.body);
    this.status.id = 'shot-light-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
  }

  show(readOnly: boolean, shot = false): void {
    this.active = true;
    this.readOnly = readOnly;
    this.shot = shot;
    this.summary.textContent = shot ? 'Lights · SHOT' : 'Lights · LIVE';
    this.root.hidden = false;
    this.render();
  }


  setReadOnly(on: boolean): void {
    this.readOnly = on;
    if (this.active) this.render();
  }

  reveal(): void {
    if (!this.active) return;
    this.root.open = true;
  }

  private kindPicker(value: ShotLightKind, id: string, label: string, change: (kind: ShotLightKind, select: HTMLSelectElement) => void, disabled = false): HTMLElement {
    const select = element('select');
    for (const [kind, title] of Object.entries(KINDS)) select.add(new Option(title, kind));
    select.value = value;
    select.disabled = this.readOnly || disabled;
    select.onchange = () => {
      if (!this.active || this.readOnly || select.disabled) return;
      change(select.value as ShotLightKind, select);
    };
    const picker = new VisualPicker(select, {
      id, label, search: false,
      preview: kind => diagram(kind as ShotLightKind),
      description: kind => DESCRIPTIONS[kind as ShotLightKind],
    });
    this.pickers.push(picker);
    return picker.root;
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    const row = element('div', 'shot-light-field');
    const title = element('label', '', label);
    if (control.id) title.htmlFor = control.id;
    else control.setAttribute('aria-label', label);
    row.append(title, control);
    return row;
  }

  private report(input: HTMLInputElement | null, message: string): void {
    if (input) {
      input.setCustomValidity(message);
      input.setAttribute('aria-invalid', String(!!message));
      if (message) this.invalid.add(input); else this.invalid.delete(input);
    }
    this.status.textContent = message || (this.invalid.size ? 'Correct the marked light values. The last valid lighting is still applied.' : '');
    this.status.classList.toggle('error', !!this.status.textContent);
    if (this.addButton) this.addButton.disabled = this.readOnly || this.invalid.size > 0 || this.view.getShotLights().length >= MAX_SHOT_LIGHTS;
  }

  private commit(id: string, patch: Partial<ShotLight>, input: HTMLInputElement | null = null): boolean {
    if (!this.active || this.readOnly) return false;
    const lights = this.view.getShotLights();
    const index = lights.findIndex(light => light.id === id);
    if (index < 0) return false;
    lights[index] = { ...lights[index], ...patch };
    if (!validShotLights(lights)) {
      const message = 'name' in patch ? 'Use a unique light name of 1–120 characters.'
        : 'position' in patch || 'target' in patch || 'kind' in patch ? 'Use finite coordinates. Spot and directional lights need different position and aim points.'
        : 'Use a value within the displayed limits.';
      this.report(input, message);
      return false;
    }
    this.report(input, '');
    this.view.setShotLights(lights);
    this.changed();
    this.renderList();
    return true;
  }

  private renderList(): void {
    this.list.replaceChildren();
    for (const light of this.view.getShotLights()) {
      const button = element('button', 'btn shot-light-entry');
      button.type = 'button';
      button.disabled = this.readOnly;
      button.setAttribute('aria-pressed', String(light.id === this.selected));
      const name = element('span', 'shot-light-name', light.name);
      const state = element('span', 'shot-light-kind', `${KINDS[light.kind]}${light.enabled ? '' : ' · off'}`);
      button.append(name, state);
      button.onclick = () => {
        if (!this.active || this.readOnly) return;
        this.selected = light.id;
        this.render();
        this.body.querySelector<HTMLInputElement>('#shot-light-name')?.focus();
      };
      this.list.append(button);
    }
  }

  private add(): void {
    if (!this.active || this.readOnly || this.invalid.size) return;
    const lights = this.view.getShotLights();
    if (lights.length >= MAX_SHOT_LIGHTS) return;
    const camera = this.view.camera.position, target = this.view.controls.target, kind = this.createKind;
    let suffix = 1;
    while (lights.some(light => light.name === `${KINDS[kind]} ${suffix}`)) ++suffix;
    const light: ShotLight = {
      id: crypto.randomUUID(), name: `${KINDS[kind]} ${suffix}`, kind, enabled: true, color: 0xffffff,
      intensity: kind === 'point' ? 25 : kind === 'spot' ? 50 : 1.5,
      position: [camera.x, camera.y, camera.z], target: [target.x, target.y, target.z],
      range: 10, angle: 35, penumbra: 0.3,
    };
    if (!validShotLights([...lights, light])) {
      this.report(null, 'Move the camera away from its orbit target before adding an aimed light.');
      return;
    }
    this.view.setShotLights([...lights, light]);
    this.selected = light.id;
    this.changed();
    this.render();
    this.body.querySelector<HTMLInputElement>('#shot-light-name')?.focus();
  }

  private number(light: ShotLight, key: 'intensity' | 'range' | 'angle' | 'penumbra', label: string, min: number, max: number, step: string): HTMLElement {
    const input = element('input');
    input.type = 'number'; input.id = `shot-light-${key}`;
    input.min = String(min); input.max = String(max); input.step = step; input.value = String(light[key]);
    input.disabled = this.readOnly;
    input.setAttribute('aria-describedby', this.status.id);
    input.oninput = () => {
      if (!this.active || this.readOnly) return;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || value < min || value > max || key === 'intensity' && value === 0) {
        this.report(input, key === 'intensity' ? `${label}: enter a value above 0, up to ${max}.` : `${label}: enter a finite value from ${min} to ${max}.`);
        return;
      }
      this.commit(light.id, { [key]: value }, input);
    };
    return this.field(label, input);
  }

  private vector(light: ShotLight, key: 'position' | 'target', label: string): HTMLElement {
    const group = element('fieldset', 'shot-light-vector');
    group.append(element('legend', '', label));
    const axes = element('div', 'shot-light-axes');
    const inputs = ['X', 'Y', 'Z'].map((axis, index) => {
      const input = element('input');
      input.type = 'number'; input.step = 'any'; input.value = String(light[key][index]);
      input.id = `shot-light-${key}-${axis.toLowerCase()}`; input.disabled = this.readOnly;
      input.setAttribute('aria-describedby', this.status.id);
      axes.append(this.field(axis, input));
      return input;
    });
    for (const input of inputs) input.oninput = () => {
      if (!this.active || this.readOnly) return;
      const value = inputs.map(field => field.valueAsNumber);
      if (!value.every(Number.isFinite)) {
        this.report(input, `${label}: enter finite X, Y and Z coordinates in metres.`);
        return;
      }
      if (this.commit(light.id, { [key]: value as [number, number, number] }, input))
        for (const field of inputs) this.report(field, '');
    };
    const place = element('button', 'btn', key === 'position' ? 'Place at camera' : 'Aim at orbit target');
    place.type = 'button'; place.disabled = this.readOnly;
    place.onclick = () => {
      if (!this.active || this.readOnly) return;
      const point = key === 'position' ? this.view.camera.position : this.view.controls.target;
      const value: [number, number, number] = [point.x, point.y, point.z];
      if (!this.commit(light.id, { [key]: value })) return;
      inputs.forEach((input, index) => { input.value = String(value[index]); this.report(input, ''); });
    };
    group.append(axes, place);
    return group;
  }

  private render(): void {
    for (const picker of this.pickers) picker.dispose();
    this.pickers = [];
    this.invalid.clear();
    this.status.textContent = '';
    this.status.classList.remove('error');
    this.body.replaceChildren();
    const lights = this.view.getShotLights();
    if (!lights.some(light => light.id === this.selected)) this.selected = lights[0]?.id ?? '';
    const limit = lights.length >= MAX_SHOT_LIGHTS;
    const create = element('div', 'shot-light-create');
    const kind = this.kindPicker(this.createKind, 'shot-light-new-kind', 'New light type', value => { this.createKind = value; }, limit);
    this.addButton = element('button', 'btn', 'Add light');
    this.addButton.type = 'button'; this.addButton.disabled = this.readOnly || limit;
    this.addButton.onclick = () => this.add();
    create.append(kind, this.addButton);
    this.body.append(element('div', 'sub', `${lights.length} / ${MAX_SHOT_LIGHTS} lights · world metres · Z up`), create);
    if (!lights.length) this.body.append(element('div', 'sub', 'No added lights.'));
    if (limit) this.body.append(element('div', 'sub', 'Eight-light limit reached. Remove a light to add another.'));
    this.renderList();
    this.body.append(this.list);
    const light = lights.find(item => item.id === this.selected);
    if (light) {
      const editor = element('div', 'shot-light-editor');
      const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = light.enabled;
      enabled.disabled = this.readOnly; enabled.onchange = () => { this.commit(light.id, { enabled: enabled.checked }); };
      const enabledLabel = element('label', 'lk-check'); enabledLabel.append(enabled, ' Enabled');
      const name = element('input'); name.type = 'text'; name.id = 'shot-light-name'; name.value = light.name;
      name.maxLength = 120; name.disabled = this.readOnly; name.setAttribute('aria-describedby', this.status.id);
      name.oninput = () => { this.commit(light.id, { name: name.value.trim() }, name); };
      const type = this.kindPicker(light.kind, 'shot-light-kind', 'Light type', (value, select) => {
        if (this.commit(light.id, { kind: value })) this.render();
        else { select.value = light.kind; this.pickers.find(picker => picker.root.contains(select))?.sync(); }
      });
      const color = element('input'); color.type = 'color'; color.id = 'shot-light-color';
      color.value = `#${light.color.toString(16).padStart(6, '0')}`; color.disabled = this.readOnly;
      color.oninput = () => { this.commit(light.id, { color: Number.parseInt(color.value.slice(1), 16) }); };
      editor.append(enabledLabel, this.field('Name', name), this.field('Type', type), this.field('Colour', color),
        this.number(light, 'intensity', light.kind === 'directional' ? 'Intensity (lux)' : 'Intensity (cd)', 0, 100000, 'any'),
        this.vector(light, 'position', 'World position (m)'));
      if (light.kind !== 'point') editor.append(this.vector(light, 'target', 'Aim point (m)'));
      if (light.kind !== 'directional') editor.append(this.number(light, 'range', 'Range (m)', 0, 10000, 'any'), element('div', 'sub', 'Range 0 has no cutoff.'));
      if (light.kind === 'spot') editor.append(this.number(light, 'angle', 'Half-angle (°)', 1, 89, 'any'), this.number(light, 'penumbra', 'Penumbra', 0, 1, 'any'));
      const remove = element('button', 'btn ghost danger', 'Remove light'); remove.type = 'button'; remove.disabled = this.readOnly;
      remove.onclick = () => {
        if (!this.active || this.readOnly) return;
        this.view.setShotLights(this.view.getShotLights().filter(item => item.id !== light.id));
        this.changed(); this.render();
        this.addButton?.focus();
      };
      editor.append(remove);
      this.body.append(editor);
    }
    const reset = element('button', 'btn ghost danger', this.shot ? 'Reset shot appearance' : 'Clear added lights');
    reset.type = 'button'; reset.disabled = this.readOnly;
    reset.onclick = () => { if (this.active && !this.readOnly) this.reset(); };
    this.body.append(this.status, element('div', 'sub', 'Added lights are unshadowed.'), reset);
  }
}
