/**
 * Session-local Source game content from Files the person selected: VPK v1/v2 sets (one
 * <name>_dir.vpk plus its <name>_NNN.vpk archives), standalone .vpk files and loose folders.
 * No server API, network request, storage or substitute asset is involved. Intake reads only VPK
 * headers/trees and gameinfo.txt; file bodies are read on demand, bounded, CRC-checked (VPK) and
 * SHA-256 identified. Paths are Source paths: case-insensitive, '\' or '/' separated.
 *
 * Precedence follows Source rather than selection order. With one gameinfo.txt in the selection
 * (or the one named in options.gameInfo), its FileSystem/SearchPaths entries carrying the GAME
 * path ID order the mounts; content outside those paths is not mounted. Directory paths also
 * mount a pak01_dir.vpk found directly inside them, ahead of their loose files: CS:GO's
 * gameinfo lists only directories, yet its content lives in csgo/pak01_dir.vpk. Without a usable
 * gameinfo.txt every mount is unordered. Whenever a path has more than one equally ranked or
 * unordered provider, read() compares their bytes and refuses differing content instead of
 * choosing one.
 */
import { parseGameInfoSearchPaths, type GameInfoSearchPath } from './gameinfo';
import { crc32, readBlobBytes, readVpkDirectory, VPK_EMBEDDED_ARCHIVE, walkVpkTree } from './vpk';

export interface LocalGameContentLimits {
  /** Files accepted in one selection. */
  readonly maxFiles: number;
  /** Indexed path/provider pairs across every mount. */
  readonly maxEntries: number;
  /** Header plus tree bytes of one VPK directory. */
  readonly maxTreeBytes: number;
  /** Header plus tree bytes of all VPK directories together. */
  readonly maxIndexBytes: number;
  /** Largest file read() returns. */
  readonly maxFileBytes: number;
  /** Bytes held by unfinished reads at one time. */
  readonly maxInFlightBytes: number;
  readonly maxGameInfoBytes: number;
  readonly maxPathLength: number;
}
export interface LocalGameContentOptions {
  /** Selected relative path (File.webkitRelativePath) of the gameinfo.txt that orders the GAME
   * search path. Needed only when the selection holds several gameinfo.txt files. */
  readonly gameInfo?: string;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<LocalGameContentLimits>;
}

