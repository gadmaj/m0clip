/**
 * Reads the FileSystem/SearchPaths block of a Source gameinfo.txt (KeyValues text). Only the
 * entries are returned, in authored order; resolving them against selected files is the caller's.
 */
export interface GameInfoSearchPath {
  /** Path IDs split on '+', lower-case (for example ['game', 'mod']). */
  readonly ids: readonly string[];
  /** The authored path, including |gameinfo_path| / |all_source_engine_paths| tokens. */
  readonly value: string;
  /** A trailing [$CONDITION] exactly as authored, when present. */
  readonly condition?: string;
}

interface Token { readonly text: string; readonly kind: 'open' | 'close' | 'condition' | 'text' }
interface KeyValue { readonly key: string; readonly value: string | KeyValue[]; readonly condition?: string }

const MAX_DEPTH = 32;

function fail(label: string, message: string): never { throw new Error(`${label}: ${message}`); }

function tokenize(text: string, label: string): Token[] {
  const tokens: Token[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (c === '{' || c === '}') { tokens.push({ text: c, kind: c === '{' ? 'open' : 'close' }); i++; continue; }
    if (c === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) fail(label, 'unterminated quoted string');
      tokens.push({ text: text.slice(i + 1, close), kind: 'text' });
      i = close + 1;
      continue;
    }
    const start = i;
    while (i < text.length && !/[\s{}"]/.test(text[i])) i++;
    const bare = text.slice(start, i);
    tokens.push({ text: bare, kind: bare.startsWith('[') && bare.endsWith(']') ? 'condition' : 'text' });
  }
  return tokens;
}

function parseBlock(tokens: readonly Token[], start: number, depth: number, label: string): [KeyValue[], number] {
  if (depth > MAX_DEPTH) fail(label, 'blocks are nested too deeply');
  const nodes: KeyValue[] = [];
  let pos = start;
  while (pos < tokens.length) {
    const key = tokens[pos++];
    if (key.kind === 'close') {
      if (depth === 0) fail(label, 'unexpected "}"');
      return [nodes, pos];
    }
    if (key.kind !== 'text') fail(label, `${JSON.stringify(key.text)} where a key belongs`);
    let condition: string | undefined;
    if (tokens[pos]?.kind === 'condition') condition = tokens[pos++].text;
    const next = tokens[pos];
    if (next?.kind === 'open') {
      const [children, after] = parseBlock(tokens, pos + 1, depth + 1, label);
      nodes.push({ key: key.text, value: children, condition });
      pos = after;
    } else if (next?.kind === 'text') {
      pos++;
      if (tokens[pos]?.kind === 'condition') condition = tokens[pos++].text;
      nodes.push({ key: key.text, value: next.text, condition });
    } else fail(label, `key ${JSON.stringify(key.text)} has no value`);
  }
  if (depth !== 0) fail(label, 'missing "}"');
  return [nodes, pos];
}

function child(nodes: readonly KeyValue[], key: string): KeyValue[] | undefined {
  for (const node of nodes) if (typeof node.value !== 'string' && node.key.toLowerCase() === key) return node.value;
  return undefined;
}

export function parseGameInfoSearchPaths(text: string, label: string): GameInfoSearchPath[] {
  const [root] = parseBlock(tokenize(text, label), 0, 0, label);
  const searchPaths = child(child(child(root, 'gameinfo') ?? [], 'filesystem') ?? [], 'searchpaths');
  if (!searchPaths) fail(label, 'has no GameInfo/FileSystem/SearchPaths block');
  const entries: GameInfoSearchPath[] = [];
  for (const node of searchPaths) {
    if (typeof node.value !== 'string') fail(label, `search path ${JSON.stringify(node.key)} is a block, not a path`);
    entries.push(Object.freeze({
      ids: Object.freeze(node.key.toLowerCase().split('+').filter(Boolean)),
      value: node.value,
      ...(node.condition ? { condition: node.condition } : {}),
    }));
  }
  return entries;
}
