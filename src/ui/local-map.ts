import type { MapBundleIndex } from '../maps/bundle';
import { registerLocalMap, type LocalMapIdentity, type MapSource } from '../maps/source';
import { verifyMapBundle, type BundleVerificationObserver } from '../maps/bundle-verification';

let localMapModule: { complete: boolean } | undefined;
/** File rejection or cancellation does not unload an imported module graph. */
export function localMapIntakeState(): Readonly<{ complete: boolean }> | undefined { return localMapModule; }

export async function inspectLocalMap(file: File, signal?: AbortSignal): Promise<MapBundleIndex> {
  // Explicit file intake must not pull ZIP inflation into the lightweight launch graph.
  const intake: { complete: boolean } = localMapModule = { complete: false };
  const { inspectMapBundle } = await import('../maps/bundle');
  intake.complete = true;
  return inspectMapBundle(file, signal);
}
export async function loadLocalMap(file: File, signal?: AbortSignal,
  observer?: BundleVerificationObserver): Promise<MapSource> {
  const bundle = await verifyMapBundle(file, signal, observer);
  // An abort between the worker's final reply and this continuation cannot register.
  signal?.throwIfAborted();
  return registerLocalMap(bundle);
}
/** User action is required to select/reattach a file; no file data enters a URL or storage. */
export function openLocalMap(
  file?: File,
  expected?: LocalMapIdentity,
  prepare?: (source: MapSource, signal: AbortSignal, commit: () => void) => Promise<void>,
  signal?: AbortSignal,
  observer?: BundleVerificationObserver,
): Promise<MapSource> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<MapSource>();
  const dialog = document.createElement('dialog');
  dialog.className = 'visual-picker-dialog';
  dialog.dataset.localMap = 'true';
  dialog.setAttribute('aria-label', expected ? 'Reattach map' : 'Open map bundle');
  const title = document.createElement('h2');
  title.textContent = expected ? 'Reattach map' : 'Open map bundle';
  const note = document.createElement('p');
  note.textContent = expected ? `Choose the same bundle for ${expected.name}.`
    : 'Choose a converted .map.zip bundle. Files stay in this tab.';
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.zip,application/zip';
  input.setAttribute('aria-label', 'Map bundle');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'visual-picker-actions';
  const load = document.createElement('button');
  load.type = 'button'; load.className = 'btn primary';
  load.textContent = expected ? 'Reattach' : 'Load map'; load.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
  actions.append(load, cancel);
  dialog.append(title, note, input, status, actions);
  document.body.append(dialog);
  const controller = new AbortController();
  let selected: File | undefined, revision = 0, settled = false, committing = false;
  const close = (error?: unknown, source?: MapSource) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', aborted);
    controller.abort(); dialog.close(); dialog.remove();
    if (source) resolve(source);
    else reject(error ?? new DOMException('Map loading cancelled.', 'AbortError'));
  };
  const aborted = () => { if (!committing) close(signal?.reason); };
  signal?.addEventListener('abort', aborted, { once: true });
  cancel.onclick = () => { if (!committing) close(); };
  dialog.oncancel = event => { event.preventDefault(); if (!committing) close(); };
  const inspect = async (value: File) => {
    const current = ++revision;
    load.disabled = true; selected = undefined;
    status.textContent = 'Reading map index…';
    try {
      const index = await inspectLocalMap(value, controller.signal);
      if (settled || current !== revision) return;
      selected = value;
      status.textContent = `${index.name} · ${index.game} · ${index.resources.length} resources. Ready to verify.`;
      load.disabled = false;
    } catch (error) {
      if (!settled && current === revision)
        status.textContent = `Cannot read this map: ${error instanceof Error ? error.message : error}`;
    }
  };
  input.onchange = () => {
    const value = input.files?.[0];
    if (value) void inspect(value);
  };
  load.onclick = async () => {
    if (!selected || load.disabled) return;
    load.disabled = true; input.disabled = true;
    status.textContent = 'Verifying local files…';
    try {
      const source = await loadLocalMap(selected, controller.signal, observer);
      if (settled) return;
      if (expected && source.identity?.fingerprint !== expected.fingerprint)
        throw new Error(`Different map content. Choose the original bundle for ${expected.name}.`);
      if (prepare) {
        status.textContent = 'Preparing map materials and collision…';
        await prepare(source, controller.signal, () => {
          committing = true; cancel.disabled = true;
          status.textContent = 'Installing map…';
        });
      }
      if (!settled) close(undefined, source);
    } catch (error) {
      if (!settled) {
        committing = false; cancel.disabled = false;
        status.textContent = `Map not loaded: ${error instanceof Error ? error.message : error}`;
        input.disabled = false; load.disabled = false;
      }
    }
  };
  dialog.showModal();
  if (file) void inspect(file);
  else input.focus();
  return promise;
}
