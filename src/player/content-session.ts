/** Game content the person adds for Player mode, held only for this tab.
 *
 * The launch shell imports this module on demand (Add game content…) and main.ts reads the same
 * instance after Load. Parsing, decoding and preview rendering are dynamic imports, so neither
 * graph pays for them until files are chosen. Nothing is uploaded, stored or substituted: a model
 * that cannot be decoded or textured from the selection is left out and the reason is shown. */
import type { LocalGameContent } from './assets/local-content';
import type { StudioModelData } from './studio/types';
import type { PlayerContentRequirement } from '../record/player-take';
import type { PlayerBodyOption } from '../ui/launch';

/** Launch value of a Studio body from local content: `studio:<canonical Source path>`. */
export const STUDIO_BODY_PREFIX = 'studio:';
export const studioBodyValue = (path: string) => `${STUDIO_BODY_PREFIX}${path}`;
export function studioBodyPath(value: string): string | null {
  return value.startsWith(STUDIO_BODY_PREFIX) && value.length > STUDIO_BODY_PREFIX.length ? value.slice(STUDIO_BODY_PREFIX.length) : null;
}

/** Where Source games keep the models a player can wear: models/player/ (Garry's Mod, Counter-Strike)
 * and the Half-Life 2: Deathmatch citizen, Combine and Metrocop bodies. */
const PLAYER_MODEL = /^models\/(player\/.+|humans\/group03\/(male|female)_\d\d|combine_soldier|combine_soldier_prisonguard|combine_super_soldier|police)\.mdl$/;
const PREVIEW_SIZE = { width: 256, height: 256 } as const;
const MAX_REASONS = 3;

interface Intake { files: File[]; gameInfo?: string }
interface IntakeDialog {
  title: string;
  note: string;
  action: string;
  /** Builds the result from the chosen files, reporting progress; rejects with a message to show.
   * A non-empty result is a final report shown until the person dismisses it. */
  accept(intake: Intake, signal: AbortSignal, status: (text: string) => void): Promise<string>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

interface ListedBodies { options: PlayerBodyOption[]; urls: string[]; omitted: string[] }

/** One modal surface for adding and reattaching: a folder or individual VPK files, then the
 * gameinfo.txt that orders the search path when the selection holds several. */
function openIntakeDialog(options: IntakeDialog, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const dialog = document.createElement('dialog');
  dialog.className = 'visual-picker-dialog';
  dialog.dataset.localMap = 'true';
  dialog.dataset.gameContent = 'true';
  dialog.setAttribute('aria-label', options.title);
  const title = document.createElement('h2');
  title.textContent = options.title;
  const note = document.createElement('p');
  note.textContent = options.note;
  const folderLabel = document.createElement('label');
  folderLabel.textContent = 'Game folder';
  const folder = document.createElement('input');
  folder.type = 'file'; folder.webkitdirectory = true; folder.multiple = true;
  folderLabel.append(folder);
  const filesLabel = document.createElement('label');
  filesLabel.textContent = 'Or VPK files';
  const pick = document.createElement('input');
  pick.type = 'file'; pick.multiple = true; pick.accept = '.vpk';
  filesLabel.append(pick);
  const gameInfoLabel = document.createElement('label');
  gameInfoLabel.textContent = 'Game';
  gameInfoLabel.hidden = true;
  const gameInfo = document.createElement('select');
  gameInfoLabel.append(gameInfo);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'visual-picker-actions';
  const run = document.createElement('button');
  run.type = 'button'; run.className = 'btn primary'; run.textContent = options.action; run.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
  actions.append(run, cancel);
  dialog.append(title, note, folderLabel, filesLabel, gameInfoLabel, status, actions);
  document.body.append(dialog);
  const controller = new AbortController();
  let files: File[] = [], settled = false, working = false;
  const close = (done: boolean, error?: unknown) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', aborted);
    controller.abort(); dialog.close(); dialog.remove();
    if (error !== undefined) reject(error); else resolve(done);
  };
  const aborted = () => close(false, signal?.reason);
  signal?.addEventListener('abort', aborted, { once: true });
  cancel.onclick = () => { if (!working) close(false); else controller.abort(new DOMException('Game content cancelled.', 'AbortError')); };
  dialog.oncancel = event => { event.preventDefault(); cancel.click(); };
  const choose = (chosen: File[]) => {
    files = chosen;
    const candidates = chosen.filter(file => file.name.toLowerCase() === 'gameinfo.txt' && file.webkitRelativePath)
      .map(file => file.webkitRelativePath).sort();
    gameInfo.replaceChildren(...candidates.map(path => new Option(path.slice(0, path.lastIndexOf('/')) || path, path)));
    gameInfoLabel.hidden = candidates.length < 2;
    run.disabled = !files.length;
    status.textContent = !files.length ? ''
      : candidates.length > 1 ? `${files.length} files. This folder holds several games; choose the one to use.`
      : `${files.length} files selected.`;
  };
  folder.onchange = () => { pick.value = ''; choose(Array.from(folder.files ?? [])); };
  pick.onchange = () => { folder.value = ''; choose(Array.from(pick.files ?? [])); };
  run.onclick = async () => {
    if (run.disabled || working) return;
    working = true; run.disabled = true; folder.disabled = pick.disabled = gameInfo.disabled = true;
    const intake: Intake = { files, ...(gameInfoLabel.hidden ? {} : { gameInfo: gameInfo.value }) };
    try {
      const report = await options.accept(intake, controller.signal, text => { if (!settled) status.textContent = text; });
      if (!report) { close(true); return; }
      status.textContent = report;
      folderLabel.hidden = filesLabel.hidden = gameInfoLabel.hidden = cancel.hidden = true;
      run.textContent = 'Done'; run.disabled = false; run.onclick = () => close(true);
      dialog.oncancel = event => { event.preventDefault(); close(true); };
      run.focus();
    } catch (error) {
      if (settled) return;
      working = false; run.disabled = !files.length; folder.disabled = pick.disabled = gameInfo.disabled = false;
      status.textContent = controller.signal.aborted ? 'Cancelled.' : message(error);
      if (controller.signal.aborted) close(false);
    }
  };
  dialog.showModal();
  return promise;
}

