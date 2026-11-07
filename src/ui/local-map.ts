import type { MapBundleIndex, DecodedMapBundle } from '../maps/bundle';
import type { SourceInspection, SourceImportChoice } from '../maps/source-import';
import type { SourceAssemblyStage } from '../maps/raw-source-convert';
import type { SourceMount } from '../maps/raw-source-files';
import type { WorkerTransferObserver } from '../loading/transfers';
import { registerLocalMap, type LocalMapIdentity, type MapSource } from '../maps/source';
import { verifyMapBundle } from '../maps/bundle-verification';
import { companionMounts, looseMount } from './source-mounts';

export type LocalMapChoice = { kind: 'bundle'; file: File; index: MapBundleIndex }
  | ({ kind: 'source' } & SourceImportChoice);
export type LocalMapStage = SourceAssemblyStage | 'verifying';
const stageLabels: Record<LocalMapStage, string> = {
  bsp: 'Reading BSP', companions: 'Resolving local companions', geometry: 'Building geometry',
  lighting: 'Building lighting', world: 'Building world', props: 'Building props', sky: 'Building sky',
  packaging: 'Packaging map', verifying: 'Verifying local files',
};
export function localMapStageLabel(stage: LocalMapStage): string { return `${stageLabels[stage]}… · local work, not downloads`; }

let localMapModule: { complete: boolean } | undefined;
/** Only the converted-bundle client graph is covered by this receipt, never either raw worker. */
export function localMapIntakeState(): Readonly<{ complete: boolean }> | undefined { return localMapModule; }
let localSourceModule: { complete: boolean } | undefined;
export function localSourceIntakeState(): Readonly<{ complete: boolean }> | undefined { return localSourceModule; }
async function importSourceClient() {
  const intake: { complete: boolean } = localSourceModule = { complete: false };
  // Runtime format choice owns this optional graph; a static import would join initial launch.
  const module = await import('../maps/source-import');
  intake.complete = true;
  return module;
}
export async function inspectLocalMap(file: File, signal?: AbortSignal): Promise<MapBundleIndex> {
  // Static ZIP decoding would load archive code before the user chooses a local file.
  const intake: { complete: boolean } = localMapModule = { complete: false };
  const { inspectMapBundle } = await import('../maps/bundle');
  intake.complete = true;
  signal?.throwIfAborted();
  return inspectMapBundle(file, signal);
}
export async function loadLocalMap(choice: LocalMapChoice, signal?: AbortSignal,
  observer?: WorkerTransferObserver, onStage?: (stage: LocalMapStage) => void): Promise<MapSource> {
  signal?.throwIfAborted();
  let decoded: DecodedMapBundle;
  if (choice.kind === 'source') {
    const { convertSourceMap } = await importSourceClient();
    signal?.throwIfAborted();
    decoded = await convertSourceMap(choice, signal, onStage, observer);
  } else {
    onStage?.('verifying');
    decoded = await verifyMapBundle(choice.file, signal, observer);
  }
  // A cancelled or superseded operation cannot register the worker's result.
  signal?.throwIfAborted();
  return registerLocalMap(decoded);
}

/** Diagnostics are plain text. Never turn local paths into links, URLs or stored state. */
export function showLocalMapError(target: HTMLElement, error: unknown): void {
  target.replaceChildren();
  const message = document.createElement('p');
  message.textContent = error instanceof Error ? error.message : String(error); target.append(message);
  if (!error || typeof error !== 'object' || !('requirements' in error) || !Array.isArray(error.requirements)) return;
  const details = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = 'Requirements'; details.append(summary);
  const list = document.createElement('ul');
  for (const requirement of error.requirements) {
    if (!requirement || typeof requirement !== 'object' || typeof requirement.code !== 'string' || typeof requirement.detail !== 'string') continue;
    const row = document.createElement('li');
    row.textContent = `${requirement.blocking === false ? 'Notice · ' : ''}${requirement.code}${typeof requirement.path === 'string' ? ` · ${requirement.path}` : ''}: ${requirement.detail}`;
    list.append(row);
  }
  if ('omittedRequirements' in error && typeof error.omittedRequirements === 'number' && error.omittedRequirements > 0) {
    const row = document.createElement('li'); row.textContent = `${error.omittedRequirements} further requirements omitted. Resolve the listed requirements and retry.`; list.append(row);
  }
  if (list.childElementCount) { details.append(list); target.append(details); }
}

