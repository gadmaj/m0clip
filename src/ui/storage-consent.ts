import './storage-consent.css';

type StorageState = 'checking' | 'best-effort' | 'requesting' | 'granted' | 'denied' | 'check-error' | 'error' | 'unsupported';
const VISIT_KEY = 'm0clip-storage-visited-v1';
const DISMISS_KEY = 'm0clip-storage-dismissed-v1';
const STATUS: Record<StorageState, string> = {
  checking: 'Checking browser storage…',
  'best-effort': 'Saved data uses best-effort storage. The browser may remove it when space is low.',
  requesting: 'Asking the browser to keep this site’s data…',
  granted: 'Persistent storage is enabled for this site. Saved data is protected from automatic eviction.',
  denied: 'The browser did not grant persistent storage. Saving still works with best-effort storage. You can try again here or in Help.',
  error: 'The storage request failed. Saving still uses best-effort storage. Try again here or in Help.',
  'check-error': 'Storage status could not be checked. You can still ask for persistent storage. Saving uses best-effort storage.',
  unsupported: 'Persistent storage is unavailable in this browser or connection. Saving can still use best-effort browser storage.',
};

/** Optional origin-wide eviction protection; never changes the saved-library records. */
export class StorageConsent {
  readonly helpSection = document.createElement('section');
  private readonly prompt = document.createElement('aside');
  private readonly helpStatus = document.createElement('p');
  private readonly promptStatus = document.createElement('p');
  private readonly helpAction = document.createElement('button');
  private readonly promptAction = document.createElement('button');
  private readonly dismissAction = document.createElement('button');
  private state: StorageState = 'checking';
  private entered = false;
  private dismissed = false;
  private revision = 0;

  constructor(parent: HTMLElement, onInteract: () => void) {
    const heading = document.createElement('h3');
    heading.textContent = 'Browser storage';
    this.helpSection.className = 'storage-consent-help';
    const explanation = document.createElement('p');
    explanation.textContent = 'Keep this site’s saved Shots, imported data and managed caches from automatic eviction. This does not pin ordinary HTTP downloads in the browser cache.';
    const limits = document.createElement('p');
    limits.textContent = 'Not a backup: clearing site data still removes it, and storage limits still apply. This does not give Downloads-folder access or move data between site addresses.';
    this.helpStatus.id = 'storage-consent-help-status';
    this.helpSection.append(heading, explanation, this.helpStatus, this.helpAction, limits);

    this.prompt.className = 'storage-consent';
    this.prompt.hidden = true;
    this.prompt.setAttribute('aria-labelledby', 'storage-consent-title');
    const title = document.createElement('h3');
    title.id = 'storage-consent-title';
    title.textContent = 'Keep files on this device';
    const description = document.createElement('p');
    description.textContent = 'Ask this browser to protect saved Shots and site data from automatic eviction. Not a backup; you can still clear site data.';
    this.promptStatus.id = 'storage-consent-prompt-status';
    const actions = document.createElement('div');
    actions.className = 'storage-consent-actions';
    this.dismissAction.type = 'button';
    this.dismissAction.className = 'btn';
    this.dismissAction.textContent = 'Not now';
    this.dismissAction.addEventListener('click', () => {
      this.rememberDismissal();
      this.prompt.hidden = true;
    });
    actions.append(this.promptAction, this.dismissAction);
    this.prompt.append(title, description, this.promptStatus, actions);
    // Appearance never takes focus or interrupts play; intentional focus stops held input.
    this.prompt.addEventListener('focusin', onInteract);
    for (const type of ['keydown', 'keyup', 'click']) {
      this.prompt.addEventListener(type, event => event.stopPropagation());
    }
    parent.append(this.prompt);

    const controls: [HTMLButtonElement, HTMLParagraphElement][] = [[this.helpAction, this.helpStatus], [this.promptAction, this.promptStatus]];
    for (const [button, status] of controls) {
      button.type = 'button';
      button.className = 'btn';
      button.setAttribute('aria-describedby', status.id);
      button.addEventListener('click', event => {
        // Invoke persist directly in the native click task, never after a status query.
        if (event.isTrusted) void this.request();
      });
      status.className = 'storage-consent-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
    }
    this.render();
  }

  /** Called only by the real scene-entry callback, not by loading or selection. */
  sceneEntered(): void {
    if (this.entered) return;
    this.entered = true;
    let returning = false;
    try {
      returning = localStorage.getItem(VISIT_KEY) === '1';
      this.dismissed = localStorage.getItem(DISMISS_KEY) === '1';
      localStorage.setItem(VISIT_KEY, '1');
    } catch {
      // Without a durable marker, do not guess that this is a return or nag each load.
      returning = false;
    }
    void this.offerOnReturn(returning);
  }

  private async offerOnReturn(returning: boolean): Promise<void> {
    await this.refresh();
    if (returning && !this.dismissed && this.state === 'best-effort') this.prompt.hidden = false;
  }

  /** Refreshes status on Help entry without requesting any permission. */
  async refresh(): Promise<void> {
    if (this.state === 'requesting') return;
    const revision = ++this.revision;
    this.state = 'checking';
    this.render();
    try {
      const storage = navigator.storage;
      if (!storage || typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') {
        this.state = 'unsupported';
      } else {
        const persisted = await storage.persisted();
        if (revision !== this.revision) return;
        this.state = persisted ? 'granted' : 'best-effort';
      }
    } catch {
      if (revision !== this.revision) return;
      this.state = 'check-error';
      this.render();
      return;
    }
    if (this.state === 'granted') this.prompt.hidden = true;
    this.render();
  }

  private async request(): Promise<void> {
    if (this.state === 'requesting' || this.state === 'granted') return;
    ++this.revision;
    this.rememberDismissal();
    try {
      const storage = navigator.storage;
      if (!storage || typeof storage.persist !== 'function') {
        this.state = 'unsupported';
      } else {
        const result = storage.persist();
        this.state = 'requesting';
        this.render();
        this.state = await result ? 'granted' : 'denied';
      }
    } catch {
      this.state = 'error';
    }
    this.render();
  }

  private rememberDismissal(): void {
    this.dismissed = true;
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* Keep the choice for this page when storage is blocked. */ }
  }

  private render(): void {
    const busy = this.state === 'checking' || this.state === 'requesting';
    const disabled = busy || this.state === 'granted' || this.state === 'unsupported';
    const label = this.state === 'granted' ? 'Storage protected'
      : this.state === 'requesting' ? 'Requesting…'
      : this.state === 'checking' ? 'Checking…'
      : this.state === 'denied' || this.state === 'error' || this.state === 'check-error' ? 'Try again' : 'Keep files';
    for (const button of [this.helpAction, this.promptAction]) {
      button.disabled = disabled;
      button.textContent = label;
      button.setAttribute('aria-busy', String(busy));
    }
    for (const element of [this.helpSection, this.prompt]) element.dataset.state = this.state;
    this.helpStatus.textContent = this.promptStatus.textContent = STATUS[this.state];
    this.dismissAction.textContent = this.state === 'best-effort' || this.state === 'checking' ? 'Not now' : 'Close';
  }
}
