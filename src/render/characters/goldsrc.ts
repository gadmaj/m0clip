/** GoldSrc IDST v10 decoder. Format facts: wootguy/modelguy studio.h and renderer;
 * independent TypeScript implementation, not copied SDK code. No network work except required dependencies. */
import * as THREE from 'three';
import { characterAsset } from './body';
import type { CharacterAsset, CharacterDefinition } from './types';

export interface GoldSrcSource {
  name: string;
  model: ArrayBuffer;
  loadDependency: (filename: string) => Promise<ArrayBuffer>;
  source: string;
  thumbnail: string;
  readme?: string;
}

class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  length: number;
  constructor(buffer: ArrayBuffer, readonly label: string) {
    this.view = new DataView(buffer); this.bytes = new Uint8Array(buffer); this.length = buffer.byteLength;
  }
  fail(message: string): never { throw new Error(`GoldSrc ${this.label}: ${message}`); }
  range(offset: number, size: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > this.length-size)
      this.fail(`out-of-bounds data at ${offset} (${size} bytes).`);
    return offset;
  }
  i(offset: number) { return this.view.getInt32(this.range(offset, 4), true); }
  u16(offset: number) { return this.view.getUint16(this.range(offset, 2), true); }
  i16(offset: number) { return this.view.getInt16(this.range(offset, 2), true); }
  u8(offset: number) { return this.view.getUint8(this.range(offset, 1)); }
  f(offset: number) {
    const value = this.view.getFloat32(this.range(offset, 4), true);
    if (!Number.isFinite(value)) this.fail(`nonfinite float at ${offset}.`);
    return value;
  }
  text(offset: number, size: number) {
    this.range(offset, size);
    let end = offset; while (end < offset+size && this.bytes[end]) end++;
    return new TextDecoder('windows-1252').decode(this.bytes.subarray(offset, end));
  }
  table(offset: number, count: number, stride: number) {
    if (!Number.isSafeInteger(count) || count < 0) this.fail(`invalid table count ${count}.`);
    this.range(offset, count*stride); return count;
  }
  header(magic = 'IDST') {
    this.range(0, magic === 'IDST' ? 244 : 76);
    if (this.text(0, 4) !== magic || this.i(4) !== 10)
      this.fail(`unsupported model format; expected ${magic} version 10 (Source MDL is not supported).`);
    const length = this.i(72);
    if (length < (magic === 'IDST' ? 244 : 76) || length > this.length) this.fail('invalid declared file length.');
    this.length = length;
  }
  vector(offset: number) { return new THREE.Vector3(this.f(offset), this.f(offset+4), this.f(offset+8)); }
}
interface BoneData {
  name: string; parent: number; value: number[]; scale: number[]; controllers: number[];
}
interface TextureData { name: string; flags: number; width: number; height: number; material: THREE.MeshPhysicalMaterial }
function rotation(values: ArrayLike<number>, target = new THREE.Quaternion()) {
  // GoldSrc's intrinsic roll/pitch/yaw is Rz * Ry * Rx (Three Euler order ZYX).
  const sx = Math.sin(values[3]/2), cx = Math.cos(values[3]/2);
  const sy = Math.sin(values[4]/2), cy = Math.cos(values[4]/2);
  const sz = Math.sin(values[5]/2), cz = Math.cos(values[5]/2);
  return target.set(sx*cy*cz-cx*sy*sz, cx*sy*cz+sx*cy*sz, cx*cy*sz-sx*sy*cz, cx*cy*cz+sx*sy*sz);
}
function checkedIndex(r: Reader, index: number, count: number, label: string) {
  if (!Number.isInteger(index) || index < 0 || index >= count) r.fail(`invalid ${label} index ${index}/${count}.`);
  return index;
}
function dependencyName(r: Reader, path: string, sourceName: string, group: number) {
  const name = path.replace(/\\/g, '/').split('/').pop() || `${sourceName}${String(group).padStart(2, '0')}.mdl`;
  if (/[\x00-\x1f/\\]/.test(name) || !name.toLowerCase().endsWith('.mdl')) r.fail('invalid sequence dependency filename.');
  return name;
}