function mapDialog<T>(file: File | undefined, expected: LocalMapIdentity | undefined, signal: AbortSignal | undefined,
  purpose: 'choose' | 'load', accept: (choice: LocalMapChoice, signal: AbortSignal, commit: () => void,
    stage: (stage: LocalMapStage) => void) => Promise<T>, initial?: LocalMapChoice, observer?: WorkerTransferObserver): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog'); dialog.className = 'visual-picker-dialog'; dialog.dataset.localMap = 'true';
  dialog.setAttribute('aria-label', expected ? 'Reattach map' : 'Open local map');
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click']) dialog.addEventListener(type, event => event.stopPropagation());
  const title = document.createElement('h2'); title.textContent = expected ? 'Reattach map' : 'Open local map';
  const note = document.createElement('p'); note.textContent = expected
    ? `Choose the original map and companions for ${expected.name}. Content must match.` : 'Files stay in this tab.';
  const modes = document.createElement('div'); modes.className = 'visual-picker-actions'; modes.setAttribute('aria-label', 'Map file format');
  modes.setAttribute('role', 'group');
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.zip,application/zip'; input.setAttribute('aria-label', 'Map file');
  const maps = document.createElement('div'); maps.className = 'local-map-candidates'; maps.setAttribute('aria-label', 'Maps in selected file');
  maps.setAttribute('role', 'group');
  maps.onkeydown = event => {
    if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const candidates = Array.from(maps.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = candidates.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? candidates.length - 1
      : Math.max(0, Math.min(candidates.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    candidates[next]?.focus();
  };
  const extras = document.createElement('section'); extras.className = 'local-map-companions'; extras.hidden = true;
  extras.setAttribute('aria-label', 'Companion mounts');
  const hint = document.createElement('p'); hint.textContent = 'Companions: first match wins after the BSP pak and map archive. No game files are downloaded.';
  const companionInput = document.createElement('input'); companionInput.type = 'file'; companionInput.multiple = true; companionInput.accept = '.zip,.gma,.vpk'; companionInput.hidden = true;
  const folderInput = document.createElement('input'); folderInput.type = 'file'; folderInput.multiple = true; folderInput.setAttribute('webkitdirectory', ''); folderInput.hidden = true;
  const extraActions = document.createElement('div'); extraActions.className = 'visual-picker-actions';
  const mountList = document.createElement('ol'); mountList.className = 'local-map-mounts';
  const status = document.createElement('div'); status.className = 'local-map-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div'); actions.className = 'visual-picker-actions';
  const button = (text: string, callback: () => void) => { const value = document.createElement('button'); value.type = 'button'; value.className = 'btn'; value.textContent = text; value.onclick = callback; return value; };
  const load = button(purpose === 'choose' ? 'Use map' : expected ? 'Reattach' : 'Load map', () => { void submit(); }); load.classList.add('primary'); load.disabled = true;
  const cancel = button('Cancel', () => { if (!committing) close(); }); actions.append(load, cancel);
  let format: 'bundle' | 'bsp' | 'gma' | 'zip' = 'bundle', selected: LocalMapChoice | undefined;
  let inspection: SourceInspection | undefined, selectedFile: File | undefined, mounts: SourceMount[] = [];
  let operation = new AbortController(), revision = 0, settled = false, committing = false;
  const modeButtons: HTMLButtonElement[] = [];
  const close = (error?: unknown, result?: T) => {
    if (settled) return; settled = true; operation.abort(); signal?.removeEventListener('abort', aborted);
    dialog.close(); dialog.remove(); window.dispatchEvent(new Event('visual-picker-close'));
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    if (result !== undefined) resolve(result); else reject(error ?? new DOMException('Map loading cancelled.', 'AbortError'));
  };
  const aborted = () => { if (!committing) close(signal?.reason); };
  signal?.addEventListener('abort', aborted, { once: true });
  const replaceOperation = () => { operation.abort(); operation = new AbortController(); ++revision; return revision; };
  const updateChoice = () => {
    if (selected?.kind === 'source') selected = { ...selected, mounts: mounts.slice() };
    load.disabled = !selected;
  };
  const renderMounts = () => {
    mountList.replaceChildren();
    mounts.forEach((mount, index) => {
      const row = document.createElement('li'), name = document.createElement('span'); name.textContent = `${mount.label ?? mount.kind}${mount.kind === 'loose' ? ` · ${mount.files.length} files` : mount.kind === 'vpk' ? ` · ${mount.chunks?.length ?? 0} chunks` : ''}`;
      const controls = document.createElement('div'); controls.className = 'visual-picker-actions';
      const move = (step: number) => {
        if (committing) return;
        if (selected) replaceOperation();
        [mounts[index], mounts[index + step]] = [mounts[index + step], mounts[index]];
        renderMounts(); updateChoice();
        mountList.children[index + step]?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      };
      const up = button('Up', () => move(-1)), down = button('Down', () => move(1)); up.disabled = index === 0; down.disabled = index === mounts.length - 1;
      up.setAttribute('aria-label', `Move ${mount.label ?? mount.kind} earlier`); down.setAttribute('aria-label', `Move ${mount.label ?? mount.kind} later`);
      const remove = button('Remove', () => {
        if (committing) return;
        if (selected) replaceOperation();
        mounts.splice(index, 1); renderMounts(); updateChoice();
        const next = mountList.children[Math.min(index, mounts.length - 1)]?.querySelector<HTMLButtonElement>('button:not(:disabled)');
        (next ?? extraActions.querySelector<HTMLButtonElement>('button'))?.focus();
      });
      remove.setAttribute('aria-label', `Remove ${mount.label ?? mount.kind}`); controls.append(up, down, remove); row.append(name, controls); mountList.append(row);
    });
  };
  const addMounts = (values: SourceMount[]) => {
    const labels = new Set(mounts.map(mount => mount.label));
    for (const mount of values) { if (labels.has(mount.label)) throw new Error(`Duplicate mount: ${mount.label}. Remove it before choosing a replacement.`); labels.add(mount.label); }
    if (values.length + mounts.length > 126) throw new Error('Too many companion mounts. Remove unused mounts.');
    if (selected) replaceOperation();
    mounts.push(...values); renderMounts(); updateChoice(); status.textContent = 'Companions updated.';
  };
  extraActions.append(
    button('Add archives…', () => { if (selected) replaceOperation(); updateChoice(); companionInput.click(); }),
    button('Add game folder…', () => { if (selected) replaceOperation(); updateChoice(); folderInput.click(); }),
  );
  companionInput.onchange = () => {
    if (committing) return;
    if (selected) replaceOperation();
    try { addMounts(companionMounts(Array.from(companionInput.files ?? []))); } catch (error) { showLocalMapError(status, error); }
    companionInput.value = ''; updateChoice();
  };
  folderInput.onchange = () => {
    if (committing) return;
    if (selected) replaceOperation();
    try { addMounts([looseMount(Array.from(folderInput.files ?? []))]); } catch (error) { showLocalMapError(status, error); }
    folderInput.value = ''; updateChoice();
  };
  extras.append(hint, extraActions, companionInput, folderInput, mountList);
  const inspect = async (value: File) => {
    const current = replaceOperation(), activeSignal = operation.signal;
    selected = undefined; inspection = undefined; selectedFile = value; maps.replaceChildren(); load.disabled = true;
    status.textContent = 'Reading map index…';
    try {
      if (format === 'bundle') {
        const index = await inspectLocalMap(value, activeSignal);
        if (settled || current !== revision || activeSignal.aborted) return;
        selected = { kind: 'bundle', file: value, index }; status.textContent = `${index.name} · ${index.game} · ${index.resources.length} resources. Ready to verify.`;
      } else {
        // Metadata workers are requested only by explicit Source intake.
        const { inspectSourceMap } = await importSourceClient(); activeSignal.throwIfAborted();
        const result = await inspectSourceMap(value, activeSignal, observer);
        if (settled || current !== revision || activeSignal.aborted) return;
        if (result.format !== format) throw new Error(`This is ${result.format.toUpperCase()}, not ${format.toUpperCase()}. Choose the matching format.`);
        inspection = result;
        status.textContent = result.maps.length ? 'Choose a map. Companions are checked when you load.' : 'No supported BSP maps found. Choose another file.';
        for (const candidate of result.maps) {
          const choice = button(`${candidate.path} · ${(candidate.bytes / 1_000_000).toFixed(1)} MB`, () => {
            if (!inspection || !selectedFile || committing) return;
            replaceOperation();
            selected = { kind: 'source', file: selectedFile, format: inspection.format, mapPath: candidate.path,
              name: candidate.path.split('/').pop()!.replace(/\.bsp$/i, ''), game: inspection.game, mounts: mounts.slice() };
            for (const child of maps.querySelectorAll('button')) child.setAttribute('aria-pressed', String(child === choice));
            status.textContent = 'Map selected.'; updateChoice();
          });
          choice.className = 'visual-picker-card'; choice.setAttribute('aria-pressed', 'false'); maps.append(choice);
        }
      }
      updateChoice();
    } catch (error) { if (!settled && current === revision && !activeSignal.aborted) showLocalMapError(status, error); }
  };
  for (const [value, text] of [['bundle', 'Converted .map.zip'], ['bsp', 'Source BSP'], ['gma', 'Source GMA'], ['zip', 'Source ZIP']] as const) {
    const mode = button(text, () => {
      if (committing || format === value) return;
      replaceOperation(); format = value; selected = undefined; inspection = undefined; selectedFile = undefined; mounts = [];
      renderMounts(); maps.replaceChildren(); input.value = ''; load.disabled = true; extras.hidden = format === 'bundle';
      input.accept = format === 'bsp' ? '.bsp' : format === 'gma' ? '.gma' : '.zip,application/zip';
      modeButtons.forEach(item => item.setAttribute('aria-pressed', String(item === mode))); status.textContent = ''; input.focus();
    });
    mode.setAttribute('aria-pressed', String(value === format)); modeButtons.push(mode); modes.append(mode);
  }
  input.onclick = () => {
    if (committing) return;
    replaceOperation(); input.value = ''; updateChoice();
    if (!selected) status.textContent = 'Choose a map file.';
  };
  input.onchange = () => { const value = input.files?.[0]; if (value) void inspect(value); };
  const submit = async () => {
    if (!selected || load.disabled) return;
    const current = replaceOperation(), choice = selected, activeSignal = operation.signal; load.disabled = true;
    status.textContent = purpose === 'choose' ? '' : choice.kind === 'source' ? 'Assembling local map…' : 'Verifying local files…';
    try {
      const result = await accept(choice, activeSignal, () => {
        activeSignal.throwIfAborted();
        if (settled || current !== revision) throw new DOMException('Map selection replaced.', 'AbortError');
        committing = true; cancel.disabled = true;
        for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = true;
        status.textContent = 'Installing map…';
      }, stage => { if (!settled && current === revision) status.textContent = localMapStageLabel(stage); });
      if (!settled && current === revision && !activeSignal.aborted) close(undefined, result);
    } catch (error) {
      if (!settled && current === revision && !activeSignal.aborted) {
        committing = false;
        for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
        renderMounts(); showLocalMapError(status, error); updateChoice();
      }
    }
  };
  dialog.oncancel = event => { event.preventDefault(); if (!committing) close(); };
  dialog.append(title, note, modes, input, maps, extras, status, actions); document.body.append(dialog); dialog.showModal();
  window.dispatchEvent(new Event('visual-picker-open'));
  if (initial) {
    if (initial.kind === 'source') {
      modeButtons[initial.format === 'bsp' ? 1 : initial.format === 'gma' ? 2 : 3].click();
      mounts = initial.mounts.slice(); renderMounts();
    }
    void inspect(initial.file);
  } else if (file) {
    if (/\.bsp$/i.test(file.name)) modeButtons[1].click(); else if (/\.gma$/i.test(file.name)) modeButtons[2].click();
    void inspect(file);
  } else modeButtons[0].focus();
  return promise;
}

/** Metadata-only choice flow, shared by launch and live reattachment. */
export function chooseLocalMap(file?: File, signal?: AbortSignal, initial?: LocalMapChoice,
  observer?: WorkerTransferObserver): Promise<LocalMapChoice> {
  return mapDialog(file, undefined, signal, 'choose', async choice => choice, initial, observer);
}
/** No live installation happens here; the caller retains prepare/commit ownership. */
export function openLocalMap(file?: File, expected?: LocalMapIdentity,
  prepare?: (source: MapSource, signal: AbortSignal, commit: () => void) => Promise<void>, signal?: AbortSignal,
  observer?: WorkerTransferObserver): Promise<MapSource> {
  return mapDialog(file, expected, signal, 'load', async (choice, activeSignal, commit, stage) => {
    const source = await loadLocalMap(choice, activeSignal, observer, stage); activeSignal.throwIfAborted();
    if (expected && source.identity?.fingerprint !== expected.fingerprint)
      throw new Error(`Different map content. Choose the original map and companions for ${expected.name}.`);
    if (prepare) await prepare(source, activeSignal, commit);
    return source;
  }, undefined, observer);
}
