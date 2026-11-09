'use strict';
/**
 * OWNED Source map fixtures. Every byte is authored here: a minimal hand-built
 * VBSP (one floor face, one solid brush, one player spawn), solid-colour VTF/VMT
 * materials and standard ZIP/GMAD containers. Nothing is extracted from, or is
 * evidence of fidelity to, any Valve or third-party game.
 *
 * fixture(options) is the raw-BSP unit factory used by test_raw_source_bsp.mjs;
 * its API, defaults and bytes are unchanged. makeSourceFixture(options) is the
 * complete raw-intake conformance map (floor, collision, spawn, lightmap, leaf
 * ambient, visibility and material companions), synchronous so CPU and browser
 * consumers share exactly the same input bytes.
 */
const { deflateRawSync } = require('node:zlib');

const record = (size, fill) => { const b = Buffer.alloc(size); fill(b); return b; };

/** VBSP header plus lump bodies, laid out in lump insertion order. */
function vbsp(entries, version, variant) {
  const header = Buffer.alloc(1036), bodies = []; header.write('VBSP'); header.writeInt32LE(version, 4); header.writeInt32LE(17, 1032);
  let offset = 1036;
  for (const [index, item] of entries) {
    const p = 8 + index * 16;
    header.writeUInt32LE(offset, p + (variant === 'standard' ? 0 : 4));
    header.writeUInt32LE(item.bytes.length, p + (variant === 'standard' ? 4 : 8));
    header.writeUInt32LE(item.version, p + (variant === 'standard' ? 8 : 0)); header.writeUInt32LE(item.decoded, p + 12);
    bodies.push(item.bytes); offset += item.bytes.length;
  }
  return [header, ...bodies];
}

function fixture({ version = 20, variant = 'standard', displacement = false, primitive = false } = {}) {
  const entries = new Map();
  const put = (id, bytes, version = 0, decoded = 0) => entries.set(id, { bytes, version, decoded });
  put(0, Buffer.from('{"classname" "worldspawn"}\n{"classname" "info_player_start" "origin" "16 16 32" "angles" "0 90 0"}\0'));
  put(1, record(120, b => {
    for (let i = 0; i < 6; i++) { b.writeFloatLE(i % 2 ? -1 : 1, i * 20 + Math.floor(i / 2) * 4); b.writeFloatLE(i === 4 ? 0 : 64, i * 20 + 12); }
  }));
  put(2, record(32, b => { b.writeInt32LE(64, 16); b.writeInt32LE(64, 20); }));
  put(3, record(48, b => { [0, 0, 0, 0, 64, 0, 64, 64, 0, 64, 0, 0].forEach((v, i) => b.writeFloatLE(v, i * 4)); }));
  put(5, record(32, b => { b.writeInt32LE(-1, 4); b.writeInt32LE(-1, 8); }));
  put(6, record(72, b => { b.writeFloatLE(1, 0); b.writeFloatLE(1, 20); b.writeFloatLE(1 / 16, 32); b.writeFloatLE(1 / 16, 52); }));
  put(7, record(56, b => {
    b.writeUInt16LE(4, 0); b.writeInt16LE(4, 8); b.writeInt16LE(displacement ? 0 : -1, 12);
    b[17] = b[18] = b[19] = 255; b.writeInt32LE(4, 36); b.writeInt32LE(4, 40);
    if (primitive) b.writeUInt16LE(0x8001, 48);
  }), 1);
  put(8, Buffer.alloc(100, 77), 1);
  put(10, record(64, b => { b.writeUInt16LE(1, 26); b.writeUInt16LE(1, 32 + 24); b.writeUInt16LE(1, 32 + 26); }), 1);
  put(12, record(16, b => { for (let i = 0; i < 4; i++) { b.writeUInt16LE(i, i * 4); b.writeUInt16LE((i + 1) % 4, i * 4 + 2); } }));
  put(13, record(16, b => { for (let i = 0; i < 4; i++) b.writeInt32LE(i, i * 4); }));
  put(14, record(48, b => { for (let i = 0; i < 3; i++) { b.writeFloatLE(-64, i * 4); b.writeFloatLE(i === 2 ? 0 : 64, 12 + i * 4); } b.writeInt32LE(1, 44); }));
  put(17, Buffer.from([0, 0, 1, 0]));
  put(18, record(24, b => { for (let i = 0; i < 2; i++) { b.writeInt32LE(i * 6, i * 12); b.writeInt32LE(6, i * 12 + 4); b.writeInt32LE(1, i * 12 + 8); } }));
  put(19, record(96, b => { for (let i = 0; i < 12; i++) b.writeUInt16LE(i % 6, i * 8); }));
  put(30, record(12, b => b.writeFloatLE(1, 8)));
  put(31, Buffer.alloc(8));
  put(43, Buffer.from('concrete/test\0')); put(44, Buffer.alloc(4));
  if (displacement) {
    // CONTENTS_SOLID; minTess carries no SURF_* collision flags.
    put(26, record(176, b => { b.writeInt32LE(2, 20); b.writeInt32LE(1, 32); }));
    put(33, record(500, b => { for (let i = 0; i < 25; i++) { b.writeFloatLE(1, i * 20 + 8); b.writeFloatLE(i % 5 + Math.floor(i / 5), i * 20 + 12); b.writeFloatLE(i * 10, i * 20 + 16); } }));
    put(48, Buffer.alloc(64, 1));
  }
  if (primitive) {
    put(37, record(version === 22 ? 16 : 10, b => { if (version === 22) b.writeUInt32LE(6, 8); else b.writeUInt16LE(6, 4); }));
    put(39, record(12, b => [0, 1, 3, 1, 2, 3].forEach((v, i) => b.writeUInt16LE(v, i * 2))));
  }
  function blob() { return new Blob(vbsp(entries, version, variant)); }
  return { entries, put, blob };
}

