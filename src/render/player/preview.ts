/** Gallery thumbnail of a Source Studio player body from the person's own game files, rendered on
 * a throwaway WebGL context: the model's own idle activity (first frame), its own materials, a
 * neutral key/fill light rig. Rejects with the material library's error when a material or texture
 * is missing; everything created here is released before returning. */
import * as THREE from 'three';
import type { LocalGameContent } from '../../player/assets/local-content';
import { SourceMaterialLibrary } from '../../player/materials/library';
import { createStudioPose, StudioPoseSampler, type StudioModelData } from '../../player/studio';
import { restControllers, restPoseParameters, SeededRandom, selectWeightedSequence } from './studio-anim';
import { isPlayerBodyModel } from './studio-body';
import { StudioObject } from './studio-object';

export async function renderStudioBodyPreview(content: LocalGameContent, model: StudioModelData, size: { width: number; height: number },
                                              signal?: AbortSignal): Promise<Blob> {
  if (!isPlayerBodyModel(model)) throw new Error(`${model.path} has no HL2MP/GMod player idle, walk and run activities.`);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  const library = new SourceMaterialLibrary({ content, renderer, unrecognizedParameters: 'record' });
  let object: StudioObject | null = null;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(size.width, size.height, false);
    object = await StudioObject.create(model, library, { signal });
    const sequence = selectWeightedSequence(model, ['ACT_HL2MP_IDLE', 'ACT_MP_STAND_IDLE'], new SeededRandom(1));
    const pose = createStudioPose(model);
    new StudioPoseSampler(model).sample({ sequence, cycle: 0, poseParameters: restPoseParameters(model), time: 0,
      controllers: restControllers(model) }, pose);
    object.setPose(pose);
    const scene = new THREE.Scene();
    scene.add(object.root);
    scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x1a2028, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(80, -60, 120);
    scene.add(key);
    object.root.updateMatrixWorld(true);
    object.skeleton.update();
    const box = new THREE.Box3().setFromObject(object.root, true), center = box.getCenter(new THREE.Vector3());
    const height = Math.max(1, box.max.z - box.min.z), aspect = size.width / size.height;
    const camera = new THREE.PerspectiveCamera(30, aspect, 1, 10000);
    camera.up.set(0, 0, 1);
    // Model space faces +X; view from the front-left like a character select screen.
    const distance = (height / 2) / Math.tan(15 * Math.PI / 180) * 1.15 * Math.max(1, 1 / aspect);
    camera.position.set(center.x + distance * Math.cos(0.45), center.y + distance * Math.sin(0.45), center.z);
    camera.lookAt(center);
    signal?.throwIfAborted();
    renderer.render(scene, camera);
    const encoded = Promise.withResolvers<Blob | null>();
    renderer.domElement.toBlob(encoded.resolve, 'image/png');
    const blob = await encoded.promise;
    if (!blob) throw new Error(`The preview of ${model.path} could not be encoded.`);
    return blob;
  } finally {
    object?.dispose();
    library.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
