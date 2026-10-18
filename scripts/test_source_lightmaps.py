"""Numerical checks against Source's RGBExp32 format and face/lightmap layout."""
import unittest
import tempfile
import json
import os
import subprocess
from pathlib import Path

import numpy as np

from source_lightmaps import LightmapAtlas, pack_rgbm, unpack_rgbexp32


class SourceLightmapTests(unittest.TestCase):
    def test_multistyle_packing_matches_noclip_bytes(self):
        root=Path(__file__).resolve().parent.parent
        reference=Path(os.environ.get('NOCLIP_REFERENCE',root.parent/'noclip.website'))
        if not reference.exists():self.skipTest('Local noclip reference is unavailable')
        samples=np.random.default_rng(1024).integers(0,256,(2,4,2,2,4),dtype=np.uint8)
        samples[...,3]=np.random.default_rng(8).integers(-4,3,(2,4,2,2)).astype(np.int8).view(np.uint8)
        case=dict(width=2,height=2,samples=samples.ravel().tolist(),intensities=[1,1])
        result=subprocess.run(['node','scripts/source_lightmap_reference.cjs'],cwd=root,env={**os.environ,'NOCLIP_REFERENCE':str(reference)},input=json.dumps([case]),capture_output=True,text=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stderr[-2000:])
        packed=np.array(json.loads(result.stdout)[0],np.uint8).reshape(4,2,2,4)
        for layer in range(1,4):
            atlas=LightmapAtlas(self.model(samples,bump=True,styles=(0,1,255,255)),[0],16,layer=layer)
            _,x,y=atlas.faces[0]
            np.testing.assert_array_equal(atlas.pages[0][y:y+2,x:x+2],packed[layer])

    def model(self, samples, *, bump=False, styles=(0, 255, 255, 255)):
        face = np.zeros(1, dtype=[('lm', '<i4', 4), ('lightofs', '<i4'),
                                  ('styles', 'u1', 4), ('texinfo', '<i4')])
        face['styles'] = styles
        face['lm'] = [2, 4, 1, 1]
        texinfo = np.zeros(1, dtype=[('flags', '<i4'), ('vecs', '<f4', 16)])
        texinfo['flags'] = 0x800 if bump else 0
        texinfo['vecs'][0, 8:] = [1, 0, 0, 0, 0, 1, 0, 0]
        return dict(faces=face, texinfo=texinfo, lighting=np.asarray(samples, np.uint8).tobytes())

    def test_rgbexp_signed_exponent(self):
        samples = np.array([[255, 128, 0, 255], [255, 0, 255, 2]], np.uint8)
        np.testing.assert_allclose(unpack_rgbexp32(samples), [[0.5, 128 / 510, 0], [4, 0, 4]])

    def test_rgbm_keeps_hdr_and_true_black(self):
        source = np.array([[0, 0, 0], [0.25, 1.5, 4.5], [6, 6, 6]], np.float32)
        packed = pack_rgbm(source).astype(float) / 255
        decoded = packed[:, :3] * packed[:, 3:] * 6
        np.testing.assert_allclose(decoded, source, atol=6 / 255)
        np.testing.assert_array_equal(decoded[0], [0, 0, 0])

    def test_bump_layers_do_not_become_other_light_styles(self):
        # Two styles, each with a diffuse slice and three directional bump slices.
        samples = np.zeros((8, 2, 2, 4), np.uint8)
        samples[0, ..., 0] = 255
        samples[1:4, ..., :3] = 255  # must be skipped for flat diffuse
        samples[4, ..., 2] = 255
        atlas = LightmapAtlas(self.model(samples, bump=True, styles=(0, 1, 255, 255)), [0], 16)
        _, x, y = atlas.faces[0]
        pixel = atlas.pages[0][y, x].astype(float) / 255
        np.testing.assert_allclose(pixel[:3] * pixel[3] * 6, [1, 0, 1], atol=6 / 255)

    def test_directional_layers_follow_source_normalization(self):
        samples = np.zeros((4, 2, 2, 4), np.uint8)
        samples[0, ..., :3] = 120
        samples[1, ..., :3] = 60
        samples[2, ..., :3] = 120
        samples[3, ..., :3] = 180
        atlas = LightmapAtlas(self.model(samples, bump=True), [0], 16, layer=3)
        _, x, y = atlas.faces[0]
        pixel = atlas.pages[0][y, x].astype(float) / 255
        np.testing.assert_allclose(pixel[:3] * pixel[3] * 6, [180 / 255] * 3, atol=6/255)

    def test_half_luxel_coordinates_and_gutters(self):
        m = self.model(np.full((2, 2, 4), [255, 0, 0, 0], np.uint8))
        atlas = LightmapAtlas(m, [0], 16)
        _, x, y = atlas.faces[0]
        uv = atlas.uv(m, 0, np.array([[2, 4, 0], [3, 5, 0]]))
        np.testing.assert_allclose(uv * 16, [[x + .5, y + .5], [x + 1.5, y + 1.5]])
        np.testing.assert_array_equal(atlas.pages[0][y - 1, x - 1], atlas.pages[0][y, x])
        # Rotated / displaced world geometry still follows the quad's luxel grid.
        disp_uv = atlas.uv(m, 0, np.full((4, 3), 999), 2)
        np.testing.assert_allclose(disp_uv[[0, -1]], uv)

    def test_animated_styles_bundle_keeps_raw_samples(self):
        samples = np.full((2, 2, 4), [255, 0, 0, 0], np.uint8)
        m = self.model(samples, styles=(9, 255, 255, 255))
        m['ents'] = [{'classname': 'light', 'style': '32', 'spawnflags': '1'}]
        atlas = LightmapAtlas(m, [0], 16)
        with tempfile.TemporaryDirectory() as directory:
            atlas.write_styles(directory, m)
            data = json.loads((Path(directory) / 'lightstyles.json').read_text())
            self.assertEqual(data['patches'][0]['styles'], [9])
            self.assertTrue(data['patterns']['32']['off'])
            self.assertTrue((Path(directory) / data['pages']['0']).is_file())


if __name__ == '__main__':
    unittest.main()
