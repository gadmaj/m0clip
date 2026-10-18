"""Projection/clipping regressions and Ghost overlay inventory."""
import json
from pathlib import Path
import struct
import unittest
import numpy as np
from source_overlays import Overlay, project_overlay, read_overlays


class OverlayTests(unittest.TestCase):
    def overlay(self):
        return Overlay(7, 0, 0, (0,), np.zeros(3), np.array([0., 0., 1.]),
            np.array([[-.5, -.5, 0], [.5, -.5, 0], [.5, .5, 0], [-.5, .5, 0]]),
            np.array([[0., 0.], [1., 0.], [1., 1.], [0., 1.]]))

    def test_projection_preserves_uvs_and_lifts_from_receiver(self):
        tri = np.array([[-2., -2., 0], [2., -2., 0], [0, 2., 0]])
        points, normal, uv, light = project_overlay(self.overlay(), tri, (tri[:, :2] + 2) / 4)
        np.testing.assert_allclose(points[:, 2], .1)
        np.testing.assert_allclose(normal, [0, 0, 1])
        np.testing.assert_allclose(uv, points[:, :2] + .5)
        np.testing.assert_allclose(light, (points[:, :2] + 2) / 4)

    def test_triangle_clipping_does_not_spill_beyond_receiver(self):
        tri = np.array([[-.5, -.5, 0], [.5, -.5, 0], [-.5, .5, 0]])
        points, _, uv, light = project_overlay(self.overlay(), tri, tri[:, :2] + .5)
        self.assertTrue((points[:, 0] + points[:, 1] <= 1e-7).all())
        area = sum(np.linalg.norm(np.cross(points[i] - points[0], points[i+1] - points[0])) / 2
                   for i in range(1, len(points)-1))
        self.assertAlmostEqual(area, .5)
        np.testing.assert_allclose(uv, light)

    def test_reprojection_follows_tilted_displacement_triangle(self):
        tri = np.array([[-2., -2., -.5], [2., -2., .5], [0., 2., 0.]])
        points, normal, _, light = project_overlay(self.overlay(), tri, (tri[:, :2] + 2) / 4)
        surface = points - .1 * normal
        np.testing.assert_allclose(surface[:, 2], surface[:, 0] * .25, atol=1e-8)
        np.testing.assert_allclose(light, (surface[:, :2] + 2) / 4)

    def test_parallel_and_distant_receivers_are_rejected(self):
        self.assertIsNone(project_overlay(self.overlay(), np.array([[0., 0, 0], [0, 1, 0], [0, 0, 1]]), np.zeros((3, 2))))
        self.assertIsNone(project_overlay(self.overlay(), np.array([[10., 10, 0], [11, 10, 0], [10, 11, 0]]), np.zeros((3, 2))))

    def test_overlay_lump_basis_and_render_order(self):
        raw = bytearray(352)
        struct.pack_into('<IHH', raw, 0, 123, 5, 2 | (3 << 14))
        struct.pack_into('<2i', raw, 8, 21, 22)
        struct.pack_into('<4f', raw, 264, .2, .8, .1, .9)
        struct.pack_into('<12f', raw, 280, -1, -1, 1, 1, -1, 0, 1, 1, 0, -1, 1, 1)
        struct.pack_into('<3f', raw, 328, 10, 20, 30)
        struct.pack_into('<3f', raw, 340, 0, 0, 1)
        overlay = read_overlays(raw)[0]
        self.assertEqual((overlay.id, overlay.texinfo, overlay.order, overlay.faces), (123, 5, 3, (21, 22)))
        np.testing.assert_allclose(overlay.points[0], [9, 21, 30])  # encoded T-axis flip
        np.testing.assert_allclose(overlay.uv[0], [.2, .1])
        with self.assertRaisesRegex(ValueError, 'Truncated'): read_overlays(raw[:-1])
        struct.pack_into('<H', raw, 6, 65)
        with self.assertRaisesRegex(ValueError, '64'): read_overlays(raw)

    def test_ghost_overlay_inventory_and_buffers(self):
        root = Path(__file__).resolve().parent.parent/'public/assets/maps/nt_ghost_ctg'
        if not (root/'materials-report.json').exists(): self.skipTest('Ghost has not been imported')
        report = json.loads((root/'materials-report.json').read_text()).get('overlays')
        if report is None: self.skipTest('Ghost overlays have not been imported')
        self.assertEqual(report['requested'], 322)
        # Verified against noclip.website's bsp.overlays: these three authored
        # rectangles do not intersect any of their listed receiving faces.
        self.assertEqual(report['restored'], 319)
        self.assertEqual(report['empty'], [48, 130, 139]); self.assertFalse(report['missing_materials'])
        data = (root/'visual.glb').read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
        gltf = json.loads(data[20:20+size]); binary = memoryview(data)[28+size:]
        nodes = [n for n in gltf['nodes'] if n.get('extras', {}).get('sourceOverlay')]
        self.assertEqual(len(nodes), 319)
        for node in nodes:
            for primitive in gltf['meshes'][node['mesh']]['primitives']:
                for kind, ai in primitive['attributes'].items():
                    accessor = gltf['accessors'][ai]; view = gltf['bufferViews'][accessor['bufferView']]
                    values = np.frombuffer(binary, '<f4', view['byteLength']//4, view.get('byteOffset', 0))
                    self.assertTrue(np.isfinite(values).all(), (node['name'], kind))
                    if kind == 'TEXCOORD_1': self.assertTrue(((values >= 0) & (values <= 1)).all())

        # Overlays add geometry without changing the original world's vertices or UVs.
        original = (root/'visual-base.glb').read_bytes(); n = struct.unpack_from('<I', original, 12)[0]
        base = json.loads(original[20:20+n]); base_binary = memoryview(original)[28+n:]
        for mesh in base['meshes']:
            for primitive in mesh['primitives']:
                for ai in primitive['attributes'].values():
                    old_view = base['bufferViews'][base['accessors'][ai]['bufferView']]
                    new_view = gltf['bufferViews'][gltf['accessors'][ai]['bufferView']]
                    self.assertEqual(bytes(base_binary[old_view['byteOffset']:old_view['byteOffset']+old_view['byteLength']]),
                                     bytes(binary[new_view['byteOffset']:new_view['byteOffset']+new_view['byteLength']]))


if __name__ == '__main__': unittest.main()
