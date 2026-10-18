#!/usr/bin/env python3
"""Refresh Ghost's six authored sky UV transforms and inward winding without reconverting props or textures."""
import argparse
import json
from pathlib import Path
import struct
import numpy as np
from import_source_bsp import BSP, MOUNTS, STORAGE
from import_source_props import GLB
from source_assets import FileSystem, VPK, material
from source_extras import sky_face_uvs


def refresh(directory, fs):
    path = directory/'props.glb'
    data = path.read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
    glb = GLB(); glb.json = json.loads(data[20:20+size]); glb.buffer = bytearray(data[28+size:])
    changed = []; faces = 0
    for node in glb.json['nodes']:
        if not node.get('extras', {}).get('sourceSky'): continue
        faces += 1
        for primitive in glb.json['meshes'][node['mesh']]['primitives']:
            name = glb.json['materials'][primitive['material']]['name']
            meta = material(fs, name)
            if meta is None: raise ValueError(f'Missing sky material: {name}')
            transform = meta.get('basetexturetransform', np.eye(3).reshape(-1).tolist())
            uv = sky_face_uvs(transform).astype('<f4')
            accessor = glb.json['accessors'][primitive['attributes']['TEXCOORD_0']]
            view = glb.json['bufferViews'][accessor['bufferView']]
            if accessor['count'] != 4 or accessor['type'] != 'VEC2' or accessor['componentType'] != 5126 or view.get('byteStride', 8) != 8:
                raise ValueError('Unexpected sky UV buffer layout')
            offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
            if accessor.get('byteOffset', 0)+uv.nbytes > view['byteLength']:
                raise ValueError('Truncated sky UV buffer')
            glb.buffer[offset:offset+uv.nbytes] = uv.tobytes()
            if 'min' in accessor: accessor['min'] = uv.min(axis=0).tolist()
            if 'max' in accessor: accessor['max'] = uv.max(axis=0).tolist()
            # Source uses clockwise front faces. glTF/Three use counterclockwise,
            # so the cube must face inward to remain visible from its centre.
            indices = glb.json['accessors'][primitive['indices']]
            index_view = glb.json['bufferViews'][indices['bufferView']]
            if indices['count'] != 6 or indices['componentType'] != 5125:
                raise ValueError('Unexpected sky index buffer layout')
            if indices.get('byteOffset', 0)+24 > index_view['byteLength']:
                raise ValueError('Truncated sky index buffer')
            index_offset = index_view.get('byteOffset', 0) + indices.get('byteOffset', 0)
            glb.buffer[index_offset:index_offset+24] = np.array([0, 2, 1, 0, 3, 2], dtype='<u4').tobytes()
            node['extras']['sourceSkyTextureTransform'] = transform
            if not np.allclose(np.asarray(transform).reshape(3, 3), np.eye(3)): changed.append(name)
    if faces != 6: raise ValueError(f'Expected six Ghost sky faces, found {faces}')
    temporary = path.with_suffix('.sky-refresh.glb')
    glb.write(temporary); temporary.replace(path)
    report_path = directory/'props-report.json'
    report = json.loads(report_path.read_text()); report['sky_transformed_faces'] = len(changed); report['sky_inward_faces'] = faces
    report_path.write_text(json.dumps(report, indent=2))
    return changed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent; cache = root/'assets/bsp-cache'
    bsp = BSP((cache/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    loose, archives = MOUNTS['neotokyo']
    fs = FileSystem(bsp.lump(40), f'{STORAGE}/{loose}', [VPK(f'{STORAGE}/{v}', str(cache)) for v in archives], str(cache))
    print(json.dumps(dict(transformed=refresh(root/'public/assets/maps'/args.map, fs)), indent=2))
