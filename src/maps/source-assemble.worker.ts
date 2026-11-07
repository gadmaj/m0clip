/** CPU-only selected-map conversion; never registers or installs live resources. */
import { assembleSourceMap } from './raw-source-convert';
import { finalizeSourceAssembly } from './source-import-finalize';
import { selectedSourceBsp } from './source-import-index';
import { observeTransfers } from '../loading/transfers';
import { sourceChoice, sourceImportFailure, sourceRecord,
  type SourceImportResponse } from './source-import-protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: SourceImportResponse): void;
};
scope.onmessage = event => {
  scope.onmessage = null;
  void (async () => {
    try {
      if (!sourceRecord(event.data) || event.data.type !== 'convert' || !sourceChoice(event.data.choice))
        throw new Error('Invalid Source conversion request.');
      const choice = event.data.choice;
      const selected = await selectedSourceBsp(choice);
      const assembly = await assembleSourceMap(selected.file, {
        mapName: selected.mapName, name: choice.name, game: choice.game, mounts: selected.mounts,
        onStage: stage => scope.postMessage({ type: 'stage', stage }),
      });
      const bundle = await finalizeSourceAssembly(assembly, choice.name, choice.game,
        () => scope.postMessage({ type: 'stage', stage: 'verifying' }));
      stopTransfers({ drain: true });
      scope.postMessage({ type: 'bundle', bundle });
    } catch (error) {
      stopTransfers({ drain: true });
      scope.postMessage({ type: 'error', error: sourceImportFailure(error) });
    }
  })();
};
// Root ownership precedes buffered static-import observations, never Blob bytes.
scope.postMessage({ type: 'ready', url: import.meta.url });
const stopTransfers = observeTransfers(`source-assembly:${crypto.randomUUID()}`, updates => {
  for (let offset = 0; offset < updates.length; offset += 4096)
    scope.postMessage({ type: 'transfers', updates: updates.slice(offset, offset + 4096) });
});
