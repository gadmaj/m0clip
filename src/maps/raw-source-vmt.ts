/** Native material CPU descriptors, not a renderer or a raw-map support claim.
 * Patch/parameter/transform behavior adapted from noclip.website VMT.ts,
 * MaterialParameters.ts and MaterialBase.ts, copyright (c) 2018 Jasper St. Pierre.
 * MIT license retained in LICENSE.noclip. No game data is embedded here.
 */
import { canonicalSourcePath } from './raw-source-files';
import type { SourceFileSystem } from './raw-source-files';
import { parseSourceKeyValues, sourceKeyValue, SourceKeyValuesBudget } from './raw-source-keyvalues';
import type { SourceKeyValue, SourceKeyValues, SourceKeyValuesOptions } from './raw-source-keyvalues';
export { SourceKeyValuesError } from './raw-source-keyvalues';
export type { SourceKeyValue, SourceKeyValues } from './raw-source-keyvalues';

export interface SourceVmt {
  readonly shader: string;
  readonly root: SourceKeyValue;
  /** Original ordered tree, including duplicate, conditional, proxy and fallback keys. */
  readonly document: SourceKeyValues;
  readonly body: SourceKeyValues;
}
export interface SourceMaterialOptions extends SourceKeyValuesOptions {
  readonly signal?: AbortSignal;
  /** Explicit target, never inferred from the browser host. Defaults to Windows PC. */
  readonly conditionSymbols?: Readonly<Record<string, boolean>>;
  /** Ordered noclip fallback/conditional-key profile. Default: DX9, sRGB, LDR. */
  readonly materialDefines?: readonly string[];
  readonly maxPatchDepth?: number;
  /** Cumulative import/profile limits for trees, scalar normalization, diagnostic
   * ownership and parameter slots. Bytes are conservative, not engine heap metrics. */
  readonly maxMergeWork?: number;
  readonly maxResolvedEntries?: number;
  readonly maxResolvedBytes?: number;
  /** Shared by the resolver and its exporter's retained requirement records. */
  readonly resourceBudget?: SourceMaterialBudget;
}
export interface SourceTextureReference {
  readonly parameter: string;
  readonly name: string;
  readonly kind: 'file' | 'local-cubemap' | 'runtime';
  readonly path?: string;
  /** Sampling intent; VTF format/HDR flags must still be reconciled by the consumer. */
  readonly colorSpace: 'srgb' | 'linear' | 'shader-defined';
  readonly frame: number;
  readonly transform?: SourceTextureTransform;
}
export interface SourceTextureTransform {
  readonly center: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotate: number;
  readonly translate: readonly [number, number];
  /** Row-major 3x3 affine UV matrix, same layout as existing sourceMaterial metadata. */
  readonly matrix: readonly number[];
}
export interface SourceMaterialMetadata {
  readonly [key: string]: string | number | boolean | readonly number[] | undefined;
  readonly shader: string;
  readonly color: readonly number[];
  readonly alphatest: boolean;
  readonly alphatestreference: number;
  readonly translucent: boolean;
  readonly additive: boolean;
  readonly nocull: boolean;
  readonly unlit: boolean;
}
export type SourceMaterialIssueCode = 'condition' | 'parameter-shape' | 'directive' | 'patch' | 'fallback' | 'texture-frame'
  | 'texture-sampling' | 'render-target' | 'local-cubemap' | 'detail-blend' | 'proxies' | 'texture-transform' | 'shader' | 'parameter';
export interface SourceMaterialIssue { readonly code: SourceMaterialIssueCode; readonly detail: string; readonly parameter?: string }
class MaterialIssues extends Map<string, SourceMaterialIssue> {
  constructor(readonly budget: SourceMaterialBudget) { budget.reserve(0, 0, 64); super(); }
  override set(key: string, value: SourceMaterialIssue): this {
    this.budget.reserve(1, this.has(key) ? 0 : 1, this.has(key) ? 0 : 64);
    return super.set(key, value);
  }
  snapshot(): readonly SourceMaterialIssue[] {
    this.budget.reserve(this.size, this.size, 32 + this.size * 8);
    return Object.freeze([...this.values()]);
  }
}
function addIssue(issues: MaterialIssues, code: SourceMaterialIssueCode, detail: string, parameter?: string): void {
  if (!issues.has(detail)) {
    issues.budget.reserve(detail.length, 1, 96 + detail.length * 2);
    issues.set(detail, Object.freeze({ code, detail, ...(parameter === undefined ? {} : { parameter }) }));
  }
}

