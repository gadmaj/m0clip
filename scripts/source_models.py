"""Source MDL/VVD/VTX model geometry and BSP prop placement.

Adapted from noclip.website SourceEngine/Studio.ts and StaticDetailObject.ts.
Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip.
Models use the highest-detail LOD, selected skin and body groups, in their bind pose.
"""
from __future__ import annotations

from dataclasses import dataclass
import struct
import numpy as np


def u32(data, offset): return struct.unpack_from('<I', data, offset)[0]
def i32(data, offset): return struct.unpack_from('<i', data, offset)[0]
def cstr(data, offset): return data[offset:].split(b'\0', 1)[0].decode('latin-1')


def qangle(angles) -> np.ndarray:
    """Source QAngle: pitch around Y, yaw around Z, roll around X (degrees)."""
    pitch, yaw, roll = np.radians(angles)
    sp, sy, sr = np.sin([pitch, yaw, roll]); cp, cy, cr = np.cos([pitch, yaw, roll])
    return np.array([[cp*cy, sp*sr*cy-cr*sy, sp*cr*cy+sr*sy],
                     [cp*sy, sp*sr*sy+cr*cy, sp*cr*sy-sr*cy],
                     [-sp, sr*cp, cr*cp]])


@dataclass
class Prop:
    model: str
    origin: np.ndarray
    angles: np.ndarray
    skin: int = 0
    body: int = 0
    scale: float = 1
    static_index: int | None = None
    solid: int = 0
    lighting_origin: np.ndarray | None = None
    cast_shadow: bool = True
    classname: str = 'prop_static'
    animation: str = ''
    leaves: tuple[int, ...] = ()


def static_props(bsp) -> list[Prop]:
    game = bsp.lump(35)
    for i in range(u32(game, 0)):
        tag, flags, version, offset, length = struct.unpack_from('<4sHHii', game, 4 + i * 16)
        if tag != b'prps': continue
        # Ghost is Source BSP v20, sprp v5. Fail explicitly instead of misreading another layout.
        if version not in (4, 5, 6):
            raise ValueError(f'unsupported static prop lump version {version}')
        raw = bsp.data[offset:offset + length]
        count = u32(raw, 0)
        names = [cstr(raw, 4 + j * 128).lower().replace('\\', '/') for j in range(count)]
        p = 4 + count * 128
        leaf_count = u32(raw, p); p += 4
        leaves = np.frombuffer(raw, '<u2', leaf_count, p); p += leaf_count*2
        count = u32(raw, p); p += 4
        size = 56 + (4 if version >= 5 else 0) + (4 if version >= 6 else 0)
        if p + count * size != len(raw): raise ValueError('unexpected static prop record size')
        result = []
        for j in range(count):
            off = p + j * size
            pose = np.frombuffer(raw, '<f4', 6, off).astype(float)
            model_index, first_leaf, num_leaves, solid, flags, skin = struct.unpack_from('<HHHBBi', raw, off + 24)
            light = np.frombuffer(raw, '<f4', 3, off + 44).astype(float) if flags & 2 else None
            result.append(Prop(names[model_index], pose[:3], pose[3:], skin=skin, static_index=j,
                               solid=solid, lighting_origin=light, cast_shadow=not bool(flags & 16),
                               leaves=tuple(map(int, leaves[first_leaf:first_leaf+num_leaves]))))
        return result
    return []


def entity_props(m) -> list[Prop]:
    result = []
    for e in m['ents']:
        if not e.get('model', '').lower().endswith('.mdl'): continue
        vector = lambda k: np.array([float(v) for v in e.get(k, '0 0 0').split()])
        result.append(Prop(e['model'].lower().replace('\\', '/'), vector('origin'), vector('angles'),
            skin=int(e.get('skin', '0')), body=int(e.get('body', '0')),
            scale=float(e.get('modelscale', '1')), solid=int(e.get('solid', '6')),
            cast_shadow=e.get('disableshadows', '0') != '1', classname=e['classname'], animation=e.get('DefaultAnim', '')))
    return result


@dataclass
class ModelMesh:
    positions: np.ndarray
    normals: np.ndarray
    uv: np.ndarray
    triangles: np.ndarray
    skinref: int
    bodypart: int
    submodel: int
    body_base: int
    body_count: int
    tangents: np.ndarray
    weights: np.ndarray
    joints: np.ndarray


