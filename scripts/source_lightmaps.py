"""Source BSP lightmaps, following noclip.website's SourceEngine BSPFile / Materials/Lightmap.

RGBExp32 -> linear light -> RGBM (range 6), bilinear sampling, half-luxel UVs.
Adapted from noclip.website, copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip.
"""
from __future__ import annotations

import io
import json
import struct
import base64
import gzip
from pathlib import Path
import numpy as np
from PIL import Image


def unpack_rgbexp32(samples: np.ndarray) -> np.ndarray:
    samples = np.asarray(samples, dtype=np.uint8)
    exponent = samples[..., 3].view(np.int8).astype(np.float64)
    # noclip calculates RGBExp32 in JS doubles, then accumulates into Float32Array.
    return samples[..., :3].astype(np.float64) * (np.exp2(exponent[..., None]) / 255.0)


def pack_rgbm(rgb: np.ndarray) -> np.ndarray:
    # Preserve JS Number arithmetic through packing; float32 intermediates can
    # move a channel across the Uint8Array truncation boundary by one byte.
    rgb = np.clip(np.asarray(rgb, dtype=np.float64) * (1.0 / 6.0), 0, 1)
    multiplier = np.ceil(np.maximum(rgb.max(axis=-1, keepdims=True), 1e-6) * 255) / 255
    return (np.concatenate([rgb * (1.0 / multiplier), multiplier], axis=-1) * 255).astype(np.uint8)


class LightmapAtlas:
    """Pack visible faces into padded pages; never interpolate between unrelated faces."""
    def __init__(self, m: dict, face_ids: list[int], size: int = 2048, layer: int = 0):
        self.size = size
        self.faces: dict[int, tuple[int, int, int]] = {}
        self.pages: list[np.ndarray] = []
        self.lit_faces = 0
        self.animations = []
        x = y = row_height = 0
        lighting = m['lighting']
        ordered = sorted(face_ids, key=lambda i: int(m['faces'][i]['lm'][3]), reverse=True)
        for fi in ordered:
            f = m['faces'][fi]
            width, height = (f['lm'][2:] + 1).astype(int)
            offset = int(f['lightofs'])
            styles = [int(s) for s in f['styles'] if s != 255]
            has_samples = offset >= 0 and bool(styles) and width > 0 and height > 0
            if not has_samples:
                width = height = 1
            if width + 2 > size or height + 2 > size:
                raise ValueError(f'face {fi}: lightmap {width}x{height} exceeds atlas page')
            if x + width + 2 > size:
                x, y, row_height = 0, y + row_height, 0
            if not self.pages or y + height + 2 > size:
                self.pages.append(np.zeros((size, size, 4), dtype=np.uint8))
                x = y = row_height = 0
            rgb = np.ones((height, width, 3), dtype=np.float32)
            if has_samples:
                # BUMPLIGHT has four consecutive layers per style; layer 0 is flat diffuse.
                layers = 4 if int(m['texinfo'][f['texinfo']]['flags']) & 0x800 else 1
                stride = width * height * layers * 4
                end = offset + stride * len(styles)
                if end > len(lighting):
                    raise ValueError(f'face {fi}: truncated lighting samples')
                rgb.fill(0)
                for j, _style in enumerate(styles):
                    samples = np.frombuffer(lighting, np.uint8, width * height * 4,
                                            offset + stride * j + (layer if layers == 4 else 0) * width * height * 4).reshape(height, width, 4)
                    rgb += unpack_rgbexp32(samples)
                if layer > 0 and layers == 4:
                    accumulated = np.zeros((4, height, width, 3), dtype=np.float32)
                    for j, _style in enumerate(styles):
                        values = np.frombuffer(lighting, np.uint8, width * height * 16,
                            offset + stride * j).reshape(4, height, width, 4)
                        accumulated += unpack_rgbexp32(values)
                    values = accumulated.astype(np.float64)
                    average = (values[1] + values[2] + values[3]) / 3.0
                    ratio = np.divide(values[0], average, out=np.zeros_like(average), where=average != 0)
                    rgb = values[layer] * ratio
                self.lit_faces += 1
            tile = np.pad(pack_rgbm(rgb), ((1, 1), (1, 1), (0, 0)), mode='edge')
            self.pages[-1][y:y + height + 2, x:x + width + 2] = tile
            self.faces[fi] = (len(self.pages) - 1, x + 1, y + 1)
            if has_samples and any(style != 0 for style in styles):
                raw = b''.join(lighting[offset + stride * j:offset + stride * j + width * height * 4]
                               for j in range(len(styles)))
                self.animations.append(dict(page=len(self.pages) - 1, x=int(x) + 1, y=int(y) + 1,
                                            width=int(width), height=int(height), styles=styles,
                                            samples=base64.b64encode(raw).decode('ascii')))
            x += width + 2
            row_height = max(row_height, height + 2)

    def uv(self, m: dict, fi: int, points: np.ndarray, grid_size: int | None = None) -> np.ndarray:
        f = m['faces'][fi]
        _, x, y = self.faces[fi]
        if f['lightofs'] < 0 or not any(s != 255 for s in f['styles']):
            coords = np.zeros((len(points), 2))
        elif grid_size is not None:
            # Displacement UVs follow the undisplaced quad's parameterization, not world position.
            t = np.linspace(0, 1, grid_size)
            xx, yy = np.meshgrid(t, t)
            coords = np.stack([xx.ravel(), yy.ravel()], -1) * f['lm'][2:]
        else:
            mapping = m['texinfo'][f['texinfo']]['vecs'][8:].reshape(2, 4).astype(float)
            coords = points @ mapping[:, :3].T + mapping[:, 3] - f['lm'][:2]
        return (coords + [x + 0.5, y + 0.5]) / self.size

    def images(self) -> list[bytes]:
        images = []
        for page in self.pages:
            buf = io.BytesIO()
            Image.fromarray(page, 'RGBA').save(buf, 'PNG')
            images.append(buf.getvalue())
        return images

    def write_styles(self, directory: str, m: dict):
        directory = Path(directory)
        pages = {}
        for page in sorted({patch['page'] for patch in self.animations}):
            name = f'lightmap_{page}.rgba.gz'
            (directory / name).write_bytes(gzip.compress(self.pages[page].tobytes(), mtime=0))
            pages[page] = name
        patterns = {}
        for entity in m['ents']:
            style = int(entity.get('style', '-1'))
            if entity.get('classname') not in ('light', 'light_spot', 'light_glspot', 'light_environment') or style < 32:
                continue
            patterns[style] = dict(pattern=entity.get('pattern'), default=int(entity.get('defaultstyle', '-1')),
                                   off=bool(int(entity.get('spawnflags', '0')) & 1))
        (directory / 'lightstyles.json').write_text(json.dumps(dict(size=self.size, pages=pages,
                                            patches=self.animations, patterns=patterns), separators=(',', ':')))


