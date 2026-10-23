import './help.css';
import type { StorageConsent } from './storage-consent';

export type HelpContext = 'play' | 'flight' | 'timeline';
export interface HelpDialogOptions {
  /** Clear held movement, stop flight and suppress gamepad input while open. */
  onOpen?: () => void;
  onClose?: () => void;
  context?: () => HelpContext;
  storageConsent?: StorageConsent;
}

type HelpSection = { id: string; title: string; intro?: string; rows: [string[], string][] };
const SECTIONS: HelpSection[] = [
  { id: 'play', title: 'Play', intro: 'Robot controls apply outside Flight and Timeline. Release movement keys to stop.', rows: [
    [['W / S'], 'Forward / backward'], [['A / D'], 'Turn left / right'], [['Q / E'], 'Strafe left / right'],
    [['Shift'], 'Hold with movement for full command speed (normally half speed)'],
    [['Space'], 'Stop robot commands and recalibrate the gamepad neutral'],
    [['0', '1', '2', '3', '4'], 'Zero torque / damping / lock / stance / policy'],
    [['[ / ]'], 'Previous / next policy'], [['G / Shift+G'], 'Next / previous remote action, when the policy provides them'],
    [['R'], 'Reset'], [['C'], 'Recenter view'], [['H'], 'Toggle hoist'], [['F'], 'Toggle flashlight'],
    [['Tab'], 'Toggle panels when the viewport has focus'],
  ] },
  { id: 'flight', title: 'Flight', intro: 'N toggles Flight. Arrow or numpad movement keys also enter Flight. Robot movement keys become camera controls.', rows: [
    [['W / S', '↑ / ↓', 'Num 8 / 2'], 'Forward / backward'],
    [['A / D', '← / →', 'Num 4 / 6'], 'Left / right'],
    [['Space', 'E', 'Page Up', 'Num 7 / 9'], 'Up'],
    [['Ctrl+Space', 'Q / C', 'Page Down', 'Num 1 / 3'], 'Down'],
    [['Shift', '\\'], 'Hold for faster / slower flight'],
    [['I / K', 'J / L', 'U / O'], 'Pitch / yaw / roll'],
    [['Mouse drag'], 'Look around; hold both mouse buttons to move forward'],
    [['Wheel', 'Num + / −'], 'Adjust flight speed'], [['X'], 'Toggle level hover'],
    [['Esc', 'Num 0 / 5'], 'Stop camera movement (stay in Flight)'],
    [['P'], 'Start / cancel robot placement; Escape also cancels placement'], [['N'], 'Exit Flight'],
  ] },
  { id: 'capture', title: 'Capture', intro: 'Save a screenshot or record a take.', rows: [
    [['V'], 'Start recording; press again to stop and open Timeline'],
    [['Screenshot'], 'Download a PNG and save a copy in Shots'],
    [['Timeline'], 'Review the last take'],
    [['Shots'], 'Browse saved takes, PNGs and recording recoveries'],
    [['Open take'], 'Load a saved .take.zip'],
  ] },
  { id: 'timeline', title: 'Timeline', intro: 'Review pauses the live simulation. These keys control the take, not the robot or Flight camera.', rows: [
    [['Space'], 'Play / pause'], [['← / →'], 'Previous / next frame'], [['Shift+← / →'], 'Seek backward / forward one second'],
    [['↑ / ↓'], 'Previous / next event'], [['Home / End'], 'Go to range start / end'],
    [['I / O'], 'Set range in / out'], [['X'], 'Clear range'], [['L'], 'Toggle loop'],
    [['F'], 'Fit timeline'], [['Esc'], 'Close Timeline (or close the export dialog first)'],
  ] },
  { id: 'gamepad', title: 'Gamepad', intro: 'Press a gamepad button to connect. Keep the sticks still for about half a second to calibrate. Standard controller labels; policy remote actions can override these combos.', rows: [
    [['Left stick'], 'Forward / backward and strafe'], [['Right stick'], 'Turn'],
    [['LT + ↑'], 'Stance'], [['LT + B'], 'Damping'], [['LT + Y'], 'Zero torque'], [['LT + X'], 'Lock'],
    [['RT + A'], 'Policy'], [['RT + ← / →'], 'Previous / next policy'], [['RT + B'], 'Reset'],
    [['Space / Stop'], 'Recover drift: release the sticks while neutral recalibrates'],
  ] },
];

