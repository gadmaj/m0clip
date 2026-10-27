/** Dependency metadata from MJCF, shared by the browser and Node packager.
 * This tokenizer does not replace MuJoCo's schema/compiler validation. */
const entities = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
const whitespace = /\s/;
function attributeValue(raw, label, signal) {
  signal?.throwIfAborted();
  if (raw.includes('<')) throw Error(`Invalid XML attribute in ${label}`);
  // XML normalizes literal attribute whitespace before expanding character refs.
  const source = raw.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' ');
  let value = '', position = 0;
  while (position < source.length) {
    signal?.throwIfAborted();
    const ampersand = source.indexOf('&', position);
    if (ampersand < 0) return value + source.slice(position);
    value += source.slice(position, ampersand);
    const end = source.indexOf(';', ampersand + 1);
    if (end < 0) throw Error(`Unterminated XML entity in ${label}`);
    const entity = source.slice(ampersand + 1, end);
    if (Object.hasOwn(entities, entity)) value += entities[entity];
    else {
      if (!/^#(?:x[\da-fA-F]+|\d+)$/.test(entity)) throw Error(`Unsupported XML entity &${entity}; in ${label}`);
      const hex = entity.startsWith('#x'), code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) throw Error(`Invalid XML character reference in ${label}`);
      value += String.fromCodePoint(code);
    }
    position = end + 1;
  }
  return value;
}
/** Scan actual opening elements; quotes protect > and attribute-looking text.
 * Only compiler/file metadata is retained. Ignored inline vertices/elevations
 * are scanned in place, never copied or charged as retained attribute records.
 * Callers reserve encoded/text reads before decoding; this tokenizer separately
 * accounts its borrowed text/workspace and actual retained metadata. */
export function parseMapXml(text, label, options = {}) {
  const maxAllocation = options.maxAllocationBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxAllocation) || maxAllocation < 0) throw new RangeError('Invalid XML metadata allocation limit');
  let allocation = 0;
  const charge = bytes => {
    options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxAllocation - allocation)
      throw new RangeError('XML metadata allocation limit exceeded');
    options.reserve?.(bytes);
    allocation += bytes;
  };
  // Text may already be borrowed from an import-owned response. Account for its
  // retention and bounded scalar/token workspace before any parser allocation.
  charge(text.length * 2 + 1024);
  const elements = [];
  const scanName = start => {
    const first = text.charCodeAt(start);
    if (!(first >= 65 && first <= 90 || first >= 97 && first <= 122 || first === 95)) return start;
    let end = start + 1;
    while (end < text.length) {
      if ((end & 1023) === 0) options.signal?.throwIfAborted();
      const code = text.charCodeAt(end);
      if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57
        || code === 95 || code === 46 || code === 58 || code === 45)) break;
      end++;
    }
    return end;
  };
  let position = 0;
  while ((position = text.indexOf('<', position)) >= 0) {
    options.signal?.throwIfAborted();
    let terminator;
    if (text.startsWith('<!--', position)) terminator = '-->';
    else if (text.startsWith('<![CDATA[', position)) terminator = ']]>';
    else if (text.startsWith('<?', position)) terminator = '?>';
    if (terminator) {
      const end = text.indexOf(terminator, position + 2);
      if (end < 0) throw Error(`Unterminated XML markup in ${label}`);
      position = end + terminator.length;
      continue;
    }
    if (text.startsWith('<!', position)) throw Error(`XML entity/declaration markup is unsupported: ${label}`);
    if (text.startsWith('</', position)) {
      const end = text.indexOf('>', position + 2);
      if (end < 0) throw Error(`Unterminated XML closing tag in ${label}`);
      position = end + 1;
      continue;
    }
    const nameStart = position + 1, nameEnd = scanName(nameStart), nameLength = nameEnd - nameStart;
    if (!nameLength) throw Error(`Invalid XML opening tag in ${label}`);
    const compiler = nameLength === 8 && text.startsWith('compiler', nameStart);
    position = nameEnd;
    let attributes, name;
    while (true) {
      options.signal?.throwIfAborted();
      const beforeSpace = position;
      while (position < text.length && whitespace.test(text[position])) {
        if ((position & 1023) === 0) options.signal?.throwIfAborted();
        position++;
      }
      if (text[position] === '>') { position++; break; }
      if (text[position] === '/' && text[position + 1] === '>') { position += 2; break; }
      if (position >= text.length) throw Error(`Unterminated XML opening tag in ${label}`);
      if (position === beforeSpace) throw Error(`Missing XML attribute separator in ${label}`);
      const start = position, endName = scanName(start), length = endName - start;
      if (!length) throw Error(`Invalid XML attribute in ${label}`);
      // Use static keys: do not allocate even a transient copy of a giant
      // ignored attribute/tag name before the retained-name reservation.
      let attribute;
      if (length === 4 && text.startsWith('file', start)) attribute = 'file';
      else if (compiler) {
        if (length === 8 && text.startsWith('assetdir', start)) attribute = 'assetdir';
        else if (length === 7 && text.startsWith('meshdir', start)) attribute = 'meshdir';
        else if (length === 10 && text.startsWith('texturedir', start)) attribute = 'texturedir';
        else if (length === 9 && text.startsWith('strippath', start)) attribute = 'strippath';
      }
      position = endName;
      while (position < text.length && whitespace.test(text[position])) {
        if ((position & 1023) === 0) options.signal?.throwIfAborted();
        position++;
      }
      if (text[position++] !== '=') throw Error(`Missing XML attribute value in ${label}`);
      while (position < text.length && whitespace.test(text[position])) {
        if ((position & 1023) === 0) options.signal?.throwIfAborted();
        position++;
      }
      const quote = text[position++];
      if (quote !== '"' && quote !== "'") throw Error(`Unquoted XML attribute in ${label}`);
      const end = text.indexOf(quote, position);
      if (end < 0) throw Error(`Unterminated XML attribute in ${label}`);
      if (attribute !== undefined) {
        if (!attributes) {
          charge(512 + nameLength * 2); // element, slot, attributes record and name
          attributes = Object.create(null);
          name = text.slice(nameStart, nameEnd);
        }
        if (Object.hasOwn(attributes, attribute)) throw Error(`Duplicate XML attribute ${attribute} in ${label}`);
        // Only selected values incur copies/normalization/entity decoding.
        // Includes source/normalized/decoded strings and conservative fragment
        // ownership for entity-heavy values, plus the actual property slot.
        charge(128 + attribute.length * 2 + (end - position) * 32);
        attributes[attribute] = attributeValue(text.slice(position, end), label, options.signal);
      }
      position = end + 1;
    }
    if (compiler && !attributes) {
      charge(512 + nameLength * 2);
      attributes = Object.create(null);
      name = text.slice(nameStart, nameEnd);
    }
    if (attributes) elements.push({ name, attributes });
  }
  options.signal?.throwIfAborted();
  return elements;
}
/** Incremental selected dependency edges. Reserve expanded/context characters
 * BEFORE combining compiler directories with file names. Equal raw names in
 * the same compiler/base context are resolved once, not expanded repeatedly.
 * Root containment and final path normalization remain the caller's policy. */
