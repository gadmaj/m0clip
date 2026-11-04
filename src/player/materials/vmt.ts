/** Resolves a Source VMT into its effective shader parameters, the way the material system builds
 * them before a shader sees them:
 *
 * 1. `patch` materials: the include is resolved first (patches may nest, at most 10 deep, and a
 *    cycle is refused). Then `insert` sets each key, replacing the first existing root key of that
 *    name or appending it, and `replace` sets only keys the include already has at its root. This
 *    is the order of the Source SDK's materialpatch.cpp. Both sections hold plain values; a block
 *    inside either is refused.
 * 2. Root blocks: `proxies` is kept as authored, in order. DirectX-level conditionals such as
 *    ">=dx90_20b" or "<dx90" apply when the profile's level satisfies them (dx90_20b is level 92).
 *    Shader fallback blocks named after this shader apply for the profile: `<shader>_dx9` without
 *    HDR, `<shader>_hdr_dx9` with HDR (falling back to `<shader>_dx9` when there's no HDR block);
 *    `_dx8`, `_dx7` and `_dx6` blocks never apply at DX9 levels. Applied blocks override root values.
 *    Two applied blocks that set one key to different values are refused, and so is any other root
 *    block, nested block inside an applied block, or differing duplicate key. With HDR on and both
 *    DX9 blocks present, every DX9 key must be restated in the HDR block, so it doesn't matter
 *    whether Source layers the two or uses the HDR block alone.
 * 3. Per-key conditions: "360?$key" is Xbox 360 only, so it is skipped and recorded; "!360?$key"
 *    applies as $key. Other conditions ("srgb?", "lowfill?"…) are refused.
 *
 * Every value keeps its authored key, file, block and line. Paths are read through the person's
 * selected files only. */
import type { LocalGameContent } from '../assets/local-content';
import { canonicalSourcePath } from '../assets/local-content';
import { readMaterialFile, SourceMaterialError } from './errors';
import { parseKeyValues, SourceKeyValuesError, type KeyValuesDocument, type KeyValuesPair } from './keyvalues';

export interface SourceMaterialProfile {
  /** Source mat_dxlevel: 90, 92 (dx90_20b), 95 or 98. */
  readonly dxLevel: number;
  /** HDR rendering selects `<shader>_hdr_dx9` fallback blocks. */
  readonly hdr: boolean;
}

export interface SourceMaterialParameter {
  /** Lower-case name, including the leading '$' or '%'. */
  readonly name: string;
  readonly key: string;
  readonly value: string;
  /** VMT that authored this value. */
  readonly file: string;
  /** 'root', 'insert', 'replace' or the authored name of the fallback/conditional block. */
  readonly block: string;
  readonly line: number;
}

export interface SourceMaterialBlock {
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly applied: boolean;
  readonly reason: string;
}

export interface SourceMaterialProxyDefinition {
  /** Lower-case proxy name. */
  readonly name: string;
  readonly key: string;
  /** Lower-case parameter name → authored value. */
  readonly parameters: ReadonlyMap<string, string>;
  readonly file: string;
  readonly line: number;
}

export interface ResolvedSourceMaterial {
  readonly path: string;
  /** Lower-case shader name after patches. */
  readonly shader: string;
  readonly authoredShader: string;
  /** Patch chain: the requested file first, then each include. One entry for a plain material. */
  readonly chain: readonly string[];
  readonly parameters: ReadonlyMap<string, SourceMaterialParameter>;
  readonly blocks: readonly SourceMaterialBlock[];
  readonly proxies: readonly SourceMaterialProxyDefinition[];
  /** Keys with a condition prefix that doesn't hold on PC ("360?$color2" is Xbox 360 only). */
  readonly skipped: readonly Readonly<{ key: string; value: string; file: string; line: number; reason: string }>[];
}

const MAX_PATCH_DEPTH = 10;

interface RootEntry { pair: KeyValuesPair; file: string; block: string }
interface Root { shaderKey: string; shader: string; file: string; entries: RootEntry[] }

const isBlock = (pair: KeyValuesPair): pair is KeyValuesPair & { value: readonly KeyValuesPair[] } => typeof pair.value !== 'string';