const MATERIAL = 'm0clip_fixture/floor';
const MATERIAL_PATH = `materials/${MATERIAL}.vmt`, TEXTURE_PATH = `materials/${MATERIAL}.vtf`;
const COLORS = Object.freeze({ red: Object.freeze([255, 0, 0, 255]), green: Object.freeze([0, 255, 0, 255]) });
const MIME_TYPES = Object.freeze({ bsp: 'application/octet-stream', gma: 'application/octet-stream', zip: 'application/zip' });
const DOS_DATE_1980_01_01 = 0x21;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** VTF 7.2, 4x4 IMAGE_FORMAT_RGBA8888, complete mip chain, no thumbnail. */
function solidVtf(rgba) {
  const header = Buffer.alloc(80);
  header.write('VTF\0'); header.writeUInt32LE(7, 4); header.writeUInt32LE(2, 8); header.writeUInt32LE(80, 12);
  header.writeUInt16LE(4, 16); header.writeUInt16LE(4, 18); // width, height; texture flags stay 0
  header.writeUInt16LE(1, 24); // one frame; firstFrame 0
  for (let c = 0; c < 3; c++) header.writeFloatLE(rgba[c] / 255, 32 + c * 4); // reflectivity
  header.writeFloatLE(1, 48); header.writeInt32LE(0, 52); // bump scale; RGBA8888
  header[56] = 3; header.writeInt32LE(-1, 57); // mip count; no low-resolution image
  header.writeUInt16LE(1, 63); // depth
  const texels = 1 + 4 + 16, pixels = Buffer.alloc(texels * 4); // smallest mip first
  for (let i = 0; i < texels; i++) pixels.set(rgba, i * 4);
  return Buffer.concat([header, pixels]);
}
const solidVmt = color => Buffer.from(`"LightmappedGeneric"\n{\n\t"$basetexture" "${MATERIAL}"\n\t"$surfaceprop" "concrete"\n\t"$keywords" "m0clip-fixture-${color}"\n}\n`);

/** PKZIP 2.0 archive: method 0 (stored) or 8 (raw Deflate), no ZIP64, extras or comments. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { path, data, method } of files) {
    if (method !== 0 && method !== 8) throw new Error(`Unsupported fixture ZIP method ${method}`);
    const name = Buffer.from(path, 'utf8'), body = method === 8 ? deflateRawSync(data, { level: 9 }) : data, crc = crc32(data);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(DOS_DATE_1980_01_01, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Uncompressed GMAD version 3 with a trailing CRC32 of the preceding bytes. */
function gma(files, title) {
  const z = text => Buffer.from(`${text}\0`, 'utf8');
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
  const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  const header = Buffer.alloc(21); header.write('GMAD'); header[4] = 3; // SteamID64 and timestamp stay zero
  const description = JSON.stringify({ description: 'Owned m0clip conformance fixture; not game content.', type: 'map', tags: ['build'] });
  const parts = [header, z(''), z(title), z(description), z('m0clip fixture'), u32(1)];
  files.forEach(({ path, data }, index) => parts.push(u32(index + 1), z(path), u64(data.length), u32(crc32(data))));
  parts.push(u32(0), ...files.map(({ data }) => data));
  const content = Buffer.concat(parts);
  return Buffer.concat([content, u32(crc32(content))]);
}

