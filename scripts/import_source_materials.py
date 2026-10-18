#!/usr/bin/env python3
"""Upgrade Ghost's world materials in place, preserving geometry, collision and lightmap UVs.

Run after import_source_bsp.py: python scripts/import_source_materials.py --map nt_ghost_ctg
Only Ghost is enabled while the visual fidelity pilot is reviewed.
"""
import argparse
import json
from pathlib import Path
import shutil
import struct
from import_source_props import GLB, BSP, parse, FileSystem, VPK, MOUNTS, STORAGE
from source_materials import MaterialExport
from source_lightmaps import LightmapAtlas
from source_overlays import export_overlays


def convert(directory, bsp, fs):
    path = directory/'visual.glb'; backup = directory/'visual-base.glb'
    if not backup.exists(): shutil.copyfile(path, backup)
    data = backup.read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
    glb = GLB(); glb.json = json.loads(data[20:20+size]); glb.buffer = bytearray(data[28+size:])
    manifest = json.loads((directory/'manifest.json').read_text())
    exporter = MaterialExport(glb, fs)
    for i, record in enumerate(glb.json['materials']):
        exporter.apply(record, record['name'])
        if i % 50 == 0: print(f'  materials {i+1}/{len(glb.json["materials"])}', flush=True)
    model = parse(bsp)
    # The atlas packing must exactly match the world's original conversion.
    # Existing per-face ordering comes from make_visual; reproduce its visible face list.
    from import_source_bsp import SURF_HIDE
    faces = [fi for fi in range(int(model['models'][0]['firstface']), int(model['models'][0]['firstface'] + model['models'][0]['numfaces']))
        if model['faces'][fi]['texinfo'] >= 0
        and model['texinfo'][model['faces'][fi]['texinfo']]['texdata'] >= 0
        and not (model['texinfo'][model['faces'][fi]['texinfo']]['flags'] & SURF_HIDE)
        and not model['texname'](model['texinfo'][model['faces'][fi]['texinfo']]['texdata']).lower().startswith('tools/')]
    pages = []
    for layer in range(1, 4):
        atlas = LightmapAtlas(model, faces, layer=layer)
        indices = []
        for png in atlas.images():
            glb.json['images'].append(dict(bufferView=glb.view(png), mimeType='image/png'))
            glb.json['textures'].append(dict(sampler=0, source=len(glb.json['images'])-1))
            indices.append(len(glb.json['textures'])-1)
        pages.append(indices)
    # Restore displacement vertex blend alpha for Ghost's two-layer ground material.
    import numpy as np
    packing = LightmapAtlas(model, faces)
    blends = {}
    transition_names = {r['name'] for r in glb.json['materials']
                        if r.get('extras', {}).get('sourceMaterial', {}).get('shader') == 'worldvertextransition'}
    from import_source_bsp import face_points
    for fi in faces:
        face = model['faces'][fi]; ti = model['texinfo'][face['texinfo']]
        name = model['texname'](ti['texdata']).lower()
        if name not in transition_names: continue
        if face['disp'] >= 0:
            _, first, power = model['dispinfo'][face['disp']]
            count = ((1 << power) + 1) ** 2
            alpha = model['dispverts'][first:first+count, 4] / 255
        else: alpha = np.zeros(len(face_points(model, face)))
        blends.setdefault((name, packing.faces[fi][0]), []).append(alpha)
    for mesh in glb.json['meshes']:
        for primitive in mesh['primitives']:
            record = glb.json['materials'][primitive['material']]
            key = (record['name'], record.get('extras', {}).get('sourceLightmap'))
            if key not in blends: continue
            alpha = np.concatenate(blends[key]); count = glb.json['accessors'][primitive['attributes']['POSITION']]['count']
            if len(alpha) != count: raise ValueError('displacement blend vertex order differs from world geometry')
            colors = np.ones((count, 4)); colors[:, 3] = alpha
            primitive['attributes']['COLOR_0'] = glb.accessor(colors, 'VEC4')
    # Original flat atlas textures were inserted first, in page order.
    for record in glb.json['materials']:
        extras = record.get('extras', {}); meta = extras.get('sourceMaterial', {})
        page = extras.get('sourceLightmap')
        if page is not None and meta.get('bumpmapIndex') is not None:
            extras['sourceBumpLightmaps'] = [indices[page] for indices in pages]
    overlays = export_overlays(glb, exporter, bsp, model, packing, manifest)
    for node in glb.json['nodes']:
        node.setdefault('extras', {}).update(sourceOrigin=manifest['spawn_source'], sourceYaw=manifest['spawn_yaw'])
    from source_visibility import annotate_world, visibility_data
    annotate_world(glb, model, packing, bsp)
    from source_surface_frames import SurfaceFrames, apply_world_frames
    surface_frames = apply_world_frames(glb, SurfaceFrames(bsp, model), manifest)
    (directory/'visibility.json').write_text(json.dumps(visibility_data(bsp, model, manifest), separators=(',', ':')))
    manifest['visibility'] = 'visibility.json'
    (directory/'manifest.json').write_text(json.dumps(manifest, indent=2))
    glb.write(path)
    report = dict(materials=len(glb.json['materials']), textures=len(exporter.textures),
                  detail_materials=sum('detailIndex' in r.get('extras', {}).get('sourceMaterial', {}) for r in glb.json['materials']),
                  missing_effect_textures=sorted(set(exporter.missing)), directional_lightmap_layers=3, overlays=overlays,
                  surface_frames=surface_frames)
    (directory/'materials-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent; cache = root/'assets/bsp-cache'
    bsp = BSP((cache/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    loose, archives = MOUNTS['neotokyo']
    fs = FileSystem(bsp.lump(40), f'{STORAGE}/{loose}', [VPK(f'{STORAGE}/{v}', str(cache)) for v in archives], str(cache))
    report = convert(root/'public/assets/maps'/args.map, bsp, fs)
    if report['missing_effect_textures']: raise SystemExit(1)