/** No global keyboard listeners: the host owns shortcuts and input suppression. */
export class HelpDialog {
  readonly button = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly content = document.createElement('div');
  private readonly title = document.createElement('h2');
  private readonly closeButton = document.createElement('button');
  private opener: HTMLElement | null = null;
  private active = false;
  private static nextId = 0;

  constructor(private readonly options: HelpDialogOptions = {}) {
    const titleId = `help-title-${++HelpDialog.nextId}`;
    this.button.type = 'button';
    this.button.className = 'btn help-trigger';
    this.button.textContent = '? Help';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.title = 'Controls and shortcuts (?)';
    this.button.addEventListener('click', () => this.open(this.button));
    this.dialog.className = 'help-dialog';
    this.dialog.setAttribute('aria-labelledby', titleId);
    const header = document.createElement('header');
    header.className = 'help-header';
    const title = this.title;
    title.id = titleId;
    title.tabIndex = -1;
    title.textContent = 'Controls & shortcuts';
    this.closeButton.type = 'button';
    this.closeButton.className = 'btn';
    this.closeButton.textContent = 'Close';
    this.closeButton.setAttribute('aria-label', 'Close help');
    this.closeButton.addEventListener('click', () => this.close());
    header.append(title, this.closeButton);
    this.content.className = 'help-content';
    this.dialog.append(header, this.content);
    this.dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => {
      // A rapid close/open can leave an old native close event queued.
      if (!this.dialog.open) this.finishClose();
    });
  }

  get isOpen(): boolean { return this.dialog.open; }

  /** Optional: the trigger is not inserted until the host explicitly attaches it. */
  attachTo(toolbar: HTMLElement): void { toolbar.append(this.button); }

  open(opener?: HTMLElement): void {
    if (this.isOpen) return;
    this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const context = this.options.context?.() ?? 'play';
    const ordered = [...SECTIONS].sort((a, b) => Number(b.id === context) - Number(a.id === context));
    this.content.replaceChildren();
    const note = document.createElement('p');
    note.className = 'help-note';
    note.textContent = 'Shortcuts do not apply while typing in a field. Escape closes Help; Tab moves between its controls.';
    this.content.append(note);
    if (this.options.storageConsent) {
      this.content.append(this.options.storageConsent.helpSection);
      void this.options.storageConsent.refresh();
    }
    for (const section of ordered) {
      const element = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = section.title + (section.id === context ? ' · current mode' : '');
      element.append(heading);
      if (section.intro) {
        const intro = document.createElement('p');
        intro.textContent = section.intro;
        element.append(intro);
      }
      const list = document.createElement('dl');
      for (const [keys, description] of section.rows) {
        const term = document.createElement('dt');
        for (const key of keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          term.append(kbd);
        }
        const detail = document.createElement('dd');
        detail.textContent = description;
        list.append(term, detail);
      }
      element.append(list);
      this.content.append(element);
    }
    if (!this.dialog.isConnected) document.body.append(this.dialog);
    this.dialog.showModal();
    this.active = true;
    this.content.scrollTop = 0;
    this.title.focus({ preventScroll: true });
    this.options.onOpen?.();
  }

  close(): void {
    if (!this.isOpen) return;
    this.dialog.close();
    this.finishClose();
  }

  private finishClose(): void {
    if (!this.active) return;
    this.active = false;
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    else if (this.button.isConnected) this.button.focus({ preventScroll: true });
    this.options.onClose?.();
  }
}