/** Player bodies in `content` that decode, animate and texture completely, each with a rendered preview. */
async function listPlayerBodies(content: LocalGameContent, group: string, signal: AbortSignal,
  status: (text: string) => void): Promise<ListedBodies> {
  // Decoders and Three load only after files are chosen; the launch shell stays free of them.
  const [{ loadStudioModel }, { isPlayerBodyModel }, { renderStudioBodyPreview }] = await Promise.all([
    import('./studio'), import('../render/player'), import('../render/player/preview')]);
  const paths: string[] = [];
  for (const entry of content.entries()) if (PLAYER_MODEL.test(entry.path)) paths.push(entry.path);
  paths.sort();
  const options: PlayerBodyOption[] = [], urls: string[] = [], omitted: string[] = [];
  for (let index = 0; index < paths.length; index++) {
    signal.throwIfAborted();
    const path = paths[index];
    status(`Checking player models ${index + 1} / ${paths.length}…`);
    let model: StudioModelData;
    try { model = await loadStudioModel(content, path, signal); }
    catch (error) { signal.throwIfAborted(); omitted.push(`${path}: ${message(error)}`); continue; }
    // Animation-only include files (…_anims.mdl) have no body to wear.
    if (!model.bodyParts.some(part => part.models.some(sub => sub.meshes.length))) continue;
    if (!isPlayerBodyModel(model)) { omitted.push(`${path}: no player movement animations`); continue; }
    try {
      const preview = await renderStudioBodyPreview(content, model, PREVIEW_SIZE, signal);
      const url = URL.createObjectURL(preview);
      urls.push(url);
      options.push({ value: studioBodyValue(path), label: path.slice(path.lastIndexOf('/') + 1, -4).replace(/_/g, ' '),
        preview: url, group, description: path });
    } catch (error) { signal.throwIfAborted(); omitted.push(`${path}: ${message(error)}`); }
  }
  return { options, urls, omitted };
}

function omittedSummary(found: number, omitted: readonly string[]): string {
  if (!omitted.length) return '';
  const shown = omitted.slice(0, MAX_REASONS).join(' ');
  return `${found ? 'Some player models were left out' : 'No player model could be used'} (${omitted.length}). ${shown}${omitted.length > MAX_REASONS ? ' …' : ''}`;
}

