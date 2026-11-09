/** Absolute Source-time playback. Each glTF keeps its own binding root, even when
 * world/props reuse node names. Seeking never leaves finite clips disabled. */
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { SourcePlayback } from '../maps/raw-source-gltf';

type Playback = Omit<SourcePlayback, 'version'>;
interface Entry extends Playback { action: THREE.AnimationAction; duration: number }
interface Group { root: THREE.Object3D; mixer: THREE.AnimationMixer; entries: Entry[] }
function playback(definition: unknown): Playback {
  const extras = definition && typeof definition === 'object' && !Array.isArray(definition)
    && 'extras' in definition ? definition.extras : undefined;
  const value = extras && typeof extras === 'object' && !Array.isArray(extras)
    && 'sourcePlayback' in extras ? extras.sourcePlayback : undefined;
  // Existing converted maps have ordinary looping glTF clips without this extension.
  if (value === undefined) return { loop: true, cycle: 0, rate: 1 };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || !('loop' in value) || typeof value.loop !== 'boolean'
    || !('cycle' in value) || typeof value.cycle !== 'number' || !Number.isFinite(value.cycle)
    || !('rate' in value) || typeof value.rate !== 'number' || !Number.isFinite(value.rate))
    throw new TypeError('Invalid Source animation playback metadata');
  return { loop: value.loop, cycle: value.cycle, rate: value.rate };
}

export class SourceAnimations {
  private readonly groups: Group[] = [];

  constructor(documents: readonly GLTF[]) {
    try {
      for (const document of documents) {
        if (!document.animations.length) continue;
        const group: Group = { root: document.scene, mixer: new THREE.AnimationMixer(document.scene), entries: [] };
        this.groups.push(group);
        for (let index = 0; index < document.animations.length; index++) {
          const clip = document.animations[index], duration = clip.duration;
          if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Invalid Source animation duration');
          const definition: unknown = document.parser.json.animations?.[index];
          const settings = playback(definition), action = group.mixer.clipAction(clip);
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          action.paused = true;
          action.play();
          group.entries.push({ action, duration, ...settings });
        }
      }
      this.update(0);
    } catch (error) { this.dispose(); throw error; }
  }

  update(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new RangeError('Invalid Source animation time');
    for (const group of this.groups) {
      for (const entry of group.entries) {
        const time = entry.cycle * entry.duration + seconds * entry.rate;
        if (!Number.isFinite(time)) throw new RangeError('Source animation time overflow');
        let local = 0;
        if (entry.duration > 0) {
          if (entry.loop) { local = time % entry.duration; if (local < 0) local += entry.duration; }
          else local = Math.max(0, Math.min(entry.duration, time));
        }
        entry.action.time = local;
      }
      // Paused actions still evaluate their explicit local time at zero delta.
      // Unlike setTime(), this neither resets that time nor strands a finished action.
      group.mixer.update(0);
    }
  }

  dispose(): void {
    for (const group of this.groups) {
      group.mixer.stopAllAction();
      group.mixer.uncacheRoot(group.root);
    }
    this.groups.length = 0;
  }
}
