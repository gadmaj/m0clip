"""Preserve native Source texture data and material parameters in the Ghost glTF pilot.

Reference: noclip.website SourceEngine/VTF.ts and Materials/Material_Generic.ts (LICENSE.noclip).
"""
from __future__ import annotations
import io
import hashlib
from pathlib import Path
import struct
import tempfile
import zlib
import numpy as np
from PIL import Image
from source_assets import material, decode_vtf


class MaterialExport:
    def __init__(self, glb, fs):
        self.glb, self.fs = glb, fs
        self.textures = {}
        self.missing = []
        self.cubemaps = []
        self.vtf_views = {}
        self.payload_cache = getattr(fs, 'source_texture_cache', None)
        if self.payload_cache: Path(self.payload_cache).mkdir(parents=True, exist_ok=True)

    def cached_payload(self, key, build):
        if not self.payload_cache: return build()
        path = Path(self.payload_cache)/key
        if path.exists(): return path.read_bytes()
        data = build()
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
            temporary = Path(file.name); file.write(data)
        temporary.replace(path)
        return data

    def texture(self, path, frame=0, face=0):
        path = path.replace('\\', '/').lower().strip('/').removesuffix('.vtf').removesuffix('.vmt')
        path = '/'.join(p for p in path.split('/') if p)
        path = path.removeprefix('materials/')
        key = (path, frame, face)
        if key in self.textures: return self.textures[key]
        raw = self.fs.read('materials/' + path + '.vtf')
        if raw is None:
            self.missing.append(path); return None
        digest = hashlib.sha256(raw).hexdigest()
        def png():
            pixels = decode_vtf(raw, frame, face)
            if pixels is None: return b''
            output = io.BytesIO(); Image.fromarray(pixels).save(output, 'PNG', optimize=True)
            return output.getvalue()
        image_bytes = self.cached_payload(f'v1-{digest}-{frame}-{face}.png', png)
        if not image_bytes:
            self.missing.append(path); return None
        js = self.glb.json
        image = len(js['images']); js['images'].append(dict(bufferView=self.glb.view(image_bytes), mimeType='image/png'))
        flags = struct.unpack_from('<I', raw, 20)[0]
        sampler = dict(wrapS=33071 if flags & 4 else 10497, wrapT=33071 if flags & 8 else 10497,
                       magFilter=9728 if flags & 1 else 9729,
                       minFilter=(9728 if flags & 1 else 9729) if flags & 256 else (9984 if flags & 1 else 9987))
        if sampler not in js['samplers']: js['samplers'].append(sampler)
        if path not in self.vtf_views:
            self.vtf_views[path] = self.glb.view(self.cached_payload(f'v1-{digest}.vtf.zlib', lambda: zlib.compress(raw, 9)))
        index = len(js['textures']); js['textures'].append(dict(sampler=js['samplers'].index(sampler), source=image,
            extras=dict(sourceVtf=dict(path=path, bufferView=self.vtf_views[path], frame=frame, face=face, compression='zlib'))))
        self.textures[key] = index
        return index

    def apply(self, record, name):
        meta = material(self.fs, name)
        if not meta: return
        base = self.texture(meta['basetexture'])
        if base is not None:
            previous = record['pbrMetallicRoughness'].get('baseColorTexture', {}).get('index')
            if previous is not None:
                images, textures = self.glb.json['images'], self.glb.json['textures']
                images[textures[previous]['source']] = dict(images[textures[base]['source']])
            record['pbrMetallicRoughness']['baseColorTexture'] = dict(index=base)
        record['pbrMetallicRoughness']['baseColorFactor'] = [*meta['color'], 1]
        record['doubleSided'] = meta['nocull']
        if meta.get('envmap') and meta['envmap'] != 'env_cubemap':
            faces = [self.texture(meta['envmap'], face=i) for i in range(6)]
            if all(i is not None for i in faces): meta['envmapFaces'] = faces
        if meta['alphatest']: record.update(alphaMode='MASK', alphaCutoff=meta['alphatestreference'])
        elif meta['translucent'] or meta['additive']: record.update(alphaMode='BLEND')
        else: record['alphaMode'] = 'OPAQUE'
        if meta.get('detail') and meta['detailblendmode'] != 0:
            raise ValueError(f'Unsupported Source detail blend mode {meta["detailblendmode"]} on {name}')
        extra = record.setdefault('extras', {})
        extra['sourceMaterial'] = meta
        for channel in ('bumpmap', 'envmapmask', 'phongexponenttexture', 'selfillummask', 'basetexture2', 'detail'):
            if channel not in meta: continue
            index = self.texture(meta[channel])
            if index is not None:
                meta[channel + 'Index'] = index
                if channel == 'bumpmap': record['normalTexture'] = dict(index=index)
        if meta.get('animationfps'):
            raw = self.fs.read('materials/' + meta['basetexture'].replace('\\', '/').strip('/').removesuffix('.vtf') + '.vtf')
            # Normalize lookup through texture() too; shipped names may have doubled slashes.
            if raw:
                frames = struct.unpack_from('<H', raw, 24)[0]
                meta['animationFrames'] = [self.texture(meta['basetexture'], i) for i in range(frames)]

    def cubes(self, bsp, map_name):
        for x, y, z, _size in struct.iter_unpack('<iiiI', bsp.lump(42)):
            path = f'maps/{map_name}/c{x}_{y}_{z}'
            faces = [self.texture(path, face=i) for i in range(6)]
            if any(i is None for i in faces): continue
            self.cubemaps.append(dict(position=[x, y, z], faces=faces))

    def nearest_cube(self, point):
        if not self.cubemaps: return None
        return min(self.cubemaps, key=lambda c: float(((np.array(c['position']) - point) ** 2).sum()))['faces']