function invalid(path: string, detail: string): never {
  throw new SourceMaterialError('invalid-material', path, `Source material ${path}: ${detail}`);
}

/** materials/<name>.vmt for a name relative to materials/, with '.vmt' optional. */
export function sourceMaterialPath(name: string): string {
  const path = canonicalSourcePath(`materials/${name}`);
  return path.endsWith('.vmt') ? path : `${path}.vmt`;
}

async function readRoot(content: LocalGameContent, path: string, chain: string[], wanted: string, signal?: AbortSignal): Promise<Root> {
  if (chain.includes(path)) invalid(chain[0], `its patch includes form a cycle (${[...chain, path].join(' → ')}).`);
  if (chain.length > MAX_PATCH_DEPTH) invalid(chain[0], `its patch includes nest deeper than ${MAX_PATCH_DEPTH}.`);
  const bytes = await readMaterialFile(content, path, chain.length ? 'missing-include' : 'missing-material', wanted, signal);
  let parsed: KeyValuesDocument;
  try { parsed = parseKeyValues(path, bytes); } catch (error) {
    if (error instanceof SourceKeyValuesError) throw new SourceMaterialError('invalid-material', path, error.message, { cause: error });
    throw error;
  }
  chain.push(path);
  const { root } = parsed;
  if (root.name !== 'patch')
    return { shaderKey: root.key, shader: root.name, file: path, entries: root.value.map(pair => ({ pair, file: path, block: 'root' })) };

  let include: KeyValuesPair | undefined, insert: KeyValuesPair | undefined, replace: KeyValuesPair | undefined;
  for (const pair of root.value) {
    const slot = pair.name === 'include' ? 'include' : pair.name === 'insert' ? 'insert' : pair.name === 'replace' ? 'replace' : null;
    if (!slot) invalid(path, `the patch has "${pair.key}" (line ${pair.line}); a patch holds only include, insert and replace.`);
    const previous = slot === 'include' ? include : slot === 'insert' ? insert : replace;
    if (previous) invalid(path, `the patch has more than one ${slot} (lines ${previous.line} and ${pair.line}).`);
    if (slot === 'include') {
      if (isBlock(pair)) invalid(path, `the patch include on line ${pair.line} is a block, not a file name.`);
      include = pair;
    } else {
      if (!isBlock(pair)) invalid(path, `the patch ${slot} on line ${pair.line} isn't a block.`);
      for (const inner of pair.value) if (isBlock(inner))
        throw new SourceMaterialError('unsupported-block', path,
          `Source material ${path}: the patch ${slot} block sets "${inner.key}" to a block (line ${inner.line}). Patches that insert or replace blocks aren't supported.`);
      if (slot === 'insert') insert = pair; else replace = pair;
    }
  }
  if (!include || !(include.value as string).trim()) invalid(path, 'the patch has no include.');
  let target: string;
  try { target = canonicalSourcePath((include.value as string).trim()); } catch (error) {
    throw new SourceMaterialError('invalid-material', path, `Source material ${path}: the patch include "${include.value}" isn't a usable path.`, { cause: error });
  }
  const base = await readRoot(content, target, chain, wanted, signal);
  const entries = base.entries.slice();
  const set = (pair: KeyValuesPair, block: string, onlyExisting: boolean) => {
    const at = entries.findIndex(entry => entry.pair.name === pair.name);
    if (at >= 0 && isBlock(entries[at].pair))
      throw new SourceMaterialError('unsupported-block', path,
        `Source material ${path}: the patch ${block} sets "${pair.key}", which ${entries[at].file} defines as a block.`);
    if (at >= 0) entries[at] = { pair, file: path, block };
    else if (!onlyExisting) entries.push({ pair, file: path, block });
  };
  for (const pair of (insert?.value ?? []) as readonly KeyValuesPair[]) set(pair, 'insert', false);
  for (const pair of (replace?.value ?? []) as readonly KeyValuesPair[]) set(pair, 'replace', true);
  return { ...base, entries };
}

const dxNames: Readonly<Record<string, number>> = { dx60: 60, dx70: 70, dx80: 80, dx81: 81, dx90: 90, dx90_20b: 92, dx95: 95, dx98: 98 };