export interface ResolvedSourceMaterial {
  readonly path: string;
  readonly shader: string;
  /** Included/base tree after recursive replace then insert. Duplicates remain ordered. */
  readonly body: SourceKeyValues;
  /** All original VMTs, outermost patch first; nothing is destructively flattened. */
  readonly sources: readonly { readonly path: string; readonly vmt: SourceVmt }[];
  readonly materialDependencies: readonly string[];
  readonly textureDependencies: readonly string[];
  /** First matching material keys, conditional parameters and selected fallback applied. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly textures: readonly SourceTextureReference[];
  readonly transforms: Readonly<Record<string, SourceTextureTransform>>;
  /** Existing renderer's sourceMaterial names/defaults, not a generic shader replacement. */
  readonly metadata: SourceMaterialMetadata;
  readonly proxies: readonly SourceKeyValue[];
  readonly fallbackBlocks: readonly SourceKeyValue[];
  readonly selectedFallback?: string;
  readonly capability: {
    readonly shaderFamily: 'generic' | 'unsupported';
    readonly nativeAssemblyRequired: true;
    readonly unknownParameters: readonly string[];
    readonly unevaluatedBlocks: readonly string[];
    readonly issues: readonly SourceMaterialIssue[];
  };
}

export class SourceMaterialError extends Error {
  constructor(message: string, readonly path?: string) {
    super(`Source material${path ? ` ${path}` : ''}: ${message}`);
    this.name = 'SourceMaterialError';
  }
}

export function parseSourceVmt(text: string, options: SourceKeyValuesOptions = {}): SourceVmt {
  const document = parseSourceKeyValues(text, options);
  if (document.entries.length !== 1) throw new SourceMaterialError('expected one shader block');
  const root = document.entries[0];
  if (typeof root.value === 'string') throw new SourceMaterialError('shader must contain a block');
  if (root.key.startsWith('#')) throw new SourceMaterialError('KeyValues filesystem directives are not material shaders');
  return Object.freeze({ shader: root.key, root, document, body: root.value });
}

/** Source names are materials-root-relative, including Patch includes. One leading
 * separator names that virtual root, never a URL, drive or UNC filesystem root. */
export function sourceMaterialPath(name: string, extension: 'vmt' | 'vtf' = 'vmt'): string {
  const path = canonicalSourcePath(name.trim().replace(/^[\\/](?![\\/])/, ''));
  const rooted = path.startsWith('materials/') ? path : `materials/${path}`;
  return rooted.endsWith(`.${extension}`) ? rooted : `${rooted}.${extension}`;
}

/** Curly-brace vectors are byte colors, square/unadorned vectors are normalized.
 * Source/noclip tolerates mismatched closing decoration in shipped material files. */
export function parseSourceVector(text: string, budget?: SourceMaterialBudget): number[] {
  // At most length+1 split tokens. Reserve scan/conversion and both token and
  // numeric arrays before trim/replace/split materialize attacker-sized values.
  budget?.reserve(text.length + 1, text.length + 1, 64 + text.length * 40);
  const source = text.trim(), scale = source.startsWith('{') ? 1 / 255 : 1;
  const words = source.replace(/[\[\]{}]/g, '').trim().split(/\s+/);
  if (!words[0]) throw new SourceMaterialError(`empty vector ${JSON.stringify(text)}`);
  const vector = words.map(word => Number(word) * scale);
  if (vector.some(value => !Number.isFinite(value))) throw new SourceMaterialError(`invalid vector ${JSON.stringify(text)}`);
  return vector;
}

export function parseSourceColor(text: string, budget?: SourceMaterialBudget): readonly [number, number, number] {
  const vector = parseSourceVector(text, budget);
  return [vector[0], vector[1] ?? vector[0], vector[2] ?? vector[0]];
}

export function parseSourceBoolean(text: string, budget?: SourceMaterialBudget): boolean {
  budget?.reserve(text.length, 0, text.length * 4);
  if (text.trim().toLowerCase() === 'true') return true;
  if (text.trim().toLowerCase() === 'false') return false;
  return parseSourceVector(text, budget)[0] !== 0;
}