/** Chrome uses the authored normal bone's origin and the camera-right basis, not static substitute UVs. */
function chromeMaterial(material: THREE.MeshPhysicalMaterial, width: number, height: number) {
  material.userData.goldsrcChrome = true;
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 chromeOrigin;')
      .replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>
#ifdef USE_MAP
#ifdef USE_SKINNING
  vec4 chromeSkinOrigin = skinMatrix * vec4(chromeOrigin, 1.0);
#else
  vec4 chromeSkinOrigin = vec4(chromeOrigin, 1.0);
#endif
  vec3 chromeViewOrigin = (modelViewMatrix * chromeSkinOrigin).xyz;
  vec3 chromeDirection = normalize(-chromeViewOrigin);
  vec3 chromeUp = cross(chromeDirection, vec3(1.0, 0.0, 0.0));
  chromeUp = length(chromeUp) > 0.00001 ? normalize(chromeUp) : vec3(0.0, 1.0, 0.0);
  vec3 chromeRight = normalize(cross(chromeDirection, chromeUp));
  vec3 chromeNormal = normalize(normalMatrix * objectNormal);
  vMapUv = (vec2(dot(chromeNormal, chromeRight), dot(chromeNormal, chromeUp)) + 1.0) * vec2(${32/width}, ${32/height});
#ifdef USE_EMISSIVEMAP
  vEmissiveMapUv = vMapUv;
#endif
#endif`);
  };
  material.customProgramCacheKey = () => `goldsrc-chrome-v1-${width}-${height}`;
}
function textures(r: Reader, reserve: (bytes: number) => void): TextureData[] {
  const count = r.table(r.i(184), r.i(180), 80), result: TextureData[] = [];
  for (let i = 0; i < count; i++) {
    const offset = r.i(184)+i*80, name = r.text(offset, 64), flags = r.i(offset+64);
    const width = r.i(offset+68), height = r.i(offset+72), data = r.i(offset+76);
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) r.fail(`invalid texture dimensions for ${name}.`);
    const pixels = width*height, palette = data+pixels; r.range(data, pixels+768);
    reserve(pixels*4);
    const rgba = new Uint8Array(pixels*4);
    for (let j = 0; j < pixels; j++) {
      const index = r.u8(data+j), p = palette+index*3;
      rgba[j*4] = r.u8(p); rgba[j*4+1] = r.u8(p+1); rgba[j*4+2] = r.u8(p+2);
      // MASKED uses palette index 255. ALPHA is a uniform render mode, not fabricated per-pixel opacity.
      rgba[j*4+3] = flags & 64 && index === 255 ? 0 : 255;
    }
    const map = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
    map.name = name; map.colorSpace = THREE.SRGBColorSpace; map.flipY = false;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.generateMipmaps = !(flags & 8); map.minFilter = flags & 8 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter; map.needsUpdate = true;
    const material = new THREE.MeshPhysicalMaterial({name, map, roughness: 1, metalness: 0,
      flatShading: !!(flags & 1), alphaTest: flags & 64 ? .5 : 0,
      transparent: !!(flags & (16|32)), blending: flags & 32 ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !(flags & (16|32))});
    material.userData = {goldsrcTextureFlags: flags, goldsrcAlpha: !!(flags & 16),
      goldsrcAlphaNote: 'Authored ALPHA flag retained; MDL stores no entity render amount, default opacity is 1.'};
    if (flags & 4) {
      material.color.setRGB(0, 0, 0); material.emissive.setRGB(1, 1, 1); material.emissiveMap = map;
      material.userData.goldsrcFullbright = true; material.userData.goldsrcFullbrightColor = [1, 1, 1];
    }
    if (flags & 2) chromeMaterial(material, width, height);
    result.push({name, flags, width, height, material});
  }
  return result;
}