function conditional(name: string, level: number): boolean | null {
  const match = /^(<=|>=|<|>)(dx[0-9_a-z]+)$/.exec(name);
  if (!match) return null;
  const threshold = dxNames[match[2]];
  if (threshold === undefined) return null;
  switch (match[1]) {
    case '<': return level < threshold;
    case '<=': return level <= threshold;
    case '>': return level > threshold;
    default: return level >= threshold;
  }
}

export async function resolveSourceMaterial(content: LocalGameContent, path: string, profile: SourceMaterialProfile,
  wanted: string, signal?: AbortSignal): Promise<ResolvedSourceMaterial> {
  if (!Number.isInteger(profile.dxLevel) || profile.dxLevel < 90)
    throw new SourceMaterialError('unsupported-shader', path, `Source material ${path}: DirectX level ${profile.dxLevel} isn't supported; use 90 or later.`);
  const chain: string[] = [];
  const root = await readRoot(content, path, chain, wanted, signal);
  const shader = root.shader;

  const parameters = new Map<string, SourceMaterialParameter>();
  const blocks: SourceMaterialBlock[] = [];
  const proxies: SourceMaterialProxyDefinition[] = [];
  let proxySeen: RootEntry | null = null;
  const overrides: RootEntry[] = [];
  const skipped: ResolvedSourceMaterial['skipped'][number][] = [];
  let hdrBlock: RootEntry | null = null, dx9Block: RootEntry | null = null;

  const flat = (authored: KeyValuesPair, file: string, block: string, into: Map<string, SourceMaterialParameter>) => {
    let pair = authored;
    const mark = pair.name.lastIndexOf('?');
    if (mark >= 0) {
      // Source's per-key conditions. On PC, "360?" never holds and "!360?" always does; the
      // others ("srgb?", "lowfill?"…) depend on hardware state m0clip doesn't reproduce.
      const condition = pair.name.slice(0, mark);
      if (condition === '360') {
        skipped.push(Object.freeze({ key: pair.key, value: String(pair.value), file, line: pair.line, reason: '360? applies on Xbox 360 only' }));
        return;
      }
      if (condition !== '!360')
        throw new SourceMaterialError('unsupported-parameter', file,
          `Source material ${path}: "${pair.key}" (${file} line ${pair.line}) applies only under the "${condition}?" condition, which m0clip doesn't evaluate.`);
      pair = { ...pair, key: pair.key.slice(pair.key.lastIndexOf('?') + 1), name: pair.name.slice(mark + 1) };
    }
    const previous = into.get(pair.name);
    if (previous && previous.value !== pair.value)
      throw new SourceMaterialError('ambiguous-material', file,
        `Source material ${path}: "${pair.key}" is set to "${previous.value}" (${previous.file} line ${previous.line}) and "${pair.value}" (${file} line ${pair.line}). Source wouldn't treat both the same way, so the material is refused.`);
    if (!previous) into.set(pair.name, Object.freeze({ name: pair.name, key: pair.key, value: pair.value as string, file, block, line: pair.line }));
  };

  for (const entry of root.entries) {
    const { pair, file } = entry;
    if (!isBlock(pair)) { flat(pair, file, entry.block, parameters); continue; }
    if (pair.name === 'proxies') {
      if (proxySeen) invalid(file, `it has two Proxies blocks (lines ${proxySeen.pair.line} and ${pair.line}).`);
      proxySeen = entry;
      for (const proxy of pair.value) {
        if (!isBlock(proxy)) invalid(file, `proxy "${proxy.key}" on line ${proxy.line} isn't a block.`);
        const params = new Map<string, string>();
        for (const inner of proxy.value) {
          if (isBlock(inner)) invalid(file, `proxy "${proxy.key}" sets "${inner.key}" to a block (line ${inner.line}).`);
          const previous = params.get(inner.name);
          if (previous !== undefined && previous !== inner.value)
            throw new SourceMaterialError('ambiguous-material', file, `Source material ${path}: proxy "${proxy.key}" sets "${inner.key}" twice, to different values.`);
          params.set(inner.name, inner.value as string);
        }
        proxies.push(Object.freeze({ name: proxy.name, key: proxy.key, parameters: params, file, line: proxy.line }));
      }
      continue;
    }
    const condition = conditional(pair.name, profile.dxLevel);
    if (condition !== null) {
      blocks.push(Object.freeze({ key: pair.key, file, line: pair.line, applied: condition,
        reason: condition ? `DirectX level ${profile.dxLevel} satisfies ${pair.key}` : `DirectX level ${profile.dxLevel} doesn't satisfy ${pair.key}` }));
      if (condition) overrides.push(entry);
      continue;
    }
    if (pair.name.startsWith(`${shader}_`)) {
      const suffix = pair.name.slice(shader.length);
      if (suffix === '_hdr_dx9') { if (hdrBlock) invalid(file, `it has two ${pair.key} blocks.`); hdrBlock = entry; continue; }
      if (suffix === '_dx9') { if (dx9Block) invalid(file, `it has two ${pair.key} blocks.`); dx9Block = entry; continue; }
      if (/^_(hdr_)?dx[678]\d*$/.test(suffix)) {
        blocks.push(Object.freeze({ key: pair.key, file, line: pair.line, applied: false, reason: `${pair.key} is a fallback below DirectX 9` }));
        continue;
      }
    } else if (/^[a-z0-9_]+?_(hdr_)?dx[0-9]+$/.test(pair.name)) {
      // Fallback blocks of another shader apply only if this shader falls back to it, which none of
      // the supported shaders do at DirectX 9.
      blocks.push(Object.freeze({ key: pair.key, file, line: pair.line, applied: false, reason: `${pair.key} is a fallback for another shader` }));
      continue;
    }
    throw new SourceMaterialError('unsupported-block', file,
      `Source material ${path}: the "${pair.key}" block (${file} line ${pair.line}) isn't a proxy, fallback or DirectX-level block, so m0clip can't tell how Source applies it.`);
  }
  // Whether Source layers an HDR block over the DX9 block or uses it alone isn't settled here, so
  // the two readings must agree: every key of the DX9 block has to be restated in the HDR block.
  if (profile.hdr && hdrBlock && dx9Block) {
    const restated = new Set((hdrBlock.pair.value as readonly KeyValuesPair[]).map(pair => pair.name));
    const loose = (dx9Block.pair.value as readonly KeyValuesPair[]).find(pair => !restated.has(pair.name));
    if (loose) throw new SourceMaterialError('ambiguous-material', dx9Block.file,
      `Source material ${path}: with HDR on, "${loose.key}" from ${dx9Block.pair.key} may or may not apply alongside ${hdrBlock.pair.key}. Load it with HDR off, or restate the key in the HDR block.`);
  }
  const fallback = profile.hdr && hdrBlock ? hdrBlock : dx9Block;
  for (const candidate of [dx9Block, hdrBlock]) if (candidate) blocks.push(Object.freeze({
    key: candidate.pair.key, file: candidate.file, line: candidate.pair.line, applied: candidate === fallback,
    reason: candidate === fallback ? `the DirectX 9${candidate === hdrBlock ? ' HDR' : ''} fallback block for ${shader}`
      : candidate === hdrBlock ? 'HDR is off' : 'HDR is on and the HDR block takes its place',
  }));
  if (fallback) overrides.push(fallback);

  const applied = new Map<string, SourceMaterialParameter>();
  for (const entry of overrides) {
    for (const pair of (entry.pair.value as readonly KeyValuesPair[])) {
      if (isBlock(pair))
        throw new SourceMaterialError('unsupported-block', entry.file,
          `Source material ${path}: the applied ${entry.pair.key} block holds the "${pair.key}" block (line ${pair.line}); nested blocks there aren't supported.`);
      flat(pair, entry.file, entry.pair.key, applied);
    }
  }
  for (const [name, value] of applied) parameters.set(name, value);
  return Object.freeze({
    path, shader, authoredShader: root.shaderKey, chain: Object.freeze(chain), parameters,
    blocks: Object.freeze(blocks), proxies: Object.freeze(proxies), skipped: Object.freeze(skipped),
  });
}