export interface LocalGameMountInfo {
  readonly kind: 'vpk' | 'loose';
  /** Selected relative path of the _dir.vpk / standalone .vpk, or the loose folder. */
  readonly label: string;
  /** Position in the gameinfo GAME search order; null when unordered. */
  readonly searchRank: number | null;
  /** Mounted because a directory search path held this pak01_dir.vpk. */
  readonly implicitPak01: boolean;
  readonly entries: number;
  readonly version?: 1 | 2;
  /** SHA-256 of the VPK header and tree bytes as read. */
  readonly indexSha256?: string;
  /** Archive files the tree refers to, by selected or expected relative path. */
  readonly requiredArchives?: readonly string[];
  readonly missingArchives?: readonly string[];
}
export interface LocalGameSearchOrder {
  readonly status: 'gameinfo' | 'unordered' | 'ambiguous-gameinfo';
  readonly gameInfo?: string;
  readonly gameInfoSha256?: string;
  /** Every gameinfo.txt in the selection. */
  readonly candidates: readonly string[];
  /** Authored entries that mounted nothing, with the reason. */
  readonly skipped: readonly Readonly<{ entry: string; reason: string }>[];
}
export interface LocalGameContentIdentity {
  /** Random per-intake id: two intakes of the same files are separate sessions. */
  readonly sessionId: string;
  readonly createdAt: number;
  /** SHA-256 over search order, mount labels, VPK index digests and each mounted File's
   * relative path, size and lastModified. File bodies are identified per read instead. */
  readonly selectionSha256: string;
  readonly mounts: readonly LocalGameMountInfo[];
  readonly searchOrder: LocalGameSearchOrder;
  /** Numbered archives whose _dir.vpk was not selected. */
  readonly orphanArchives: readonly string[];
  /** Selected files that no mount uses (outside the GAME search paths, or orphan archives). */
  readonly unusedFiles: number;
}
export interface LocalGameEntry {
  readonly path: string;
  /** Size of the content read() returns (of the first candidate when ambiguous). */
  readonly bytes: number;
  /** Providers read() consults: one, or several it must find byte-identical. */
  readonly sources: readonly string[];
  readonly status: 'available' | 'ambiguous' | 'missing-archive';
}
export interface LocalGameRead {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sources: readonly string[];
}
export interface LocalGameContent {
  readonly identity: LocalGameContentIdentity;
  readonly disposed: boolean;
  /** Indexed in a mount. A stored body can still be unreadable: see entries() status. */
  has(path: string): boolean;
  /** Fresh bytes per call. Throws LocalGameContentMissingError naming the canonical path. */
  read(path: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  entries(): IterableIterator<LocalGameEntry>;
  /** Every distinct path read so far in this session, with the SHA-256 of its bytes. */
  readClosure(): readonly LocalGameRead[];
  /** Drops File references and the index, and aborts unfinished reads. Identity and closure remain. */
  dispose(): void;
}

export class LocalGameContentMissingError extends Error {
  constructor(readonly path: string) {
    super(`Local game content: ${path} isn't in the selected game files.`);
    this.name = 'LocalGameContentMissingError';
  }
}
export class LocalGameContentArchiveError extends Error {
  constructor(readonly path: string, readonly archive: string) {
    super(`Local game content: ${path} is stored in ${archive}, which wasn't selected. Add that archive to the selection.`);
    this.name = 'LocalGameContentArchiveError';
  }
}
export class LocalGameContentAmbiguityError extends Error {
  constructor(readonly path: string, readonly sources: readonly string[]) {
    super(`Local game content: ${path} differs between ${sources.join(', ')}. Include the game's gameinfo.txt (or choose one) so Source search order decides, or select only one copy.`);
    this.name = 'LocalGameContentAmbiguityError';
  }
}

const MiB = 1024 * 1024;
const defaultLimits: LocalGameContentLimits = Object.freeze({
  maxFiles: 1 << 20, maxEntries: 1 << 21, maxTreeBytes: 64 * MiB, maxIndexBytes: 256 * MiB,
  maxFileBytes: 128 * MiB, maxInFlightBytes: 512 * MiB, maxGameInfoBytes: MiB, maxPathLength: 1024,
});
const utf8 = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function fail(message: string): never { throw new Error(`Local game content: ${message}`); }

/** Canonical Source lookup path: '\' → '/', repeated separators and '.' removed, lower-case.
 * Absolute, drive, '..' and control-character paths are refused rather than resolved. */
export function canonicalSourcePath(path: string, maxLength = defaultLimits.maxPathLength): string {
  if (typeof path !== 'string' || !path || path.length > maxLength || /[\u0000-\u001f\u007f:]/.test(path) || /^[\\/]/.test(path))
    fail(`unsafe Source path ${JSON.stringify(path)}`);
  let out = '';
  for (const part of path.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    if (part === '..') fail(`unsafe Source path ${JSON.stringify(path)}`);
    out = out ? `${out}/${part}` : part;
  }
  if (!out) fail(`unsafe Source path ${JSON.stringify(path)}`);
  return out.toLowerCase();
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

interface Selected {
  readonly file: File;
  /** webkitRelativePath, or the bare name for individually picked files. */
  readonly rel: string;
  readonly lower: string;
  /** Lower-case parent folder; '' for individually picked files. */
  readonly dir: string;
  readonly name: string;
  readonly hasPath: boolean;
}
interface VpkSet {
  /** Lower-case path without _dir.vpk / .vpk: what a gameinfo "<path>.vpk" entry names. */
  readonly key: string;
  readonly directory: Selected;
  /** Relative path minus '_dir.vpk' for archive naming; null for a standalone .vpk. */
  readonly archiveBase: string | null;
  readonly archives: Map<number, Selected>;
}
interface PlannedVpk { readonly kind: 'vpk'; readonly set: VpkSet; readonly implicitPak01: boolean }
interface PlannedLoose { readonly kind: 'loose'; readonly root: string; readonly label: string }
type Planned = PlannedVpk | PlannedLoose;

interface VpkMount {
  readonly kind: 'vpk';
  readonly label: string;
  readonly rank: number;
  readonly directory: File;
  readonly archives: ReadonlyMap<number, File>;
  readonly archiveBase: string | null;
  readonly dataStart: number;
}
interface LooseMount { readonly kind: 'loose'; readonly label: string; readonly rank: number }
interface VpkProvider {
  readonly mount: VpkMount;
  readonly crc: number;
  readonly preloadStart: number;
  readonly preloadSize: number;
  readonly archive: number;
  readonly offset: number;
  readonly length: number;
}
interface LooseProvider { readonly mount: LooseMount; readonly file: File; readonly rel: string }
type Provider = VpkProvider | LooseProvider;

const archiveName = (base: string, index: number) => `${base}_${String(index).padStart(3, '0')}.vpk`;

function providerBytes(provider: Provider): number {
  return 'file' in provider ? provider.file.size : provider.preloadSize + provider.length;
}
function providerSource(provider: Provider): string {
  if ('file' in provider) return provider.rel;
  if (!provider.length || provider.archive === VPK_EMBEDDED_ARCHIVE || provider.mount.archiveBase === null) return provider.mount.label;
  return `${provider.mount.label} → ${archiveName(provider.mount.archiveBase, provider.archive)}`;
}
/** Providers read() must consult: all at the best search rank plus every unordered one. */
function candidates(found: Provider | Provider[]): Provider | Provider[] {
  if (!Array.isArray(found)) return found;
  let best = Infinity;
  for (const provider of found) if (provider.mount.rank < best) best = provider.mount.rank;
  const chosen = found.filter(provider => provider.mount.rank === best || provider.mount.rank === Infinity);
  return chosen.length === 1 ? chosen[0] : chosen;
}

function select(files: readonly File[], limits: LocalGameContentLimits): Selected[] {
  if (!Array.isArray(files) || files.length === 0) fail('no files were selected. Choose the game folder or its VPK files.');
  if (files.length > limits.maxFiles) fail(`the selection has ${files.length} files; the limit is ${limits.maxFiles}`);
  const byRel = new Map<string, File>();
  const selected: Selected[] = [];
  for (const file of files) {
    const value: unknown = file;
    if (!(value instanceof Blob) || typeof (value as Partial<File>).name !== 'string') fail('the selection contains something that is not a file');
    const relative = file.webkitRelativePath || '';
    const rel = relative || file.name;
    const previous = byRel.get(rel);
    if (previous === file) continue;
    if (previous) fail(`${rel} was selected twice from different places. Select each game file once.`);
    byRel.set(rel, file);
    const lower = rel.toLowerCase(), slash = lower.lastIndexOf('/');
    selected.push({ file, rel, lower, dir: slash < 0 ? '' : lower.slice(0, slash), name: lower.slice(slash + 1), hasPath: !!relative });
  }
  return selected;
}

interface Classified {
  readonly sets: Map<string, VpkSet>;
  readonly orphans: Selected[];
  readonly loose: Selected[];
  readonly gameInfos: Selected[];
}
function classify(selected: readonly Selected[]): Classified {
  const sets = new Map<string, VpkSet>(), numbered: [Selected, string, number][] = [], loose: Selected[] = [], gameInfos: Selected[] = [];
  const addSet = (set: VpkSet) => {
    if (sets.has(set.key)) fail(`${sets.get(set.key)!.directory.rel} and ${set.directory.rel} name the same VPK. Select one of them.`);
    sets.set(set.key, set);
  };
  for (const item of selected) {
    const prefix = item.dir ? `${item.dir}/` : '';
    if (item.name.endsWith('.vpk')) {
      const directory = /^(.+)_dir\.vpk$/.exec(item.name), archive = /^(.+)_(\d+)\.vpk$/.exec(item.name);
      if (directory) addSet({ key: prefix + directory[1], directory: item, archiveBase: item.rel.slice(0, -'_dir.vpk'.length), archives: new Map() });
      else if (archive) numbered.push([item, prefix + archive[1], Number(archive[2])]);
      else addSet({ key: prefix + item.name.slice(0, -'.vpk'.length), directory: item, archiveBase: null, archives: new Map() });
      continue;
    }
    if (!item.hasPath) fail(`${item.rel} was picked without its folder, so its Source path is unknown. Choose the game folder instead, or pick only VPK files.`);
    if (item.name === 'gameinfo.txt') gameInfos.push(item);
    loose.push(item);
  }
  const orphans: Selected[] = [];
  for (const [item, key, index] of numbered) {
    const set = sets.get(key);
    if (!set || set.archiveBase === null) { orphans.push(item); continue; }
    if (!Number.isSafeInteger(index) || index >= VPK_EMBEDDED_ARCHIVE) fail(`${item.rel} has an unsupported archive number`);
    const previous = set.archives.get(index);
    if (previous) fail(`${previous.rel} and ${item.rel} are both archive ${index} of ${set.directory.rel}. Select each archive once.`);
    set.archives.set(index, item);
  }
  return { sets, orphans, loose, gameInfos };
}

const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const under = (lower: string, root: string) => !root || lower.startsWith(`${root}/`);

/** Resolves an authored search path against the selection's base folder. */
function resolveSearchPath(value: string, gameDir: string, baseDir: string): { path: string; wildcard: boolean } | string {
  let text = value.replace(/\\/g, '/'), prefix = baseDir;
  const lower = text.toLowerCase();
  if (lower.startsWith('|gameinfo_path|')) { prefix = gameDir; text = text.slice('|gameinfo_path|'.length); }
  else if (lower.startsWith('|all_source_engine_paths|')) text = text.slice('|all_source_engine_paths|'.length);
  else if (text.startsWith('|')) return 'unknown path token';
  else if (text.startsWith('/') || /^[a-z]:/i.test(text)) return 'absolute path';
  const parts = prefix ? prefix.split('/') : [];
  for (const part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part !== '..') parts.push(part.toLowerCase());
    else if (!parts.length) return 'leaves the selected folders';
    else parts.pop();
  }
  const wildcard = parts[parts.length - 1] === '*';
  if (wildcard) parts.pop();
  return { path: parts.join('/'), wildcard };
}

function planOrdered(paths: readonly GameInfoSearchPath[], gameInfo: Selected, classified: Classified,
  skipped: { entry: string; reason: string }[]): Planned[] {
  const gameDir = gameInfo.dir, baseDir = parent(gameDir);
  const planned: Planned[] = [], mounted = new Set<string>();
  const loose = classified.loose;
  const rootLabel = (root: string) => {
    if (!root) return '.';
    for (const item of loose) if (under(item.lower, root) && item.rel.length === item.lower.length) return item.rel.slice(0, root.length);
    return root;
  };
  const addVpk = (set: VpkSet, implicitPak01: boolean) => {
    if (mounted.has(`vpk:${set.key}`)) return false;
    mounted.add(`vpk:${set.key}`);
    planned.push({ kind: 'vpk', set, implicitPak01 });
    return true;
  };
  const addDirectory = (root: string) => {
    let added = false;
    const pak01 = classified.sets.get(root ? `${root}/pak01` : 'pak01');
    if (pak01 && pak01.archiveBase !== null) added = addVpk(pak01, true);
    if (!mounted.has(`loose:${root}`) && loose.some(item => under(item.lower, root))) {
      mounted.add(`loose:${root}`);
      planned.push({ kind: 'loose', root, label: rootLabel(root) });
      added = true;
    }
    return added;
  };
  for (const entry of paths) {
    const authored = `${entry.ids.join('+')} ${entry.value}${entry.condition ? ` ${entry.condition}` : ''}`;
    if (!entry.ids.includes('game')) { skipped.push({ entry: authored, reason: 'not a GAME search path' }); continue; }
    if (entry.condition) { skipped.push({ entry: authored, reason: 'platform condition is not evaluated' }); continue; }
    const resolved = resolveSearchPath(entry.value, gameDir, baseDir);
    if (typeof resolved === 'string') { skipped.push({ entry: authored, reason: resolved }); continue; }
    const { path, wildcard } = resolved;
    let added = false;
    if (wildcard) {
      // Source mounts each VPK and subfolder of a '*' path in alphabetical order.
      const children = new Map<string, () => boolean>();
      for (const item of loose) {
        if (!under(item.lower, path)) continue;
        const rest = path ? item.lower.slice(path.length + 1) : item.lower, slash = rest.indexOf('/');
        if (slash > 0) { const folder = rest.slice(0, slash), root = path ? `${path}/${folder}` : folder; children.set(folder, () => addDirectory(root)); }
      }
      for (const set of classified.sets.values()) {
        if (parent(set.key) !== path) continue;
        children.set(set.directory.name, () => addVpk(set, false));
      }
      for (const name of [...children.keys()].sort()) added = children.get(name)!() || added;
    } else if (path.endsWith('.vpk')) {
      const set = classified.sets.get(path.slice(0, -'.vpk'.length));
      if (set) added = addVpk(set, false);
    } else added = addDirectory(path);
    if (!added) skipped.push({ entry: authored, reason: 'nothing selected at that path' });
  }
  return planned;
}

function planUnordered(classified: Classified): Planned[] {
  const planned: Planned[] = [];
  for (const set of [...classified.sets.values()].sort((a, b) => a.directory.lower < b.directory.lower ? -1 : 1))
    planned.push({ kind: 'vpk', set, implicitPak01: false });
  const roots = new Map<string, string>();
  for (const item of classified.loose) {
    const lowerSlash = item.lower.indexOf('/'), slash = item.rel.indexOf('/');
    if (lowerSlash <= 0 || slash <= 0) fail(`${item.rel} has no folder in its selected path`);
    roots.set(item.lower.slice(0, lowerSlash), item.rel.slice(0, slash));
  }
  for (const root of [...roots.keys()].sort()) planned.push({ kind: 'loose', root, label: roots.get(root)! });
  return planned;
}

class LocalGameContentSession implements LocalGameContent {
  private index: Map<string, Provider | Provider[]>;
  private readonly closure = new Map<string, LocalGameRead>();
  private readonly lifetime = new AbortController();
  private inFlight = 0;

