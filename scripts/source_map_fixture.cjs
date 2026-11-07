/** Owned renderer inputs use the real local bundle format, never substituted native HTTP bodies. */
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');

function glb(document) {
  const json = Buffer.from(JSON.stringify(document));
  const chunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(chunk);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(chunk.length + 20, 8);
  header.writeUInt32LE(chunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk]);
}

function bundle(document, { name, files = {}, manifest = {} }) {
  const bodies = {
    'map.xml': Buffer.from('<mujoco><worldbody><geom name="fixture_floor" type="plane" size="0 0 .1" rgba=".2 .2 .2 1"/></worldbody></mujoco>'),
    'visual.glb': glb(document),
    ...files,
  };
  bodies['manifest.json'] = Buffer.from(JSON.stringify({
    name, game: 'Renderer fixture', files: ['map.xml'], visual: 'visual.glb',
    native_textures: { visual: 'visual.glb' }, ...manifest,
  }));
  const index = {
    format: 'm0clip-map', version: 1, name, game: 'Renderer fixture', entry: 'manifest.json',
    resources: Object.entries(bodies).map(([path, bytes]) => ({
      path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  const zipped = zipSync({ ...bodies, 'm0clip-map.json': Buffer.from(JSON.stringify(index)) }, { level: 0 });
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}

module.exports = { bundle };
