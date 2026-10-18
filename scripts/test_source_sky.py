"""Sky UVs and inward winding match Source and preserve every non-sky buffer."""
import json
import os
from pathlib import Path
import struct
import unittest
import numpy as np
from source_extras import sky_face_uvs

ROOT = Path(__file__).resolve().parent.parent
SIDE = np.diag([1., 2., 1.])


def read(path):
    data = Path(path).read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+size]), memoryview(data)[28+size:]


class SkyTests(unittest.TestCase):
    def test_seam_clamp_precedes_authored_texture_transform(self):
        expected = [[1/512, 511/256], [1/512, 1/256], [511/512, 1/256], [511/512, 511/256]]
        np.testing.assert_allclose(sky_face_uvs(SIDE), expected)
        self.assertGreater(sky_face_uvs(SIDE)[0, 1], 1)  # texture sampler handles the authored clamp

    def test_untransformed_top_and_bottom_keep_original_seam_uvs(self):
        np.testing.assert_allclose(sky_face_uvs(), [[1/512, 511/512], [1/512, 1/512],
                                                   [511/512, 1/512], [511/512, 511/512]])

    def test_ghost_six_faces_match_loaded_noclip_material_matrices(self):
        path = ROOT/'public/assets/maps/nt_ghost_ctg/props.glb'
        if not path.exists(): self.skipTest('Ghost props are not imported')
        js, binary = read(path)
        faces = [n for n in js['nodes'] if n.get('extras', {}).get('sourceSky')]
        self.assertEqual(len(faces), 6)
        for node in faces:
            # Verified against noclip.website's loaded materialInstances for Ghost:
            # rt/lf/bk/ft use scale(1,2); up/dn use identity.
            expected = np.eye(3) if node['name'].endswith((':up', ':dn')) else SIDE
            np.testing.assert_allclose(np.array(node['extras']['sourceSkyTextureTransform']).reshape(3, 3), expected)
            for primitive in js['meshes'][node['mesh']]['primitives']:
                a = js['accessors'][primitive['attributes']['TEXCOORD_0']]
                view = js['bufferViews'][a['bufferView']]
                uv = np.frombuffer(binary, '<f4', 8, view.get('byteOffset', 0)+a.get('byteOffset', 0)).reshape(4, 2)
                np.testing.assert_allclose(uv, sky_face_uvs(expected))
                positions = js['accessors'][primitive['attributes']['POSITION']]
                pview = js['bufferViews'][positions['bufferView']]
                points = np.frombuffer(binary, '<f4', 12, pview.get('byteOffset', 0)+positions.get('byteOffset', 0)).reshape(4, 3)
                indices = js['accessors'][primitive['indices']]
                iview = js['bufferViews'][indices['bufferView']]
                triangles = np.frombuffer(binary, '<u4', 6, iview.get('byteOffset', 0)+indices.get('byteOffset', 0)).reshape(2, 3)
                for i, j, k in triangles:
                    normal = np.cross(points[j]-points[i], points[k]-points[i])
                    self.assertLess(np.dot(normal, points.mean(axis=0)), 0)


    def test_refresh_changes_only_sky_uv_index_bytes_and_metadata(self):
        baseline = os.environ.get('SOURCE_SKY_BASELINE')
        if not baseline: self.skipTest('Set SOURCE_SKY_BASELINE to a pre-refresh Ghost props.glb')
        before, old = read(baseline)
        after, current = read(ROOT/'public/assets/maps/nt_ghost_ctg/props.glb')
        self.assertEqual(before['bufferViews'], after['bufferViews'])
        self.assertEqual(len(old), len(current))
        allowed = []
        for index, node in enumerate(after['nodes']):
            # Visibility annotations add only JSON metadata, independently checked
            # against the BSP and byte-for-byte buffers in test_source_visibility.py.
            if 'sourceVisibilityClusters' not in before['nodes'][index].get('extras', {}):
                node.get('extras', {}).pop('sourceVisibilityClusters', None)
            if not node.get('extras', {}).get('sourceSky'): continue
            node['extras'].pop('sourceSkyTextureTransform')
            for primitive in after['meshes'][node['mesh']]['primitives']:
                accessor = after['accessors'][primitive['attributes']['TEXCOORD_0']]
                view = after['bufferViews'][accessor['bufferView']]
                offset = view.get('byteOffset', 0)+accessor.get('byteOffset', 0)
                allowed.append((offset, offset+32))
                index = after['accessors'][primitive['indices']]
                index_view = after['bufferViews'][index['bufferView']]
                index_offset = index_view.get('byteOffset', 0)+index.get('byteOffset', 0)
                allowed.append((index_offset, index_offset+24))
        self.assertEqual(before, after)
        previous = 0
        for start, end in sorted(allowed):
            self.assertEqual(old[previous:start], current[previous:start])
            previous = end
        self.assertEqual(old[previous:], current[previous:])


if __name__ == '__main__': unittest.main()
