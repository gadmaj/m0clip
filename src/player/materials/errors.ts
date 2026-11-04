import {
  LocalGameContentAmbiguityError, LocalGameContentArchiveError, LocalGameContentMissingError, type LocalGameContent,
} from '../assets/local-content';

export type SourceMaterialErrorCode =
  | 'missing-material' | 'missing-include' | 'missing-texture' | 'archive-not-selected' | 'ambiguous-file'
  | 'invalid-material' | 'invalid-texture'
  | 'unsupported-shader' | 'unsupported-parameter' | 'unsupported-proxy' | 'unsupported-block' | 'unsupported-texture'
  | 'ambiguous-material' | 'paint-kit-required';

/** Every refusal names the Source path involved and what would make it load. Nothing is replaced
 * by a default, error or substitute material. */
export class SourceMaterialError extends Error {
  constructor(readonly code: SourceMaterialErrorCode, readonly path: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceMaterialError';
  }
}

/** Reads one file through the session, turning its intake errors into material errors that say
 * which material needed the file. Abort and disposal errors pass through unchanged. */
export async function readMaterialFile(content: LocalGameContent, path: string, missing: SourceMaterialErrorCode,
  wanted: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await content.read(path, signal);
  } catch (error) {
    if (error instanceof LocalGameContentArchiveError)
      throw new SourceMaterialError('archive-not-selected', error.path,
        `${wanted} needs ${error.path}, which is stored in ${error.archive}. Add that archive to the selected game files.`, { cause: error });
    if (error instanceof LocalGameContentAmbiguityError)
      throw new SourceMaterialError('ambiguous-file', error.path,
        `${wanted} needs ${error.path}, but its copies differ between ${error.sources.join(', ')}. Include the game's gameinfo.txt so Source search order picks one.`, { cause: error });
    if (error instanceof LocalGameContentMissingError)
      throw new SourceMaterialError(missing, error.path, `${wanted} needs ${error.path}, which isn't in the selected game files.`, { cause: error });
    throw error;
  }
}
