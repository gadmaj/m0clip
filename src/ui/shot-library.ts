import type { SavedShot, SavedShotInfo, ShotLibrary } from '../record/library';
import type { PhotoLibrary, SavedPhoto, SavedPhotoInfo } from '../record/photos';
import type { RecordingRecovery } from '../record/recovery';
import type { RecordingRecoveryInfo } from '../record/storage';
import { storageErrorMessage } from '../record/storage';
import { saveTake } from '../record/take';
import { download } from '../render/recorder';
import './shot-library.css';

export interface ShotLibraryHost {
  library: ShotLibrary;
  photos: PhotoLibrary;
  recoveries: RecordingRecovery;
  open: (saved: SavedShot, signal: AbortSignal) => void | Promise<void>;
  deleted: (id: string) => void;
  blocked: () => string | null;
  modalChanged: (open: boolean) => void;
}

type Entry = { kind: 'take'; info: SavedShotInfo } | { kind: 'photo'; info: SavedPhotoInfo } | { kind: 'recovery'; info: RecordingRecoveryInfo };
type Card = { entry: Entry; root: HTMLElement; preview: HTMLElement; loaded: boolean };
type Operation = { session: number; kind: 'open' | 'backup' | 'delete'; controller:AbortController };

function button(text: string, action: () => void, className = 'btn'): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button'; result.className = className; result.textContent = text;
  result.addEventListener('click', action);
  return result;
}

/** Browser-local shots. Listing never opens the heavy motion or scene records. */
export class ShotLibraryDialog {
  private static nextId = 0;
  private readonly dialog = document.createElement('dialog');
  private readonly title = document.createElement('h2');
  private readonly search = document.createElement('input');
  private readonly grid = document.createElement('div');
  private readonly status = document.createElement('p');
  private readonly blockedNote = document.createElement('p');
  private readonly confirmation = document.createElement('section');
  private readonly confirmationText = document.createElement('p');
  private readonly photoView = document.createElement('section');
  private readonly photoFrame = document.createElement('div');
  private readonly photoCaption = document.createElement('p');
  private readonly backButton: HTMLButtonElement;
  private readonly savePngButton: HTMLButtonElement;
  private readonly cancelDelete: HTMLButtonElement;
  private readonly confirmDelete: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private opener: HTMLElement | null = null;
  private active = false;
  private session = 0;
  private listRequest = 0;
  private loading = false;
  private operation: Operation | null = null;
  private pendingRefresh = false;
  private deleting: Entry | null = null;
  private deleteOpener: HTMLButtonElement | null = null;
  private cards: Card[] = [];
  private observer: IntersectionObserver | null = null;
  private readonly urls = new Set<string>();
  private viewing: SavedPhoto | null = null;
  private photoUrl: string | null = null;
  private photoOpener: HTMLButtonElement | null = null;

