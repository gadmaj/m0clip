/** Import-owned JSON limits. Plain data records/arrays only: no getters, custom
 * prototypes or toJSON hooks. Shared graphs are charged on EVERY occurrence.
 * The preflight deliberately does not deduplicate by object identity. */
export interface SourceJsonOptions {
  signal?: AbortSignal;
  /** Encoded output/input, default 256 MiB. Zero permits only an empty allowance. */
  maxBytes?: number;
  /** Serialized/parsed value occurrences, default 2,000,000. */
  maxNodes?: number;
  /** Object properties plus array slots, default 4,000,000. */
  maxMembers?: number;
  /** Root is depth 1; default 128, maximum 512 (also bounds native stringify). */
  maxDepth?: number;
}
export interface SourceJsonParseOptions extends SourceJsonOptions {
  /** Conservative simultaneous response/text/parsed ownership, default 256 MiB.
   * This is accounting, not an engine-specific measured heap-size guarantee. */
  maxAllocationBytes?: number;
}
export interface SourceJsonSize { byteLength: number; nodes: number; members: number }
export interface SourceJsonOwnership extends SourceJsonSize { ownershipBytes: number }
export interface SourceJsonParsed extends SourceJsonOwnership { value: unknown }
function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid Source JSON ${name} limit`);
  return value;
}
function limits(options: SourceJsonOptions) {
  const maxDepth = limit(options.maxDepth ?? 128, 'depth');
  if (maxDepth > 512) throw new RangeError('Source JSON depth limit exceeds 512');
  return { maxBytes: limit(options.maxBytes ?? 256 * 1024 * 1024, 'byte'),
    maxNodes: limit(options.maxNodes ?? 2_000_000, 'node'),
    maxMembers: limit(options.maxMembers ?? 4_000_000, 'member'), maxDepth };
}
/** Exact well-formed JSON.stringify UTF-8 size for supported internal data.
 * Undefined object properties are omitted and undefined/holes in arrays are null.
 * Nonfinite numbers are null; lone surrogates use six-byte Unicode escapes. */
export function preflightSourceJson(value: unknown, options: SourceJsonOptions = {}): SourceJsonSize {
  const cap = limits(options), active = new Set<object>();
  let byteLength = 0, nodes = 0, members = 0;
  const charge = (amount: number) => {
    options.signal?.throwIfAborted();
    if (amount > cap.maxBytes - byteLength) throw new RangeError('Source JSON byte limit exceeded');
    byteLength += amount;
  };
  const member = () => {
    options.signal?.throwIfAborted();
    if (++members > cap.maxMembers) throw new RangeError('Source JSON member limit exceeded');
  };
  const string = (text: string) => {
    charge(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) charge(2);
      else if (c < 32) charge(6);
      else if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { charge(4); i++; }
        else charge(6);
      } else if (c >= 0xdc00 && c <= 0xdfff) charge(6);
      else charge(c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  };
  // Inspect descriptors rather than invoking a getter during one of two passes.
  const data = (object: object, key: string): unknown => {
    let owner: object | null = object;
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!('value' in descriptor)) throw new TypeError('Source JSON accessors are unsupported');
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  };
  const visit = (input: unknown, depth: number): void => {
    options.signal?.throwIfAborted();
    if (depth > cap.maxDepth) throw new RangeError('Source JSON depth limit exceeded');
    if (++nodes > cap.maxNodes) throw new RangeError('Source JSON node limit exceeded');
    if (input === null || input === undefined) { charge(4); return; }
    switch (typeof input) {
      case 'string': string(input); return;
      case 'number': charge(Number.isFinite(input) ? String(input).length : 4); return;
      case 'boolean': charge(input ? 4 : 5); return;
      case 'object': break;
      default: throw new TypeError('Unsupported Source JSON value');
    }
    const object = input as object, array = Array.isArray(object), prototype = Object.getPrototypeOf(object);
    if ((!array && prototype !== null && prototype !== Object.prototype) || (array && prototype !== Array.prototype))
      throw new TypeError('Unsupported Source JSON object prototype');
    if (typeof data(object, 'toJSON') === 'function') throw new TypeError('Source JSON toJSON hooks are unsupported');
    if (active.has(object)) throw new TypeError('Cyclic Source JSON graph');
    active.add(object);
    charge(2);
    if (array) {
      const list = object as unknown[];
      for (let i = 0; i < list.length; i++) {
        member(); if (i) charge(1);
        visit(data(list, String(i)), depth + 1);
      }
    } else {
      let emitted = false;
      for (const key in object) {
        if (!Object.hasOwn(object, key)) continue;
        member();
        const child = data(object, key);
        if (child === undefined) continue;
        if (emitted) charge(1);
        string(key); charge(1); visit(child, depth + 1); emitted = true;
      }
    }
    active.delete(object);
  };
  if (value === undefined) throw new TypeError('Source JSON root is undefined');
  visit(value, 1);
  return { byteLength, nodes, members };
}
/** No string or UTF-8 output allocation happens until the complete preflight fits. */
export function encodeSourceJson(value: unknown, options: SourceJsonOptions = {}): Uint8Array<ArrayBuffer> {
  const measured = preflightSourceJson(value, options);
  options.signal?.throwIfAborted();
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  // Internal graphs must not be mutated between the synchronous passes.
  if (encoded.byteLength !== measured.byteLength) throw new Error('Source JSON graph changed during serialization');
  options.signal?.throwIfAborted();
  return encoded;
}

/** Validate grammar/UTF-8 and bound structure BEFORE decoding or JSON.parse.
 * Includes ignored and duplicate-key subtrees. Allocation charges deliberately
 * assume UTF-16 text/strings, non-interned keys and generous per-node/member
 * overhead: input + 2*input text, 128/object, 96/array, 16/scalar, 32/string
 * plus 2/decoded code unit, and 64/property or array slot. Callers must also
 * charge their own normalized objects, decoded buffers and page ownership. */
export function preflightSourceJsonBytes(bytes: Uint8Array, options: SourceJsonParseOptions = {}): SourceJsonOwnership {
  const cap = limits(options), maxAllocation = limit(options.maxAllocationBytes ?? 256 * 1024 * 1024, 'allocation');
  if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)
    throw new TypeError('Shared Source JSON input cannot be preflighted atomically');
  let at = 0, nodes = 0, members = 0, ownershipBytes = 0;
  const charge = (amount: number) => {
    options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(amount) || amount > maxAllocation - ownershipBytes)
      throw new RangeError('Source JSON parsed allocation limit exceeded');
    ownershipBytes += amount;
  };
  const syntax = (): never => { throw new SyntaxError(`Invalid Source JSON at byte ${at}`); };
  if (bytes.byteLength > cap.maxBytes) throw new RangeError('Source JSON byte limit exceeded');
  charge(bytes.byteLength * 3);
  // TextDecoder's default strips exactly one leading UTF-8 BOM.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
  const space = () => {
    while (at < bytes.length && (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 10 || bytes[at] === 13)) {
      if ((at & 1023) === 0) options.signal?.throwIfAborted();
      at++;
    }
  };
  const hex = (c: number) => c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102;
  const digit = (c: number) => c >= 48 && c <= 57;
  const string = () => {
    if (bytes[at++] !== 34) syntax();
    charge(32);
    while (at < bytes.length) {
      const c = bytes[at++];
      if (c === 34) return;
      if (c < 32) syntax();
      if (c === 92) {
        const escaped = bytes[at++];
        if (escaped === 117) {
          for (let j = 0; j < 4; j++) if (!hex(bytes[at++])) syntax();
        } else if (escaped !== 34 && escaped !== 92 && escaped !== 47 && escaped !== 98 && escaped !== 102 && escaped !== 110 && escaped !== 114 && escaped !== 116) syntax();
        charge(2);
      } else if (c < 128) charge(2);
      else {
        // Strict shortest-form UTF-8, rejecting encoded surrogates and >U+10FFFF.
        const count = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : syntax();
        const second = bytes[at];
        if ((c === 0xe0 && second < 0xa0) || (c === 0xed && second >= 0xa0)
          || (c === 0xf0 && second < 0x90) || (c === 0xf4 && second >= 0x90)) syntax();
        for (let j = 0; j < count; j++) { const next = bytes[at++]; if (!(next >= 0x80 && next <= 0xbf)) syntax(); }
        charge(count === 3 ? 4 : 2);
      }
    }
    syntax();
  };
  const member = () => {
    if (++members > cap.maxMembers) throw new RangeError('Source JSON member limit exceeded');
    charge(64);
  };
  const value = (depth: number): void => {
    options.signal?.throwIfAborted();
    if (depth > cap.maxDepth) throw new RangeError('Source JSON depth limit exceeded');
    if (++nodes > cap.maxNodes) throw new RangeError('Source JSON node limit exceeded');
    const c = bytes[at];
    if (c === 34) { string(); return; }
    if (c === 123 || c === 91) {
      const object = c === 123, end = object ? 125 : 93;
      charge(object ? 128 : 96); at++; space();
      if (bytes[at] === end) { at++; return; }
      for (;;) {
        member();
        if (object) { string(); space(); if (bytes[at++] !== 58) syntax(); space(); }
        value(depth + 1); space();
        if (bytes[at] === end) { at++; return; }
        if (bytes[at++] !== 44) syntax();
        space();
      }
    }
    charge(16);
    if (c === 116 || c === 102 || c === 110) {
      const literal = c === 116 ? 'true' : c === 102 ? 'false' : 'null';
      for (let i = 0; i < literal.length; i++) if (bytes[at++] !== literal.charCodeAt(i)) syntax();
      return;
    }
    if (c === 45) at++;
    if (bytes[at] === 48) at++;
    else {
      if (!(bytes[at] >= 49 && bytes[at] <= 57)) syntax();
      do { at++; if ((at & 1023) === 0) options.signal?.throwIfAborted(); } while (digit(bytes[at]));
    }
    if (bytes[at] === 46) {
      at++; if (!digit(bytes[at])) syntax();
      do { at++; if ((at & 1023) === 0) options.signal?.throwIfAborted(); } while (digit(bytes[at]));
    }
    if (bytes[at] === 101 || bytes[at] === 69) {
      at++; if (bytes[at] === 43 || bytes[at] === 45) at++;
      if (!digit(bytes[at])) syntax();
      do { at++; if ((at & 1023) === 0) options.signal?.throwIfAborted(); } while (digit(bytes[at]));
    }
  };
  space(); value(1); space(); if (at !== bytes.length) syntax();
  return { byteLength: bytes.byteLength, nodes, members, ownershipBytes };
}
export function parseSourceJson(bytes: Uint8Array, options: SourceJsonParseOptions = {}): SourceJsonParsed {
  const measured = preflightSourceJsonBytes(bytes, options);
  options.signal?.throwIfAborted();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  options.signal?.throwIfAborted();
  return { ...measured, value };
}
