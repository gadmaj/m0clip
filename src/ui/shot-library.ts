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
  /** A take rename has committed in storage. Delivered even if this dialog session has since closed or reopened. */
  takeRenamed: (id: string, name: string) => void;
  blocked: () => string | null;
  modalChanged: (open: boolean) => void;
}

type Entry = { kind: 'take'; info: SavedShotInfo } | { kind: 'photo'; info: SavedPhotoInfo } | { kind: 'recovery'; info: RecordingRecoveryInfo };
type Card = { entry: Entry; root: HTMLElement; preview: HTMLElement; name: HTMLElement; actions: HTMLElement; rename: HTMLButtonElement | null; loaded: boolean };
type Operation = { session: number; kind: 'open' | 'backup' | 'delete' | 'rename'; controller:AbortController };
type Rename = { card: Card; form: HTMLFormElement; input: HTMLInputElement; error: HTMLElement; cancel: HTMLButtonElement };

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
  private renaming: Rename | null = null;
  /** Restores the confirmation and focus when a deferred refresh replaces the renamed card. */
  private renamed: { kind: Entry['kind']; id: string } | null = null;
  private readonly baseId: string;

  constructor(parent: HTMLElement, private readonly host: ShotLibraryHost) {
    const id = this.baseId = `shot-library-${++ShotLibraryDialog.nextId}`;
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
      if (this.renaming && !this.operation) this.cancelRename();
      else if (this.deleting && !this.operation) this.cancelConfirmation(); else this.close();
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
    this.renaming = null; this.renamed = null;
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
    if (this.operation || this.deleting || this.viewing || this.renaming) {
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
        const renamed = this.renamed; this.renamed = null;
        if (renamed && this.status.dataset.error !== 'true') {
          const card = this.cards.find(item => item.entry.kind === renamed.kind && item.entry.info.id === renamed.id);
          this.setStatus('Name saved.');
          if (card?.rename && !card.root.hidden) card.rename.focus({ preventScroll: true });
          else this.search.focus({ preventScroll: true });
        }
      }
    }
  }

  private addCard(entry: Entry): void {
    const { info } = entry;
    const root = document.createElement('article'); root.className = 'shot-library-card'; root.dataset.shotId = info.id;
    root.dataset.shotKind = entry.kind;
    const preview = document.createElement('div'); preview.className = 'shot-library-preview';
    preview.textContent = entry.kind === 'recovery' ? 'Recording recovery' : info.thumbnail ? 'Preview loading…' : 'Preview unavailable';
    const name = document.createElement('h3');
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
    // Actions read card.entry when activated, so an in-place rename reaches every later action.
    const card: Card = { entry, root, preview, name, actions, rename: null, loaded: false };
    const open = button('Open', () => { this.photoOpener = open; void this.run('open', card.entry); }); open.dataset.shotAction = 'open';
    const backup = button(entry.kind === 'photo' ? 'Save PNG' : 'Save ZIP', () => { void this.run('backup', card.entry); }); backup.dataset.shotAction = 'backup';
    const remove = button('Delete', () => this.askDelete(card.entry, remove), 'btn danger'); remove.dataset.shotAction = 'delete';
    actions.append(open, backup);
    if (entry.kind !== 'recovery') {
      card.rename = button('Rename', () => this.startRename(card)); card.rename.dataset.shotAction = 'rename';
      actions.append(card.rename);
    }
    actions.append(remove); root.append(preview, name, scene, details, actions);
    this.showName(card);
    this.grid.append(root);
    this.cards.push(card);
    this.observer?.observe(root);
  }

  private showName(card: Card): void {
    const name = card.entry.info.name || 'Untitled shot';
    card.name.textContent = name;
    for (const action of card.actions.querySelectorAll('button')) action.setAttribute('aria-label', `${action.textContent}: ${name}`);
  }

  private startRename(card: Card): void {
    if (card.entry.kind === 'recovery' || !card.rename || this.renaming || this.deleting || !this.canAct()) return;
    const form = document.createElement('form'); form.className = 'shot-library-rename'; form.noValidate = true;
    const label = document.createElement('label'); label.textContent = 'Name';
    const input = document.createElement('input'); input.type = 'text'; input.className = 'shot-library-rename-input';
    input.id = label.htmlFor = `${this.baseId}-rename-input`;
    input.value = card.entry.info.name; input.autocomplete = 'off'; input.spellcheck = false; input.enterKeyHint = 'done';
    const error = document.createElement('p'); error.className = 'shot-library-rename-error';
    error.id = `${this.baseId}-rename-error`; error.hidden = true; error.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', error.id);
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn'; save.textContent = 'Save';
    save.dataset.shotAction = 'rename-save'; save.setAttribute('aria-label', 'Save name');
    const cancel = button('Cancel', () => this.cancelRename()); cancel.dataset.shotAction = 'rename-cancel';
    cancel.setAttribute('aria-label', 'Cancel rename');
    const formActions = document.createElement('div'); formActions.className = 'shot-library-actions';
    formActions.append(save, cancel); form.append(label, input, error, formActions);
    const state: Rename = { card, form, input, error, cancel };
    form.addEventListener('submit', event => { event.preventDefault(); void this.submitRename(state); });
    input.addEventListener('input', () => this.renameError(state, ''));
    this.renaming = state;
    card.name.hidden = true; card.actions.hidden = true; card.name.after(form);
    this.setStatus(''); this.syncControls();
    input.focus({ preventScroll: true }); input.select();
  }

  private renameError(state: Rename, text: string): void {
    state.error.textContent = text; state.error.hidden = !text;
    if (text) state.input.setAttribute('aria-invalid', 'true'); else state.input.removeAttribute('aria-invalid');
  }

  private endRename(state: Rename): void {
    state.form.remove(); state.card.name.hidden = false; state.card.actions.hidden = false;
    if (this.renaming === state) this.renaming = null;
  }

  private cancelRename(): void {
    const state = this.renaming;
    if (!state || this.operation) return;
    this.endRename(state);
    this.setStatus(''); this.syncControls(); this.filter();
    if (this.pendingRefresh) { this.refresh(); this.search.focus({ preventScroll: true }); }
    else this.focusRename(state.card);
  }

  private focusRename(card: Card): void {
    if (card.rename?.isConnected && !card.root.hidden) card.rename.focus({ preventScroll: true });
    else this.search.focus({ preventScroll: true });
  }

  private async submitRename(state: Rename): Promise<void> {
    if (this.renaming !== state || this.operation) return;
    // Name and identity are captured before any await; later edits or refreshes cannot retarget this write.
    const name = state.input.value.trim(), entry = state.card.entry;
    if (entry.kind === 'recovery') return;
    if (!name) { this.renameError(state, 'Enter a name.'); state.input.focus({ preventScroll: true }); return; }
    if (name === entry.info.name) { this.cancelRename(); return; }
    if (!this.canAct()) return;
    const operation: Operation = { session: this.session, kind: 'rename', controller: new AbortController() };
    this.operation = operation; this.renameError(state, ''); state.input.readOnly = true;
    this.setStatus('Saving name…'); this.syncControls();
    let saved = false;
    try {
      let next: Entry;
      try {
        next = entry.kind === 'photo'
          ? { kind: 'photo', info: await this.host.photos.rename(entry.info.id, name) }
          : { kind: 'take', info: await this.host.library.rename(entry.info.id, name) };
      } catch (error) {
        if (this.current(operation.session) && this.renaming === state) {
          // The draft stays in the field; the row may have been deleted elsewhere, so Cancel reloads the actual list.
          this.setStatus('');
          this.renameError(state, `Name not saved. ${storageErrorMessage(error)} Try again or cancel.`);
          this.pendingRefresh = true;
        }
        return;
      }
      // Committed: the active take owner follows before the session guard, so closing Shots cannot drop it.
      if (next.kind === 'take') this.host.takeRenamed(next.info.id, next.info.name);
      // Announce only into the same dialog session and the same still-visible edit.
      if (!this.current(operation.session) || this.renaming !== state || !this.cards.includes(state.card)
        || state.card.entry !== entry) { if (this.isOpen) this.pendingRefresh = true; return; }
      state.card.entry = next; saved = true;
      this.endRename(state); this.showName(state.card); this.filter();
      this.setStatus('Name saved.');
      if (this.pendingRefresh) this.renamed = { kind: next.kind, id: next.info.id };
    } finally {
      if (this.operation === operation) this.operation = null;
      state.input.readOnly = false;
      if (this.isOpen) {
        this.syncControls();
        if (this.renaming === state) state.input.focus({ preventScroll: true });
        else if (this.pendingRefresh && !this.deleting && !this.viewing && !this.renaming) this.refresh();
        else if (saved) this.focusRename(state.card);
      }
    }
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
    // An open rename owns the grid: only its Save/Cancel stay usable until it is saved or cancelled.
    const editing = this.renaming;
    for (const action of this.grid.querySelectorAll<HTMLButtonElement>('button')) {
      action.disabled = editing && editing.form.contains(action)
        ? action === editing.cancel ? !!this.operation : busy || !!reason
        : busy || !!reason || !!editing;
    }
    this.search.disabled = !!this.deleting || !!editing;
    this.backButton.disabled = !!this.operation;
    this.savePngButton.disabled = busy || !!reason;
    this.refreshButton.disabled = busy || !!this.deleting || !!editing;
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
      if (this.renaming && !this.operation) this.cancelRename();
      else if (this.deleting && !this.operation) this.cancelConfirmation(); else this.close();
    } else if (event.repeat && (event.key === ' ' || event.key === 'Enter')
      && (event.target instanceof HTMLButtonElement || event.key === 'Enter' && event.target === this.renaming?.input)) {
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
