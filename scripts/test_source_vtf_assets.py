"""Verify Ghost VTF bindings against their retained lossless image and GLB compaction."""
import io
import tempfile
import unittest
import struct
import zlib
from pathlib import Path

from PIL import Image
from import_source_props import GLB
from optimize_map_textures import read_glb, write_glb
from source_assets import decode_vtf
from build_native_map_visuals import build_variant, EXTENSION

ROOT = Path(__file__).resolve().parent.parent

def native_variant_fixture(directory, shared=False):
    rgba = bytes([19, 37, 73, 0, 51, 91, 127, 64, 151, 181, 211, 128, 231, 241, 251, 255])
    header = bytearray(80)
    header[:4] = b'VTF\0'
    struct.pack_into('<IIIHHIH', header, 4, 7, 2, 80, 2, 2, 4 | 8, 1)
    struct.pack_into('<I', header, 52, 0)
    header[56] = 1
    struct.pack_into('<I', header, 57, 0xffffffff)
    struct.pack_into('<H', header, 65, 1)
    output = io.BytesIO()
    Image.frombytes('RGBA', (2, 2), rgba).save(output, 'PNG')
    other = io.BytesIO()
    Image.new('RGBA', (2, 2), (48, 96, 144, 255)).save(other, 'PNG')
    positions = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0)
    uvs = struct.pack('<6f', 0, 0, 1, 0, 0, 1)
    payloads = [positions, output.getvalue(), zlib.compress(bytes(header) + rgba), other.getvalue(), uvs]
    binary, views = bytearray(), []
    for payload in payloads:
        binary.extend(bytes(-len(binary) % 4))
        views.append(dict(buffer=0, byteOffset=len(binary), byteLength=len(payload)))
        binary.extend(payload)
    textures = [dict(source=0, extras=dict(sourceVtf=dict(bufferView=2, frame=0, face=0, path='fixture/native', compression='zlib'))), dict(source=1)]
    if shared:
        textures.append(dict(source=0))
    material = dict(pbrMetallicRoughness=dict(baseColorTexture=dict(index=0)), emissiveTexture=dict(index=1))
    if shared:
        material['normalTexture'] = dict(index=2)
    document = dict(asset=dict(version='2.0'), bufferViews=views,
                    images=[dict(bufferView=1, mimeType='image/png'), dict(bufferView=3, mimeType='image/png')],
                    textures=textures, materials=[material],
                    accessors=[dict(bufferView=0, componentType=5126, count=3, type='VEC3', min=[0, 0, 0], max=[1, 1, 0]),
                               dict(bufferView=4, componentType=5126, count=3, type='VEC2')],
                    meshes=[dict(primitives=[dict(attributes=dict(POSITION=0, TEXCOORD_0=1), material=0)])],
                    nodes=[dict(mesh=0)], scenes=[dict(nodes=[0])], scene=0)
    source = directory / 'visual.glb'
    write_glb(source, document, binary)
    return source, rgba, positions, uvs


def image_pixels(document, binary, texture_index):
    texture = document['textures'][texture_index]
    index = texture.get('extensions', {}).get('EXT_texture_webp', {}).get('source', texture.get('source'))
    image = document['images'][index]
    view = document['bufferViews'][image['bufferView']]
    start = view.get('byteOffset', 0)
    with Image.open(io.BytesIO(binary[start:start + view['byteLength']])) as encoded:
        return encoded.convert('RGBA').tobytes()


