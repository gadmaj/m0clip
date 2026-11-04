/** Source KeyValues text, as VMT files use it. Tokens follow Source's reader: bytes up to ' ' are
 * whitespace, '//' starts a comment that runs to the end of the line, quoted strings have no escape
 * sequences (VMT paths keep their backslashes), and unquoted tokens end at whitespace, '"', '{' or
 * '}'. Every pair keeps its authored key, its order and duplicates; lookups lower-case the key.
 *
 * Text Source would only accept with a reported error is refused here: an unterminated or
 * multi-line quoted string, a stray '}', a token over Source's 1023-byte limit, '#include'/'#base'
 * directives and '[$...]' platform conditionals, which this reader doesn't evaluate. */

export class SourceKeyValuesError extends Error {
  constructor(readonly path: string, readonly line: number, readonly detail: string) {
    super(`Source material ${path}, line ${line}: ${detail}`);
    this.name = 'SourceKeyValuesError';
  }
}

export interface KeyValuesPair {
  /** Key as authored. */
  readonly key: string;
  /** Lower-case key, the form Source compares. */
  readonly name: string;
  readonly value: string | readonly KeyValuesPair[];
  readonly line: number;
}

export interface KeyValuesDocument {
  readonly path: string;
  readonly root: KeyValuesPair & { readonly value: readonly KeyValuesPair[] };
}

const TOKEN_LIMIT = 1023;
const MAX_DEPTH = 32;

interface Token { readonly text: string; readonly quoted: boolean; readonly line: number }

class Tokenizer {
  private at = 0;
  private line = 1;
  constructor(private readonly path: string, private readonly text: string) {}

  fail(line: number, detail: string): never { throw new SourceKeyValuesError(this.path, line, detail); }

  next(): Token | null {
    const s = this.text;
    for (;;) {
      while (this.at < s.length && s.charCodeAt(this.at) <= 32) {
        if (s.charCodeAt(this.at) === 10) this.line++;
        this.at++;
      }
      if (this.at >= s.length) return null;
      if (s[this.at] === '/' && s[this.at + 1] === '/') {
        while (this.at < s.length && s[this.at] !== '\n') this.at++;
        continue;
      }
      break;
    }
    const line = this.line, c = s[this.at];
    if (c === '"') {
      const start = ++this.at;
      for (;;) {
        if (this.at >= s.length) this.fail(line, 'a quoted string is never closed.');
        const d = s[this.at];
        if (d === '\n' || d === '\r') this.fail(line, 'a quoted string runs past the end of its line.');
        if (d === '"') break;
        this.at++;
      }
      const text = s.slice(start, this.at++);
      if (text.length > TOKEN_LIMIT) this.fail(line, `a string is ${text.length} bytes; Source stops at ${TOKEN_LIMIT}.`);
      return { text, quoted: true, line };
    }
    if (c === '{' || c === '}') { this.at++; return { text: c, quoted: false, line }; }
    const start = this.at;
    while (this.at < s.length) {
      const d = s[this.at];
      if (d === '"' || d === '{' || d === '}' || s.charCodeAt(this.at) <= 32) break;
      this.at++;
    }
    const text = s.slice(start, this.at);
    if (text.length > TOKEN_LIMIT) this.fail(line, `a token is ${text.length} bytes; Source stops at ${TOKEN_LIMIT}.`);
    if (text[0] === '#') this.fail(line, `the ${text} directive isn't supported in materials.`);
    if (text[0] === '[') this.fail(line, `the platform conditional ${text} isn't evaluated.`);
    return { text, quoted: false, line };
  }
}

function block(tokens: Tokenizer, depth: number, opened: number): KeyValuesPair[] {
  if (depth > MAX_DEPTH) tokens.fail(opened, `blocks nest deeper than ${MAX_DEPTH}.`);
  const pairs: KeyValuesPair[] = [];
  for (;;) {
    const key = tokens.next();
    if (!key) tokens.fail(opened, 'a { block is never closed.');
    if (!key.quoted && key.text === '}') return pairs;
    if (!key.quoted && key.text === '{') tokens.fail(key.line, 'a { block has no key.');
    const value = tokens.next();
    if (!value) tokens.fail(key.line, `"${key.text}" has no value.`);
    if (!value.quoted && value.text === '}') tokens.fail(value.line, `"${key.text}" has no value before }.`);
    const item = !value.quoted && value.text === '{' ? block(tokens, depth + 1, value.line) : value.text;
    pairs.push(Object.freeze({ key: key.text, name: key.text.toLowerCase(), value: Object.freeze(item), line: key.line }));
  }
}

/** Parses one KeyValues document: a single root key and its block. Bytes are decoded as Latin-1,
 * so every byte maps to one character and nothing is replaced. A UTF-8 byte-order mark is skipped. */
export function parseKeyValues(path: string, bytes: Uint8Array): KeyValuesDocument {
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const text = new TextDecoder('latin1').decode(bytes.subarray(start));
  if (text.includes('\0')) throw new SourceKeyValuesError(path, 1, 'the file contains a NUL byte, so it isn\'t a text material.');
  const tokens = new Tokenizer(path, text);
  const name = tokens.next();
  if (!name) throw new SourceKeyValuesError(path, 1, 'the file is empty.');
  if (!name.quoted && (name.text === '{' || name.text === '}')) tokens.fail(name.line, 'the file starts with a brace instead of a shader name.');
  const open = tokens.next();
  if (!open || open.quoted || open.text !== '{') return tokens.fail(name.line, `the shader name "${name.text}" isn't followed by a { block.`);
  const value = Object.freeze(block(tokens, 1, open.line));
  const trailing = tokens.next();
  if (trailing) tokens.fail(trailing.line, `text follows the material's closing brace ("${trailing.text}").`);
  return Object.freeze({ path, root: Object.freeze({ key: name.text, name: name.text.toLowerCase(), value, line: name.line }) });
}