def write_ambient(path: str, bsp, m: dict, origin, yaw: float):
    """Keep Source's BSP leaf lookup and ambient cubes for the moving robot.

    Like noclip's WorldLight.ts, cubes use RGBExp32 * 255 and inverse-square interpolation
    inside the containing leaf. Coordinates stay in Source units to preserve that weighting.
    """
    raw = bsp.lump(10)
    version = bsp.lump_version(10)
    size = 56 if version == 0 else 32
    lighting = bsp.lump(55 if m['using_hdr'] else 56) or bsp.lump(56)
    index = bsp.lump(51 if m['using_hdr'] else 52)
    leaves = []
    for i, leaf in enumerate(m['leafs']):
        lo, hi = np.array(leaf[3:6]), np.array(leaf[6:9])
        samples = []
        if version == 0:
            colors = np.frombuffer(raw, np.uint8, 24, i * size + 30).reshape(6, 4)
            samples.append([*((lo + hi) / 2).tolist(), *(unpack_rgbexp32(colors) * 255).ravel().tolist()])
        elif lighting and index:
            count, first = np.frombuffer(index, '<u2', 2, i * 4)
            for j in range(int(count)):
                offset = (int(first) + j) * 28
                colors = np.frombuffer(lighting, np.uint8, 24, offset).reshape(6, 4)
                frac = np.frombuffer(lighting, np.uint8, 3, offset + 24) / 255.0
                samples.append([*(lo + (hi - lo) * frac).tolist(),
                                *(unpack_rgbexp32(colors) * 255).ravel().tolist()])
        elif lighting:
            colors = np.frombuffer(lighting, np.uint8, 24, i * 24).reshape(6, 4)
            samples.append([*((lo + hi) / 2).tolist(), *(unpack_rgbexp32(colors) * 255).ravel().tolist()])
        leaves.append(samples)
    nodes = []
    for node in m['nodes']:
        p = m['planes'][node['plane']]
        nodes.append([*p['n'].tolist(), float(p['d']), *node['child'].tolist()])
    light_lump = 54 if m['using_hdr'] and bsp.lump(54) else 15
    raw_lights = bsp.lump(light_lump)
    lights = []
    light_size = 100 if bsp.lump_version(light_lump) == 1 else 88
    for offset in range(0, len(raw_lights), light_size):
        position, color, normal = np.frombuffer(raw_lights, '<f4', 9, offset).reshape(3, 3)
        extra = 12 if light_size == 100 else 0
        kind, style = struct.unpack_from('<ii', raw_lights, offset + 40 + extra)
        inner, outer, exponent, radius, const, linear, quadratic = struct.unpack_from('<7f', raw_lights, offset + 48 + extra)
        flags = struct.unpack_from('<i', raw_lights, offset + 76 + extra)[0]
        if const == linear == quadratic == 0 and kind in (1, 2):
            quadratic = 1.0
        if radius == 0:
            threshold = 0.015 if light_lump == 54 else 0.03
            strength = float(np.linalg.norm(color)) / threshold
            if quadratic:
                discriminant = linear ** 2 - 4 * quadratic * (const - strength)
                radius = (-linear + np.sqrt(discriminant)) / (2 * quadratic) if discriminant > 0 else 2000.0
            else:
                radius = (strength - const) / linear if linear else 2000.0
        lights.append(dict(pos=position.tolist(), color=color.tolist(), normal=normal.tolist(),
                           kind=kind, style=style, inner=inner, outer=outer, exponent=exponent,
                           radius=float(radius), attenuation=[const, linear, quadratic], flags=flags))
    with open(path, 'w') as fh:
        json.dump(dict(origin=np.asarray(origin).tolist(), yaw=float(yaw),
                       head=int(m['models'][0]['head']), nodes=nodes, leaves=leaves, lights=lights), fh, separators=(',', ':'))
