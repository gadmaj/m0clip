#!/usr/bin/env python3
"""Add native visibility and 3D sky camera metadata to existing Ghost assets, preserving buffers."""
import argparse
import json
from pathlib import Path
import struct
from import_source_bsp import BSP, parse
from import_source_props import GLB
from source_lightmaps import LightmapAtlas
from source_visibility import visibility_data, annotate_world, annotate_props, visible_faces


def load(path):
    data = path.read_bytes(); n = struct.unpack_from('<I', data, 12)[0]
    glb = GLB(); glb.json = json.loads(data[20:20+n]); glb.buffer = bytearray(data[28+n:])
    return glb


def convert(directory, bsp):
    model = parse(bsp); manifest = json.loads((directory/'manifest.json').read_text())
    data = visibility_data(bsp, model, manifest)
    atlas = LightmapAtlas(model, visible_faces(model))
    world = load(directory/'visual.glb'); annotate_world(world, model, atlas, bsp)
    props = load(directory/'props.glb'); annotate_props(props, bsp, model)
    for name, glb in (('visual', world), ('props', props)):
        temporary = directory/(name+'.visibility-new.glb')
        glb.write(temporary); temporary.replace(directory/(name+'.glb'))
    (directory/'visibility.json').write_text(json.dumps(data, separators=(',', ':')))
    manifest['visibility'] = 'visibility.json'
    (directory/'manifest.json').write_text(json.dumps(manifest, indent=2))
    return dict(face_ranges=sum(len(p['extras']['sourceFaceRanges']) for p in world.json['meshes'][0]['primitives']),
                static_props=sum('sourceVisibilityClusters' in n.get('extras', {}) for n in props.json['nodes']),
                sky=data['sky'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True)
    args = parser.parse_args(); root = Path(__file__).resolve().parent.parent
    path = root/f'assets/bsp-cache/z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp'
    print(json.dumps(convert(root/'public/assets/maps'/args.map, BSP(path.read_bytes())), indent=2))
