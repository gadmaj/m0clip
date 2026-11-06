/** The physics gun keeps a robot across scene rebuilds of OTHER robots: the real PlayerWorld
 * spawns two R1 robots with the hosted default policies (ONNX Runtime in Node), grabs one, and the
 * rebuild that undoes the other must leave the same body held and following the aim. Removing the
 * held robot releases it. No browser. */
import assert from 'node:assert/strict';
import buildFixture from './build-fixture.cjs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolveObjectURL } from 'node:buffer';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixture = resolve(root, `.player-physgun-test-${process.pid}.mjs`);
const { code } = await buildFixture({ root, platform: 'node', format: 'es', externalPackages: true, source:
  "export {PlayerWorld} from './src/worker/player-world';export {PLAYER_BUTTON} from './src/player/types';" +
  "export {packEntries,parsePack,resolvePackConfig} from './src/packs/index';" });
await writeFile(fixture, code
  .replaceAll('"/wasm/mujoco.js"', JSON.stringify(pathToFileURL(resolve(root, 'node_modules/mujoco/mujoco.js')).href))
  .replaceAll('"/wasm/mujoco.wasm"', JSON.stringify(resolve(root, 'node_modules/mujoco/mujoco.wasm'))));
globalThis.fetch = async url => {
  const text = String(url);
  // Policy configs point at blob: URLs of the pack's own ONNX files.
  if (text.startsWith('blob:')) return new Response(resolveObjectURL(text));
  const path = new URL(text, 'http://local').pathname;
  try {
    return new Response(await readFile(resolve(root, 'public' + path)),
      { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
  } catch { return new Response('', { status: 404 }); }
};

try {
  const { PlayerWorld, PLAYER_BUTTON, packEntries, parsePack, resolvePackConfig } = await import(pathToFileURL(fixture));
  const catalog = JSON.parse(await readFile(resolve(root, 'public/assets/packs/r1-default-v1.json'), 'utf8'));
  const entries = catalog.flatMap(packEntries), configs = new Map();
  const config = async entry => {
    if (!configs.has(entry.name)) {
      const metadata = catalog.find(pack => pack.id === entry.packId);
      const pack = parsePack(new Uint8Array(await readFile(resolve(root, 'public' + metadata.downloadUrl))));
      configs.set(entry.name, resolvePackConfig(pack, entry));
    }
    return configs.get(entry.name);
  };

  const s = { frame: null, model: null, errors: [], now: 0, sequence: 0 };
  const world = new PlayerWorld({ post(m) {
    if (m.t === 'frame') {
      const g = m.player.grab;
      s.frame = { origin: [...m.player.origin], grab: g && { entity: g.entity, body: g.body, point: [...g.point], target: [...g.target] } };
    } else if (m.t === 'model') s.model = m.desc;
    else if (m.t === 'error') s.errors.push(m.msg);
  }, entries: () => entries, config });
  assert.equal(await world.load(await world.prepare('flat', null), { tools: ['physgun', 'spawn'] }, () => true), true);
  const ticks = async n => { for (let i = 0; i < n; i++) { s.now += 15; await world.wake(s.now, false); } };
  await world.wake(s.now, false);
  const look = { yaw: 0, pitch: 0 };
  const send = (held, pressed) => world.input({ sequence: ++s.sequence, yaw: look.yaw, pitch: look.pitch, forward: 0, side: 0,
    held, pressed, reset: false, thirdPerson: false });
  const attack = PLAYER_BUTTON.attack;
  const click = async () => { send(attack, attack); await ticks(1); send(0, 0); await ticks(1); };
  const bodyName = id => s.model.bodyNames[id];
  const robots = () => (s.model.entities ?? []).map(e => e.id);
  // Bearing of an app-space point from the player (Source inches; the flat world's frame is identity).
  const bearing = (p, o) => Math.atan2(p[1] - o[1] * 0.0254, p[0] - o[0] * 0.0254) * 180 / Math.PI;
  /** Sweep the aim with the button down until the physics gun takes hold. */
  async function grab(yaws) {
    world.selectTool('physgun');
    for (const yaw of yaws)
      for (let pitch = 10; pitch <= 40 && !s.frame.grab; pitch += 2) {
        look.yaw = yaw; look.pitch = pitch; send(0, 0); await ticks(1);
        send(attack, attack); await ticks(2);
        if (s.frame.grab) return;
      }
  }

  // Two robots, one ahead (+X) and one to the left (+Y).
  world.selectTool('spawn');
  await click(); assert.deepEqual(robots(), ['robot1'], s.errors.join('; '));
  look.yaw = 90; await click(); assert.deepEqual(robots(), ['robot1', 'robot2'], s.errors.join('; '));
  await ticks(40);

  await grab([0]);
  assert.equal(s.frame.grab?.entity, 'robot1', 'the physics gun holds the robot ahead');
  await ticks(30);
  const held = bodyName(s.frame.grab.body);
  assert.ok(held.startsWith('robot1/'), held);

  // Undo spawns: robot2 leaves while the button stays down.
  await world.undo();
  assert.deepEqual(robots(), ['robot1']);
  await ticks(2);
  assert.equal(s.frame.grab?.entity, 'robot1', 'robot1 is still held after robot2 was undone');
  assert.equal(bodyName(s.frame.grab.body), held, 'the same body is held in the rebuilt scene');

  // Still under control: swing the aim 30° and the held point follows it.
  const before = bearing(s.frame.grab.point, s.frame.origin);
  look.yaw = 30; send(attack, 0);
  await ticks(90);
  const g = s.frame.grab, after = bearing(g.point, s.frame.origin);
  assert.ok(Math.abs(after - before - 30) < 8, `held point turned ${after - before}° for a 30° aim change`);
  assert.ok(Math.hypot(g.point[0] - g.target[0], g.point[1] - g.target[1], g.point[2] - g.target[2]) < 0.3,
    'the held point reached the aim target');

  // Releasing the button drops it.
  send(0, 0); await ticks(2);
  assert.equal(s.frame.grab, null, 'released');
  // Pressed again along the same aim, the ray meets the robot where it was just held. Holding
  // robot1 while robot1 itself is undone releases it.
  send(attack, attack); await ticks(2);
  assert.equal(s.frame.grab?.entity, 'robot1', 'robot1 held again');
  await world.undo();
  assert.deepEqual(robots(), []);
  await ticks(3);
  assert.equal(s.frame.grab, null, 'removing the held robot releases it');
  assert.deepEqual(s.errors, []);
  console.log('ok physics gun hold survives rebuilds of other robots and ends with its own removal');
} finally {
  await rm(fixture, { force: true });
}