/** Map actual authored bones, never an invented proxy skeleton. Reject incomplete humanoids. */
function rigDefinition(data: BoneData[], r: Reader): CharacterDefinition['rig'] {
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = new Map<string, string>();
  for (const bone of data) {
    const key = normalized(bone.name);
    if (names.has(key)) r.fail(`ambiguous rig bone ${bone.name}.`);
    names.set(key, bone.name);
  }
  const find = (aliases: string[], required = true) => {
    for (const alias of aliases) { const found = names.get(normalized(alias)); if (found) return found; }
    if (required) r.fail(`unsupported rig: missing ${aliases[0]} humanoid segment.`);
    return undefined;
  };
  const bindings: Record<string, readonly string[]> = {}, aim: Record<string, string> = {};
  const pelvis = find(['Bip01 Pelvis', 'ValveBiped.Bip01_Pelvis'])!; bindings[pelvis] = ['pelvis'];
  for (const aliases of [['Bip01 Spine','ValveBiped.Bip01_Spine'], ['Bip01 Spine1','ValveBiped.Bip01_Spine1'],
    ['Bip01 Spine2','ValveBiped.Bip01_Spine2'], ['Bip01 Spine3','ValveBiped.Bip01_Spine3']]) {
    const bone = find(aliases, false); if (bone) bindings[bone] = ['torso_link'];
  }
  if (!Object.values(bindings).some(values => values.includes('torso_link'))) r.fail('unsupported rig: no humanoid spine.');
  const neck = find(['Bip01 Neck', 'ValveBiped.Bip01_Neck1'], false);
  const head = find(['Bip01 Head', 'ValveBiped.Bip01_Head1'])!;
  if (neck) bindings[neck] = ['head_pitch_link', 'torso_link'];
  bindings[head] = ['head_yaw_link', 'head_pitch_link', 'torso_link'];
  const feet: string[] = [];
  for (const [side, prefix] of [['L','left'], ['R','right']] as const) {
    // Old Biped: Arm is clavicle, Arm1 humerus, Arm2 forearm. ValveBiped names are explicit.
    const upper = find([`Bip01 ${side} Arm1`, `ValveBiped.Bip01_${side}_UpperArm`, `Bip01 ${side} UpperArm`])!;
    const lower = find([`Bip01 ${side} Arm2`, `ValveBiped.Bip01_${side}_Forearm`, `Bip01 ${side} Forearm`])!;
    const hand = find([`Bip01 ${side} Hand`, `ValveBiped.Bip01_${side}_Hand`])!;
    const thigh = find([`Bip01 ${side} Leg`, `ValveBiped.Bip01_${side}_Thigh`, `Bip01 ${side} Thigh`])!;
    const calf = find([`Bip01 ${side} Leg1`, `ValveBiped.Bip01_${side}_Calf`, `Bip01 ${side} Calf`])!;
    const foot = find([`Bip01 ${side} Foot`, `ValveBiped.Bip01_${side}_Foot`])!;
    bindings[upper] = [`${prefix}_shoulder_yaw_link`]; bindings[lower] = [`${prefix}_elbow_link`];
    bindings[hand] = [`${prefix}_wrist_roll_link`, `${prefix}_elbow_link`];
    bindings[thigh] = [`${prefix}_hip_yaw_link`]; bindings[calf] = [`${prefix}_knee_link`];
    bindings[foot] = [`${prefix}_ankle_roll_link`];
    aim[upper] = lower; aim[lower] = hand; aim[thigh] = calf; aim[calf] = foot; feet.push(foot);
  }
  return {root: pelvis, alignment: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], bindings, aim, feet};
}

/** Decode an RLE channel once. Every run must advance, contain values, and stay inside its file. */
function animationChannel(r: Reader, start: number, frames: number): Int16Array {
  const output = new Int16Array(frames); let cursor = start, frame = 0;
  while (frame < frames) {
    const valid = r.u8(cursor), total = r.u8(cursor+1);
    if (!total || !valid || valid > total) r.fail(`invalid animation RLE run at ${cursor}.`);
    r.range(cursor+2, valid*2);
    for (let j = 0; j < total && frame < frames; j++, frame++) output[frame] = r.i16(cursor+2+Math.min(j, valid-1)*2);
    cursor += (valid+1)*2;
  }
  return output;
}

