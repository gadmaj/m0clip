#!/usr/bin/env python3
"""Ghost-only pilot: restore Source prop models and visible brush entities.

    python scripts/import_source_props.py --map nt_ghost_ctg

Exports props.glb separately from terrain/physics. Physics props are shown at authored placement;
Source gameplay physics, skeletal animation and particle entities are not simulated.
No other map is changed. Source formats / lighting follow noclip.website (LICENSE.noclip).
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import struct
import sys

import numpy as np

from import_source_bsp import BSP, parse, SCALE, STORAGE, MOUNTS, SURF_HIDE, face_points, front_normal, load_textures
from source_assets import FileSystem, VPK, material
from source_models import StudioModel, static_props, entity_props, qangle
from source_lightmaps import LightmapAtlas
from source_materials import MaterialExport
from source_animation import AnimationModel


class PropLighting:
    def __init__(self, data):
        self.data = data
        self.lights = data['lights']
        self.positions = np.array([l['pos'] for l in self.lights])
        self.color = np.array([l['color'] for l in self.lights])
        self.attenuation = np.array([l['attenuation'] for l in self.lights])
        self.kind = np.array([l['kind'] for l in self.lights])
        self.radius = np.array([l['radius'] for l in self.lights])
        self.flags = np.array([l['flags'] for l in self.lights])

    def cache(self, point):
        leaf = self.data['head']
        while leaf >= 0:
            n = self.data['nodes'][leaf]
            leaf = n[4 if np.dot(point, n[:3]) >= n[3] else 5]
        samples = np.array(self.data['leaves'][-leaf - 1])
        cube = np.zeros((6, 3))
        if len(samples):
            weights = 1 / (((samples[:, :3] - point) ** 2).sum(axis=1) + 1)
            cube = (samples[:, 3:].reshape(-1, 6, 3) * weights[:, None, None]).sum(axis=0) / weights.sum()
        delta = self.positions - point
        dist2 = (delta ** 2).sum(axis=1); distance = np.sqrt(dist2)
        a = self.attenuation
        ratio = 1 / np.maximum(a[:, 0] + a[:, 1] * distance + a[:, 2] * dist2, 1e-12)
        ratio[self.kind == 0] = 1 / np.maximum(dist2[self.kind == 0], 1)
        ratio[self.kind == 4] = np.maximum(0, a[self.kind == 4, 1] - distance[self.kind == 4])
        ratio[(self.radius > 0) & (dist2 > self.radius ** 2)] = 0
        ratio[self.kind == 3] = 0.1
        ratio[self.kind == 5] = 0
        if len(samples): ratio[(self.flags & 1) != 0] = 0
        strengths = ratio * (self.color @ [.299, .587, .114])
        selected = []
        for i in np.flatnonzero(strengths > 0):
            slot = next((j for j, old in enumerate(selected) if strengths[i] > strengths[old]), len(selected))
            if slot == 4: continue
            if len(selected) == 4:
                old = selected.pop()
                l = self.lights[old]
                direction = delta[old] / max(distance[old], 1e-12)
                angle = -np.dot(direction, l['normal'])
                angular = max(0, angle) if l['kind'] in (0, 3) else 1
                if l['kind'] == 2:
                    angular = 0 if angle <= l['outer'] else 1 if angle >= l['inner'] \
                        else ((angle - l['outer']) / (l['inner'] - l['outer'])) ** l['exponent']
                for axis in range(6):
                    cube[axis] += self.color[old] * ratio[old] * angular * max(0, direction[axis//2] * (-1 if axis%2 else 1))
            selected.insert(slot, i)
        return cube, [self.lights[i] for i in selected]

    def shade(self, positions, normals, cache, half_lambert=False):
        cube, lights = cache
        axes = np.arange(3)[None, :] * 2 + (normals < 0)
        result = ((normals ** 2)[..., None] * cube[axes]).sum(axis=1)
        for l in lights:
            delta = np.asarray(l['pos']) - positions
            distance = np.linalg.norm(delta, axis=1)
            if l['kind'] == 3:
                direction = -np.broadcast_to(l['normal'], normals.shape)
                attenuation = np.ones(len(positions))
            else:
                direction = delta / np.maximum(distance[:, None], 1e-12)
                coeff = [0, 0, 1] if l['kind'] == 0 else l['attenuation']
                attenuation = 1 / np.maximum(coeff[0] + distance * coeff[1] + distance ** 2 * coeff[2], 1e-12)
                if l['kind'] in (0, 2):
                    exponent = 0 if l['kind'] == 0 else l['exponent']
                    inner, outer = (0, 0) if l['kind'] == 0 else (l['inner'], l['outer'])
                    angle = -(direction @ l['normal'])
                    t = np.maximum((angle - outer) / (inner - outer), .01) if inner != outer else np.where(angle >= outer, 1.0, .01)
                    attenuation *= np.clip(t ** exponent, 0, 1)
            diffuse = (direction * normals).sum(axis=1)
            diffuse = (diffuse * .5 + .5) ** 2 if half_lambert else np.maximum(0, diffuse)
            result += np.asarray(l['color'])[None, :] * (attenuation * diffuse)[:, None]
        return np.clip(result / 6, 0, 1).astype(np.float32)


class GLB:
    """Shared model geometry / textures; per-placement lighting only duplicates color attributes."""
    def __init__(self):
        self.buffer = bytearray()
        self.json = dict(asset={'version': '2.0', 'generator': 'Ghost Source props pilot'},
                         scene=0, scenes=[{'nodes': []}], nodes=[], meshes=[], materials=[], accessors=[],
                         bufferViews=[], buffers=[], images=[], textures=[],
                         samplers=[{'wrapS': 10497, 'wrapT': 10497, 'magFilter': 9729, 'minFilter': 9987}])

    def view(self, data, target=None):
        self.buffer.extend(b'\0' * (-len(self.buffer) % 4))
        record = dict(buffer=0, byteOffset=len(self.buffer), byteLength=len(data))
        if target: record['target'] = target
        self.buffer.extend(data); self.json['bufferViews'].append(record)
        return len(self.json['bufferViews']) - 1

    def accessor(self, array, kind, index=False, joints=False):
        dtype = np.uint16 if joints else np.uint32 if index else np.float32
        array = np.asarray(array, dtype=dtype)
        record = dict(bufferView=self.view(array.tobytes(), 34963 if index else 34962),
                      componentType=5123 if joints else 5125 if index else 5126, count=len(array), type=kind)
        if kind == 'VEC3': record.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        self.json['accessors'].append(record)
        return len(self.json['accessors']) - 1

    def materials(self, names, textures, metadata):
        result = {}
        for name in names:
            record = dict(name=name, pbrMetallicRoughness={'metallicFactor': 0, 'roughnessFactor': .85},
                          extras={'sourceVertexLighting': 6})
            meta = metadata.get(name) or {}
            record['extras'].update(sourceSelfIllum=meta.get('selfillum', False),
                                   sourceUnlit=meta.get('unlit', False), sourceSelfIllumTint=meta.get('selfillumtint', [1, 1, 1]))
            if name in textures:
                data, mime, mode = textures[name]
                self.json['images'].append(dict(bufferView=self.view(data), mimeType=mime))
                self.json['textures'].append(dict(sampler=0, source=len(self.json['images']) - 1))
                record['pbrMetallicRoughness']['baseColorTexture'] = {'index': len(self.json['textures']) - 1}
                if mode != 'OPAQUE':
                    record.update(alphaMode=mode, doubleSided=True)
                    if mode == 'MASK': record['alphaCutoff'] = .5
            else:
                record['pbrMetallicRoughness']['baseColorFactor'] = [.5, .5, .5, 1]
            result[name] = len(self.json['materials']); self.json['materials'].append(record)
        return result

    def node(self, name, primitives, matrix, extras):
        mesh = len(self.json['meshes']); self.json['meshes'].append(dict(name=name, primitives=primitives))
        node = dict(name=name, mesh=mesh, extras=extras)
        if matrix is not None: node['matrix'] = matrix.T.ravel().tolist()
        self.json['scenes'][0]['nodes'].append(len(self.json['nodes'])); self.json['nodes'].append(node)
        return len(self.json['nodes']) - 1

    def skin(self, node_index, animation_model, clip):
        from import_source_bsp import SCALE
        root = self.json['nodes'][node_index]
        mesh = root.pop('mesh')
        mesh_node = len(self.json['nodes'])
        self.json['nodes'].append(dict(name=root['name'] + ':mesh', mesh=mesh))
        root['children'] = [mesh_node]
        bone_indices = []
        for i, bone in enumerate(animation_model.bones):
            bone_indices.append(len(self.json['nodes']))
            self.json['nodes'].append(dict(name=f"{root['name']}:{bone['name']}",
                translation=(bone['pos']*SCALE).tolist(), rotation=bone['quat'].tolist()))
            parent = bone_indices[bone['parent']] if bone['parent'] >= 0 else node_index
            self.json['nodes'][parent].setdefault('children', []).append(bone_indices[-1])
        inverse = np.array([b['inverse'].copy() for b in animation_model.bones])
        inverse[:, :3, 3] *= SCALE
        inverse_index = self.accessor(inverse.transpose(0, 2, 1).reshape(-1, 16), 'MAT4')
        self.json.setdefault('skins', []).append(dict(joints=bone_indices, inverseBindMatrices=inverse_index))
        self.json['nodes'][mesh_node]['skin'] = len(self.json['skins']) - 1
        times = self.accessor(clip['times'], 'SCALAR')
        self.json['accessors'][times].update(min=[0], max=[float(clip['times'][-1])])
        anim = dict(name=root['name'] + ':animation', samplers=[], channels=[], extras=dict(loop=clip['loop']))
        for i, index in enumerate(bone_indices):
            for kind, values, typ in [('translation', clip['positions'][:, i]*SCALE, 'VEC3'),
                                      ('rotation', clip['quaternions'][:, i], 'VEC4')]:
                output = self.accessor(values, typ)
                sampler = len(anim['samplers'])
                anim['samplers'].append(dict(input=times, output=output, interpolation='LINEAR'))
                anim['channels'].append(dict(sampler=sampler, target=dict(node=index, path=kind)))
        self.json.setdefault('animations', []).append(anim)

    def write(self, path):
        # Replaced texture payloads must not inflate the final download.
        referenced = {a['bufferView'] for a in self.json['accessors'] if 'bufferView' in a}
        referenced.update(i['bufferView'] for i in self.json['images'] if 'bufferView' in i)
        native = [texture['extras']['sourceVtf'] for texture in self.json['textures'] if texture.get('extras', {}).get('sourceVtf')]
        referenced.update(texture['bufferView'] for texture in native)
        compact = bytearray(); views = []; remap = {}
        for index in sorted(referenced):
            old = self.json['bufferViews'][index]
            compact.extend(b'\0' * (-len(compact) % 4))
            remap[index] = len(views)
            views.append({**old, 'byteOffset': len(compact)})
            compact.extend(self.buffer[old.get('byteOffset', 0):old.get('byteOffset', 0) + old['byteLength']])
        for item in self.json['accessors'] + self.json['images'] + native:
            if 'bufferView' in item: item['bufferView'] = remap[item['bufferView']]
        self.buffer = compact; self.json['bufferViews'] = views
        self.buffer.extend(b'\0' * (-len(self.buffer) % 4))
        self.json['buffers'] = [dict(byteLength=len(self.buffer))]
        js = json.dumps(self.json, separators=(',', ':')).encode(); js += b' ' * (-len(js) % 4)
        output = struct.pack('<III', 0x46546c67, 2, 28 + len(js) + len(self.buffer))
        output += struct.pack('<II', len(js), 0x4e4f534a) + js
        output += struct.pack('<II', len(self.buffer), 0x004e4942) + self.buffer
        temp = Path(str(path) + '.part'); temp.write_bytes(output); temp.replace(path)


def convert(map_dir: Path, bsp, fs, workers=8):
    m = parse(bsp); manifest = json.loads((map_dir/'manifest.json').read_text())
    props = static_props(bsp) + entity_props(m)
    paths = sorted({p.model for p in props})
    models, failures = {}, {}
    def load(path):
        try: return path, StudioModel(fs, path), None
        except Exception as e: return path, None, str(e)
    with ThreadPoolExecutor(workers) as executor:
        for i, (path, model, error) in enumerate(executor.map(load, paths)):
            if error: failures[path] = error
            else: models[path] = model
            if i % 20 == 0: print(f'  models {i+1}/{len(paths)}', file=sys.stderr, flush=True)
    material_names = sorted({model.material(mesh, p.skin) for p in props if (model := models.get(p.model))
                             for mesh in model.selected(p.body)})
    brush_entities = [e for e in m['ents'] if e.get('model', '').startswith('*')
                      and e['classname'] in ('func_illusionary', 'func_brush', 'func_wall', 'func_detail')]
    brush_faces = []
    for e in brush_entities:
        model = m['models'][int(e['model'][1:])]
        for fi in range(model['firstface'], model['firstface'] + model['numfaces']):
            f = m['faces'][fi]
            if f['texinfo'] < 0: continue
            ti = m['texinfo'][f['texinfo']]
            if ti['texdata'] < 0 or ti['flags'] & SURF_HIDE: continue
            name = m['texname'](ti['texdata']).lower()
            if name.startswith('tools/'): continue
            brush_faces.append(fi); material_names.append(name)
    material_names = sorted(set(material_names))
    print(f'  textures for {len(material_names)} materials', file=sys.stderr, flush=True)
    textures = load_textures(fs, material_names)
    metadata = {name: material(fs, name) for name in material_names}
    glb = GLB(); materials = glb.materials(material_names, textures, metadata)
    full_materials = MaterialExport(glb, fs)
    full_materials.cubes(bsp, map_dir.name)
    for name, index in materials.items(): full_materials.apply(glb.json['materials'][index], name)
    origin = np.asarray(manifest['spawn_source']); rotation = qangle([0, -manifest['spawn_yaw'], 0])
    lighting = PropLighting(json.loads((map_dir/'lighting.json').read_text()))
    attributes = {}; restored = []; triangles = 0
    animation_cache = {}; animation_failures = {}
    for i, prop in enumerate(props):
        model = models.get(prop.model)
        if not model: continue
        animation = None
        if prop.animation:
            key = (prop.model, prop.animation)
            if key not in animation_cache:
                try:
                    animation_model = AnimationModel(model.mdl)
                    animation_cache[key] = (animation_model, animation_model.sample(prop.animation))
                except Exception as error:
                    animation_failures[prop.model] = str(error); animation_cache[key] = None
            animation = animation_cache[key]
        r = qangle(prop.angles)
        light_origin = prop.lighting_origin if prop.lighting_origin is not None else prop.origin + r @ (model.illumination * prop.scale)
        cache = lighting.cache(light_origin)
        transform = np.eye(4); transform[:3, :3] = rotation @ r * prop.scale
        transform[:3, 3] = rotation @ (prop.origin - origin) * SCALE
        primitives = []
        for j, mesh in enumerate(model.selected(prop.body)):
            key = (prop.model, mesh.bodypart, mesh.submodel, j, bool(animation))
            if key not in attributes:
                attributes[key] = dict(POSITION=glb.accessor(mesh.positions * SCALE, 'VEC3'),
                                       NORMAL=glb.accessor(mesh.normals, 'VEC3'), TANGENT=glb.accessor(mesh.tangents, 'VEC4'), TEXCOORD_0=glb.accessor(mesh.uv, 'VEC2'))
                attributes[key]['indices'] = glb.accessor(mesh.triangles.ravel(), 'SCALAR', index=True)
                if animation:
                    weights = mesh.weights / np.maximum(mesh.weights.sum(axis=1, keepdims=True), 1e-12)
                    joints = np.column_stack([mesh.joints, np.zeros(len(mesh.joints))])
                    attributes[key]['JOINTS_0'] = glb.accessor(joints, 'VEC4', joints=True)
                    attributes[key]['WEIGHTS_0'] = glb.accessor(weights, 'VEC4')
            attr = attributes[key]
            name = model.material(mesh, prop.skin)
            color = lighting.shade(mesh.positions @ r.T * prop.scale + prop.origin, mesh.normals @ r.T, cache,
                                   half_lambert=bool((metadata.get(name) or {}).get('halflambert')))
            primitives.append(dict(attributes={**{k:v for k,v in attr.items() if k != 'indices'},
                                               'COLOR_0': glb.accessor(color, 'VEC3')},
                                   indices=attr['indices'], material=materials[model.material(mesh, prop.skin)]))
            triangles += len(mesh.triangles)
        if not primitives: continue
        extras = dict(sourceProp=prop.model, sourceClass=prop.classname, sourceStaticIndex=prop.static_index,
                      castShadow=prop.cast_shadow, skin=prop.skin, body=prop.body, solid=prop.solid,
                      sourceLighting=dict(cube=cache[0].tolist(), lights=cache[1]),
                      sourceCubeFaces=full_materials.nearest_cube(light_origin), sourceOrigin=origin.tolist(),
                      sourceYaw=manifest['spawn_yaw'])
        node = glb.node(f'{prop.classname}:{i}:{Path(prop.model).stem}', primitives, transform, extras)
        if animation: glb.skin(node, *animation)
        restored.append(dict(index=i, model=prop.model, classname=prop.classname,
                             position=transform[:3, 3].tolist(), source_origin=prop.origin.tolist()))
        if i % 250 == 0: print(f'  props {i+1}/{len(props)}', file=sys.stderr, flush=True)
    brush_count = brush_triangles = 0
    if brush_faces:
        atlas = LightmapAtlas(m, brush_faces)
        atlas_indices = []
        for png in atlas.images():
            glb.json['images'].append(dict(bufferView=glb.view(png), mimeType='image/png'))
            glb.json['textures'].append(dict(sampler=0, source=len(glb.json['images']) - 1))
            atlas_indices.append(len(glb.json['textures']) - 1)
        brush_materials = {}
        for entity in brush_entities:
            model = m['models'][int(entity['model'][1:])]
            pos = np.array([float(v) for v in entity.get('origin', '0 0 0').split()])
            r = qangle([float(v) for v in entity.get('angles', '0 0 0').split()])
            primitives = []
            for fi in range(model['firstface'], model['firstface'] + model['numfaces']):
                if fi not in atlas.faces: continue
                face = m['faces'][fi]; ti = m['texinfo'][face['texinfo']]; td = m['texdata'][ti['texdata']]
                name = m['texname'](ti['texdata']).lower(); page = atlas.faces[fi][0]
                pts = face_points(m, face)[::-1]; count = len(pts)
                if count < 3: continue
                key = (name, page)
                if key not in brush_materials:
                    record = dict(glb.json['materials'][materials[name]])
                    record['extras'] = {**record['extras'], 'sourceLightmap': atlas_indices[page], 'sourcePropBrush': True}
                    record['extras'].pop('sourceVertexLighting', None)
                    brush_materials[key] = len(glb.json['materials']); glb.json['materials'].append(record)
                vec = ti['vecs'][:8].reshape(2, 4).astype(float)
                uv = (pts @ vec[:, :3].T + vec[:, 3]) / np.maximum(td['w'][:2], 1)
                positions = ((pts @ r.T + pos - origin) @ rotation.T) * SCALE
                normal = rotation @ r @ front_normal(face_points(m, face))
                tri = np.stack([np.zeros(count - 2, int), np.arange(1, count - 1), np.arange(2, count)], 1)
                primitives.append(dict(attributes=dict(POSITION=glb.accessor(positions, 'VEC3'),
                    NORMAL=glb.accessor(np.broadcast_to(normal, positions.shape), 'VEC3'),
                    TEXCOORD_0=glb.accessor(uv, 'VEC2'), TEXCOORD_1=glb.accessor(atlas.uv(m, fi, pts), 'VEC2')),
                    indices=glb.accessor(tri.ravel(), 'SCALAR', index=True), material=brush_materials[key]))
                brush_triangles += len(tri)
            if primitives:
                glb.node(f"{entity['classname']}:{entity['model']}", primitives, None,
                         dict(sourceBrush=entity['model'], sourceClass=entity['classname']))
                brush_count += 1
    from source_extras import export_extras, export_details
    extras_report = export_extras(glb, full_materials, m, rotation, origin)
    extras_report['detail_sprites'] = export_details(glb, full_materials, bsp, m, rotation, origin)
    report = dict(**extras_report, requested=len(props), restored=len(restored), static=sum(p['classname']=='prop_static' for p in restored),
                  entities=sum(p['classname']!='prop_static' for p in restored), unique_models=len(models),
                  triangles=triangles, materials=len(material_names), textured=len(textures),
                  detail_materials=sum('detailIndex' in r.get('extras', {}).get('sourceMaterial', {}) for r in glb.json['materials']),
                  missing_models=failures, missing_textures=[n for n in material_names if n not in textures],
                  placements=restored, material_effect_textures=len(full_materials.textures), missing_effect_textures=sorted(set(full_materials.missing)), brush_entities=brush_count, brush_triangles=brush_triangles,
                  visual_only=True, skeletal_animation=bool(glb.json.get('animations')),
                  animated_props=len(glb.json.get('animations', [])), animation_failures=animation_failures)
    from source_visibility import annotate_props
    annotate_props(glb, bsp, m)
    from source_surface_frames import SurfaceFrames, apply_brush_frames
    report['surface_frames'] = apply_brush_frames(glb, SurfaceFrames(bsp, m), manifest)
    from source_brush_lightmaps import restore_brush_lightmaps
    report['brush_lightmaps'] = restore_brush_lightmaps(glb, m)
    glb.write(map_dir/'props.glb')
    (map_dir/'props-report.json').write_text(json.dumps(report, indent=1))
    manifest['props'] = {k:v for k,v in report.items() if k != 'placements'}
    manifest['props']['visual'] = 'props.glb'
    (map_dir/'manifest.json').write_text(json.dumps(manifest, indent=1))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True, help='Ghost pilot only; other maps await approval')
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    cache = root/'assets'/'bsp-cache'; directory = root/'public'/'assets'/'maps'/args.map
    bsp = BSP((cache/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    loose, archives = MOUNTS['neotokyo']
    fs = FileSystem(bsp.lump(40), f'{STORAGE}/{loose}', [VPK(f'{STORAGE}/{v}', str(cache)) for v in archives], str(cache))
    report = convert(directory, bsp, fs, args.workers)
    print(json.dumps({k:v for k,v in report.items() if k != 'placements'}, indent=1))
    if report['missing_models'] or report['missing_textures']: sys.exit(1)


if __name__ == '__main__': main()
