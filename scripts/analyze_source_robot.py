#!/usr/bin/env python3
"""Analyze Ghost's original conveyor robot and extract unmodified visual parts.

No network access, skin guessing, mesh cutting or simulation changes. Native MDL/VVD/VTX
and VMT/VTF are required from the existing Source cache. Outputs ignored game assets.
Run: python scripts/analyze_source_robot.py
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
from import_source_bsp import SCALE
from import_source_props import GLB
from source_models import StudioModel
from source_animation import AnimationModel
from source_materials import MaterialExport
from source_assets import VPK

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ('girlbot_body', 'girlbot_head', 'girlbot_leftarm', 'girlbot_rightarm', 'girlbot_full')

class CachedFiles:
    def __init__(self, root): self.root = root
    def read(self, path):
        target = self.root / path
        return target.read_bytes() if target.is_file() else None


def connected_surfaces(mesh):
    """Count real welded islands without mistaking UV/normal seams for boundaries."""
    _, vertex = np.unique(np.round(mesh.positions, 4), axis=0, return_inverse=True)
    parents = np.arange(int(vertex.max()) + 1)
    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    for triangle in vertex[mesh.triangles]:
        for index in triangle[1:]: parents[find(int(index))] = find(int(triangle[0]))
    return len({find(int(index)) for index in vertex})


def extract(cache, output):
    fs = CachedFiles(cache)
    output.mkdir(parents=True, exist_ok=True)
    report = dict(game='NeoTokyo', map='nt_ghost_ctg.bsp', units='metres',
                  source_units_to_metres=SCALE, coordinate_system='Source X-forward, Y-left, Z-up',
                  articulated=False, changes_physics=False, models=[],
                  findings=[
                      'All conveyor girlbot assets have only a static_prop bone; none has a humanoid rig.',
                      'The body and each arm are connected surfaces, not separate hip/knee/elbow parts.',
                      'The independently authored head can replace the R1 visual head without changing physics.',
                      'A full articulated replacement requires authored skin weights and joint alignment; rigid substitution cannot preserve these shapes during R1 motion.',
                      'Other Source-game robots must be inspected individually; this report only proves the Ghost assets.'])
    for name in ASSETS:
        path = f'models/nt/props_tech/{name}.mdl'
        model = StudioModel(fs, path)
        animation = AnimationModel(model.mdl)
        glb = GLB()
        glb.json['asset']['generator'] = 'Original Source robot visual extraction'
        materials = {}
        textures = MaterialExport(glb, fs)
        for material_name in model.materials:
            index = len(glb.json['materials']); materials[material_name] = index
            record = dict(name=material_name, pbrMetallicRoughness=dict(metallicFactor=0, roughnessFactor=.6))
            textures.apply(record, material_name)
            glb.json['materials'].append(record)
        if textures.missing: raise FileNotFoundError('Missing original textures: ' + ', '.join(textures.missing))
        primitives = []
        for mesh in model.selected(0):
            primitives.append(dict(attributes=dict(POSITION=glb.accessor(mesh.positions*SCALE, 'VEC3'),
                NORMAL=glb.accessor(mesh.normals, 'VEC3'), TANGENT=glb.accessor(mesh.tangents, 'VEC4'),
                TEXCOORD_0=glb.accessor(mesh.uv, 'VEC2')),
                indices=glb.accessor(mesh.triangles.ravel(), 'SCALAR', index=True),
                material=materials[model.material(mesh, 0)]))
        glb.node(name, primitives, None, dict(sourceProp=path, sourceGame='NeoTokyo', sourceMap='nt_ghost_ctg.bsp',
                                           sourceRigid=True, originalTriangles=True))
        glb.write(output / f'{name}.glb')
        report['models'].append(dict(id=name, source=path, visual=f'{name}.glb',
            triangles=sum(len(m.triangles) for m in model.selected(0)),
            vertices=sum(len(m.positions) for m in model.selected(0)),
            connected_surfaces=sum(connected_surfaces(m) for m in model.selected(0)),
            bones=[dict(name=b['name'], parent=b['parent']) for b in animation.bones],
            materials=model.materials, sequences=list(animation.sequences),
            bounds_metres=(model.bounds*SCALE).tolist(),
            textures=len(glb.json['textures']), missing_textures=textures.missing))
    placements_path = ROOT/'public/assets/maps/nt_ghost_ctg/props-report.json'
    if placements_path.exists():
        placements = json.loads(placements_path.read_text())['placements']
        paths = {m['source'] for m in report['models']}
        report['placements'] = [p for p in placements if p['model'] in paths]
    (output/'analysis.json').write_text(json.dumps(report, indent=2)+'\n')
    return report

def candidate_headers(output):
    """Optional bounded investigation: fetch three small MDL headers, not VPK archives.

    This proves named skeletons exist, not that their geometry/weights are retargeted.
    The source archive directory is cached by the existing Source importer.
    """
    archive = VPK('https://z.noclip.website/HalfLife2/hl2_misc', str(ROOT/'assets/bsp-cache'))
    result = []
    for path in ('models/dog.mdl', 'models/combine_scanner.mdl', 'models/combine_turrets/floor_turret.mdl'):
        data = archive.read(path)
        if data is None: raise FileNotFoundError(path)
        animation = AnimationModel(data)
        result.append(dict(game='HalfLife2', source=path, header_bytes=len(data),
            bones=[dict(name=b['name'], parent=b['parent']) for b in animation.bones],
            sequences=list(animation.sequences), geometry_downloaded=False,
            assessed='header and native skeleton only'))
    (output/'candidate-robots.json').write_text(json.dumps(result, indent=2)+'\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-headers', action='store_true', help='Inspect small Half-Life 2 robot MDL headers over HTTP')
    parser.add_argument('--cache', type=Path, default=ROOT/'assets/bsp-cache/files')
    parser.add_argument('--output', type=Path, default=ROOT/'public/assets/source-robots/neotokyo-girlbot')
    args = parser.parse_args()
    result = extract(args.cache, args.output)
    if args.candidate_headers: candidate_headers(args.output)
    print(json.dumps({m['id']:dict(triangles=m['triangles'], bones=len(m['bones']),
                                  surfaces=m['connected_surfaces'], textures=m['textures']) for m in result['models']}, indent=2))
