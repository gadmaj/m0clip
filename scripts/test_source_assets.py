"""Material/texture regressions found while matching Ghost against noclip.website."""
import struct
import unittest
import numpy as np
from source_assets import parse_vmt, material, decode_vtf, _dxt_color, texture_transform
from source_animation import decode_quat, rle, AnimationModel
from pathlib import Path
from source_materials import MaterialExport


class AssetTests(unittest.TestCase):
    def test_native_texture_cache_reuses_exact_payloads_and_separates_content(self):
        import tempfile
        from unittest.mock import patch
        from import_source_props import GLB
        header = bytearray(80); header[:4] = b'VTF\0'
        struct.pack_into('<IIIHHIHH', header, 4, 7, 2, 80, 2, 2, 0, 1, 0)
        struct.pack_into('<iBiBB', header, 52, 0, 1, -1, 0, 0); struct.pack_into('<H', header, 65, 1)
        class FS:
            raw = bytes(header)+bytes([10, 20, 30, 255])*4
            def read(self, _path): return self.raw
        fs = FS()
        with tempfile.TemporaryDirectory() as directory:
            fs.source_texture_cache = Path(directory)
            first = GLB(); MaterialExport(first, fs).texture('fixture')
            with patch('source_materials.decode_vtf', side_effect=AssertionError('Cache hit decoded the VTF again')):
                second = GLB(); MaterialExport(second, fs).texture('another-alias')
            self.assertEqual(first.buffer, second.buffer)
            fs.raw = bytes(header)+bytes([40, 50, 60, 255])*4
            third = GLB(); MaterialExport(third, fs).texture('fixture')
            self.assertNotEqual(first.buffer, third.buffer)
            self.assertEqual(len(list(Path(directory).glob('*.png'))), 2)

    def test_cutout_culling_replaces_legacy_double_sided_flag(self):
        class FS:
            nocull = False
            def read(self, path):
                return ('"LightmappedGeneric" { "$basetexture" "grate" "$alphatest" "1" "$nocull" "%d" }' % self.nocull).encode()
        fs = FS()
        exporter = MaterialExport(None, fs)
        exporter.texture = lambda *_args, **_kwargs: None
        for authored in (False, True):
            fs.nocull = authored
            record = dict(doubleSided=not authored, pbrMetallicRoughness={})
            exporter.apply(record, 'grate')
            self.assertEqual(record['doubleSided'], authored)
            self.assertEqual(record['alphaMode'], 'MASK')
            self.assertEqual(record['alphaCutoff'], .7)

    def test_proxy_parameters_do_not_replace_material_values(self):
        shader, kv = parse_vmt('''"VertexLitGeneric" {
            "$basetexture" "models\\test" "$envmaptint" "[.2 .3 .4]"
            "VertexLitGeneric_DX8" { "$envmaptint" "[1 1 1]" }
            "Proxies" { "TextureScroll" { "textureScrollVar" "$baseTextureTransform" } }
        }''')
        self.assertEqual(shader, 'vertexlitgeneric')
        self.assertEqual(kv['$envmaptint'], '[.2 .3 .4]')
        self.assertNotIn('texturescrollvar', kv)
        self.assertEqual(kv['proxies']['texturescroll']['texturescrollvar'], '$baseTextureTransform')

    def test_patch_keeps_shader_and_replaces_flags(self):
        class FS:
            def read(self, path): return {
                'materials/base.vmt': b'"VertexLitGeneric" { "$basetexture" "test" "$alphatest" "0" }',
                'materials/patched.vmt': b'"patch" { "include" "base.vmt" "replace" { "$alphatest" "1" } "insert" { "$nocull" "1" } }',
            }.get(path)
        mat = material(FS(), 'patched')
        self.assertEqual(mat['shader'], 'vertexlitgeneric')
        self.assertTrue(mat['alphatest']); self.assertTrue(mat['nocull'])
        self.assertEqual(mat['alphatestreference'], .7)  # noclip Material_Generic's default

    def test_authored_alpha_cutoff_overrides_reference_default(self):
        class FS:
            def read(self, path):
                return b'"LightmappedGeneric" { "$basetexture" "grate" "$alphatest" "1" "$alphatestreference" ".45" }'
        self.assertEqual(material(FS(), 'grate')['alphatestreference'], .45)

    def test_native_detail_parameters_survive_material_import(self):
        class FS:
            def read(self, path):
                return b'"LightmappedGeneric" { "$basetexture" "metal/door" "$detail" "detail/metal_detail_01" "$detailscale" "4.283" "$detailblendfactor" ".65" "$detailblendmode" "0" }'
        result = material(FS(), 'metal/door')
        self.assertEqual(result['detail'], 'detail/metal_detail_01')
        self.assertEqual(result['detailblendmode'], 0)
        self.assertAlmostEqual(result['detailscale'], 4.283)
        self.assertAlmostEqual(result['detailblendfactor'], .65)

    def test_texture_transform_matches_source_matrix_order(self):
        matrix = texture_transform('center .5 .25 scale 2 3 rotate 90 translate -.2 .1')
        np.testing.assert_allclose(matrix, [[0, -3, .55], [2, 0, -.15], [0, 0, 1]], atol=1e-12)
        np.testing.assert_allclose(texture_transform('scale 2'), [[2, 0, 0], [0, 2, 0], [0, 0, 1]])
        np.testing.assert_allclose(texture_transform(''), np.eye(3))
        with self.assertRaisesRegex(ValueError, 'Invalid Source texture transform'):
            texture_transform('scale invalid')

    def test_dxt1_three_color_mode(self):
        # c0 <= c1: index 2 is the average; index 3 is transparent black.
        block = np.array([[0, 0, 255, 255, 0xaa, 0xaa, 0xaa, 0xaa]], np.uint8)
        pixel = _dxt_color(block, True)[0, 0]
        np.testing.assert_array_equal(pixel, [127, 127, 127, 255])

    def test_vtf_cube_skips_legacy_seventh_faces(self):
        header = bytearray(80); header[:4] = b'VTF\0'
        struct.pack_into('<IIIHHIHH', header, 4, 7, 2, 80, 2, 2, 0x4000, 1, 0)
        struct.pack_into('<iBiBB', header, 52, 0, 2, -1, 0, 0); struct.pack_into('<H', header, 65, 1)
        # Smallest mip has seven faces; then seven 2x2 full-resolution faces.
        mip = b''.join(bytes([i, 0, 0, 255]) for i in range(7))
        full = b''.join(bytes([10+i, 0, 0, 255])*4 for i in range(7))
        pixels = decode_vtf(bytes(header) + mip + full, face=5)
        np.testing.assert_array_equal(pixels[0, 0], [15, 0, 0, 255])

    def test_animation_runs_hold_last_valid_sample(self):
        data = bytes([2, 4]) + struct.pack('<hh', 12, 34) + bytes([1, 2]) + struct.pack('<h', 56)
        data = b'XX' + data
        self.assertEqual([rle(data, 0, 2, f) for f in range(6)], [12, 34, 34, 34, 56, 56])

    def test_packed_identity_quaternion(self):
        q = decode_quat(struct.pack('<HHH', 32768, 32768, 16384), 0, 48)
        np.testing.assert_allclose(q, [0, 0, 0, 1])

    def test_hard_edged_spotlight_keeps_full_intensity_inside_cone(self):
        from import_source_props import PropLighting
        light = dict(pos=[0, 0, 10], color=[1, 1, 1], attenuation=[1, 0, 0], kind=2,
                     normal=[0, 0, -1], exponent=1, inner=.866, outer=.866, radius=100, flags=0)
        lighting = PropLighting({'lights': [light]})
        result = lighting.shade(np.array([[0, 0, 0], [10, 0, 0]]),
            np.array([[0, 0, 1], [0, 0, 1]]), (np.zeros((6, 3)), [light]))
        np.testing.assert_allclose(result[0], [1/6]*3)
        np.testing.assert_allclose(result[1], [np.sqrt(.5)*.01/6]*3)

    def test_ghost_arm_animation(self):
        path = Path(__file__).resolve().parent.parent/'assets/bsp-cache/files/models/nt/props_tech/robotarm_dynamic.mdl'
        if not path.exists(): self.skipTest('Ghost model is not cached')
        clip = AnimationModel(path.read_bytes()).sample('loop1')
        self.assertAlmostEqual(clip['times'][-1], 4)
        self.assertEqual(clip['quaternions'].shape, (121, 3, 4))
        self.assertGreater(float(np.ptp(clip['quaternions'], axis=0).max()), .5)
        np.testing.assert_allclose(np.linalg.norm(clip['quaternions'], axis=-1), 1)
        self.assertTrue(clip['loop'])


if __name__ == '__main__': unittest.main()