class NativeTextureAssets(unittest.TestCase):
    def test_ghost_bindings_retain_original_pixels_and_share_payloads(self):
        expected = {'visual.glb': (449, 259, 3528), 'props.glb': (612, 383, 5213)}
        for name, counts in expected.items():
            document, binary = read_glb(ROOT/'public/assets/maps/nt_ghost_ctg'/name)
            payloads, paths, seen, levels = {}, {}, 0, 0
            def data(index):
                view = document['bufferViews'][index]
                at = view.get('byteOffset', 0)
                self.assertLessEqual(at + view['byteLength'], len(binary))
                return binary[at:at + view['byteLength']]
            for texture in document['textures']:
                native = texture.get('extras', {}).get('sourceVtf')
                if not native:
                    continue
                self.assertEqual(native['compression'], 'zlib')
                index = native['bufferView']
                if index not in payloads:
                    payloads[index] = zlib.decompress(data(index))
                if native['path'] in paths:
                    self.assertEqual(paths[native['path']], index)
                paths[native['path']] = index
                raw = payloads[index]
                self.assertEqual(raw[:4], b'VTF\0')
                pixels = decode_vtf(raw, native['frame'], native['face'])
                image = document['images'][texture['source']]
                original = Image.open(io.BytesIO(data(image['bufferView']))).convert('RGBA')
                self.assertEqual(original.size, (pixels.shape[1], pixels.shape[0]), native['path'])
                self.assertEqual(original.tobytes(), pixels.tobytes(), native['path'])
                levels += raw[56]
                seen += 1
            self.assertEqual((seen, len(payloads), levels), counts)

    def test_compaction_remaps_native_payloads_and_shared_faces(self):
        glb = GLB()
        glb.view(b'unused')
        image = glb.view(b'image')
        glb.view(b'also unused')
        payload = glb.view(b'native VTF mip data')
        glb.json['images'] = [dict(bufferView=image, mimeType='image/png')]
        glb.json['textures'] = [dict(source=0, extras=dict(sourceVtf=dict(bufferView=payload, face=face))) for face in range(6)]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/'fixture.glb'
            glb.write(output)
            document, binary = read_glb(output)
        self.assertEqual(len(document['bufferViews']), 2)
        self.assertEqual(document['images'][0]['bufferView'], 0)
        for texture in document['textures']:
            self.assertEqual(texture['extras']['sourceVtf']['bufferView'], 1)
        view = document['bufferViews'][1]
        self.assertEqual(binary[view['byteOffset']:view['byteOffset']+view['byteLength']], b'native VTF mip data')

    def test_native_variant_preserves_export_pixels_and_geometry_references(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, rgba, positions, uvs = native_variant_fixture(directory)
            original = source.read_bytes()
            cache = directory / 'cache'
            cache.mkdir()
            target = directory / 'visual-native.glb'
            build_variant(source, target, cache)
            document, binary = read_glb(target)
            meta = document['textures'][0]['extensions'][EXTENSION]
            view = document['bufferViews'][meta['bufferView']]
            start = view.get('byteOffset', 0)
            native = zlib.decompress(binary[start:start + view['byteLength']])
            self.assertEqual(decode_vtf(native, meta['frame'], meta['face']).tobytes(), rgba)
            for accessor, expected in zip(document['accessors'], (positions, uvs)):
                view = document['bufferViews'][accessor['bufferView']]
                start = view.get('byteOffset', 0)
                self.assertEqual(binary[start:start + view['byteLength']], expected)
            self.assertEqual(image_pixels(document, binary, 1), bytes([48, 96, 144, 255]) * 4)
            self.assertEqual(source.read_bytes(), original)

    def test_native_variant_retains_preview_shared_by_an_ordinary_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, rgba, _, _ = native_variant_fixture(directory, shared=True)
            cache = directory / 'cache'
            cache.mkdir()
            target = directory / 'visual-native.glb'
            build_variant(source, target, cache)
            document, binary = read_glb(target)
            normal_index = document['materials'][0]['normalTexture']['index']
            self.assertEqual(image_pixels(document, binary, normal_index), rgba)

    def test_native_variant_rejects_preview_pixel_changes_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, _, _, _ = native_variant_fixture(directory)
            document, binary = read_glb(source)
            meta = document['textures'][0]['extras']['sourceVtf']
            view = document['bufferViews'][meta['bufferView']]
            start = view.get('byteOffset', 0)
            changed = bytearray(zlib.decompress(binary[start:start + view['byteLength']]))
            changed[-1] ^= 1
            replacement = zlib.compress(changed)
            document['bufferViews'].append(dict(buffer=0, byteOffset=len(binary), byteLength=len(replacement)))
            meta['bufferView'] = len(document['bufferViews']) - 1
            write_glb(source, document, binary + replacement)
            original = source.read_bytes()
            cache = directory / 'cache'
            cache.mkdir()
            target = directory / 'visual-native.glb'
            with self.assertRaises(ValueError):
                build_variant(source, target, cache)
            self.assertFalse(target.exists())
            self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