class StudioModel:
    def __init__(self, fs, path: str):
        base = path.removesuffix('.mdl')
        blobs = [fs.read(base + ext) for ext in ('.mdl', '.vvd', '.dx90.vtx')]
        if any(b is None for b in blobs):
            raise FileNotFoundError('missing ' + ', '.join(base + ext for b, ext in
                zip(blobs, ('.mdl', '.vvd', '.dx90.vtx')) if b is None))
        mdl, vvd, vtx = blobs
        self.mdl = mdl
        if mdl[:4] != b'IDST' or u32(mdl, 4) not in (44, 45, 46, 47, 48, 49):
            raise ValueError(f'unsupported MDL version: {path}')
        if vvd[:4] != b'IDSV' or u32(vvd, 4) != 4 or u32(vtx, 0) != 7:
            raise ValueError(f'unsupported VVD/VTX: {path}')
        if not u32(mdl, 8) == u32(vvd, 8) == u32(vtx, 16):
            raise ValueError(f'model checksum mismatch: {path}')
        self.version = u32(mdl, 4)
        self.illumination = np.frombuffer(mdl, '<f4', 3, 0x5c).astype(float)
        self.bounds = np.frombuffer(mdl, '<f4', 6, 0x68).reshape(2, 3).astype(float)
        dirs = [cstr(mdl, u32(mdl, u32(mdl, 0xd8) + i*4)).replace('\\', '/').lower()
                for i in range(u32(mdl, 0xd4))]
        self.materials = []
        for i in range(u32(mdl, 0xcc)):
            off = u32(mdl, 0xd0) + i * 64
            name = cstr(mdl, off + u32(mdl, off)).replace('\\', '/').lower().removesuffix('.vmt')
            candidates = [d.rstrip('/') + '/' + name for d in dirs] + [name]
            resolved = next((p.removeprefix('materials/') for p in candidates
                             if fs.read('materials/' + p.removeprefix('materials/') + '.vmt') is not None), None)
            self.materials.append(resolved or name)
        refs, families = u32(mdl, 0xdc), u32(mdl, 0xe0)
        self.skins = np.frombuffer(mdl, '<u2', refs * families, u32(mdl, 0xe4)).reshape(families, refs)
        vertex_count = u32(vvd, 16)
        vertex_offset = u32(vvd, 56)
        records = np.frombuffer(vvd, np.dtype([('weights', '<f4', 3), ('bones', 'u1', 4),
            ('p', '<f4', 3), ('n', '<f4', 3), ('uv', '<f4', 2)]),
            count=(u32(vvd, 60) - vertex_offset) // 48, offset=vertex_offset)
        fixups = [struct.unpack_from('<III', vvd, u32(vvd, 52) + i * 12) for i in range(u32(vvd, 48))]
        remap = np.concatenate([np.arange(src, src + count) for lod, src, count in fixups]) \
            if fixups else np.arange(vertex_count)
        if len(remap) != vertex_count: raise ValueError(f'invalid VVD fixups: {path}')
        tangents_data = np.frombuffer(vvd, '<f4', len(records) * 4, u32(vvd, 60)).reshape(-1, 4)
        self.meshes = []
        for bodypart in range(u32(mdl, 0xe8)):
            body = u32(mdl, 0xec) + bodypart * 16
            vbody = u32(vtx, 32) + bodypart * 8
            count, body_base, model_offset = struct.unpack_from('<III', mdl, body + 4)
            if u32(vtx, vbody) != count: raise ValueError('MDL/VTX bodypart mismatch')
            for submodel in range(count):
                model = body + model_offset + submodel * 148
                vmodel = vbody + u32(vtx, vbody + 4) + submodel * 8
                lod = vmodel + u32(vtx, vmodel + 4)  # LOD 0 only
                first_vertex = u32(mdl, model + 84) // 48
                for mesh in range(u32(mdl, model + 72)):
                    mesh_off = model + u32(mdl, model + 76) + mesh * 116
                    vm = lod + u32(vtx, lod + 4) + mesh * 9
                    positions, normals, uvs, triangles, tangents, weights, joints = [], [], [], [], [], [], []
                    vertex_base = 0
                    for group in range(u32(vtx, vm)):
                        vg = vm + u32(vtx, vm + 4) + group * (33 if self.version >= 49 else 25)
                        nv, voff, ni, ioff, ns, soff = struct.unpack_from('<6I', vtx, vg)
                        if not nv or not ni: continue
                        ids = np.ndarray((nv,), dtype='<u2', buffer=vtx, offset=vg + voff + 4, strides=(9,))
                        ids = remap[first_vertex + u32(mdl, mesh_off + 12) + ids.astype(int)]
                        rows = records[ids]
                        positions.append(rows['p']); normals.append(rows['n']); uvs.append(rows['uv']); tangents.append(tangents_data[ids]); weights.append(np.column_stack([rows['weights'], np.zeros(len(rows))])); joints.append(rows['bones'])
                        indices = np.frombuffer(vtx, '<u2', ni, vg + ioff).astype(np.uint32)
                        for strip in range(ns):
                            vs = vg + soff + strip * (35 if self.version >= 49 else 27)
                            nidx, idxoff = struct.unpack_from('<II', vtx, vs)
                            flags = vtx[vs + 18]
                            selected = indices[idxoff:idxoff + nidx]
                            if flags & 1:
                                tri = selected.reshape(-1, 3)
                            elif flags & 2:
                                tri = np.array([selected[j:j+3] if j % 2 == 0 else selected[j:j+3][::-1]
                                                for j in range(len(selected) - 2)], dtype=np.uint32)
                                tri = tri[(tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])]
                            else: raise ValueError(f'unsupported strip flags {flags}: {path}')
                            triangles.append(tri + vertex_base)
                        vertex_base += nv
                    if not positions: continue
                    p, n, uv, tri = np.concatenate(positions), np.concatenate(normals), np.concatenate(uvs), np.concatenate(triangles)
                    if int(tri.max()) >= len(p): raise ValueError(f'out-of-range model triangle: {path}')
                    # Source front faces are clockwise; confirm winding against authored normals.
                    cross = np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]])
                    if np.sum(cross * n[tri].mean(axis=1)) < 0: tri = tri[:, ::-1]
                    tangent = np.concatenate(tangents).copy()
                    # Source uses S*w, cross(S,N); glTF uses T, cross(N,T)*w.
                    # Convert the basis so native normals also work in glTF / Studio lighting.
                    tangent[:, :3] *= tangent[:, 3:4]
                    tangent[:, 3] *= -1
                    self.meshes.append(ModelMesh(p, n, uv, tri, u32(mdl, mesh_off), bodypart,
                                                 submodel, body_base, count, tangent, np.concatenate(weights), np.concatenate(joints)[:, :3]))

    def selected(self, body: int):
        return [m for m in self.meshes if m.submodel == (body // max(m.body_base, 1)) % m.body_count]

    def material(self, mesh: ModelMesh, skin: int):
        family = self.skins[skin if 0 <= skin < len(self.skins) else 0]
        return self.materials[int(family[mesh.skinref])]
