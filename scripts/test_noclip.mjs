/** Run with node scripts/test_noclip.mjs. Verify flight response across frame rates. */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const directory = await mkdtemp(join(tmpdir(), 'noclip-test-'));
try {
  const path = join(directory, 'flight.mjs');
  await build({ entryPoints: ['src/input/noclip.ts'], outfile: path, bundle: true, format: 'esm', platform: 'node' });
  const { flightAxis, NoclipFlight } = await import(path);
  const travel = fps => {
    let velocity = 0, position = 0;
    for (let i = 0; i < fps; i++) {
      const [next, distance] = flightAxis(velocity, 1, 4.572, 1 / fps);
      velocity = next; position += distance;
    }
    const peak = velocity;
    for (let i = 0; i < fps; i++) {
      const [next, distance] = flightAxis(velocity, 0, 4.572, 1 / fps);
      velocity = next; position += distance;
    }
    return { peak, velocity, position };
  };
  const baseline = travel(60);
  assert.equal(baseline.peak, 4.572);
  assert.equal(baseline.velocity, 0);
  for (const fps of [30, 120, 144]) assert.ok(Math.abs(travel(fps).position - baseline.position) < .002, `Distance varies at ${fps}Hz`);
  assert.ok(Math.abs(flightAxis(0, 1, 4.572, 1 / 60)[0] - .9144) < 1e-9);
  assert.ok(Math.abs(flightAxis(0, -1, 4.572, 1 / 60)[0] + .9144) < 1e-9);
  assert.deepEqual(flightAxis(2, 1, 4.572, 0), [2, 0]);
  assert.ok(flightAxis(22.86, 1, 4.572, 1 / 60)[0] <= 4.572, 'Releasing Shift must respect the normal speed cap');
  const released = flightAxis(4.572, 0, 4.572, 1 / 60);
  assert.ok(Math.abs(released[0] - 4.572 * .8) < 1e-9);
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false });
  const canvas = Object.assign(new EventTarget(), { style: {}, setAttribute() {}, hasPointerCapture: () => false });
  const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(1, 0, 1);
  const flight = new NoclipFlight(camera, target, canvas, () => {});
  const key = (code, down = true, repeat = false) => flight.key({ code, repeat, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }, down);
  const reset = () => { flight.setActive(false); camera.up.set(0, 0, 1); camera.position.set(0, 0, 1); target.set(1, 0, 1); camera.lookAt(target); camera.updateMatrixWorld(); flight.setActive(true); };
  const forward = new THREE.Vector3(1, 0, 0), right = new THREE.Vector3(0, -1, 0), up = new THREE.Vector3(0, 0, 1);
  for (const [code, axis, sign] of [['ArrowUp',forward,1],['ArrowDown',forward,-1],['ArrowRight',right,1],['ArrowLeft',right,-1],
      ['Numpad8',forward,1],['Numpad2',forward,-1],['Numpad6',right,1],['Numpad4',right,-1],['Numpad9',up,1],['Numpad3',up,-1],['Numpad7',up,1],['Numpad1',up,-1]]) {
    reset(); key(code); assert.ok(flight.update(1/60).dot(axis)*sign>0, `${code} moves along its camera axis`);
  }
  reset(); flight.key({code:'ArrowUp',repeat:false,shiftKey:true,ctrlKey:false,metaKey:false,altKey:false,preventDefault(){}},true);
  assert.ok(Math.abs(flight.update(1/60).length()-2.286)<1e-8,'Entering flight with Shift already held uses the fast cap');
  reset(); flight.key({code:'Space',repeat:false,shiftKey:true,ctrlKey:true,metaKey:false,altKey:false,preventDefault(){}},true);
  assert.ok(Math.abs(flight.update(1/60).z+2.286)<1e-8,'Ctrl+Space descends with modifiers held before flight started');
  reset(); key('Numpad8'); flight.update(1/60); key('Numpad5'); key('Numpad8',true,true);
  assert.equal(flight.update(1/60).lengthSq(),0,'A held repeating key cannot undo Stop');
  key('Numpad8',false); key('Numpad8'); assert.ok(flight.update(1/60).lengthSq()>0);
  for (const [a,b,axis,sign] of [['KeyW','KeyS',forward,1],['KeyA','KeyD',right,-1],['KeyQ','KeyE',up,-1]]) {
    reset(); key(a); key(b); assert.ok(flight.update(1/60).dot(axis)*sign>0,'Opposite-key priority matches noclip');
  }
  for (const hover of [false,true]) {
    reset(); flight.hover=hover; if(hover){camera.rotateZ(.5);camera.updateMatrixWorld();}
    const initial=camera.quaternion.clone(), oldRight=new THREE.Vector3(1,0,0).applyQuaternion(initial), oldForward=camera.getWorldDirection(new THREE.Vector3());
    if(hover){oldRight.z=oldForward.z=0;oldRight.normalize();oldForward.normalize();}
    key('KeyJ'); key('KeyI'); key('KeyU'); flight.update(1/60);
    const reference=new THREE.Matrix4().makeRotationAxis(up,.02)
      .multiply(new THREE.Matrix4().makeRotationAxis(oldRight,.02))
      .multiply(new THREE.Matrix4().makeRotationAxis(oldForward,.02))
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(initial));
    assert.ok(camera.quaternion.angleTo(new THREE.Quaternion().setFromRotationMatrix(reference))<1e-7,`Combined rotation matches reference matrix order (level flight: ${hover})`);
  }
  console.log('Arrows, numpad axes, stop/repeat, reference rotation order and 30–144Hz flight response passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