export function parseSourceTextureTransform(text: string, budget?: SourceMaterialBudget): SourceTextureTransform {
  budget?.reserve(text.length + 1, text.length + 1, 128 + text.length * 48);
  const tokens = text.trim() ? text.trim().split(/\s+/) : [];
  const values: Record<string, number[]> = { center: [0, 0], scale: [1, 1], rotate: [0], translate: [0, 0] };
  let index = 0;
  while (index < tokens.length) {
    const mode = tokens[index++].toLowerCase();
    if (!Object.hasOwn(values, mode)) throw new SourceMaterialError(`unknown texture transform section ${mode}`);
    const numbers: number[] = [];
    while (index < tokens.length && !/^[a-z]+$/i.test(tokens[index])) {
      const value = Number(tokens[index++]);
      if (!Number.isFinite(value)) throw new SourceMaterialError(`invalid texture transform ${text}`);
      numbers.push(value);
    }
    if (numbers.length < 1 || numbers.length > (mode === 'rotate' ? 1 : 2)) throw new SourceMaterialError(`invalid ${mode} in texture transform ${text}`);
    values[mode] = numbers;
  }
  const [cx, cy = cx] = values.center, [sx, sy = sx] = values.scale, [tx, ty = tx] = values.translate;
  const rotate = values.rotate[0], angle = rotate * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  // ParameterMatrix sets S and -center together, then left-multiplies R and
  // T(center+translate). This is NOT the common T(center)*R*S*T(-center).
  return { center: [cx, cy], scale: [sx, sy], rotate, translate: [tx, ty], matrix: [
    c * sx, -s * sy, cx + tx - c * cx + s * cy,
    s * sx, c * sy, cy + ty - s * cx - c * cy,
    0, 0, 1,
  ] };
}

const defaultDefines = ['gpu>=1', 'gpu>=2', 'gpu>=3', '>=dx90_20b', '>=dx90', '>dx90', 'srgb', 'srgb_pc', 'dx9', 'ldr'];
const defaultSymbols: Readonly<Record<string, boolean>> = { WIN32: true, WINDOWS: true, X360: false, OSX: false, LINUX: false, POSIX: false, DECK: false };

function accepted(entry: SourceKeyValue, symbols: Readonly<Record<string, boolean>>, issues: MaterialIssues): boolean {
  for (const condition of entry.conditions) {
    const match = /^\[\s*(!?)\s*\$([a-z0-9_]+)\s*\]$/i.exec(condition);
    if (!match || !Object.hasOwn(symbols, match[2].toUpperCase())) {
      addIssue(issues,'condition',`Unresolved KeyValues condition ${condition}; affected entries are retained only in sources`,condition);
      return false;
    }
    const result = symbols[match[2].toUpperCase()];
    if (match[1] ? result : !result) return false;
  }
  return true;
}

export class SourceMaterialBudget {
  private work = 0;
  private entries = 0;
  private bytes = 0;
  private readonly limits: readonly number[];
  constructor(options: SourceMaterialOptions) {
    this.limits = [options.maxMergeWork ?? 20_000_000, options.maxResolvedEntries ?? 4_000_000, options.maxResolvedBytes ?? 256 * 1024 ** 2];
    if (this.limits.some(value => !Number.isSafeInteger(value) || value < 1)) throw new SourceMaterialError('invalid tree resource limit');
  }
  reserve(work: number, entries = 0, bytes = 0): void {
    const totals = [this.work + work, this.entries + entries, this.bytes + bytes];
    if (totals.some((value, index) => !Number.isSafeInteger(value) || value > this.limits[index])) throw new SourceMaterialError('tree resource limit exceeded');
    [this.work, this.entries, this.bytes] = totals;
  }
}

function activeBlock(block: SourceKeyValues, symbols: Readonly<Record<string, boolean>>, issues: MaterialIssues, budget: SourceMaterialBudget): SourceKeyValues {
  budget.reserve(block.entries.length, block.entries.length, 32 + block.entries.length * 88);
  const entries: SourceKeyValue[] = [];
  let changed = false;
  for (const entry of block.entries) {
    if (!accepted(entry, symbols, issues)) { changed = true; continue; }
    const value = typeof entry.value === 'string' ? entry.value : activeBlock(entry.value, symbols, issues, budget);
    if (value !== entry.value) { changed = true; entries.push(Object.freeze({ ...entry, value })); }
    else entries.push(entry);
  }
  return changed ? Object.freeze({ entries: Object.freeze(entries) }) : block;
}

