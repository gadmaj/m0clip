/** Local-only worker messages. HTTP code metadata, never registration or persistent file state. */
import type { DecodedMapBundle } from './bundle';
import type { SourceAssemblyStage } from './raw-source-convert';
import type { SourceMount } from './raw-source-files';
import type { TransferUpdate } from '../loading/transfers';

export type SourceFormat = 'bsp' | 'gma' | 'zip';
export interface SourceInspection {
  kind: 'source';
  format: SourceFormat;
  name: string;
  game: string;
  maps: readonly { path: string; bytes: number }[];
}
export interface SourceImportChoice {
  file: File;
  format: SourceFormat;
  mapPath: string;
  name: string;
  game: string;
  mounts: readonly SourceMount[];
}
export interface SourceImportRequirement {
  readonly code: string;
  readonly path?: string;
  readonly detail: string;
  readonly blocking: boolean;
}
export interface SourceImportFailure {
  message: string;
  requirements: readonly SourceImportRequirement[];
  /** All blockers prevent finalization, including diagnostics beyond the display bound. */
  omittedRequirements: number;
}
export type SourceImportStage = SourceAssemblyStage | 'verifying';
export type SourceImportRequest =
  | { type: 'inspect'; file: File }
  | { type: 'convert'; choice: SourceImportChoice };
export type SourceImportResponse =
  | { type: 'ready'; url: string }
  | { type: 'inspection'; inspection: SourceInspection }
  | { type: 'bundle'; bundle: DecodedMapBundle }
  | { type: 'stage'; stage: SourceImportStage }
  | { type: 'transfers'; updates: TransferUpdate[] }
  | { type: 'error'; error: SourceImportFailure };

export const sourceDiagnosticLimit = 256;
const stages: readonly string[] = ['bsp', 'companions', 'geometry', 'lighting', 'world', 'props', 'sky', 'packaging', 'verifying'];
export function sourceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function sourceFormat(value: unknown): value is SourceFormat { return value === 'bsp' || value === 'gma' || value === 'zip'; }
export function sourceStage(value: unknown): value is SourceImportStage { return typeof value === 'string' && stages.includes(value); }
export function sourceTransfers(value: unknown): value is TransferUpdate[] {
  return Array.isArray(value) && value.length <= 4096 && value.every(item => sourceRecord(item)
    && text(item.id, 4096) && text(item.url, 8192) && /^https?:\/\//i.test(item.url)
    && bytes(item.loaded) && (item.total === null || bytes(item.total))
    && ['loading', 'done', 'failed', 'cancelled'].includes(item.state as string)
    // The client assigns the worker realm; an observed HTTP status stays as the worker saw it.
    && item.realm === undefined
    && (item.status === undefined || (Number.isSafeInteger(item.status) && (item.status as number) >= 100 && (item.status as number) <= 599)));
}
export function sourceInspection(value: unknown): value is SourceInspection {
  return sourceRecord(value) && value.kind === 'source' && sourceFormat(value.format)
    && text(value.name, 256) && text(value.game, 256) && Array.isArray(value.maps) && value.maps.length <= 262144
    && value.maps.every(map => sourceRecord(map) && text(map.path, 4096) && bytes(map.bytes));
}
export function sourceFailure(value: unknown): value is SourceImportFailure {
  return sourceRecord(value) && text(value.message, 2048) && bytes(value.omittedRequirements)
    && Array.isArray(value.requirements) && value.requirements.length <= sourceDiagnosticLimit
    && value.requirements.every(item => sourceRecord(item) && text(item.code, 128) && text(item.detail, 2048)
      && (item.path === undefined || text(item.path, 4096)) && typeof item.blocking === 'boolean');
}
export function sourceChoice(value: unknown): value is SourceImportChoice {
  if (!sourceRecord(value) || !(value.file instanceof File) || !sourceFormat(value.format)
    || !text(value.mapPath, 4096) || !text(value.name, 256) || !text(value.game, 256)
    || !Array.isArray(value.mounts) || value.mounts.length > (value.format === 'bsp' ? 127 : 126)) return false;
  return value.mounts.every(mount => {
    if (!sourceRecord(mount) || (mount.label !== undefined && !text(mount.label, 4096))) return false;
    if (mount.kind === 'zip' || mount.kind === 'gma') return mount.file instanceof Blob;
    if (mount.kind === 'loose') return Array.isArray(mount.files) && mount.files.length <= 262144
      && mount.files.every(file => sourceRecord(file) && text(file.path, 4096) && file.blob instanceof Blob);
    return mount.kind === 'vpk' && mount.directory instanceof Blob && (mount.chunks === undefined
      || (Array.isArray(mount.chunks) && mount.chunks.length <= 65535 && mount.chunks.every(chunk =>
        sourceRecord(chunk) && bytes(chunk.index) && chunk.index < 65535 && chunk.blob instanceof Blob)));
  });
}
export function sourceBundle(value: unknown): value is DecodedMapBundle {
  if (!sourceRecord(value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || value.id !== `local-${value.fingerprint}` || !(value.files instanceof Map)
    || !sourceRecord(value.index) || value.index.format !== 'm0clip-map' || value.index.version !== 1
    || value.index.entry !== 'manifest.json' || !text(value.index.name, 256) || !text(value.index.game, 256)
    || !Array.isArray(value.index.resources) || value.index.resources.length > 65534
    || value.files.size !== value.index.resources.length) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const item of value.index.resources) {
    if (!sourceRecord(item) || !text(item.path, 4096) || seen.has(item.path) || !bytes(item.bytes)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return false;
    const blob = value.files.get(item.path);
    if (!(blob instanceof Blob) || blob.size !== item.bytes) return false;
    total += blob.size;
    if (total > 512 * 1024 ** 2) return false;
    seen.add(item.path);
  }
  return seen.has('manifest.json');
}

function clipped(value: string, max: number): string { return value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\ufffd'); }
export function sourceImportFailure(error: unknown): SourceImportFailure {
  if (sourceFailure(error)) return error;
  const message = clipped(error instanceof Error ? error.message || error.name : 'Source import failed', 2048);
  const missingChunk = error instanceof Error && error.name === 'SourceMissingChunkError';
  const path = sourceRecord(error) && typeof error.path === 'string' && error.path.length
    ? clipped(error.path, 4096) : undefined;
  return { message, requirements: [{ code: missingChunk ? 'missing-vpk-chunk' : 'source-import-failed',
    detail: message, blocking: true, ...(path ? { path } : {}) }], omittedRequirements: 0 };
}
/** The complete requirement list is checked before any identity is generated.
 * Only display diagnostics are bounded; omitted blockers remain explicitly counted. */
export function sourceBlockingFailure(requirements: readonly (SourceImportRequirement & { face?: number })[]): SourceImportFailure | undefined {
  let blockers = 0;
  const diagnostics: SourceImportRequirement[] = [];
  for (const item of requirements) {
    if (!item.blocking) continue;
    blockers++;
    if (diagnostics.length < sourceDiagnosticLimit) diagnostics.push({ code: clipped(item.code, 128),
      detail: clipped(item.face === undefined ? item.detail : `Face ${item.face}: ${item.detail}`, 2048),
      blocking: true, ...(item.path ? { path: clipped(item.path, 4096) } : {}) });
  }
  if (!blockers) return undefined;
  return { message: `This map has ${blockers} unresolved Source requirement${blockers === 1 ? '' : 's'}. Select the required local companions or use a map whose features are supported.`,
    requirements: diagnostics, omittedRequirements: blockers - diagnostics.length };
}