  constructor(readonly identity: LocalGameContentIdentity, index: Map<string, Provider | Provider[]>, private readonly limits: LocalGameContentLimits) {
    this.index = index;
  }
  get disposed(): boolean { return this.lifetime.signal.aborted; }
  private open(signal?: AbortSignal): void {
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
  }
  has(path: string): boolean {
    this.open();
    return this.index.has(canonicalSourcePath(path, this.limits.maxPathLength));
  }
  async read(path: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.open(signal);
    const key = canonicalSourcePath(path, this.limits.maxPathLength);
    const found = this.index.get(key);
    if (!found) throw new LocalGameContentMissingError(key);
    const chosen = candidates(found);
    if (!Array.isArray(chosen)) {
      const bytes = await this.readProvider(key, chosen, signal);
      this.record(key, bytes.length, await sha256Hex(bytes), [providerSource(chosen)]);
      this.open(signal);
      return bytes;
    }
    let first: Uint8Array<ArrayBuffer> | undefined, firstSha = '';
    for (const provider of chosen) {
      const bytes = await this.readProvider(key, provider, signal), sha = await sha256Hex(bytes);
      this.open(signal);
      if (!first) { first = bytes; firstSha = sha; }
      else if (sha !== firstSha) throw new LocalGameContentAmbiguityError(key, chosen.map(providerSource));
    }
    this.record(key, first!.length, firstSha, chosen.map(providerSource));
    return first!;
  }
  private record(path: string, bytes: number, sha256: string, sources: string[]): void {
    const previous = this.closure.get(path);
    if (previous && previous.sha256 !== sha256) fail(`${path} changed during this session (SHA-256 ${previous.sha256} then ${sha256}). Select the game files again.`);
    if (!previous) this.closure.set(path, Object.freeze({ path, bytes, sha256, sources: Object.freeze(sources) }));
  }
  private async readProvider(path: string, provider: Provider, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const size = providerBytes(provider);
    if (size > this.limits.maxFileBytes) fail(`${path} is ${size} bytes, above the ${this.limits.maxFileBytes}-byte read limit`);
    if (size > this.limits.maxInFlightBytes - this.inFlight) fail(`reading ${path} would exceed the ${this.limits.maxInFlightBytes}-byte limit for unfinished reads`);
    this.inFlight += size;
    try {
      if ('file' in provider) {
        const bytes = await readBlobBytes(provider.file, 0, size, signal);
        this.open(signal);
        return bytes;
      }
      return await this.readVpk(path, provider, size, signal);
    } catch (error) {
      // Give Blob failures (out of range, short read, a File changed on disk) the Source path and provider.
      if (this.disposed || signal?.aborted || !(error instanceof Error) || error.message.startsWith('Local game content:')) throw error;
      throw new Error(`Local game content: couldn't read ${path} from ${providerSource(provider)}: ${error.message}`, { cause: error });
    } finally {
      this.inFlight -= size;
    }
  }
  private async readVpk(path: string, entry: VpkProvider, size: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const { mount } = entry;
    let body: Blob = mount.directory, start = mount.dataStart + entry.offset;
    if (entry.length && entry.archive !== VPK_EMBEDDED_ARCHIVE) {
      const archive = mount.archives.get(entry.archive);
      if (!archive) throw new LocalGameContentArchiveError(path, archiveName(mount.archiveBase!, entry.archive));
      body = archive;
      start = entry.offset;
    }
    if (entry.length && start + entry.length > body.size)
      fail(`${path} lies at ${start}+${entry.length} in ${providerSource(entry)}, past its ${body.size} bytes. The archive doesn't belong to this _dir.vpk.`);
    let bytes: Uint8Array<ArrayBuffer>;
    if (!entry.preloadSize && entry.length) bytes = await readBlobBytes(body, start, entry.length, signal);
    else {
      bytes = new Uint8Array(size);
      if (entry.preloadSize) bytes.set(await readBlobBytes(mount.directory, entry.preloadStart, entry.preloadSize, signal));
      if (entry.length) bytes.set(await readBlobBytes(body, start, entry.length, signal), entry.preloadSize);
    }
    this.open(signal);
    const crc = crc32(bytes);
    if (crc !== entry.crc) fail(`${path} in ${providerSource(entry)} fails its CRC (${crc.toString(16)}, expected ${entry.crc.toString(16)})`);
    return bytes;
  }
  *entries(): IterableIterator<LocalGameEntry> {
    this.open();
    for (const [path, found] of this.index) {
      const chosen = candidates(found), list = Array.isArray(chosen) ? chosen : [chosen];
      let status: LocalGameEntry['status'] = list.length > 1 ? 'ambiguous' : 'available';
      for (const provider of list)
        if (!('file' in provider) && provider.length && provider.archive !== VPK_EMBEDDED_ARCHIVE && !provider.mount.archives.has(provider.archive))
          status = 'missing-archive';
      yield Object.freeze({ path, bytes: providerBytes(list[0]), sources: Object.freeze(list.map(providerSource)), status });
      this.open();
    }
  }
  readClosure(): readonly LocalGameRead[] { return Object.freeze([...this.closure.values()]); }
  dispose(): void {
    if (this.disposed) return;
    this.lifetime.abort(new DOMException('Local game content was disposed.', 'AbortError'));
    this.index = new Map();
  }
}

/** Builds a session over explicitly selected Files. Reads VPK trees and gameinfo.txt only. */
export async function createLocalGameContent(files: readonly File[], options: LocalGameContentOptions = {}): Promise<LocalGameContent> {
  const { signal } = options;
  signal?.throwIfAborted();
  const limits: LocalGameContentLimits = Object.freeze({ ...defaultLimits, ...options.limits });
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid ${name} limit ${value}`);
  const selected = select(files, limits);
  const classified = classify(selected);

  const candidatesList = Object.freeze(classified.gameInfos.map(item => item.rel).sort());
  const skipped: { entry: string; reason: string }[] = [];
  let gameInfo: Selected | undefined;
  if (options.gameInfo !== undefined) {
    gameInfo = classified.gameInfos.find(item => item.rel === options.gameInfo);
    if (!gameInfo) fail(`${options.gameInfo} isn't a selected gameinfo.txt. Selected: ${candidatesList.join(', ') || 'none'}.`);
  } else if (classified.gameInfos.length === 1) gameInfo = classified.gameInfos[0];
  let planned: Planned[], searchOrder: LocalGameSearchOrder;
  if (gameInfo) {
    if (gameInfo.file.size > limits.maxGameInfoBytes) fail(`${gameInfo.rel} is larger than ${limits.maxGameInfoBytes} bytes`);
    const bytes = await readBlobBytes(gameInfo.file, 0, gameInfo.file.size, signal);
    planned = planOrdered(parseGameInfoSearchPaths(utf8.decode(bytes), gameInfo.rel), gameInfo, classified, skipped);
    searchOrder = { status: 'gameinfo', gameInfo: gameInfo.rel, gameInfoSha256: await sha256Hex(bytes), candidates: candidatesList, skipped };
  } else {
    planned = planUnordered(classified);
    searchOrder = { status: classified.gameInfos.length > 1 ? 'ambiguous-gameinfo' : 'unordered', candidates: candidatesList, skipped };
  }

