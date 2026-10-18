"""Native Ghost detail images and metadata after material restoration."""
import io
import json
from pathlib import Path
import struct
import unittest

import numpy as np
from PIL import Image
from import_source_bsp import BSP, MOUNTS, STORAGE
from source_assets import FileSystem, VPK, decode_vtf, material_kv

ROOT = Path(__file__).resolve().parent.parent


def read_glb(path):
    data = path.read_bytes()
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+size]), memoryview(data)[28+size:]


class GhostDetailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cache = ROOT/'assets/bsp-cache'
        bsp_path = cache/'z.noclip.website_NeoTokyo_NeotokyoSource_maps_nt_ghost_ctg.bsp'
        if not bsp_path.exists(): raise unittest.SkipTest('Ghost source cache is not installed')
        bsp = BSP(bsp_path.read_bytes())
        loose, archives = MOUNTS['neotokyo']
        cls.fs = FileSystem(bsp.lump(40), f'{STORAGE}/{loose}', [VPK(f'{STORAGE}/{v}', str(cache)) for v in archives], str(cache))

    def test_every_authored_detail_material_and_native_image(self):
        images_checked = set()
        for filename, expected in (('visual', 43), ('props', 3)):
            js, binary = read_glb(ROOT/f'public/assets/maps/nt_ghost_ctg/{filename}.glb')
            restored = set()
            for record in js['materials']:
                _, kv = material_kv(self.fs, record['name'])
                if '$detail' not in kv: continue
                meta = record['extras']['sourceMaterial']
                self.assertEqual(meta['detail'], kv['$detail'])
                self.assertEqual(meta['detailblendmode'], 0)
                self.assertAlmostEqual(meta['detailscale'], float(kv['$detailscale']))
                self.assertAlmostEqual(meta['detailblendfactor'], float(kv['$detailblendfactor']))
                texture = js['textures'][meta['detailIndex']]
                sampler = js['samplers'][texture['sampler']]
                self.assertEqual(sampler['wrapS'], 10497)
                self.assertEqual(sampler['wrapT'], 10497)
                restored.add(record['name'])
                key = (filename, meta['detailIndex'])
                if key in images_checked: continue
                view = js['bufferViews'][js['images'][texture['source']]['bufferView']]
                at = view.get('byteOffset', 0)
                actual = np.asarray(Image.open(io.BytesIO(binary[at:at+view['byteLength']])).convert('RGBA'))
                raw = self.fs.read('materials/'+meta['detail'].replace('\\', '/')+'.vtf')
                np.testing.assert_array_equal(actual, decode_vtf(raw))
                images_checked.add(key)
            self.assertEqual(len(restored), expected)
        self.assertEqual(len(images_checked), 3)  # world noise + metal, prop metal


if __name__ == '__main__': unittest.main()
