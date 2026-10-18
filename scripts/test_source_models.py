"""Regression checks for Source model coordinate conventions and Ghost model export."""
import json
from pathlib import Path
import struct
import unittest

import numpy as np

from source_models import StudioModel, qangle


class SourceModelTests(unittest.TestCase):
    def test_source_angles(self):
        # Source is Z-up: yaw turns forward X toward Y; pitch turns X downward.
        np.testing.assert_allclose(qangle([0, 90, 0]) @ [1, 0, 0], [0, 1, 0], atol=1e-7)
        np.testing.assert_allclose(qangle([90, 0, 0]) @ [1, 0, 0], [0, 0, -1], atol=1e-7)
        np.testing.assert_allclose(qangle([0, 0, 90]) @ [0, 1, 0], [0, 0, 1], atol=1e-7)
        rotation = qangle([27, -124, 53])
        np.testing.assert_allclose(rotation.T @ rotation, np.eye(3), atol=1e-7)
        self.assertAlmostEqual(np.linalg.det(rotation), 1)

    def test_skin_families(self):
        model = StudioModel.__new__(StudioModel)
        model.materials = ['red', 'blue', 'green']
        model.skins = np.array([[0, 1], [2, 0]])
        mesh = type('Mesh', (), {'skinref': 0})()
        self.assertEqual(model.material(mesh, 1), 'green')
        self.assertEqual(model.material(mesh, 99), 'red')

    def test_bodygroup_selection(self):
        model = StudioModel.__new__(StudioModel)
        mesh = lambda part, base, count, sub: type('Mesh', (), dict(bodypart=part, body_base=base, body_count=count, submodel=sub))()
        model.meshes = [mesh(0, 1, 2, i) for i in range(2)] + [mesh(1, 2, 3, i) for i in range(3)]
        self.assertEqual([(m.bodypart, m.submodel) for m in model.selected(5)], [(0, 1), (1, 2)])

    def test_mismatched_companion_files_rejected(self):
        mdl, vvd, vtx = bytearray(16), bytearray(16), bytearray(20)
        mdl[:4] = b'IDST'; vvd[:4] = b'IDSV'
        struct.pack_into('<II', mdl, 4, 44, 123)
        struct.pack_into('<II', vvd, 4, 4, 456)
        struct.pack_into('<I', vtx, 0, 7); struct.pack_into('<I', vtx, 16, 123)
        class FS:
            def read(self, path): return {'.mdl': mdl, '.vvd': vvd, '.vtx': vtx}[Path(path).suffix]
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            StudioModel(FS(), 'models/test.mdl')

    def test_ghost_export_inventory(self):
        path = Path(__file__).resolve().parent.parent / 'public/assets/maps/nt_ghost_ctg/props-report.json'
        if not path.exists(): self.skipTest('Ghost assets have not been imported')
        report = json.loads(path.read_text())
        self.assertEqual(report['static'], 1750)
        self.assertEqual(report['entities'], 303)
        self.assertEqual(report['brush_entities'], 9)
        self.assertFalse(report['missing_models'])
        self.assertFalse(report['missing_textures'])
        self.assertEqual(report['textured'], report['materials'])
        self.assertEqual(report['sky_faces'], 6)
        self.assertEqual(report['sprites'], 150)
        self.assertEqual(report['detail_sprites'], 52)
        self.assertEqual(report['animated_props'], 11)
        self.assertFalse(report['missing_effect_textures'])

    def test_ghost_gpu_buffers(self):
        path = Path(__file__).resolve().parent.parent / 'public/assets/maps/nt_ghost_ctg/props.glb'
        if not path.exists(): self.skipTest('Ghost assets have not been imported')
        data = path.read_bytes()
        size = struct.unpack_from('<I', data, 12)[0]
        gltf = json.loads(data[20:20 + size])
        binary = memoryview(data)[28 + size:]
        checked = set()
        for mesh in gltf['meshes']:
            for primitive in mesh['primitives']:
                attributes = primitive['attributes']
                vertices = gltf['accessors'][attributes['POSITION']]['count']
                if 'COLOR_0' in attributes:
                    self.assertEqual(gltf['accessors'][attributes['COLOR_0']]['count'], vertices)
                index = primitive['indices']
                if index in checked: continue
                checked.add(index)
                accessor = gltf['accessors'][index]
                view = gltf['bufferViews'][accessor['bufferView']]
                indices = np.frombuffer(binary, '<u4', accessor['count'],
                                        view.get('byteOffset', 0) + accessor.get('byteOffset', 0))
                self.assertLess(int(indices.max()), vertices)
        for node in gltf['nodes']:
            if 'matrix' in node:
                self.assertTrue(np.isfinite(node['matrix']).all())
                self.assertGreater(np.linalg.det(np.array(node['matrix']).reshape(4, 4)), 0)


if __name__ == '__main__': unittest.main()