class PlayerGameContent {
  private intake: Intake | null = null;
  private scene: LocalGameContent | null = null;
  private bodies: readonly PlayerBodyOption[] = [];
  private previews: string[] = [];

  /** The content the live scene reads; its read closure is what a Player take records. */
  get content(): LocalGameContent | null { return this.scene; }
  get bodyOptions(): readonly PlayerBodyOption[] { return this.bodies; }

  /** Launch: choose game files and list the player bodies they provide. Resolves false when cancelled. */
  add(): Promise<boolean> {
    return openIntakeDialog({
      title: 'Add game content',
      note: 'Choose a Source game folder (for example hl2mp or garrysmod) or its .vpk files. Files stay in this tab; nothing is uploaded.',
      action: 'Add',
      accept: async (intake, signal, status) => {
        // Parsing loads only after files are chosen; the launch shell stays free of it.
        const { createLocalGameContent } = await import('./assets/local-content');
        status('Reading game file indexes…');
        const survey = await createLocalGameContent(intake.files, { gameInfo: intake.gameInfo, signal });
        let listed: ListedBodies;
        try {
          const order = survey.identity.searchOrder;
          if (order.status === 'ambiguous-gameinfo') throw new Error('This folder holds several games. Choose one.');
          const gameInfo = order.gameInfo, group = gameInfo ? gameInfo.split('/').slice(-2, -1)[0] || 'Local game' : 'Local game';
          listed = await listPlayerBodies(survey, group, signal, status);
        } finally { survey.dispose(); }
        if (!listed.options.length) {
          for (const url of listed.urls) URL.revokeObjectURL(url);
          throw new Error(omittedSummary(0, listed.omitted) || 'No player models were found in this selection.');
        }
        // Inventory reads are not scene reads: the scene gets its own session over the same files.
        const scene = await createLocalGameContent(intake.files, { gameInfo: intake.gameInfo, signal });
        this.replace(intake, scene, listed.options, listed.urls);
        return omittedSummary(listed.options.length, listed.omitted);
      },
    });
  }

  /** Content matching a recorded Player take: a fresh session over this tab's selection when every
   * recorded path, size and hash matches, otherwise a reattached selection. The caller keeps it with
   * that take; the live scene's own session and its read closure are left untouched. */
  async reattach(requirements: readonly PlayerContentRequirement[], verify: (content: LocalGameContent, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal): Promise<LocalGameContent> {
    // Parsing loads only on demand; the launch shell stays free of it.
    const { createLocalGameContent } = await import('./assets/local-content');
    if (this.intake) {
      const content = await createLocalGameContent(this.intake.files, { gameInfo: this.intake.gameInfo, signal });
      try { await verify(content, signal); return content; }
      catch (error) { content.dispose(); if (signal?.aborted) throw error; }
    }
    const result: { content?: LocalGameContent } = {};
    const done = await openIntakeDialog({
      title: 'Reattach game content',
      note: `This take shows ${requirements.length} file${requirements.length === 1 ? '' : 's'} from your own game content. Choose the same game folder or .vpk files.`,
      action: 'Reattach',
      accept: async (intake, abort, status) => {
        status('Reading game file indexes…');
        const content = await createLocalGameContent(intake.files, { gameInfo: intake.gameInfo, signal: abort });
        status('Checking the recorded files…');
        try { await verify(content, abort); }
        catch (error) { content.dispose(); throw error; }
        result.content = content;
        return '';
      },
    }, signal);
    if (!done || !result.content) throw new DOMException('Game content was not reattached.', 'AbortError');
    return result.content;
  }

  private replace(intake: Intake, scene: LocalGameContent, bodies: readonly PlayerBodyOption[], previews: string[]) {
    this.scene?.dispose();
    for (const url of this.previews) URL.revokeObjectURL(url);
    this.intake = intake; this.scene = scene; this.bodies = bodies; this.previews = previews;
  }
}

/** One per tab, shared by the launch shell and the scene. */
export const playerGameContent = new PlayerGameContent();
