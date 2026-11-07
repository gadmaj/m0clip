/** Ordered KeyValues1 reader. No filesystem directives or code are executed. */
export interface SourceKeyValue {
  /** Case-insensitive lookup name; spelling is retained separately. */
  readonly key: string;
  readonly spelling: string;
  readonly value: string | SourceKeyValues;
  readonly conditions: readonly string[];
  readonly offset: number;
}
export interface SourceKeyValues { readonly entries: readonly SourceKeyValue[] }
export interface SourceKeyValuesOptions {
  /** Source KeyValues defaults this OFF. Enable for files authored with UsesEscapeSequences(true). */
  readonly escapeSequences?: boolean;
  readonly maxDepth?: number;
  /** Cumulative import-owned limits. Strings use UTF-16 bytes; object bytes
   * conservatively include fixed object ownership and ordered-array slots. */
  readonly maxEntries?: number;
  readonly maxStringBytes?: number;
  readonly maxObjects?: number;
  readonly maxObjectBytes?: number;
  /** Import-owned cumulative accounting, shared by every parsed source. */
  readonly budget?: SourceKeyValuesBudget;
}
export class SourceKeyValuesError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`Source KeyValues at character ${offset}: ${message}`);
    this.name = 'SourceKeyValuesError';
  }
}

export class SourceKeyValuesBudget {
  private entries = 0;
  private strings = 0;
  private objects = 0;
  private objectBytes = 0;
  private readonly limits: readonly number[];
  constructor(options: Pick<SourceKeyValuesOptions, 'maxEntries' | 'maxStringBytes' | 'maxObjects' | 'maxObjectBytes'> = {}) {
    this.limits = [options.maxEntries ?? 2_000_000, options.maxStringBytes ?? 128 * 1024 ** 2, options.maxObjects ?? 4_000_000, options.maxObjectBytes ?? 256 * 1024 ** 2];
    if (this.limits.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid Source KeyValues resource limit');
  }
  reserve(entries = 0, strings = 0, objects = 0, slots = 0): void {
    const nextEntries = this.entries + entries, nextStrings = this.strings + strings, nextObjects = this.objects + objects;
    // Conservative fixed ownership per object plus ordered-array reference slots.
    const nextObjectBytes = this.objectBytes + objects * 96 + (entries + slots) * 8;
    if (!Number.isSafeInteger(nextEntries) || nextEntries > this.limits[0]
      || !Number.isSafeInteger(nextStrings) || nextStrings > this.limits[1]
      || !Number.isSafeInteger(nextObjects) || nextObjects > this.limits[2]
      || !Number.isSafeInteger(nextObjectBytes) || nextObjectBytes > this.limits[3]) throw new Error('Source KeyValues resource limit exceeded');
    this.entries = nextEntries; this.strings = nextStrings; this.objects = nextObjects; this.objectBytes = nextObjectBytes;
  }
}
interface Token { kind: 'text' | 'open' | 'close' | 'condition'; text: string; offset: number }
const escapes: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' };

export function parseSourceKeyValues(text: string, options: SourceKeyValuesOptions = {}): SourceKeyValues {
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lookahead: Token | undefined;
  const maxDepth = options.maxDepth ?? 128;
  const budget = options.budget ?? new SourceKeyValuesBudget(options);
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error('Source KeyValues: maxDepth must be a positive integer');
  function fail(message: string, offset = position): never { throw new SourceKeyValuesError(message, offset); }
  function next(): Token | undefined {
    for (;;) {
      while (position < text.length && /\s/.test(text[position])) position++;
      if (text.startsWith('//', position)) {
        const end = text.indexOf('\n', position + 2);
        position = end < 0 ? text.length : end + 1;
      } else if (text.startsWith('/*', position)) {
        const end = text.indexOf('*/', position + 2);
        if (end < 0) fail('unterminated block comment');
        position = end + 2;
      } else break;
    }
    if (position === text.length) return undefined;
    const offset = position, first = text[position++];
    if (first === '\0') {
      if (/^[\0\s]*$/.test(text.slice(position))) { position = text.length; return undefined; }
      fail('embedded NUL', offset);
    }
    if (first === '{' || first === '}') return { kind: first === '{' ? 'open' : 'close', text: first, offset };
    if (first === '"') {
      let value = '';
      while (position < text.length) {
        const character = text[position++];
        if (character !== '"') budget.reserve(0, 2);
        if (character === '"') return { kind: 'text', text: value, offset };
        if (character === '\0') fail('NUL in quoted string', position - 1);
        if (character === '\\' && options.escapeSequences && position < text.length) {
          const escaped = text[position];
          if (Object.hasOwn(escapes, escaped)) { value += escapes[escaped]; position++; }
          else value += character; // Do not destroy unknown escapes / Source path separators.
        } else value += character;
      }
      return fail('unterminated quoted string', offset);
    }
    if (first === '[') {
      const end = text.indexOf(']', position);
      if (end < 0) fail('unterminated conditional', offset);
      budget.reserve(0, (end + 1 - offset) * 2);
      const value = text.slice(offset, end + 1);
      position = end + 1;
      return { kind: 'condition', text: value, offset };
    }
    while (position < text.length && !/[\s{}"\0]/.test(text[position]) && !text.startsWith('//', position) && !text.startsWith('/*', position)) position++;
    budget.reserve(0, (position - offset) * 2);
    return { kind: 'text', text: text.slice(offset, position), offset };
  }
  const peek = () => lookahead ??= next();
  const take = () => { const token = peek(); lookahead = undefined; return token; };
  function block(depth: number, nested: boolean): SourceKeyValues {
    if (depth > maxDepth) fail(`nesting exceeds ${maxDepth}`);
    budget.reserve(0, 0, 2); // Block and ordered entry array.
    const entries: SourceKeyValue[] = [];
    for (;;) {
      const key = take();
      if (!key) {
        if (nested) fail('missing closing brace');
        return Object.freeze({ entries: Object.freeze(entries) });
      }
      if (key.kind === 'close') {
        if (!nested) fail('unexpected closing brace', key.offset);
        return Object.freeze({ entries: Object.freeze(entries) });
      }
      if (key.kind !== 'text' || !key.text) fail('expected key', key.offset);
      budget.reserve(1, key.text.length * 2, 2); // Entry, conditions and lowercase key.
      const conditions: string[] = [];
      while (peek()?.kind === 'condition') { budget.reserve(0, 0, 0, 1); conditions.push(take()!.text); }
      const token = take();
      if (!token || (token.kind !== 'text' && token.kind !== 'open')) fail(`missing value for ${key.text}`, key.offset);
      const value = token.kind === 'open' ? block(depth + 1, true) : token.text;
      // Postfix conditions occur on scalar values; accepting them on blocks also
      // preserves authored branch extensions instead of flattening their contents.
      while (peek()?.kind === 'condition') { budget.reserve(0, 0, 0, 1); conditions.push(take()!.text); }
      entries.push(Object.freeze({ key: key.text.toLowerCase(), spelling: key.text, value, conditions: Object.freeze(conditions), offset: key.offset }));
    }
  }
  return block(0, false);
}

/** Source lookup is first-match, not JavaScript object last-write-wins. */
export function sourceKeyValue(block: SourceKeyValues, key: string): SourceKeyValue | undefined {
  const lower = key.toLowerCase();
  return block.entries.find(entry => entry.key === lower);
}
