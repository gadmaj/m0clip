"""Restore Ghost brush entities' directional RGBM6 lightmaps from their BSP samples."""
from source_lightmaps import LightmapAtlas
from source_surface_frames import read_attribute
from import_source_bsp import face_points
import numpy as np


def restore_brush_lightmaps(glb, model):
    faces = []; bindings = {}; bumped = 0
    for node in glb.json['nodes']:
        if not node.get('extras', {}).get('sourceBrush'): continue
        for primitive in glb.json['meshes'][node['mesh']]['primitives']:
            fi = primitive.get('extras', {}).get('sourceBrushFace')
            if not isinstance(fi, int):
                raise ValueError('Brush face references are missing; run refresh_source_surface_frames.py first')
            faces.append(fi)
            material = glb.json['materials'][primitive['material']]
            extra = material['extras']; metadata = extra.get('sourceMaterial', {})
            if isinstance(metadata.get('bumpmapIndex'), int):
                bindings[primitive['material']] = extra['sourceLightmap']
                bumped += 1
    if len(faces) != len(set(faces)): raise ValueError('Unexpected repeated Ghost brush-model faces')
    if not bindings: return dict(faces=0, materials=0, directional_textures=0)
    atlas = LightmapAtlas(model, faces)
    pages = {}; page_bindings = {}
    for node in glb.json['nodes']:
        if not node.get('extras', {}).get('sourceBrush'): continue
        for primitive in glb.json['meshes'][node['mesh']]['primitives']:
            fi = primitive['extras']['sourceBrushFace']; face = model['faces'][fi]
            expected = atlas.uv(model, fi, face_points(model, face)[::-1])
            actual = read_attribute(glb, primitive['attributes']['TEXCOORD_1'], 2)
            if not np.allclose(actual, expected, atol=1e-7, rtol=0):
                raise ValueError(f'Brush lightmap packing differs on Source face {fi}')
            material = glb.json['materials'][primitive['material']]
            flat = material['extras']['sourceLightmap']; page = atlas.faces[fi][0]
            if flat in pages and pages[flat] != page: raise ValueError('Brush atlas page binding is ambiguous')
            pages[flat] = page
            if primitive['material'] in bindings: page_bindings[primitive['material']] = page
    saved = glb.json.setdefault('extras', {}).get('sourceBrushBumpLightmaps')
    if saved is None:
        sampler = dict(wrapS=33071, wrapT=33071, magFilter=9729, minFilter=9729)
        if sampler not in glb.json['samplers']: glb.json['samplers'].append(sampler)
        sampler_index = glb.json['samplers'].index(sampler); saved = [[] for _ in atlas.pages]
        fresh = True
    else:
        fresh = False
        if len(saved) != len(atlas.pages) or any(len(page) != 3 for page in saved):
            raise ValueError('Existing brush directional atlas bindings are invalid')
    for layer in range(1, 4):
        directional = LightmapAtlas(model, faces, layer=layer)
        if directional.faces != atlas.faces: raise ValueError('Directional atlas changed the native UV layout')
        for page, png in enumerate(directional.images()):
            if fresh:
                image = len(glb.json['images']); glb.json['images'].append(dict(bufferView=glb.view(png), mimeType='image/png'))
                texture = len(glb.json['textures']); glb.json['textures'].append(dict(source=image, sampler=sampler_index))
                saved[page].append(texture)
            else:
                image = glb.json['images'][glb.json['textures'][saved[page][layer-1]]['source']]
                view = glb.json['bufferViews'][image['bufferView']];start = view.get('byteOffset', 0)
                if glb.buffer[start:start+view['byteLength']] != png:image['bufferView'] = glb.view(png)
    glb.json['extras']['sourceBrushBumpLightmaps'] = saved
    for index, page in page_bindings.items():
        glb.json['materials'][index]['extras']['sourceBumpLightmaps'] = saved[page]
    return dict(faces=bumped, materials=len(bindings), directional_textures=sum(map(len, saved)), atlas_pages=len(saved))