  const index = new Map<string, Provider | Provider[]>();
  const used = new Set<Selected>();
  const mounts: LocalGameMountInfo[] = [];
  const manifest: string[] = [`gameinfo\t${searchOrder.gameInfo ?? '-'}\t${searchOrder.gameInfoSha256 ?? '-'}`];
  let entries = 0, indexBytes = 0;
  const add = (path: string, provider: Provider) => {
    if (++entries > limits.maxEntries) fail(`the selection indexes more than ${limits.maxEntries} files`);
    const found = index.get(path);
    if (!found) index.set(path, provider);
    else if (Array.isArray(found)) found.push(provider);
    else index.set(path, [found, provider]);
  };
  for (let position = 0; position < planned.length; position++) {
    const plan = planned[position], rank = gameInfo ? position : Infinity;
    if (plan.kind === 'loose') {
      const mount: LooseMount = { kind: 'loose', label: plan.label, rank };
      const lines: string[] = [];
      let count = 0;
      for (const item of classified.loose) {
        if (!under(item.lower, plan.root)) continue;
        const path = plan.root ? item.lower.slice(plan.root.length + 1) : item.lower;
        add(path, { mount, file: item.file, rel: item.rel });
        used.add(item);
        lines.push(`file\t${item.rel}\t${item.file.size}\t${item.file.lastModified}`);
        count++;
      }
      manifest.push(`loose\t${gameInfo ? position : '-'}\t${plan.label}`, ...lines.sort());
      mounts.push(Object.freeze({ kind: 'loose', label: plan.label, searchRank: gameInfo ? position : null, implicitPak01: false, entries: count }));
      continue;
    }
    const { set } = plan, label = set.directory.rel;
    const directory = await readVpkDirectory(set.directory.file, label, limits.maxTreeBytes, signal);
    indexBytes += directory.index.length;
    if (indexBytes > limits.maxIndexBytes) fail(`VPK directories exceed the ${limits.maxIndexBytes}-byte index limit`);
    const indexSha256 = await sha256Hex(directory.index);
    const archives = new Map<number, File>();
    for (const [number, item] of set.archives) archives.set(number, item.file);
    const mount: VpkMount = { kind: 'vpk', label, rank, directory: set.directory.file, archives, archiveBase: set.archiveBase, dataStart: directory.dataStart };
    const required = new Set<number>();
    let count = 0;
    walkVpkTree(directory, label, record => {
      if (record.length && record.archive !== VPK_EMBEDDED_ARCHIVE) {
        if (set.archiveBase === null) fail(`${label} is a standalone VPK but ${record.path} refers to archive ${record.archive}`);
        required.add(record.archive);
      }
      add(record.path.toLowerCase(), { mount, crc: record.crc, preloadStart: record.preloadStart, preloadSize: record.preloadSize,
        archive: record.archive, offset: record.offset, length: record.length });
      count++;
    }, limits.maxPathLength * 4);
    signal?.throwIfAborted();
    used.add(set.directory);
    const requiredArchives: string[] = [], missingArchives: string[] = [];
    for (const number of [...required].sort((a, b) => a - b)) {
      const item = set.archives.get(number), name = item?.rel ?? archiveName(set.archiveBase!, number);
      requiredArchives.push(name);
      if (!item) missingArchives.push(name);
    }
    manifest.push(`vpk\t${gameInfo ? position : '-'}\t${label}\t${set.directory.file.size}\t${set.directory.file.lastModified}\t${indexSha256}`);
    for (const number of [...set.archives.keys()].sort((a, b) => a - b)) {
      const item = set.archives.get(number)!;
      used.add(item);
      manifest.push(`archive\t${number}\t${item.rel}\t${item.file.size}\t${item.file.lastModified}`);
    }
    mounts.push(Object.freeze({ kind: 'vpk', label, searchRank: gameInfo ? position : null, implicitPak01: plan.implicitPak01,
      entries: count, version: directory.version, indexSha256,
      requiredArchives: Object.freeze(requiredArchives), missingArchives: Object.freeze(missingArchives) }));
  }
  if (!index.size) fail('the selection holds no mountable game content. Choose a game folder or a _dir.vpk with its archives.');
  if (gameInfo) used.add(gameInfo);

  const identity: LocalGameContentIdentity = Object.freeze({
    sessionId: crypto.randomUUID(),
    createdAt: Date.now(),
    selectionSha256: await sha256Hex(encoder.encode(manifest.join('\n'))),
    mounts: Object.freeze(mounts),
    searchOrder: Object.freeze({ ...searchOrder, skipped: Object.freeze(skipped.map(item => Object.freeze(item))) }),
    orphanArchives: Object.freeze(classified.orphans.map(item => item.rel).sort()),
    unusedFiles: selected.length - used.size,
  });
  signal?.throwIfAborted();
  return new LocalGameContentSession(identity, index, limits);
}
