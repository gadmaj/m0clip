"""Verify Ghost VTF bindings against their retained lossless image and GLB compaction."""
import io
import tempfile
import unittest
import zlib
from pathlib import Path

from PIL import Image
from import_source_props import GLB
from optimize_map_textures import read_glb
from source_assets import decode_vtf

ROOT = Path(__file__).resolve().parent.parent


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


if __name__ == '__main__':
    unittest.main()
