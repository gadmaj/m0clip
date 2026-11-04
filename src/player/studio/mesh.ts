/** VVD (vertexFileHeader_t v4) and .dx90.vtx (OptimizedModel v7) decoding into per-mesh CPU
 * arrays for the root LOD. Layout knowledge follows the published SDK headers and the MIT noclip
 * reader (LICENSE.noclip); no SDK code is copied. Checksums must match the MDL, the VVD fixup table
 * is applied, and every hardware bone table entry is checked against the VVD bone it stands for. */
import { BinaryFile, StudioUnsupportedError } from './binary';
import { STUDIOHDR_EXTRA_VERTEX_DATA, type MdlFile } from './mdl';
import type { StudioBodyPart, StudioMesh, StudioStripGroup, StudioSubmodel } from './types';

const STRIPGROUP_IS_HWSKINNED = 0x02;
const STRIP_IS_TRILIST = 0x01;
const STRIP_IS_TRISTRIP = 0x02;

export interface DecodedMeshes {
  readonly bodyParts: StudioBodyPart[];
  readonly lodCount: number;
  readonly replacements: Map<number, string>;
}

interface Vvd {
  readonly file: BinaryFile;
  readonly lodCount: number;
  /** Root-LOD vertex -> VVD record, after fixups. */
  readonly remap: Uint32Array;
  readonly vertexStart: number;
  readonly tangentStart: number;
}

function readVvd(file: BinaryFile, mdl: MdlFile): Vvd {
  file.range(0, 0x40, 'VVD header');
  if (file.fixedString(0, 4, 'VVD ident') !== 'IDSV') file.fail('is not an IDSV vertex file');
  const version = file.i32(4);
  if (version !== 4) throw new StudioUnsupportedError(file.path, `VVD version ${version}`);
  const checksum = file.u32(8);
  if (checksum !== mdl.checksum) file.fail(`checksum ${checksum} doesn't match ${mdl.file.path} (${mdl.checksum})`);
  const lodCount = file.i32(0x0c);
  if (lodCount < 1 || lodCount > 8) file.fail(`has ${lodCount} LODs`);
  const rootCount = file.i32(0x10);
  const fixupCount = file.i32(0x30), fixupStart = file.i32(0x34);
  const vertexStart = file.i32(0x38), tangentStart = file.i32(0x3c);
  if (mdl.flags & STUDIOHDR_EXTRA_VERTEX_DATA) throw new StudioUnsupportedError(file.path, 'extra vertex data (second UV set)');
  const totalVertices = Math.floor((tangentStart - vertexStart)/0x30);
  file.table(vertexStart, totalVertices, 0x30, 'VVD vertices');
  file.table(tangentStart, totalVertices, 0x10, 'VVD tangents');
  const remap = new Uint32Array(rootCount);
  if (fixupCount === 0) {
    if (rootCount > totalVertices) file.fail(`root LOD needs ${rootCount} vertices but holds ${totalVertices}`);
    for (let i = 0; i < rootCount; i++) remap[i] = i;
  } else {
    // Fixups copy VVD runs into mesh order; with root LOD 0 every run applies, in table order.
    const f0 = file.table(fixupStart, fixupCount, 12, 'VVD fixups');
    let dst = 0;
    for (let i = 0; i < fixupCount; i++) {
      const lod = file.i32(f0 + i*12), src = file.i32(f0 + i*12 + 4), n = file.i32(f0 + i*12 + 8);
      if (lod < 0 || src < 0 || n < 0 || src + n > totalVertices || dst + n > rootCount) file.fail(`fixup ${i} (lod ${lod}, ${n} from ${src}) is out of range`);
      for (let k = 0; k < n; k++) remap[dst++] = src + k;
    }
    if (dst !== rootCount) file.fail(`fixups rebuild ${dst} of ${rootCount} root-LOD vertices`);
  }
  return { file, lodCount, remap, vertexStart, tangentStart };
}