  constructor(parent: HTMLElement, private readonly host: ShotLibraryHost) {
    const id = `shot-library-${++ShotLibraryDialog.nextId}`;
    this.dialog.className = 'shot-library-dialog';
    this.dialog.setAttribute('aria-labelledby', `${id}-title`);
    this.title.id = `${id}-title`; this.title.textContent = 'Shots'; this.title.tabIndex = -1;
    const header = document.createElement('header');
    header.append(this.title, button('Close', () => this.close()));
    this.search.type = 'search'; this.search.className = 'shot-library-search';
    this.search.placeholder = 'Filter name, robot, map or kind…';
    this.search.setAttribute('aria-label', 'Filter shots by name, robot, map or kind');
    this.search.addEventListener('input', () => this.filter());
    this.grid.className = 'shot-library-grid';
    this.grid.setAttribute('aria-label', 'Saved shots');
    this.status.className = 'shot-library-status';
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.blockedNote.className = 'shot-library-blocked';
    this.blockedNote.setAttribute('role', 'status');
    this.confirmation.className = 'shot-library-confirm'; this.confirmation.hidden = true;
    this.confirmation.setAttribute('role', 'group');
    this.confirmation.setAttribute('aria-labelledby', `${id}-delete`);
    this.confirmationText.id = `${id}-delete`;
    this.cancelDelete = button('Cancel', () => this.cancelConfirmation());
    this.confirmDelete = button('Delete shot', () => { void this.run('delete', this.deleting); }, 'btn danger');
    const confirmActions = document.createElement('div'); confirmActions.className = 'shot-library-actions';
    confirmActions.append(this.cancelDelete, this.confirmDelete);
    this.confirmation.append(this.confirmationText, confirmActions);
    this.photoView.className = 'shot-library-photo'; this.photoView.hidden = true;
    this.photoView.setAttribute('aria-label', 'Original PNG capture');
    const photoActions = document.createElement('div'); photoActions.className = 'shot-library-actions';
    this.backButton = button('Back to shots', () => this.backToShots());
    this.savePngButton = button('Save PNG', () => {
      if (this.viewing) void this.run('backup', { kind: 'photo', info: this.viewing.info });
    });
    photoActions.append(this.backButton, this.savePngButton);
    this.photoFrame.className = 'shot-library-photo-frame';
    this.photoCaption.className = 'shot-library-photo-caption';
    this.photoView.append(photoActions, this.photoFrame, this.photoCaption);
    const footer = document.createElement('footer');
    const note = document.createElement('small'); note.textContent = 'Stored in this browser.';
    this.refreshButton = button('Refresh', () => this.refresh());
    footer.append(note, this.refreshButton);
    this.dialog.append(header, this.search, this.blockedNote, this.grid, this.photoView, this.confirmation, this.status, footer);
    parent.append(this.dialog);

    // Native modal focus/inert behavior plus local event isolation: browser shortcuts keep their defaults.
    for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click']) {
      this.dialog.addEventListener(type, event => event.stopPropagation());
    }
    this.dialog.addEventListener('keydown', event => this.onKey(event));
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.deleting && !this.operation) this.cancelConfirmation(); else this.close();
    });
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.finishClose();
    });
    let backdropDown = false;
    const outside = (event: MouseEvent) => {
      const rect = this.dialog.getBoundingClientRect();
      return event.target === this.dialog && (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom);
    };
    this.dialog.addEventListener('pointerdown', event => { backdropDown = outside(event); });
    this.dialog.addEventListener('click', event => {
      if (backdropDown && outside(event)) this.close();
      backdropDown = false;
    });
  }

  get isOpen(): boolean { return this.dialog.open; }

  open(): void {
    if (this.isOpen) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.search.value = '';
    if (this.operation) this.setStatus('Finishing previous request…');
    this.dialog.showModal();
    this.active = true; ++this.session;
    this.host.modalChanged(true);
    this.search.focus({ preventScroll: true });
    this.refresh();
  }

  close(): void {
    if (!this.isOpen) return;
    this.dialog.close();
    this.finishClose();
  }

  private finishClose(): void {
    if (!this.active) return;
    this.active = false; ++this.session; ++this.listRequest;
    this.operation?.controller.abort();
    this.loading = false; this.pendingRefresh = false; this.deleting = null; this.deleteOpener = null;
    this.confirmation.hidden = true; this.grid.hidden = false;
    this.clearPhoto(); this.search.hidden = false; this.refreshButton.hidden = false;
    this.photoOpener = null;
    this.clearCards();
    this.host.modalChanged(false);
    const opener = this.opener; this.opener = null;
    if (opener?.isConnected && !opener.closest('[inert]') && !opener.closest('[hidden]')) {
      opener.focus({ preventScroll: true });
    }
  }

  refresh(): void {
    if (!this.isOpen) return;
    if (this.operation || this.deleting || this.viewing) {
      this.pendingRefresh = true; this.syncControls();
      return;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    const request = ++this.listRequest, session = this.session;
    this.loading = true; this.pendingRefresh = false;
    this.clearCards(); this.setStatus('Loading shots…'); this.syncControls();
    try {
      const [takes, photos, recoveries] = await Promise.all([
        this.host.library.list(), this.host.photos.list(), this.host.recoveries.list(),
      ]);
      const entries: Entry[] = [
        ...takes.map(info => ({ kind: 'take' as const, info })),
        ...photos.map(info => ({ kind: 'photo' as const, info })),
        ...recoveries.map(info => ({ kind: 'recovery' as const, info })),
      ];
      entries.sort((a, b) => b.info.updated.localeCompare(a.info.updated) || a.kind.localeCompare(b.kind) || a.info.id.localeCompare(b.info.id));
      if (!this.current(session) || request !== this.listRequest) return;
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = this.cards.find(item => item.root === entry.target);
          if (card && !card.root.hidden) this.loadPreview(card, session);
        }
      }, { root: this.grid, rootMargin: '100px' });
      for (const entry of entries) this.addCard(entry);
      this.setStatus('');
    } catch (error) {
      if (!this.current(session) || request !== this.listRequest) return;
      this.setStatus(`Could not load shots: ${storageErrorMessage(error)} Use Refresh to try again.`, true);
    } finally {
      if (this.current(session) && request === this.listRequest) {
        this.loading = false; this.syncControls(); this.filter();
      }
    }
  }

  private addCard(entry: Entry): void {
    const { info } = entry;
    const root = document.createElement('article'); root.className = 'shot-library-card'; root.dataset.shotId = info.id;
    root.dataset.shotKind = entry.kind;
    const preview = document.createElement('div'); preview.className = 'shot-library-preview';
    preview.textContent = entry.kind === 'recovery' ? 'Recording recovery' : info.thumbnail ? 'Preview loading…' : 'Preview unavailable';
    const name = document.createElement('h3'); name.textContent = info.name || 'Untitled shot';
    const scene = document.createElement('p'); scene.className = 'shot-library-scene';
    scene.textContent = `${info.robot} · ${info.terrain}`;
    const details = document.createElement('p'); details.className = 'shot-library-details';
    const date = document.createElement('time'); date.dateTime = info.created;
    const created = new Date(info.created);
    date.textContent = Number.isNaN(created.getTime()) ? info.created : created.toLocaleString();
    const description = document.createElement('span');
    if (entry.kind === 'photo') description.textContent = `PNG capture · ${entry.info.width} × ${entry.info.height}`;
    else if (entry.kind === 'recovery') description.textContent = `${entry.info.duration.toFixed(2)} s committed`;
    else {
      description.textContent = entry.info.range
        ? `Take · ${(entry.info.range[1] - entry.info.range[0]).toFixed(2)} / ${entry.info.duration.toFixed(2)} s`
        : `Take · ${entry.info.duration.toFixed(2)} s`;
      if (entry.info.range) description.title = 'Selected / recorded duration';
    }
    details.append(description, date);
    const actions = document.createElement('div'); actions.className = 'shot-library-actions';
    const open = button('Open', () => { this.photoOpener = open; void this.run('open', entry); }); open.dataset.shotAction = 'open';
    const backup = button(entry.kind === 'photo' ? 'Save PNG' : 'Save ZIP', () => { void this.run('backup', entry); }); backup.dataset.shotAction = 'backup';
    const remove = button('Delete', () => this.askDelete(entry, remove), 'btn danger'); remove.dataset.shotAction = 'delete';
    for (const action of [open, backup, remove]) action.setAttribute('aria-label', `${action.textContent}: ${name.textContent}`);
    actions.append(open, backup, remove); root.append(preview, name, scene, details, actions);
    this.grid.append(root);
    const card = { entry, root, preview, loaded: false }; this.cards.push(card);
    this.observer?.observe(root);
  }

  private loadPreview(card: Card, session: number): void {
    if (card.loaded || !card.entry.info.thumbnail || !this.current(session)) return;
    card.loaded = true; this.observer?.unobserve(card.root);
    try {
      const url = URL.createObjectURL(card.entry.info.thumbnail); this.urls.add(url);
      const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
      image.width = 320; image.height = 200;
      image.onerror = () => {
        URL.revokeObjectURL(url); this.urls.delete(url);
        if (this.current(session) && card.root.isConnected) card.preview.textContent = 'Preview unavailable';
      };
      image.src = url; card.preview.replaceChildren(image);
    } catch {
      card.preview.textContent = 'Preview unavailable';
    }
  }

  private clearCards(): void {
    this.observer?.disconnect(); this.observer = null;
    this.grid.replaceChildren(); this.cards = [];
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private async showPhoto(saved: SavedPhoto, session: number): Promise<void> {
    const url = URL.createObjectURL(saved.png);
    const image = document.createElement('img'); image.alt = saved.info.name || 'PNG capture';
    image.width = saved.info.width; image.height = saved.info.height; image.decoding = 'async'; image.src = url;
    let attached = false;
    try {
      await image.decode();
      if (!this.current(session)) return;
      const reason = this.host.blocked(); if (reason) throw new Error(reason);
      this.clearPhoto(); this.viewing = saved; this.photoUrl = url;
      this.photoFrame.replaceChildren(image);
      this.photoCaption.textContent = `${saved.info.name || 'Untitled shot'} · ${saved.info.width} × ${saved.info.height} · Original PNG`;
      this.photoView.hidden = false; this.search.hidden = true; this.grid.hidden = true; this.refreshButton.hidden = true;
      this.setStatus(''); attached = true;
    } finally { if (!attached) URL.revokeObjectURL(url); }
  }

  private clearPhoto(): void {
    this.viewing = null; this.photoView.hidden = true; this.photoFrame.replaceChildren(); this.photoCaption.textContent = '';
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = null;
  }

  private backToShots(): void {
    if (this.operation) return;
    const opener = this.photoOpener; this.photoOpener = null;
    this.clearPhoto(); this.search.hidden = false; this.grid.hidden = false; this.refreshButton.hidden = false;
    this.setStatus(''); this.syncControls(); this.filter();
    if (this.pendingRefresh) { this.refresh(); this.search.focus({ preventScroll: true }); }
    else if (opener?.isConnected) opener.focus({ preventScroll: true });
    else this.search.focus({ preventScroll: true });
  }

  private filter(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const card of this.cards) {
      const { kind, info } = card.entry;
      const label = kind === 'photo' ? 'photo PNG capture' : kind === 'recovery' ? 'recording recovery' : 'take';
      card.root.hidden = !`${info.name} ${info.robot} ${info.terrain} ${label}`.toLocaleLowerCase().includes(query);
      if (!card.root.hidden) { ++count; if (!card.loaded) this.observer?.observe(card.root); }
    }
    if (!this.loading && !this.operation && !this.deleting && !this.viewing && this.status.dataset.error !== 'true') {
      this.setStatus(count ? '' : this.cards.length ? 'No matching shots.' : 'No saved shots. Capture a PNG or record a take to save it here.');
    }
  }

  private askDelete(entry: Entry, opener: HTMLButtonElement): void {
    if (!this.canAct()) return;
    this.deleting = entry; this.deleteOpener = opener;
    const backup = entry.kind === 'photo' ? 'PNG' : 'ZIP';
    this.confirmationText.textContent = `Delete “${entry.info.name || 'Untitled shot'}” from this browser? This cannot be undone. Saved ${backup} files are not deleted.`;
    this.confirmation.hidden = false; this.grid.hidden = true;
    this.setStatus(''); this.syncControls(); this.cancelDelete.focus({ preventScroll: true });
  }

  private cancelConfirmation(): void {
    if (this.operation) return;
    const opener = this.deleteOpener;
    this.deleting = null; this.deleteOpener = null;
    this.confirmation.hidden = true; this.grid.hidden = false;
    this.setStatus(''); this.syncControls(); this.filter();
    if (this.pendingRefresh) { this.refresh(); this.search.focus({ preventScroll: true }); }
    else opener?.focus({ preventScroll: true });
  }

  private canAct(): boolean {
    if (!this.isOpen || this.loading || this.operation) return false;
    const reason = this.host.blocked();
    this.syncControls();
    if (reason) { this.setStatus(reason, true); return false; }
    return true;
  }

  private async run(kind: Operation['kind'], entry: Entry | null): Promise<void> {
    if (!entry || !this.canAct()) return;
    const { info } = entry;
    const operation: Operation = { session: this.session, kind, controller:new AbortController() };
    this.operation = operation;
    const format = entry.kind === 'photo' ? 'PNG' : 'ZIP';
    this.setStatus(kind === 'delete' ? 'Deleting shot…' : kind === 'backup' ? `Preparing ${format}…` : 'Opening shot…');
    this.syncControls();
    try {
      if (kind === 'delete') {
        if (entry.kind === 'photo') await this.host.photos.remove(info.id);
        else if (entry.kind === 'recovery') await this.host.recoveries.remove(info.id);
        else {
          await this.host.library.remove(info.id);
          // A committed take deletion must suppress autosave, even after the dialog closes.
          this.host.deleted(info.id);
        }
        if (this.current(operation.session)) {
          this.deleting = null; this.deleteOpener = null;
          this.confirmation.hidden = true; this.grid.hidden = false;
          this.pendingRefresh = true;
          this.search.focus({ preventScroll: true });
        } else if (this.isOpen) this.pendingRefresh = true;
      } else if (entry.kind === 'photo') {
        const saved = this.viewing?.info.id === info.id ? this.viewing : await this.host.photos.open(info.id);
        if (!this.current(operation.session)) return;
        const reason = this.host.blocked(); if (reason) throw new Error(reason);
        if (kind === 'open') await this.showPhoto(saved, operation.session);
        else {
          const stem = (saved.info.name || 'shot').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+$/g, '') || 'shot';
          download(saved.png, `${stem}.png`); this.setStatus('PNG download started.');
        }
      } else if (kind === 'backup') {
        const saved = entry.kind === 'recovery' ? await this.host.recoveries.read(info.id) : await this.host.library.open(info.id);
        if (!this.current(operation.session)) return;
        const blob = await saveTake(saved.take);
        if (!this.current(operation.session)) return;
        const reason = this.host.blocked(); if (reason) throw new Error(reason);
        const stem = (saved.info.name || 'shot').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+$/g, '') || 'shot';
        download(blob, `${stem}.take.zip`); this.setStatus('ZIP download started.');
      } else {
        const saved = entry.kind === 'recovery' ? await this.host.recoveries.recover(info.id) : await this.host.library.open(info.id);
        // Recovery promotion is durable even if this session closed. Never open it into a newer session.
        if (entry.kind === 'recovery' && this.isOpen) this.pendingRefresh = true;
        if (!this.current(operation.session)) return;
        const reason = this.host.blocked(); if (reason) throw new Error(reason);
        await this.host.open(saved,operation.controller.signal);
        if(this.current(operation.session))this.close();
      }
    } catch (error) {
      if (this.current(operation.session)) {
        const action = kind === 'delete' ? 'delete shot' : kind === 'backup' ? `save ${format}` : 'open shot';
        this.setStatus(`Could not ${action}: ${storageErrorMessage(error)} Try again.`, true);
      }
    } finally {
      if (this.operation === operation) this.operation = null;
      if (this.isOpen) {
        this.syncControls();
        if (kind === 'open' && entry.kind === 'photo' && this.viewing && this.current(operation.session)) {
          this.backButton.focus({ preventScroll: true });
        }
        if (this.pendingRefresh && !this.deleting && !this.viewing) this.refresh();
      }
    }
  }

  private syncControls(): void {
    const reason = this.host.blocked();
    this.blockedNote.textContent = reason ?? ''; this.blockedNote.hidden = !reason;
    const busy = this.loading || !!this.operation;
    this.grid.setAttribute('aria-busy', String(busy));
    for (const action of this.grid.querySelectorAll<HTMLButtonElement>('button')) action.disabled = busy || !!reason;
    this.search.disabled = !!this.deleting;
    this.backButton.disabled = !!this.operation;
    this.savePngButton.disabled = busy || !!reason;
    this.refreshButton.disabled = busy || !!this.deleting;
    this.confirmDelete.disabled = busy || !!reason;
    this.cancelDelete.disabled = !!this.operation;
    this.confirmation.setAttribute('aria-busy', String(this.operation?.kind === 'delete'));
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text; this.status.hidden = !text;
    this.status.dataset.error = String(error);
  }

  private current(session: number): boolean { return this.isOpen && this.session === session; }

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && !event.shiftKey) {
      event.preventDefault();
      if (this.deleting && !this.operation) this.cancelConfirmation(); else this.close();
    } else if (event.repeat && (event.key === ' ' || event.key === 'Enter') && event.target instanceof HTMLButtonElement) {
      event.preventDefault();
    } else if (event.key === 'Tab') {
      const controls = Array.from(this.dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'))
        .filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); this.title.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); first.focus();
      }
    }
  }
}
