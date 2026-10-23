"""Source BSP visibility and per-face index ranges, following noclip.website BSPFile/Main.ts."""
import base64
import struct
import numpy as np
from import_source_bsp import SURF_HIDE, face_points, displacement
from source_models import static_props
from source_triangulation import native_face_triangles


def visible_faces(model):
    world = model['models'][0]
    return [i for i in range(int(world['firstface']), int(world['firstface']+world['numfaces']))
            if model['faces'][i]['texinfo'] >= 0
            and model['texinfo'][model['faces'][i]['texinfo']]['texdata'] >= 0
            and not model['texinfo'][model['faces'][i]['texinfo']]['flags'] & SURF_HIDE
            and not model['texname'](model['texinfo'][model['faces'][i]['texinfo']]['texdata']).lower().startswith('tools/')]


def visibility_data(bsp, model, manifest):
    clusters = [set() for _ in model['faces']]
    leaf_faces = np.frombuffer(bsp.lump(16), '<u2')
    for leaf in model['leafs']:
        if leaf[1] == 65535: continue
        for face in leaf_faces[leaf[9]:leaf[9]+leaf[10]]: clusters[int(face)].add(leaf[1])
    # noclip associates displaced surfaces with all leaves intersecting their displaced bounds.
    def intersect(lo, hi, node):
        if node < 0:
            cluster = model['leafs'][-node-1][1]
            return set() if cluster == 65535 else {cluster}
        n = model['nodes'][node]; plane = model['planes'][n['plane']]
        centre = (lo+hi)*.5; radius = np.abs(plane['n']) @ ((hi-lo)*.5)
        distance = plane['n'] @ centre-plane['d']; result = set()
        if distance+radius >= 0: result.update(intersect(lo, hi, int(n['child'][0])))
        if distance-radius <= 0: result.update(intersect(lo, hi, int(n['child'][1])))
        return result
    for i, face in enumerate(model['faces']):
        if face['disp'] < 0: continue
        points, _ = displacement(model, face); points = points.reshape(-1, 3)
        clusters[i].update(intersect(points.min(0), points.max(0), int(model['models'][0]['head'])))
    nodes = []
    for node in model['nodes']:
        plane = model['planes'][node['plane']]
        nodes.append([*map(float, plane['n']), float(plane['d']), *map(int, node['child'])])
    sky = next((e for e in model['ents'] if e['classname'] == 'sky_camera'), None)
    return dict(version=1, spawn=manifest['spawn_source'], yaw=manifest['spawn_yaw'],
                head=int(model['models'][0]['head']), nodes=nodes,
                leafClusters=[int(leaf[1]) for leaf in model['leafs']],
                faceClusters=[sorted(c) for c in clusters],
                visibility=base64.b64encode(bsp.lump(4)).decode(),
                sky=dict(origin=[float(v) for v in sky['origin'].split()], scale=float(sky['scale'])) if sky else None)


def annotate_world(glb, model, atlas, bsp):
    groups = {}
    for i in visible_faces(model):
        face = model['faces'][i]; info = model['texinfo'][face['texinfo']]
        name = model['texname'](info['texdata']).lower(); page = atlas.faces[i][0]
        if face['disp'] >= 0:
            n = (1 << model['dispinfo'][face['disp']][2])+1
            vertices, count = n*n, 6*(n-1)**2
        else:
            vertices = len(face_points(model, face)); count = 3*(vertices-2)
            if vertices < 3: continue
            if native_face_triangles(bsp, face) is None: continue
        groups.setdefault((name, page), []).append((i, vertices, count))
    for primitive in glb.json['meshes'][0]['primitives']:
        mat = glb.json['materials'][primitive['material']]
        faces = groups[(mat['name'], mat['extras']['sourceLightmap'])]
        if sum(f[1] for f in faces) != glb.json['accessors'][primitive['attributes']['POSITION']]['count']:
            raise ValueError('World vertex ordering differs from Source face ranges')
        if sum(f[2] for f in faces) != glb.json['accessors'][primitive['indices']]['count']:
            raise ValueError('World index ordering differs from Source face ranges')
        ranges = []; offset = 0
        for i, _, count in faces: ranges.append([i, offset, count]); offset += count
        primitive.setdefault('extras', {})['sourceFaceRanges'] = ranges
    from source_overlays import read_overlays
    overlays = {o.id: o for o in read_overlays(bsp.lump(45))}
    for node in glb.json['nodes']:
        if node.get('extras', {}).get('sourceOverlay'):
            node['extras']['sourceVisibilityFaces'] = list(overlays[node['extras']['sourceOverlayId']].faces)


def annotate_props(glb, bsp, model):
    props = static_props(bsp)
    for node in glb.json['nodes']:
        extra = node.get('extras', {}); index = extra.get('sourceStaticIndex')
        if isinstance(index, int):
            extra['sourceVisibilityClusters'] = sorted({model['leafs'][i][1] for i in props[index].leaves
                                                       if model['leafs'][i][1] != 65535})