export function* mapXmlReferences(elements, base, inherited, options = {}) {
  const maxCharacters = options.maxExpandedCharacters ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) throw new RangeError('Invalid XML dependency character limit');
  options.signal?.throwIfAborted();
  let characters = 0;
  const charge = amount => {
    options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > maxCharacters - characters)
      throw new RangeError('XML dependency character limit exceeded');
    options.reserve?.(amount);
    characters += amount;
  };
  const compiler = { ...inherited, ...elements.find(element => element.name === 'compiler')?.attributes };
  const direct = { base, prefix: '', seen: new Set() };
  const root = base === 'map.xml' ? direct : { base: 'map.xml', prefix: '', seen: new Set() };
  const directories = new Map();
  const directoryContext = directory => {
    if (!directory) return direct;
    let context = directories.get(directory);
    if (context) return context;
    charge(directory.length + 1 + 'map.xml'.length);
    // Prepare a directory once. Preserve the old single trailing-slash and
    // MAPDIR rules, including unsafe doubled slashes for caller rejection.
    let prefix = (directory.endsWith('/') ? directory.slice(0, -1) : directory) + '/';
    if (prefix.startsWith('MAPDIR/')) prefix = prefix.slice(7);
    context = { base: 'map.xml', prefix, seen: new Set() };
    directories.set(directory, context);
    return context;
  };
  let mesh, texture, asset;
  for (const element of elements) {
    options.signal?.throwIfAborted();
    let value = element.attributes.file;
    if (value === undefined) continue;
    let context = direct;
    if (value.startsWith('MAPDIR/')) { value = value.slice(7); context = root; }
    else if (element.name !== 'include') {
      if (compiler.strippath === 'true') value = value.slice(value.lastIndexOf('/') + 1);
      if (element.name === 'mesh' || element.name === 'skin') context = mesh ??= directoryContext(compiler.meshdir ?? compiler.assetdir);
      else if (element.name === 'texture') context = texture ??= directoryContext(compiler.texturedir ?? compiler.assetdir);
      else context = asset ??= directoryContext(compiler.assetdir);
    }
    if (context.seen.has(value)) continue;
    charge(context.prefix.length + value.length + context.base.length);
    context.seen.add(value);
    yield { value: context.prefix + value, base: context.base };
  }
}
