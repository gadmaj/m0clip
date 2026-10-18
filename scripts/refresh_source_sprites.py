#!/usr/bin/env python3
"""Refresh Ghost glow tint metadata without touching geometry, images or animation buffers."""
import argparse
import json
from pathlib import Path
import struct
from import_source_bsp import BSP, parse


def refresh(directory, entities):
    path=directory/'props.glb';data=path.read_bytes()
    size=struct.unpack_from('<I',data,12)[0];gltf=json.loads(data[20:20+size])
    sprites=[e for e in entities if e.get('classname') in ('env_sprite','env_glow','env_sprite_clientside')
             and (not e.get('targetname') or int(e.get('spawnflags','0'))&1)]
    nodes=[n for n in gltf['nodes'] if n.get('extras',{}).get('sourceSprite')]
    if len(sprites)!=150 or len(nodes)!=150:raise ValueError('Expected all 150 authored Ghost glow sprites')
    changed=0
    for i,(node,entity) in enumerate(zip(nodes,sprites)):
        if node['name']!=f'sprite:{i}':raise ValueError('Unexpected sprite ordering')
        material=gltf['materials'][gltf['meshes'][node['mesh']]['primitives'][0]['material']]
        if material['name']!=entity['model'].removesuffix('.vmt').removesuffix('.spr').removeprefix('materials/'):
            raise ValueError('Authored sprite material does not match its node')
        rgba=[float(v)/255 for v in entity.get('rendercolor','255 255 255').split()[:3]]+[float(entity.get('renderamt','255'))/255]
        if len(rgba)!=4:raise ValueError('Invalid authored sprite color')
        pbr=material['pbrMetallicRoughness'];changed+=pbr['baseColorFactor']!=rgba;pbr['baseColorFactor']=rgba
    # Preserve the entire original BIN chunk, including every view, index and image byte.
    encoded=json.dumps(gltf,separators=(',',':')).encode();encoded+=b' '*(-len(encoded)%4)
    tail=data[20+size:]
    result=struct.pack('<III',0x46546c67,2,20+len(encoded)+len(tail))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+tail
    temporary=path.with_suffix('.sprites-refresh.glb');temporary.write_bytes(result);temporary.replace(path)
    return dict(sprites=len(nodes),materials_changed=changed,binary_preserved=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--map',choices=['nt_ghost_ctg'],required=True);args=parser.parse_args()
    root=Path(__file__).resolve().parent.parent
    bsp=BSP((root/'assets/bsp-cache'/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    print(json.dumps(refresh(root/'public/assets/maps'/args.map,parse(bsp)['ents']),indent=2))