/** The same VMT/VTF paths in every source; only the authored colour differs. */
function materialZip(color, textureMethod) {
  return zip([
    { path: MATERIAL_PATH, data: solidVmt(color), method: 0 },
    { path: TEXTURE_PATH, data: solidVtf(COLORS[color]), method: textureMethod },
  ]);
}

function makeSourceFixture({ format = 'bsp', pakColor = 'red', companionColors = [], ambient = true, mapName = 'm0clip_conformance' } = {}) {
  if (!Object.hasOwn(MIME_TYPES, format)) throw new Error(`Unknown Source fixture format ${format}`);
  if (typeof mapName !== 'string' || !/^[a-z\d_-]{1,128}$/.test(mapName)) throw new Error('Source fixture mapName must be a lowercase Source map stem');
  if (pakColor !== null && !Object.hasOwn(COLORS, pakColor)) throw new Error(`Unknown Source fixture pak colour ${pakColor}`);
  if (!Array.isArray(companionColors) || companionColors.some(color => !Object.hasOwn(COLORS, color))
    || new Set(companionColors).size !== companionColors.length) throw new Error('Source fixture companion colours must be distinct red/green values');
  const f = fixture();
  // One cluster that sees itself: PVS row at byte 12 and PAS row at byte 13.
  f.put(4, Buffer.from([1, 0, 0, 0, 12, 0, 0, 0, 13, 0, 0, 0, 1, 1]));
  // The face's 5x5 single-style lightmap, ColorRGBExp32 (128,128,128,2^0).
  f.put(8, record(100, b => { for (let i = 0; i < 25; i++) b.set([128, 128, 128, 0], i * 4); }), 1);
  // Leaf 0: the reachable empty leaf above the floor, cluster 0, owning face 0.
  // Leaf 1: the unreachable solid leaf below it, cluster -1.
  const leaves = f.entries.get(10).bytes;
  [-64, -64, 0, 64, 64, 64].forEach((v, i) => leaves.writeInt16LE(v, 8 + i * 2));
  leaves.writeUInt16LE(0, 20); leaves.writeUInt16LE(1, 22);
  leaves.writeInt32LE(1, 32); leaves.writeInt16LE(-1, 32 + 4);
  [-64, -64, -64, 64, 64, 0].forEach((v, i) => leaves.writeInt16LE(v, 32 + 8 + i * 2));
  f.put(16, Buffer.from([0, 0]));
  f.put(43, Buffer.from(`${MATERIAL}\0`));
  if (ambient) {
    // Indexed leaf ambient (dleafambientindex_t / dleafambientlighting_t v1):
    // leaf 0 owns one probe at its (153,153,128)/255 fraction; side s is
    // ColorRGBExp32 ((s+1)*16, 32, 64, -4), i.e. linear (s+1, 2, 4).
    f.put(52, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
    f.put(56, record(28, b => {
      for (let side = 0; side < 6; side++) b.set([(side + 1) * 16, 32, 64, 0xfc], side * 4);
      b.set([153, 153, 128, 0], 24);
    }), 1);
  }
  if (pakColor !== null) f.put(40, materialZip(pakColor, 0));
  const bsp = Buffer.concat(vbsp(f.entries, 20, 'standard'));
  const entry = `maps/${mapName}.bsp`;
  const buffer = format === 'bsp' ? bsp
    : format === 'gma' ? gma([{ path: entry, data: bsp }], `${mapName} (owned m0clip fixture)`)
      : zip([{ path: entry, data: bsp, method: 8 }]);
  const effectiveColor = pakColor ?? companionColors[0] ?? null;
  return {
    selected: { name: `${mapName}.${format}`, mimeType: MIME_TYPES[format], buffer },
    companions: companionColors.map(color => ({ name: `m0clip-companion-${color}.zip`, mimeType: 'application/zip', buffer: materialZip(color, 8) })),
    expected: {
      mapName, name: mapName, game: format === 'gma' ? 'Garry\u2019s Mod' : 'Source',
      mapPath: format === 'bsp' ? `${mapName}.bsp` : entry, material: MATERIAL_PATH, texture: TEXTURE_PATH,
      triangles: 2, collision: 1, origin: [16, 16, 0], yaw: 90,
      effectiveColor, rgba: effectiveColor === null ? null : [...COLORS[effectiveColor]],
    },
  };
}

module.exports = { fixture, record, makeSourceFixture };
