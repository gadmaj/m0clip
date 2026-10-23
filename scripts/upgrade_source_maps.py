#!/usr/bin/env python3
"""Upgrade listed NeoTokyo maps with the verified Source renderer asset pipeline.

Work, original bundles, PNG masters and logs stay outside public. A successful map
is installed into the development tree only after strict asset and pixel checks.
The running stable dist is never modified. Successful maps resume without rework.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import traceback
import numpy as np
from import_source_bsp import BSP, GAMES, MOUNTS, STORAGE
from source_assets import FileSystem, VPK
from import_source_materials import convert as convert_materials
from import_source_props import convert as convert_props
from refresh_source_vtf import refresh as refresh_vtf
from optimize_map_textures import optimize, read_glb

ROOT = Path(__file__).resolve().parent.parent
VERSION = 1


def attribute(document, binary, index):
    a = document['accessors'][index]; v = document['bufferViews'][a['bufferView']]
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}[a['componentType']]
    return np.frombuffer(binary, dtype, a['count']*width, v.get('byteOffset', 0)+a.get('byteOffset', 0)).reshape(-1, width)


def validate(directory, original):
    manifest = json.loads((directory/'manifest.json').read_text())
    for name in manifest['files']:
        if (directory/name).read_bytes() != (original/name).read_bytes():
            raise ValueError(f'Physics asset changed: {name}')
    before, old = read_glb(original/'visual.glb'); world, new = read_glb(directory/'visual.glb')
    old_primitives = before['meshes'][0]['primitives']; new_primitives = world['meshes'][0]['primitives']
    if len(old_primitives) != len(new_primitives): raise ValueError('World primitive inventory changed')
    for a, b in zip(old_primitives, new_primitives, strict=True):
        for key in ('POSITION', 'TEXCOORD_0', 'TEXCOORD_1'):
            if key in a['attributes']:
                if not np.array_equal(attribute(before, old, a['attributes'][key]), attribute(world, new, b['attributes'][key])):
                    raise ValueError(f'World {key} changed during material upgrade')
    counts = {}
    for name in ('visual.glb', 'props.glb'):
        document, binary = read_glb(directory/name)
        for view in document['bufferViews']:
            if view.get('byteOffset', 0)+view['byteLength'] > len(binary): raise ValueError('Truncated buffer view')
        triangles = 0
        for mesh in document['meshes']:
            for primitive in mesh['primitives']:
                indices = attribute(document, binary, primitive['indices'])
                positions = attribute(document, binary, primitive['attributes']['POSITION'])
                if not np.isfinite(positions).all() or indices.size % 3 or (indices.size and int(indices.max()) >= len(positions)):
                    raise ValueError('Invalid mesh positions or triangle indices')
                triangles += indices.size//3
        counts[name] = dict(triangles=triangles, bytes=(directory/name).stat().st_size)
    return counts


def upgrade(map_id, workspace, image_cache, archives, workers):
    public = ROOT/'public/assets/maps'/map_id
    completed = public/'source-upgrade.json'
    if completed.exists() and json.loads(completed.read_text()).get('version') == VERSION:
        return json.loads(completed.read_text())
    original = workspace/'original'/map_id
    if not original.exists():
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(public, original)
    attempt = workspace/'work'/str(time.time_ns())/map_id
    shutil.copytree(original, attempt)
    bsp = BSP((ROOT/'assets/bsp-cache'/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{map_id}.bsp').read_bytes())
    if json.loads((public/'manifest.json').read_text()).get('source_lightmaps', {}).get('hdr'):
        raise ValueError('HDR maps need their post-processing verified before this LDR pipeline')
    loose, _ = MOUNTS['neotokyo']
    fs = FileSystem(bsp.lump(40), f'{STORAGE}/{loose}', archives, str(ROOT/'assets/bsp-cache'))
    fs.source_texture_cache = image_cache.parent/'source-texture-payloads'
    materials = convert_materials(attempt, bsp, fs)
    if materials['missing_effect_textures']: raise ValueError(f'Missing world effect textures: {materials["missing_effect_textures"]}')
    props = convert_props(attempt, bsp, fs, workers)
    for key in ('missing_models', 'missing_textures', 'missing_effect_textures', 'animation_failures'):
        if props[key]: raise ValueError(f'{key}: {props[key]}')
    native = [refresh_vtf(attempt/'visual.glb', fs, bsp), refresh_vtf(attempt/'props.glb', fs, bsp, props['textured'])]
    counts = validate(attempt, original)
    masters = workspace/'masters'/map_id
    masters.parent.mkdir(parents=True, exist_ok=True)
    if masters.exists():
        masters = workspace/'masters'/f'{map_id}-{time.time_ns()}'/map_id
        masters.parent.mkdir(parents=True, exist_ok=True)
    attempt.rename(masters)
    optimized = workspace/'optimized'/map_id
    if optimized.exists():
        optimized = workspace/'optimized'/str(time.time_ns())/map_id
    shutil.copytree(masters, optimized, ignore=shutil.ignore_patterns('visual-base.glb'))
    images = [optimize(optimized/name, image_cache, workers) for name in ('visual.glb', 'props.glb')]
    validate(optimized, original)
    report = dict(version=VERSION, map=map_id, props=props['restored'], models=props['unique_models'],
                  sky_faces=props['sky_faces'], sprites=props['sprites'], details=props['detail_sprites'],
                  brushes=props['brush_entities'], geometry=counts, native=native, optimization=images,
                  original_directory=str(original), png_masters=str(masters), collision_preserved=True)
    (optimized/'source-upgrade.json').write_text(json.dumps(report, indent=2)+'\n')
    # Retain the replaced development tree as well as its initial original copy.
    replaced = workspace/'replaced'/str(time.time_ns())/map_id
    replaced.parent.mkdir(parents=True, exist_ok=True)
    public.rename(replaced)
    try: optimized.rename(public)
    except Exception:
        replaced.rename(public)
        raise
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--maps', nargs='+', choices=GAMES['neotokyo'][2], default=[m for m in GAMES['neotokyo'][2] if m != 'nt_ghost_ctg'])
    parser.add_argument('--workspace', type=Path, default=Path.home()/'.local/state/unitree-renderer/map-expansion')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args(); workspace = args.workspace.resolve(); workspace.mkdir(parents=True, exist_ok=True)
    image_cache = ROOT/'node_modules/.cache/ghost-lossless-textures'; image_cache.mkdir(parents=True, exist_ok=True)
    _, names = MOUNTS['neotokyo']; archives = [VPK(f'{STORAGE}/{name}', str(ROOT/'assets/bsp-cache')) for name in names]
    report_path = workspace/'report.json'
    report = json.loads(report_path.read_text()) if report_path.exists() else dict(version=VERSION, maps={}, failures={})
    for map_id in args.maps:
        print(f'Upgrading {map_id}', flush=True)
        try:
            report['maps'][map_id] = upgrade(map_id, workspace, image_cache, archives, args.workers)
            report['failures'].pop(map_id, None)
            print(f'Installed {map_id}: {report["maps"][map_id]["props"]} props', flush=True)
        except Exception as error:
            report['failures'][map_id] = str(error); traceback.print_exc()
        temporary = report_path.with_suffix('.part'); temporary.write_text(json.dumps(report, indent=2)+'\n'); temporary.replace(report_path)
    if any(map_id in report['failures'] for map_id in args.maps): return 1
    return 0


if __name__ == '__main__': sys.exit(main())
