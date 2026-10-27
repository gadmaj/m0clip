/** Dependency metadata from MJCF, shared by the browser and Node packager.
 * This tokenizer does not replace MuJoCo's schema/compiler validation. */
const entities = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
const compilerAttributes = { assetdir: true, meshdir: true, texturedir: true, strippath: true };
const namePattern = /[A-Za-z_][\w.:-]*/y;
function attributeValue(raw, label) {
  if (raw.includes('<')) throw Error(`Invalid XML attribute in ${label}`);
  // XML normalizes literal attribute whitespace before expanding character refs.
  const source = raw.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' ');
  let value = '', position = 0;
  while (position < source.length) {
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
 * Retain only dependency metadata, not large inline vertex arrays or other
 * attributes. Comments, CDATA and processing instructions cannot add edges. */
export function parseMapXml(text, label) {
  const elements = [];
  let position = 0;
  while ((position = text.indexOf('<', position)) >= 0) {
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
    namePattern.lastIndex = position + 1;
    const name = namePattern.exec(text)?.[0];
    if (!name) throw Error(`Invalid XML opening tag in ${label}`);
    position += name.length + 1;
    let attributes;
    while (true) {
      const beforeSpace = position;
      while (/\s/.test(text[position] ?? '') && position < text.length) position++;
      if (text[position] === '>') { position++; break; }
      if (text[position] === '/' && text[position + 1] === '>') { position += 2; break; }
      if (position >= text.length) throw Error(`Unterminated XML opening tag in ${label}`);
      if (position === beforeSpace) throw Error(`Missing XML attribute separator in ${label}`);
      namePattern.lastIndex = position;
      const attribute = namePattern.exec(text)?.[0];
      if (!attribute) throw Error(`Invalid XML attribute in ${label}`);
      position += attribute.length;
      while (/\s/.test(text[position] ?? '') && position < text.length) position++;
      if (text[position++] !== '=') throw Error(`Missing XML attribute value in ${label}`);
      while (/\s/.test(text[position] ?? '') && position < text.length) position++;
      const quote = text[position++];
      if (quote !== '"' && quote !== "'") throw Error(`Unquoted XML attribute in ${label}`);
      const end = text.indexOf(quote, position);
      if (end < 0) throw Error(`Unterminated XML attribute in ${label}`);
      if (attribute === 'file' || name === 'compiler' && Object.hasOwn(compilerAttributes, attribute)) {
        attributes ??= Object.create(null);
        if (Object.hasOwn(attributes, attribute)) throw Error(`Duplicate XML attribute ${attribute} in ${label}`);
        attributes[attribute] = attributeValue(text.slice(position, end), label);
      }
      position = end + 1;
    }
    if (name === 'compiler' || attributes) elements.push({ name, attributes: attributes ?? Object.create(null) });
  }
  return elements;
}
/** Keep path resolution/containment in the caller's selected-root policy. */
export function mapXmlReferences(elements, base, inherited) {
  const compiler = { ...inherited, ...elements.find(element => element.name === 'compiler')?.attributes };
  const result = [];
  for (const element of elements) {
    let value = element.attributes.file;
    if (value === undefined) continue;
    let parent = base;
    if (value.startsWith('MAPDIR/')) { value = value.slice(7); parent = 'map.xml'; }
    else if (element.name !== 'include') {
      if (compiler.strippath === 'true') value = value.split('/').at(-1);
      const directory = (element.name === 'mesh' || element.name === 'skin' ? compiler.meshdir : element.name === 'texture' ? compiler.texturedir : undefined) ?? compiler.assetdir;
      if (directory) {
        value = `${directory.replace(/\/$/, '')}/${value}`;
        if (value.startsWith('MAPDIR/')) value = value.slice(7);
        parent = 'map.xml';
      }
    }
    result.push({ value, base: parent });
  }
  return result;
}