function triangles(vtx: BinaryFile, groupIndices: Uint16Array, flags: number, start: number, count: number, out: number[], base: number, what: string): void {
  if (flags & STRIP_IS_TRISTRIP) throw new StudioUnsupportedError(vtx.path, `${what} triangle strips`);
  if (!(flags & STRIP_IS_TRILIST) || count % 3) vtx.fail(`${what} has strip flags ${flags} and ${count} indices`);
  for (let i = 0; i < count; i++) out.push(base + groupIndices[start + i]);
}

export function decodeMeshes(mdl: MdlFile, vvdFile: BinaryFile, vtx: BinaryFile): DecodedMeshes {
  const vvd = readVvd(vvdFile, mdl);
  const vv = vvd.file.view;
  vtx.range(0, 36, 'VTX header');
  const vtxVersion = vtx.i32(0);
  if (vtxVersion !== 7) throw new StudioUnsupportedError(vtx.path, `VTX version ${vtxVersion}`);
  const checksum = vtx.u32(0x10);
  if (checksum !== mdl.checksum) vtx.fail(`checksum ${checksum} doesn't match ${mdl.file.path} (${mdl.checksum})`);
  const lodCount = vtx.i32(0x14);
  if (lodCount !== vvd.lodCount) vtx.fail(`has ${lodCount} LODs; the VVD has ${vvd.lodCount}`);
  if (vtx.i32(0x1c) !== mdl.bodyParts.length) vtx.fail(`has ${vtx.i32(0x1c)} body parts; the MDL has ${mdl.bodyParts.length}`);

  const replacements = new Map<number, string>();
  const rl = vtx.table(vtx.i32(0x18), lodCount, 8, 'material replacement lists');
  const replacementCount = vtx.i32(rl);
  const r0 = vtx.table(rl + vtx.i32(rl + 4), replacementCount, 6, 'root LOD material replacements');
  for (let i = 0; i < replacementCount; i++) {
    const id = vtx.i16(r0 + i*6);
    if (id < 0 || id >= mdl.textures.length) vtx.fail(`material replacement ${i} names texture ${id}`);
    replacements.set(id, vtx.cstring(r0 + i*6 + vtx.i32(r0 + i*6 + 2), 'material replacement'));
  }

  // v49 VTX strip groups and strips carry two extra topology ints (MIT noclip); unobserved here.
  const topology = mdl.version >= 49;
  const groupStride = topology ? 0x21 : 0x19, stripStride = topology ? 0x23 : 0x1b;
  const boneCount = mdl.bones.count;
  const bodyParts: StudioBodyPart[] = [];
  const bp0 = vtx.table(vtx.i32(0x20), mdl.bodyParts.length, 8, 'VTX body parts');
  mdl.bodyParts.forEach((part, pi) => {
    const vbp = bp0 + pi*8;
    if (vtx.i32(vbp) !== part.models.length) vtx.fail(`body part ${part.name} has ${vtx.i32(vbp)} models; the MDL has ${part.models.length}`);
    const vm0 = vtx.table(vbp + vtx.i32(vbp + 4), part.models.length, 8, 'VTX models');
    const models: StudioSubmodel[] = part.models.map((model, mi) => {
      const vm = vm0 + mi*8;
      if (vtx.i32(vm) !== lodCount) vtx.fail(`model ${model.name} has ${vtx.i32(vm)} LODs`);
      const lod = vtx.table(vm + vtx.i32(vm + 4), lodCount, 12, 'VTX model LODs');
      if (vtx.i32(lod) !== model.meshes.length) vtx.fail(`model ${model.name} root LOD has ${vtx.i32(lod)} meshes; the MDL has ${model.meshes.length}`);
      const me0 = vtx.table(lod + vtx.i32(lod + 4), model.meshes.length, 9, 'VTX meshes');
      const meshes: StudioMesh[] = [];
      model.meshes.forEach((mesh, ki) => {
        const what = `${part.name}/${model.name} mesh ${ki}`;
        const vme = me0 + ki*9;
        const groupCount = vtx.i32(vme);
        const g0 = vtx.table(vme + vtx.i32(vme + 4), groupCount, groupStride, `${what} strip groups`);
        let vertexCount = 0;
        for (let g = 0; g < groupCount; g++) vertexCount += vtx.i32(g0 + g*groupStride);
        if (vertexCount === 0) return;
        const position = new Float32Array(vertexCount*3), normal = new Float32Array(vertexCount*3), tangent = new Float32Array(vertexCount*4);
        const uv = new Float32Array(vertexCount*2), boneIndex = new Uint8Array(vertexCount*3), boneWeight = new Float32Array(vertexCount*3);
        const influences = new Uint8Array(vertexCount), sourceVertex = new Uint16Array(vertexCount);
        const vvdBone = new Int32Array(vertexCount*3), vtxBone = new Int32Array(vertexCount*3);
        const index: number[] = [];
        const stripGroups: StudioStripGroup[] = [];
        let vBase = 0;
        for (let g = 0; g < groupCount; g++) {
          const sg = g0 + g*groupStride;
          const nv = vtx.i32(sg), vOff = vtx.i32(sg + 4), ni = vtx.i32(sg + 8), iOff = vtx.i32(sg + 12);
          const ns = vtx.i32(sg + 16), sOff = vtx.i32(sg + 20), groupFlags = vtx.u8(sg + 24);
          const v0 = vtx.table(sg + vOff, nv, 9, `${what} strip group vertices`);
          const i0 = vtx.table(sg + iOff, ni, 2, `${what} strip group indices`);
          for (let v = 0; v < nv; v++) {
            const vo = v0 + v*9, out = vBase + v;
            const count = vtx.u8(vo + 3), orig = vtx.u16(vo + 4);
            if (orig >= mesh.vertexCount) vtx.fail(`${what} vertex ${v} refers to mesh vertex ${orig} of ${mesh.vertexCount}`);
            const modelVertex = model.firstVertex + mesh.vertexOffset + orig;
            const tangentVertex = model.firstTangent + mesh.vertexOffset + orig;
            if (modelVertex >= vvd.remap.length || tangentVertex >= vvd.remap.length) vtx.fail(`${what} vertex ${v} lies past the root LOD`);
            const r = vvd.vertexStart + vvd.remap[modelVertex]*0x30, t = vvd.tangentStart + vvd.remap[tangentVertex]*0x10;
            const vvdCount = vv.getUint8(r + 15);
            // A rigid vertex may store no VTX influence; it then uses its single VVD bone as authored.
            const rigid = count === 0 && vvdCount === 1;
            if (!rigid && (count < 1 || count > 3 || count !== vvdCount)) vtx.fail(`${what} vertex ${v} has ${count} influences; the VVD has ${vvdCount}`);
            const used = rigid ? 1 : count;
            let sum = 0;
            for (let i = 0; i < used; i++) {
              const slot = rigid ? 0 : vtx.u8(vo + i);
              if (slot >= vvdCount) vtx.fail(`${what} vertex ${v} weight slot ${slot}`);
              const bone = vv.getInt8(r + 12 + slot), weight = vv.getFloat32(r + slot*4, true);
              if (bone < 0 || bone >= boneCount) vvd.file.fail(`vertex ${vvd.remap[modelVertex]} uses bone ${bone} of ${boneCount}`);
              if (!(weight >= 0 && weight <= 1.0001)) vvd.file.fail(`vertex ${vvd.remap[modelVertex]} has weight ${weight}`);
              boneIndex[out*3 + i] = bone;
              boneWeight[out*3 + i] = weight;
              vvdBone[out*3 + i] = rigid ? -1 : bone;
              vtxBone[out*3 + i] = rigid ? -1 : vtx.u8(vo + 6 + i);
              sum += weight;
            }
            for (let i = used; i < 3; i++) { vvdBone[out*3 + i] = -1; vtxBone[out*3 + i] = -1; }
            if (Math.abs(sum - 1) > 0.002) vvd.file.fail(`vertex ${vvd.remap[modelVertex]} weights sum to ${sum}`);
            influences[out] = used;
            sourceVertex[out] = orig;
            for (let c = 0; c < 3; c++) {
              position[out*3 + c] = vv.getFloat32(r + 0x10 + c*4, true);
              normal[out*3 + c] = vv.getFloat32(r + 0x1c + c*4, true);
            }
            for (let c = 0; c < 4; c++) tangent[out*4 + c] = vv.getFloat32(t + c*4, true);
            uv[out*2] = vv.getFloat32(r + 0x28, true);
            uv[out*2 + 1] = vv.getFloat32(r + 0x2c, true);
          }
          const groupIndices = new Uint16Array(ni);
          for (let i = 0; i < ni; i++) {
            groupIndices[i] = vtx.u16(i0 + i*2);
            if (groupIndices[i] >= nv) vtx.fail(`${what} index ${i} is ${groupIndices[i]} of ${nv} vertices`);
          }
          const hw = (groupFlags & STRIPGROUP_IS_HWSKINNED) !== 0;
          const table = new Int32Array(256).fill(-1);
          const indexStart = index.length;
          const st0 = vtx.table(sg + sOff, ns, stripStride, `${what} strips`);
          for (let s = 0; s < ns; s++) {
            const so = st0 + s*stripStride;
            const sni = vtx.i32(so), sio = vtx.i32(so + 4), stripFlags = vtx.u8(so + 0x12);
            const changes = vtx.i32(so + 0x13), c0 = vtx.table(so + vtx.i32(so + 0x17), changes, 8, `${what} bone state changes`);
            if (sio < 0 || sni < 0 || sio + sni > ni) vtx.fail(`${what} strip ${s} indexes ${sni} from ${sio} of ${ni}`);
            if (!hw && changes) vtx.fail(`${what} software-skinned strip ${s} changes hardware bones`);
            for (let c = 0; c < changes; c++) {
              const hwId = vtx.i32(c0 + c*8), bone = vtx.i32(c0 + c*8 + 4);
              if (hwId < 0 || hwId > 255 || bone < 0 || bone >= boneCount) vtx.fail(`${what} strip ${s} maps hardware bone ${hwId} to ${bone}`);
              table[hwId] = bone;
            }
            // Each influence's hardware bone must resolve to the VVD bone it replaces.
            for (let i = sio; i < sio + sni; i++) {
              const v = vBase + groupIndices[i];
              for (let k = 0; k < influences[v]; k++) {
                const id = vtxBone[v*3 + k];
                if (id < 0) continue;
                const resolved = hw ? table[id] : id;
                if (resolved !== vvdBone[v*3 + k]) vtx.fail(`${what} strip ${s} vertex ${groupIndices[i]} hardware bone ${id} resolves to ${resolved}, not VVD bone ${vvdBone[v*3 + k]}`);
              }
            }
            triangles(vtx, groupIndices, stripFlags, sio, sni, index, vBase, `${what} strip ${s}`);
          }
          stripGroups.push({ flags: groupFlags, vertexStart: vBase, vertexCount: nv, indexStart, indexCount: index.length - indexStart });
          vBase += nv;
        }
        meshes.push({
          skinRef: mesh.skinRef, materialType: mesh.materialType, materialParam: mesh.materialParam, meshId: mesh.meshId,
          center: mesh.center, flags: vtx.u8(vme + 8), vertexCount, position, normal, tangent, uv, boneIndex, boneWeight,
          boneCount: influences, sourceVertex, index: vertexCount > 65535 ? Uint32Array.from(index) : Uint16Array.from(index),
          stripGroups, flexCount: mesh.flexCount,
        });
      });
      return { name: model.name, boundingRadius: model.boundingRadius, meshes, eyeballs: model.eyeballs };
    });
    bodyParts.push({ name: part.name, base: part.base, models });
  });
  return { bodyParts, lodCount, replacements };
}
