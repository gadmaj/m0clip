/** Worker-only cutover boundary: unresolved requirements never receive identity. */
import { finalizeGeneratedMapBundle, type DecodedMapBundle } from './bundle';
import type { SourceMapAssembly } from './raw-source-convert';
import { sourceBlockingFailure } from './source-import-protocol';

export async function finalizeSourceAssembly(assembly: Pick<SourceMapAssembly, 'files' | 'requirements'>,
  name: string, game: string, onVerifying?: () => void): Promise<DecodedMapBundle> {
  const failure = sourceBlockingFailure(assembly.requirements);
  if (failure) throw failure;
  onVerifying?.();
  return finalizeGeneratedMapBundle({ name, game, files: assembly.files,
    maxOutputBytes: 512 * 1024 ** 2, maxHashBytes: 1024 * 1024 ** 2 + 4096,
    maxMetadataBytes: 64 * 1024 ** 2, maxMetadataAllocationBytes: 256 * 1024 ** 2 });
}
