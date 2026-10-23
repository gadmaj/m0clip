/** Floating controls over a full-bleed scene, with independent, remembered positions. */
const STORAGE = 'playpen-workspace-v1';
const WINDOW_LAYER: Record<string, number> = { deck: 250, export: 300 };
interface Placement { x: number; y: number; collapsed: boolean }
interface FloatingPanel {
  root: HTMLElement; grip: HTMLButtonElement; body: HTMLElement | null;
  placement: Placement; home: () => Placement; rank: number; activator?: HTMLButtonElement;
}
const element = (id: string) => document.getElementById(id)!;

export class FloatingWorkspace {
  private panels = new Map<string, FloatingPanel>();
  private saved: Record<string, Placement> = {};
  private dockHeight = 0;
  private workspaceTop = 84;

  constructor() {
    try { this.saved = JSON.parse(localStorage.getItem(STORAGE) || '{}') || {}; } catch { /* Use the default layout. */ }
    const menu = element('panel'), original = [...menu.children] as HTMLElement[];
    const play = this.window('play-window', 'Play', menu);
    const capture = this.window('capture-window', 'Capture', menu);
    const scene = this.window('scene-window', 'Scene', menu);
    const inspector = element('inspector');
    for (const child of original) {
      if (child.matches('.p-head')) {
        const packButton = child.querySelector('button');
        if (packButton) play.root.querySelector('.floating-titlebar')!.append(packButton);
        child.remove();
      } else if (child.dataset.workspace === 'capture') capture.body!.append(child);
      else if (child.dataset.workspace === 'inspector') inspector.append(child);
      else if (child.matches('details')) scene.body!.append(child);
      else play.body!.append(child);
    }
    this.register(play.root, play.body, 'Play', () => ({ x: 20, y: 96, collapsed: innerWidth <= 760 }));
    this.register(scene.root, scene.body, 'Scene', () => ({ x: innerWidth <= 760 ? 12 : innerWidth - 324, y: innerWidth <= 760 ? 148 : 96, collapsed: innerWidth <= 760 }));
    this.register(capture.root, capture.body, 'Capture', () => ({ x: innerWidth <= 760 ? 12 : innerWidth - 324, y: innerWidth <= 760 ? 200 : Math.min(352, innerHeight - 310), collapsed: innerWidth <= 760 }));
    this.adapt(inspector, 'Inspector', () => ({ x: 20, y: innerHeight - 62, collapsed: true }));
    this.adapt(element('policy-manager'), 'Policy packs', () => ({ x: Math.max(32, (innerWidth - 340)/2), y: 100, collapsed: false }));
    this.adapt(element('export'), 'Export', () => ({ x: Math.max(32, (innerWidth - 440)/2), y: 88, collapsed: false }));
    this.adapt(element('deck'), 'Take timeline', () => ({
      x: Math.max(12, (innerWidth - 920)/2),
      y: innerHeight - this.dockHeight - 24 - (innerWidth <= 760 ? 340 : 270), collapsed: false,
    }));

    const toolbar = element('viewport-tools');
    const switcher = document.createElement('nav');
    switcher.id = 'workspace-panels';
    switcher.setAttribute('aria-label', 'Advanced panels');
    for (const id of ['play-window', 'scene-window', 'capture-window']) {
      const panel = this.panels.get(id)!;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn';
      button.textContent = panel.grip.lastElementChild!.textContent;
      button.setAttribute('aria-controls', id);
      button.title = `Show and focus ${button.textContent} controls`;
      panel.activator = button;
      button.onclick = () => {
        panel.placement.collapsed = false;
        this.apply(panel); this.raise(panel); this.persist();
        panel.grip.focus({ preventScroll: true });
      };
      switcher.append(button);
    }
    toolbar.append(switcher);
    const dock = element('scene-actions');
    const sizeWorkspace = () => {
      this.dockHeight = dock.offsetHeight;
      this.workspaceTop = Math.max(84, toolbar.getBoundingClientRect().bottom + 12);
      const app = element('app');
      app.style.setProperty('--scene-actions-height', `${this.dockHeight}px`);
      app.style.setProperty('--workspace-top', `${this.workspaceTop}px`);
      for (const panel of this.panels.values()) this.apply(panel);
    };
    sizeWorkspace();
    const resize = new ResizeObserver(sizeWorkspace);
    resize.observe(dock); resize.observe(toolbar);

    element('reset-workspace').addEventListener('click', () => {
      for (const panel of this.panels.values()) {
        panel.placement = panel.home();
        this.apply(panel);
      }
      this.persist();
    });
    window.addEventListener('resize', () => {
      for (const panel of this.panels.values()) this.apply(panel);
    });
    // A newly opened window must be on top and within reach after a screen resize.
    for (const panel of this.panels.values()) {
      new MutationObserver(records => {
        if (!records.some(record => record.attributeName === 'hidden' ||
            (record.oldValue?.split(/\s+/).includes('hidden') ?? false) !== panel.root.classList.contains('hidden'))) return;
        if (panel.root.getClientRects().length) { this.apply(panel); this.raise(panel); }
      }).observe(panel.root, { attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'class'] });
      new ResizeObserver(() => this.apply(panel)).observe(panel.root);
    }
  }

  private window(id: string, title: string, parent: HTMLElement) {
    const root = document.createElement('section'); root.id = id;
    root.setAttribute('aria-label', `${title} panel`);
    const bar = document.createElement('header'); bar.className = 'floating-titlebar';
    const body = document.createElement('div'); body.className = 'floating-body';
    root.append(bar, body); parent.append(root);
    return { root, body };
  }

  private adapt(root: HTMLElement, title: string, home: () => Placement) {
    const body = document.createElement('div'); body.className = 'floating-body';
    body.append(...root.childNodes);
    const bar = document.createElement('header'); bar.className = 'floating-titlebar';
    // Keep existing close buttons and tabs in their original headers.
    if (root.id === 'inspector') body.querySelector(':scope > h2')?.remove();
    root.append(bar, body);
    this.register(root, body, title, home);
  }

  private register(root: HTMLElement, body: HTMLElement | null, title: string, home: () => Placement) {
    root.classList.add('floating-window');
    const bar = root.querySelector<HTMLElement>('.floating-titlebar')!;
    const grip = document.createElement('button');
    grip.type = 'button'; grip.className = 'floating-grip';
    grip.innerHTML = '<span class="grip-dots" aria-hidden="true">⠿</span><span></span>';
    grip.lastElementChild!.textContent = title;
    grip.setAttribute('aria-label', `Move ${title} panel`);
    grip.title = 'Drag to move · arrow keys to position · Home to reset';
    bar.prepend(grip);
    const collapse = document.createElement('button');
    collapse.type = 'button'; collapse.className = 'floating-collapse';
    collapse.setAttribute('aria-label', `Collapse ${title} panel`);
    bar.append(collapse);
    const saved = this.saved[root.id];
    const valid = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && typeof saved.collapsed === 'boolean';
    const panel: FloatingPanel = { root, grip, body, home, placement: valid ? { ...saved } : home(), rank: this.panels.size };
    this.panels.set(root.id, panel);
    root.style.zIndex = String((WINDOW_LAYER[root.id] ?? 20) + panel.rank);
    collapse.onclick = () => {
      panel.placement.collapsed = !panel.placement.collapsed;
      if (!panel.placement.collapsed) panel.placement.y = Math.min(panel.placement.y, Math.max(this.workspaceTop, innerHeight - this.dockHeight - 480));
      this.apply(panel); this.persist();
    };
    root.addEventListener('pointerdown', () => this.raise(panel));
    root.addEventListener('focusin', () => this.raise(panel));
    let drag: { id: number; x: number; y: number; startX: number; startY: number } | null = null;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.raise(panel);
      const rect = root.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: rect.x, startY: rect.y };
      grip.setPointerCapture(event.pointerId);
      root.classList.add('is-dragging');
      event.preventDefault(); event.stopPropagation();
    });
    grip.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      panel.placement.x = drag.startX + event.clientX - drag.x;
      panel.placement.y = drag.startY + event.clientY - drag.y;
      this.apply(panel);
    });
    const finish = () => {
      if (!drag) return;
      drag = null; root.classList.remove('is-dragging'); this.persist();
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', finish);
    grip.addEventListener('keydown', event => {
      const step = event.shiftKey ? 40 : 10;
      const directions: Record<string, [number, number]> = { ArrowLeft: [-step,0], ArrowRight: [step,0], ArrowUp: [0,-step], ArrowDown: [0,step] };
      if (directions[event.key]) {
        const [x,y] = directions[event.key]; panel.placement.x += x; panel.placement.y += y;
      } else if (event.key === 'Home') panel.placement = home();
      else return;
      event.preventDefault(); event.stopPropagation(); this.apply(panel); this.persist();
    });
    // Moving a window with arrows must not also fly the camera or drive the robot.
    this.apply(panel);
  }

  private apply(panel: FloatingPanel) {
    const { root, placement, body } = panel;
    root.classList.toggle('is-collapsed', placement.collapsed);
    if (body) body.hidden = placement.collapsed;
    const collapse = root.querySelector<HTMLButtonElement>('.floating-collapse')!;
    collapse.textContent = placement.collapsed ? '+' : '−';
    collapse.setAttribute('aria-expanded', String(!placement.collapsed));
    const title = panel.grip.lastElementChild!.textContent;
    collapse.setAttribute('aria-label', `${placement.collapsed ? 'Expand' : 'Collapse'} ${title} panel`);
    panel.activator?.setAttribute('aria-expanded', String(!placement.collapsed));
    // Keep the full panel above the real dock; scroll its body rather than its title offscreen.
    const width = root.getBoundingClientRect().width || Math.min(304, innerWidth - 24);
    const bottom = innerHeight - this.dockHeight - 24;
    const top = Math.min(this.workspaceTop, Math.max(12, bottom - 44));
    placement.x = Math.max(12, Math.min(placement.x, innerWidth - width - 12));
    // A bottom-edge placement must still leave the expanded timeline its requested height.
    // Old small heights remain valid: its body scrolls when the wrapped toolbar cannot fit.
    const height = root.id === 'deck' && !placement.collapsed
      ? Math.min(Number.parseFloat(root.style.height) || (innerWidth <= 760 ? 340 : 270), bottom - top)
      : 44;
    placement.y = Math.max(top, Math.min(placement.y, bottom - height));
    root.style.left = `${placement.x}px`; root.style.top = `${placement.y}px`;
    let space = Math.max(44, bottom - placement.y);
    if (root.id === 'scene-window') {
      const capture = this.panels.get('capture-window');
      if (capture && !capture.root.hidden && !capture.root.classList.contains('hidden')) {
        const below = capture.placement, gap = below.y - placement.y - 12;
        // Stacked controls scroll within Scene instead of covering Capture.
        if (gap >= 80 && below.x < placement.x + width && below.x + width > placement.x) space = Math.min(space, gap);
      }
    }
    root.style.setProperty('--window-space', `${space}px`);
    if (root.id === 'capture-window') {
      const scene = this.panels.get('scene-window');
      if (scene) this.apply(scene);
    }
  }

  private raise(panel: FloatingPanel) {
    const rank = panel.rank, top = this.panels.size - 1;
    if (rank === top) return;
    // Bounded ranks preserve window order without overtaking HUDs or core actions.
    for (const other of this.panels.values()) {
      if (other === panel) other.rank = top;
      else if (other.rank > rank) other.rank--;
      else continue;
      other.root.style.zIndex = String((WINDOW_LAYER[other.root.id] ?? 20) + other.rank);
    }
  }

  private persist() {
    const placements = Object.fromEntries([...this.panels].map(([id,panel]) => [id,panel.placement]));
    try { localStorage.setItem(STORAGE, JSON.stringify(placements)); } catch { /* Dragging works without storage. */ }
  }
}