/** Replace changes existing leaves; insert adds AND overwrites. Lookup always
 * targets the first duplicate, while ordered proxy duplicates remain distinct. */
function patchBlock(destination: SourceKeyValues, patch: SourceKeyValues, replace: boolean, budget: SourceMaterialBudget): SourceKeyValues {
  if (!patch.entries.length) return destination;
  budget.reserve(destination.entries.length + patch.entries.length, destination.entries.length + patch.entries.length,
    64 + destination.entries.length * 48 + patch.entries.length * 128);
  const entries = [...destination.entries], first = new Map<string, number>();
  for (let index = 0; index < entries.length; index++) if (!first.has(entries[index].key)) first.set(entries[index].key, index);
  for (const entry of patch.entries) {
    const index = first.get(entry.key);
    if (index === undefined && replace) continue;
    const previous = index === undefined ? undefined : entries[index];
    let value = entry.value;
    if (typeof value !== 'string') {
      if (previous && typeof previous.value === 'string') throw new SourceMaterialError(`Patch block ${entry.key} targets a scalar`);
      value = patchBlock((previous?.value as SourceKeyValues | undefined) ?? { entries: [] }, value, replace, budget);
    }
    const updated = Object.freeze({ ...entry, value });
    if (index === undefined) { first.set(entry.key, entries.length); entries.push(updated); }
    else entries[index] = updated;
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

function parametersFrom(block: SourceKeyValues, defines: readonly string[], target: Record<string, string>, issues: MaterialIssues): void {
  const seen = new Set<string>();
  for (const entry of block.entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    let key = entry.key;
    const question = key.indexOf('?');
    if (question >= 0) {
      const condition = key.slice(0, question), negate = condition.startsWith('!');
      if (defines.includes(negate ? condition.slice(1) : condition) === negate) continue;
      key = key.slice(question + 1);
    }
    if (!key.startsWith('$')) continue;
    if (typeof entry.value === 'string') target[key] = entry.value;
    else addIssue(issues,'parameter-shape',`Material parameter ${key} is a block, not a scalar`,key);
  }
}

const booleanNames = ['alphatest', 'translucent', 'additive', 'nocull', 'selfillum', 'halflambert', 'ssbump', 'nodiffusebumplighting', 'normalmapalphaenvmapmask', 'basealphaenvmapmask', 'phong', 'phongalbedotint', 'phongmaskinvert', 'vertexcolor', 'vertexalpha', 'ignorez', 'znearer', 'decal', 'nofog', 'model', 'receiveflashlight', 'selfillumfresnel', 'opaquetexture'];
const numericDefaults: Readonly<Record<string, number>> = { alpha: 1, alphatestreference: .7, envmapcontrast: 0, envmapsaturation: 1, envmapfresnel: 1, envmaplightscale: 0, phongboost: 1, phongexponent: 5, phongexponentfactor: 149, phongalbedoboost: 1, detailscale: 4, detailblendfactor: 1, detailblendmode: 0, decalblendmode: -1, frame: 0, frame2: 0, bumpframe: 0, bumpframe2: 0, envmapframe: 0, envmapmaskframe: 0, detailframe: 0 };
const colorDefaults: Readonly<Record<string, string>> = { color: '[1 1 1]', color2: '[1 1 1]', selfillumtint: '[1 1 1]', envmaptint: '[1 1 1]', phongtint: '[1 1 1]', phongfresnelranges: '[0 .5 1]' };
const textureSlots: Readonly<Record<string, { srgb?: boolean; frame?: string; transform?: string }>> = {
  basetexture: { srgb: true, frame: 'frame', transform: 'basetexturetransform' },
  basetexture2: { srgb: true, frame: 'frame2', transform: 'basetexturetransform2' },
  bumpmap: { srgb: false, frame: 'bumpframe', transform: 'bumptransform' },
  bumpmap2: { srgb: false, frame: 'bumpframe2', transform: 'bumptransform2' },
  bumpmask: { srgb: false }, envmap: { srgb: true, frame: 'envmapframe' },
  envmapmask: { srgb: false, frame: 'envmapmaskframe', transform: 'envmapmasktransform' },
  detail: { srgb: false, frame: 'detailframe', transform: 'detailtexturetransform' },
  phongexponenttexture: { srgb: false }, selfillummask: { srgb: false },
  blendmodulatetexture: { srgb: true, transform: 'blendmasktransform' }, decaltexture: { srgb: false },
  // Dependency roles outside the existing generic shader retain unknown sampling intent.
  lightwarptexture: {}, phongwarptexture: {},
  dudvmap: {}, normalmap: {}, flowmap: {},
  refracttexture: {}, reflecttexture: {}, flashlighttexture: {},
};

interface ResolvedTree {
  readonly shader: string;
  readonly body: SourceKeyValues;
  readonly sources: readonly { readonly path: string; readonly vmt: SourceVmt }[];
  readonly issues: readonly SourceMaterialIssue[];
}
interface MaterialContext {
  readonly trees: Map<string, ResolvedTree | undefined>;
  readonly parser: SourceKeyValuesBudget;
  readonly budget: SourceMaterialBudget;
}

/** One import and immutable target profile. Resolution is queued so concurrent
 * roots cannot deadlock on mutually dependent include promises. No global cache. */
export function createSourceMaterialResolver(filesystem: Pick<SourceFileSystem, 'readFile'>, options: SourceMaterialOptions = {}): (name: string) => Promise<ResolvedSourceMaterial | undefined> {
  const profile: SourceMaterialOptions = { ...options,
    conditionSymbols: options.conditionSymbols ? Object.freeze({ ...options.conditionSymbols }) : undefined,
    materialDefines: options.materialDefines ? Object.freeze([...options.materialDefines]) : undefined };
  const context: MaterialContext = { trees: new Map(), parser: options.budget ?? new SourceKeyValuesBudget(profile), budget: options.resourceBudget ?? new SourceMaterialBudget(profile) };
  let queue: Promise<unknown> = Promise.resolve();
  return name => {
    const result = queue.then(() => resolveMaterial(name, filesystem, profile, context));
    queue = result.then(() => {}, () => {});
    return result;
  };
}

export function resolveSourceMaterial(name: string, filesystem: Pick<SourceFileSystem, 'readFile'>, options: SourceMaterialOptions = {}): Promise<ResolvedSourceMaterial | undefined> {
  return createSourceMaterialResolver(filesystem, options)(name);
}

async function resolveMaterial(name: string, filesystem: Pick<SourceFileSystem, 'readFile'>, options: SourceMaterialOptions, context: MaterialContext): Promise<ResolvedSourceMaterial | undefined> {
  const path = sourceMaterialPath(name), issues = new MaterialIssues(context.budget);
  const symbols: Record<string, boolean> = Object.create(null);
  for (const [key, value] of Object.entries(options.conditionSymbols ?? defaultSymbols)) symbols[key.replace(/^\$/, '').toUpperCase()] = value;
  const defines = (options.materialDefines ?? defaultDefines).map(define => define.toLowerCase());
  const maxDepth = options.maxPatchDepth ?? 64;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new SourceMaterialError('maxPatchDepth must be a positive integer', path);
  const stack: string[] = [];
  async function resolve(current: string): Promise<ResolvedTree | undefined> {
    options.signal?.throwIfAborted();
    if (stack.includes(current)) throw new SourceMaterialError(`Patch include cycle: ${[...stack, current].join(' -> ')}`, current);
    if (stack.length >= maxDepth) throw new SourceMaterialError(`Patch include depth exceeds ${maxDepth}`, current);
    if (context.trees.has(current)) {
      const cached = context.trees.get(current);
      if (cached && stack.length + cached.sources.length > maxDepth) throw new SourceMaterialError(`Patch include depth exceeds ${maxDepth}`, current);
      return cached;
    }
    const file = await filesystem.readFile(current, options.signal);
    options.signal?.throwIfAborted();
    if (!file) { context.trees.set(current, undefined); return undefined; }
    context.parser.reserve(0, file.size * 2); // Decoded source ownership before decoding.
    const bytes = await file.arrayBuffer();
    options.signal?.throwIfAborted();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('windows-1252').decode(bytes); }
    const vmt = parseSourceVmt(text, { ...options, budget: context.parser });
    const localIssues = new MaterialIssues(context.budget);
    if (!accepted(vmt.root, symbols, localIssues)) throw new SourceMaterialError('shader root condition is not active', current);
    const body = activeBlock(vmt.body, symbols, localIssues, context.budget);
    for (const entry of body.entries) if (entry.key.startsWith('#')) addIssue(localIssues,'directive',`Unexecuted filesystem directive ${entry.key} in ${current}`,entry.key);
    let shader = vmt.shader, patched = body;
    let sources: readonly { readonly path: string; readonly vmt: SourceVmt }[] = [Object.freeze({ path: current, vmt })];
    let inheritedIssues: readonly SourceMaterialIssue[] | undefined;
    if (shader === 'patch') {
      const include = sourceKeyValue(body, 'include');
      if (!include || typeof include.value !== 'string' || !include.value.trim()) throw new SourceMaterialError('Patch requires a scalar include', current);
      stack.push(current);
      let base: ResolvedTree | undefined;
      const includedPath = sourceMaterialPath(include.value);
      try { base = await resolve(includedPath); } finally { stack.pop(); }
      if (!base) throw new SourceMaterialError(`missing Patch include ${includedPath}`, current);
      context.budget.reserve(base.sources.length, base.sources.length + 1, (base.sources.length + 1) * 32);
      sources = [...sources, ...base.sources];
      if (!localIssues.size && body.entries.every(entry => ['include', 'replace', 'insert'].includes(entry.key))) inheritedIssues = base.issues;
      else for (const issue of base.issues) localIssues.set(issue.detail, issue);
      shader = base.shader;
      patched = base.body;
      for (const mode of ['replace', 'insert']) {
        const operation = sourceKeyValue(body, mode);
        if (!operation) continue;
        if (typeof operation.value === 'string') throw new SourceMaterialError(`Patch ${mode} must be a block`, current);
        patched = patchBlock(patched, operation.value, mode === 'replace', context.budget);
      }
      for (const entry of body.entries) if (!['include', 'replace', 'insert'].includes(entry.key)) addIssue(localIssues,'patch',`Patch-only key ${entry.key} is preserved in sources, not applied`,entry.key);
    }
    const result: ResolvedTree = Object.freeze({ shader, body: patched, sources: Object.freeze(sources), issues: inheritedIssues ?? localIssues.snapshot() });
    context.trees.set(current, result);
    return result;
  }
  const resolved = await resolve(path);
  if (!resolved) return undefined;
  const { shader, body } = resolved;
  const sources = resolved.sources;
  for (const issue of resolved.issues) issues.set(issue.detail, issue);
  context.budget.reserve(body.entries.length, body.entries.length, body.entries.length * 96);
  const parameters: Record<string, string> = Object.create(null);
  parametersFrom(body, defines, parameters, issues);
  let selectedFallback: string | undefined;
  for (const define of defines) {
    const fallback = sourceKeyValue(body, define) ?? sourceKeyValue(body, `${shader}_${define}`);
    if (!fallback) continue;
    if (typeof fallback.value === 'string') { addIssue(issues,'fallback',`Fallback ${fallback.key} is not a block`,fallback.key); continue; }
    selectedFallback = fallback.key;
    context.budget.reserve(fallback.value.entries.length, fallback.value.entries.length, fallback.value.entries.length * 96);
    parametersFrom(fallback.value, defines, parameters, issues);
    break;
  }
  const metadata: Record<string, string | number | boolean | readonly number[] | undefined> = { shader, unlit: shader === 'unlitgeneric' || shader === 'sdk_unlitgeneric' };
  const recognized = new Set<string>();
  for (const key of booleanNames) {
    recognized.add(`$${key}`);
    metadata[key] = parameters[`$${key}`] === undefined ? false : parseSourceBoolean(parameters[`$${key}`], context.budget);
  }
  for (const [key, fallback] of Object.entries(numericDefaults)) {
    recognized.add(`$${key}`);
    metadata[key] = parameters[`$${key}`] === undefined ? fallback : parseSourceVector(parameters[`$${key}`], context.budget)[0];
  }
  for (const [key, fallback] of Object.entries(colorDefaults)) {
    recognized.add(`$${key}`);
    metadata[key] = parseSourceColor(parameters[`$${key}`] ?? fallback, context.budget);
  }
  recognized.add('$basemapalphaphongmask'); recognized.add('$invertphongmask');
  metadata.basealphaphongmask = parameters.$basemapalphaphongmask === undefined ? false : parseSourceBoolean(parameters.$basemapalphaphongmask, context.budget);
  if (parameters.$invertphongmask !== undefined) metadata.phongmaskinvert = parseSourceBoolean(parameters.$invertphongmask, context.budget);
  metadata.halflambert = Boolean(metadata.halflambert || metadata.phong);
  const transforms: Record<string, SourceTextureTransform> = Object.create(null);
  for (const spec of Object.values(textureSlots)) {
    if (!spec.transform) continue;
    const key = `$${spec.transform}`, value = parameters[key];
    if (value === undefined || Object.hasOwn(transforms, key)) continue;
    recognized.add(key);
    transforms[key] = parseSourceTextureTransform(value, context.budget);
    metadata[key.slice(1)] = transforms[key].matrix;
  }
  const textures: SourceTextureReference[] = [];
  for (const [slot, spec] of Object.entries(textureSlots)) {
    const parameter = `$${slot}`, value = parameters[parameter];
    recognized.add(parameter);
    if (!value?.trim()) continue;
    const textureName = value.trim(), lower = textureName.toLowerCase();
    const kind = lower === 'env_cubemap' ? 'local-cubemap' : lower.startsWith('_rt_') ? 'runtime' : 'file';
    metadata[slot] = textureName;
    const frame = Number(spec.frame ? metadata[spec.frame] ?? 0 : 0);
    const srgb = slot === 'detail' ? metadata.detailblendmode === 1
      : slot === 'decaltexture' ? metadata.decalblendmode === 0 : spec.srgb;
    if (!Number.isInteger(frame) || frame < 0) addIssue(issues,'texture-frame',`Texture ${parameter} uses a dynamic/invalid static frame ${frame}; consumer must reconcile it with VTF frames`,parameter);
    textures.push({ parameter, name: textureName, kind, path: kind === 'file' ? sourceMaterialPath(textureName, 'vtf') : undefined,
      colorSpace: srgb === undefined ? 'shader-defined' : srgb ? 'srgb' : 'linear', frame, transform: spec.transform ? transforms[`$${spec.transform}`] : undefined });
    if (srgb === undefined) addIssue(issues,'texture-sampling',`Texture ${parameter} has shader-defined sampling; no existing native implementation is claimed`,parameter);
    if (kind === 'runtime') addIssue(issues,'render-target',`Texture ${parameter} requires runtime render target ${textureName}`,parameter);
    if (kind === 'local-cubemap') addIssue(issues,'local-cubemap',`Texture ${parameter} requires BSP/entity-local cubemap selection`,parameter);
  }
  metadata.envmap ??= '';
  if (parameters.$detail && metadata.detailblendmode !== 0) addIssue(issues,'detail-blend',`Existing renderer does not implement detail blend mode ${metadata.detailblendmode}`,'$detailblendmode');
  const proxies = body.entries.filter(entry => entry.key === 'proxies');
  const fallbackBlocks = body.entries.filter(entry => typeof entry.value !== 'string' && entry.key !== 'proxies');
  if (proxies.length) addIssue(issues,'proxies','Ordered material proxies are preserved, not executed by this CPU resolver');
  if (Object.keys(transforms).some(key => key !== '$basetexturetransform')) addIssue(issues,'texture-transform','Independent texture transforms require assembly support beyond existing base-texture metadata');
  const genericShaders = ['lightmappedgeneric', 'vertexlitgeneric', 'unlitgeneric', 'sdk_unlitgeneric', 'worldvertextransition'];
  const shaderFamily = genericShaders.includes(shader) ? 'generic' : 'unsupported';
  if (shaderFamily === 'unsupported') addIssue(issues,'shader',`No existing native renderer implementation is claimed for shader ${shader}`);
  const unknownParameters = Object.keys(parameters).filter(key => !recognized.has(key));
  if (unknownParameters.length) addIssue(issues,'parameter','Unrecognized shader parameters remain in parameters; they are not implemented by metadata extraction');
  options.signal?.throwIfAborted();
  return { path, shader, body, sources, materialDependencies: sources.map(source => source.path),
    textureDependencies: [...new Set(textures.flatMap(texture => texture.path ? [texture.path] : []))],
    parameters, textures, transforms, metadata: metadata as SourceMaterialMetadata, proxies, fallbackBlocks, selectedFallback,
    capability: { shaderFamily, nativeAssemblyRequired: true, unknownParameters,
      unevaluatedBlocks: fallbackBlocks.filter(entry => entry.key !== selectedFallback).map(entry => entry.key), issues: issues.snapshot() } };
}