/** Public CPU decode seam for fixtures/tools. Scene is complete, including authored alternatives and clips. */
export async function decodeGoldSrcScene(source: GoldSrcSource): Promise<{scene: THREE.Group; definition: CharacterDefinition}> {
  const r = new Reader(source.model, source.name); r.header();
  let decodedBytes = 0;
  const reserve = (bytes: number) => {
    decodedBytes += bytes;
    if (decodedBytes > 128*1024*1024) r.fail('decoded model exceeds the 128 MiB geometry, texture and animation limit.');
  };
  const boneCount = r.table(r.i(144), r.i(140), 112);
  if (!boneCount || boneCount > 512) r.fail('unsupported empty or oversized skeleton (maximum 512 bones).');
  const boneData: BoneData[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < boneCount; i++) {
    const offset = r.i(144)+i*112, name = r.text(offset, 32), parent = r.i(offset+32);
    if (!name || seen.has(name) || parent < -1 || parent >= boneCount || parent === i) r.fail(`invalid bone ${i} hierarchy/name.`);
    seen.add(name);
    boneData.push({name, parent, controllers: Array.from({length:6}, (_, k) => r.i(offset+40+k*4)),
      value: Array.from({length:6}, (_, k) => r.f(offset+64+k*4)), scale: Array.from({length:6}, (_, k) => r.f(offset+88+k*4))});
  }
  const state = new Uint8Array(boneCount);
  const checkParent = (index: number) => {
    if (state[index] === 1) r.fail('cyclic skeleton.');
    if (state[index] === 2) return;
    state[index] = 1; if (boneData[index].parent >= 0) checkParent(boneData[index].parent); state[index] = 2;
  };
  for (let i = 0; i < boneCount; i++) checkParent(i);
  const rig = rigDefinition(boneData, r);
  const controllerCount = r.table(r.i(152), r.i(148), 24), adjustments: number[] = [];
  const controllers: Record<string, number>[] = [];
  for (let i = 0; i < controllerCount; i++) {
    const p = r.i(152)+i*24, bone = r.i(p), type = r.i(p+4), start = r.f(p+8), end = r.f(p+12), rest = r.i(p+16), index = r.i(p+20);
    checkedIndex(r, bone, boneCount, 'controller bone');
    if (index < 0 || index > 4 || rest < 0 || rest > 255 || ![1,2,4,8,16,32].includes(type & 0x7fff)) r.fail('unsupported bone controller.');
    const fraction = Math.min(1, rest/(index === 4 ? 64 : 255));
    let value = type & 0x8000 ? start+rest*360/256 : start+(end-start)*fraction;
    if ((type & 0x7fff) >= 8) value *= Math.PI/180;
    adjustments.push(value); controllers.push({bone,type,start,end,rest,index});
  }
  const defaults = boneData.map(bone => bone.value.map((value, k) => {
    const controller = bone.controllers[k];
    if (controller === -1) return value;
    checkedIndex(r, controller, controllerCount, 'bone controller'); return value+adjustments[controller];
  }));
  const scene = new THREE.Group(); scene.name = 'GoldSrcCharacter'; scene.rotation.x = -Math.PI/2;
  const motion = new THREE.Group(); motion.name = 'GoldSrcRootMotion'; scene.add(motion);
  const boneNames = new Set<string>();
  const bones = boneData.map((data, i) => {
    const bone = new THREE.Bone(); bone.name = THREE.PropertyBinding.sanitizeNodeName(data.name);
    if (boneNames.has(bone.name)) r.fail(`animation bone-name collision at ${data.name}.`);
    boneNames.add(bone.name); bone.userData.name = data.name;
    bone.position.fromArray(defaults[i]); bone.quaternion.copy(rotation(defaults[i])); return bone;
  });
  for (let i = 0; i < boneCount; i++) (boneData[i].parent >= 0 ? bones[boneData[i].parent] : motion).add(bones[i]);
  scene.updateMatrixWorld(true);
  // Geometry is stored in individual bone-local coordinates, not model/world coordinates.
  const inverseScene = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const boneWorld = bones.map(bone => new THREE.Matrix4().multiplyMatrices(inverseScene, bone.matrixWorld));
  let textureReader = r;
  if (r.i(180) === 0) {
    const filename = `${source.name}t.mdl`;
    textureReader = new Reader(await source.loadDependency(filename), filename); textureReader.header();
  }
  const textureData = textures(textureReader, reserve);
  if (!textureData.length) r.fail('no authored texture data.');
  // External texture MDLs own their skin table as well as their palette images.
  const skinReader = textureReader;
  const skinRefs = skinReader.i(192), familyCount = skinReader.i(196), skinOffset = skinReader.i(200);
  if (skinRefs <= 0 || familyCount <= 0) skinReader.fail('missing skin-reference table.');
  skinReader.table(skinOffset, skinRefs*familyCount, 2);
  const skinFamilies = Array.from({length: familyCount}, (_, family) => Array.from({length: skinRefs}, (_, slot) =>
    checkedIndex(skinReader, skinReader.i16(skinOffset+2*(family*skinRefs+slot)), textureData.length, 'skin texture')));
  const bodyCount = r.table(r.i(208), r.i(204), 76);
  if (!bodyCount) r.fail('model has no body parts.');
  const bodyParts: {name:string; base:number; selected:number; models:{name:string;vertices:number;triangles:number}[]}[] = [];
  const point = new THREE.Vector3(), normal = new THREE.Vector3(), origin = new THREE.Vector3();
  for (let part = 0; part < bodyCount; part++) {
    const p = r.i(208)+part*76, name = r.text(p, 64), count = r.table(r.i(p+72), r.i(p+64), 112), base = r.i(p+68);
    if (!count || base <= 0) r.fail('invalid body-part alternatives.');
    const partInfo = {name, base, selected: 0, models: [] as {name:string;vertices:number;triangles:number}[]}; bodyParts.push(partInfo);
    const group = new THREE.Group(); group.name = `Bodypart_${part}_${name}`; motion.add(group);
    for (let model = 0; model < count; model++) {
      const m = r.i(p+72)+model*112, modelName = r.text(m, 64);
      const meshCount = r.table(r.i(m+76), r.i(m+72), 20), vertices = r.table(r.i(m+88), r.i(m+80), 12);
      r.table(r.i(m+84), vertices, 1);
      const normals = r.table(r.i(m+100), r.i(m+92), 12); r.table(r.i(m+96), normals, 1);
      if (r.i(m+104) !== 0) r.fail('unsupported legacy deformation groups.');
      const alternative = new THREE.Group(); alternative.name = `${part}_${model}_${modelName}`; alternative.visible = model === 0;
      alternative.userData.goldsrcBodypart = part; alternative.userData.goldsrcSubmodel = model; group.add(alternative);
      const info = {name: modelName, vertices, triangles: 0}; partInfo.models.push(info);
      for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
        const meshOffset = r.i(m+76)+meshIndex*20, expectedTriangles = r.i(meshOffset), skinRef = r.i(meshOffset+8);
        if (expectedTriangles < 0) r.fail('negative mesh triangle count.');
        checkedIndex(r, skinRef, skinRefs, 'mesh skin reference'); const texture = textureData[skinFamilies[0][skinRef]];
        const positions: number[] = [], normalValues: number[] = [], uv: number[] = [], joints: number[] = [], weights: number[] = [], chromeOrigins: number[] = [], indices: number[] = [];
        let cursor = r.i(meshOffset+4), triangleCount = 0;
        while (true) {
          const command = r.i16(cursor); cursor += 2; if (!command) break;
          const n = Math.abs(command); if (n < 3) r.fail('triangle command has fewer than three vertices.');
          r.range(cursor, n*8); const first = positions.length/3;
          reserve(n*68+(n-2)*12);
          for (let v = 0; v < n; v++, cursor += 8) {
            const vi = checkedIndex(r, r.i16(cursor), vertices, 'vertex'), ni = checkedIndex(r, r.i16(cursor+2), normals, 'normal');
            const vb = checkedIndex(r, r.u8(r.i(m+84)+vi), boneCount, 'vertex bone');
            const nb = checkedIndex(r, r.u8(r.i(m+96)+ni), boneCount, 'normal bone');
            // GoldSrc normally pairs a vertex and its normal to the same rigid bone. A different
            // normal bone needs independent normal skinning, which this R1 surface pipeline cannot represent.
            if (vb !== nb) r.fail(`unsupported independent normal-bone binding in ${modelName}.`);
            const vp = r.i(m+88)+vi*12, np = r.i(m+100)+ni*12;
            point.set(r.f(vp),r.f(vp+4),r.f(vp+8)).applyMatrix4(boneWorld[vb]);
            normal.set(r.f(np),r.f(np+4),r.f(np+8)).transformDirection(boneWorld[nb]);
            if (!Number.isFinite(Math.fround(point.x)) || !Number.isFinite(Math.fround(point.y)) ||
                !Number.isFinite(Math.fround(point.z))) r.fail('nonfinite transformed vertex.');
            if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() < .5) r.fail('invalid authored normal.');
            positions.push(point.x, point.y, point.z); normalValues.push(normal.x,normal.y,normal.z);
            uv.push(r.i16(cursor+4)/texture.width, r.i16(cursor+6)/texture.height);
            joints.push(vb,0,0,0); weights.push(1,0,0,0); origin.setFromMatrixPosition(boneWorld[nb]); chromeOrigins.push(origin.x,origin.y,origin.z);
          }
          // MDL commands face clockwise: Valve's utils/mdlviewer/studio_render.cpp culls GL_FRONT.
          // Reverse fan and both strip parities for Three's CCW front faces, not the authored normals.
          for (let t = 0; t < n-2; t++) {
            if (command < 0) indices.push(first,first+t+2,first+t+1);
            else if (t & 1) indices.push(first+t+1,first+t+2,first+t);
            else indices.push(first+t,first+t+2,first+t+1);
            triangleCount++;
          }
          if (triangleCount > expectedTriangles) r.fail('triangle commands exceed declared mesh count.');
        }
        if (triangleCount !== expectedTriangles) r.fail('triangle command count does not match mesh header.');
        info.triangles += triangleCount;
        if (!triangleCount) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalValues,3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints,4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights,4));
        geometry.setAttribute('chromeOrigin', new THREE.Float32BufferAttribute(chromeOrigins,3)); geometry.setIndex(indices);
        const mesh = new THREE.SkinnedMesh(geometry, texture.material); mesh.name = `${alternative.name}_mesh${meshIndex}`;
        mesh.userData.goldsrcSkinRef = skinRef; mesh.userData.goldsrcSkinTextures = skinFamilies.map(family => family[skinRef]);
        mesh.frustumCulled = false; alternative.add(mesh); scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
      }
    }
  }
  const sequenceCount = r.table(r.i(168), r.i(164), 176), groupCount = r.table(r.i(176), r.i(172), 104);
  if (sequenceCount && !groupCount) r.fail('missing sequence groups.');
  const groups = new Map<number, Reader>(); groups.set(0,r);
  const sequenceInfo: Record<string, unknown>[] = [];
  for (let sequence = 0; sequence < sequenceCount; sequence++) {
    const p = r.i(168)+sequence*176, name = r.text(p,32) || `sequence_${sequence}`, fps = r.f(p+32), flags = r.i(p+36);
    const frames = r.i(p+56), blends = r.i(p+120), group = checkedIndex(r,r.i(p+156),groupCount,'sequence group');
    if (fps <= 0 || frames <= 0 || frames > 100000 || ![1,2,4].includes(blends)) r.fail(`unsupported frame/blend count in ${name}.`);
    reserve(frames*blends*(boneCount*7+4)*4);
    if (r.i(p+88) || r.i(p+92)) r.fail(`unsupported legacy automove arrays in ${name}.`);
    const motionType = r.i(p+68), motionBone = r.i(p+72), linear = r.vector(p+76);
    if (motionBone !== -1 || motionType) checkedIndex(r,motionBone,boneCount,'motion bone');
    let animationReader = groups.get(group);
    if (!animationReader) {
      const filename = dependencyName(r,r.text(r.i(176)+group*104+32,64),source.name,group);
      animationReader = new Reader(await source.loadDependency(filename), filename); animationReader.header('IDSQ'); groups.set(group,animationReader);
    }
    const a = animationReader, animation = r.i(p+124)+(group === 0 ? r.i(r.i(176)+100) : 0);
    a.table(animation, blends*boneCount, 12);
    const events = Array.from({length:r.table(r.i(p+52),r.i(p+48),76)},(_, event) => {
      const e = r.i(p+52)+event*76; return {frame:r.i(e),event:r.i(e+4),type:r.i(e+8),options:r.text(e+12,64)};
    });
    const blendNames: string[] = [];
    for (let blend = 0; blend < blends; blend++) {
      const times = Float32Array.from({length:frames},(_, frame) => frame/fps), tracks: THREE.KeyframeTrack[] = [];
      for (let bone = 0; bone < boneCount; bone++) {
        const q = animation+(blend*boneCount+bone)*12;
        const channels = Array.from({length:6},(_, axis) => {
          const offset = a.u16(q+axis*2); return offset ? animationChannel(a,q+offset,frames) : null;
        });
        const positions = new Float32Array(frames*3), quaternions = new Float32Array(frames*4);
        const values = new Float64Array(6), quaternion = new THREE.Quaternion(), previous = new THREE.Quaternion();
        for (let frame = 0; frame < frames; frame++) {
          for (let axis = 0; axis < 6; axis++) {
            values[axis] = defaults[bone][axis]+(channels[axis]?.[frame] ?? 0)*boneData[bone].scale[axis];
            if (!Number.isFinite(Math.fround(values[axis]))) a.fail(`nonfinite animated pose in ${name}.`);
          }
          if (bone === motionBone) for (let axis = 0; axis < 3; axis++) if (motionType & (1<<axis)) values[axis] = 0;
          positions[frame*3] = values[0]; positions[frame*3+1] = values[1]; positions[frame*3+2] = values[2];
          rotation(values,quaternion);
          if (frame && previous.dot(quaternion) < 0) quaternion.set(-quaternion.x,-quaternion.y,-quaternion.z,-quaternion.w);
          quaternion.toArray(quaternions,frame*4); previous.copy(quaternion);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${bones[bone].name}.position`,times,positions),
          new THREE.QuaternionKeyframeTrack(`${bones[bone].name}.quaternion`,times,quaternions));
      }
      const movement = new Float32Array(frames*3);
      for (let frame = 0; frame < frames; frame++) {
        const fraction = frames > 1 ? frame/(frames-1) : 0;
        movement[frame*3] = linear.x*fraction; movement[frame*3+1] = linear.y*fraction; movement[frame*3+2] = linear.z*fraction;
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${motion.name}.position`,times,movement));
      const clipName = `${sequence}:${name}${blend ? ` [blend ${blend}]` : ''}`;
      const clip = new THREE.AnimationClip(clipName, Math.max(1/fps,(frames-1)/fps),tracks);
      clip.blendMode = THREE.NormalAnimationBlendMode; scene.animations.push(clip); blendNames.push(clipName);
    }
    sequenceInfo.push({name,frames,fps,flags,looping:!!(flags&1),motionType,motionBone,linearMovement:linear.toArray(),
      blends,blendTypes:[r.i(p+128),r.i(p+132)],blendStart:[r.f(p+136),r.f(p+140)],blendEnd:[r.f(p+144),r.f(p+148)],
      group,clips:blendNames,events});
  }
  const localPicardia = source.name.toLowerCase() === 'picardia_v1sc';
  const definition: CharacterDefinition = {id: localPicardia ? 'pmodels:hl:picardia_v1sc' : `goldsrc:${encodeURIComponent(source.name)}`,
    label: localPicardia ? 'Picardia' : source.name, url: source.source, preview: source.thumbnail,
    attribution: {title:localPicardia ? 'Picardia' : source.name,
      creator:localPicardia ? 'TayKlor (HLDM-BR.NET); design and 3D model: DAZ Productions, Inc.; Half-Life port: modelguy' : 'Original model authors; see selected model readme',
      source:source.source, license:'No blanket redistribution license asserted; original model credits and terms apply.',
      modifications:['Decoded GoldSrc IDST v10 geometry, indexed palettes, rig and authored animation in-browser.',
        'Native Z-up coordinates rotated to Y-up; compatible R1 retargeting does not replace authored mesh/rig.']}, rig};
  scene.userData = {characterDefinition:definition,characterAttribution:definition.attribution,
    goldsrc:{version:10,name:source.name,readme:source.readme ?? '',boneCount,sequenceCount,clipCount:scene.animations.length,
      textureCount:textureData.length,bodyParts,skinFamilies,defaultSkin:0,defaultBody:0,controllers,sequences:sequenceInfo,
      materials:textureData.map(({name,flags,width,height}) => ({name,flags,width,height})),
      materialLimits:['GoldSrc legacy directional lighting is represented by scene PBR lighting; flat/fullbright/chrome/additive/masked flags are retained.',
        'ALPHA has no per-model entity render amount; default amount is opaque. Chrome view-dependent UV shader is retained at runtime; generic GLB viewers do not implement that shader.',
        'Authored blend endpoints are separate clips; no animation UI or engine gameplay/controller emulation is claimed.'],
      formatReference:'https://github.com/wootguy/modelguy',coordinateSystem:'Native Z-up X-forward, scene Rx(-90deg), physics alignment Rx(+90deg)'}};
  scene.updateMatrixWorld(true);
  return {scene,definition};
}

export async function loadGoldSrcCharacter(source: GoldSrcSource): Promise<CharacterAsset> {
  const {scene,definition} = await decodeGoldSrcScene(source);
  return characterAsset(scene,definition);
}
