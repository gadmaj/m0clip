"""Check real Ghost triangles against upstream code and preserve all other GLB bytes."""
import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import unittest
import numpy as np
from import_source_bsp import BSP, parse
from optimize_map_textures import read_glb
from source_triangulation import native_face_triangles
from test_source_surface_frames import attr

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT/'public/assets/maps/nt_ghost_ctg'


def group(bsp, faces):
    return dict(version=bsp.version, primitives=base64.b64encode(bsp.lump(37)).decode(),
                indices=base64.b64encode(bsp.lump(39)).decode(),
                faces=[[int(f['numedges']), int(f['nprims']), int(f['fprim'])] for f in faces])


def native_reference(groups):
    result = subprocess.run(['node', 'scripts/source_triangulation_reference.cjs'], cwd=ROOT,
                            input=json.dumps(groups), text=True, capture_output=True, timeout=60)
    if result.returncode: raise AssertionError(result.stderr[-4000:])
    return json.loads(result.stdout)


class TriangulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        file = ROOT/'assets/bsp-cache/z.noclip.website_NeoTokyo_NeotokyoSource_maps_nt_ghost_ctg.bsp'
        if not file.exists(): raise unittest.SkipTest('Ghost source cache is not installed')
        cls.bsp = BSP(file.read_bytes()); cls.model = parse(cls.bsp)

    def test_every_flat_face_matches_upstream_native_triangle_membership(self):
        exported = []
        for name in ('visual.glb', 'props.glb'):
            document, binary = read_glb(DIRECTORY/name)
            for mesh in document['meshes']:
                for p in mesh['primitives']:
                    ranges = p.get('extras', {}).get('sourceFaceRanges')
                    brush = p.get('extras', {}).get('sourceBrushFace')
                    if ranges is None and brush is None: continue
                    indices = attr(document, binary, p['indices']).ravel(); vertex_offset = 0
                    for fi, first, size in ranges or [(brush, 0, len(indices))]:
                        face = self.model['faces'][fi]
                        if face['disp'] >= 0:
                            vertex_offset += ((1 << int(self.model['dispinfo'][face['disp']][2]))+1)**2
                            continue
                        # Recover native corner labels and winding from the exported glTF.
                        actual = int(face['numedges'])-1-(indices[first:first+size].astype(np.int64)-vertex_offset)
                        actual = actual.reshape(-1, 3)[:, [0, 2, 1]]
                        exported.append((fi, face, actual))
                        vertex_offset += int(face['numedges'])
        reference = native_reference([group(self.bsp, [f for _, f, _ in exported])])[0]
        authored = 0
        for (fi, face, actual), expected in zip(exported, reference, strict=True):
            np.testing.assert_array_equal(actual.ravel(), expected, err_msg=f'exported face {fi}')
            np.testing.assert_array_equal(native_face_triangles(self.bsp, face).ravel(), expected, err_msg=f'importer face {fi}')
            authored += bool(int(face['nprims']) & 0x7fff)
        self.assertEqual((len(exported), authored), (13476, 1776))

    def test_primitive_layouts_fans_and_dynamic_skip_against_upstream(self):
        class Fixture:
            def lump(self, number): return self.primitives if number == 37 else self.indices
        groups = []; fixtures = []
        for version in (20, 22):
            bsp = Fixture(); bsp.version = version
            # Deliberately use a non-fan authored diagonal, a high-bit count flag,
            # and a dynamic primitive which the actual reference skips.
            bsp.primitives = (struct.pack('<B3xIIHH', 0, 0, 6, 0, 0)+struct.pack('<B3xIIHH', 0, 0, 6, 0, 4)
                              if version == 22 else struct.pack('<BxHHHH', 0, 0, 6, 0, 0)+struct.pack('<BxHHHH', 0, 0, 6, 0, 4))
            bsp.indices = struct.pack('<6H', 1, 2, 3, 1, 3, 0)
            faces = [dict(numedges=5, nprims=0, fprim=0), dict(numedges=4, nprims=0x8001, fprim=0), dict(numedges=4, nprims=1, fprim=1)]
            groups.append(group(bsp, faces)); fixtures.append((bsp, faces))
        for (bsp, faces), expected in zip(fixtures, native_reference(groups), strict=True):
            for face, result in zip(faces, expected, strict=True):
                actual = native_face_triangles(bsp, face)
                if result is None: self.assertIsNone(actual)
                else: np.testing.assert_array_equal(actual.ravel(), result)

    def test_only_triangle_index_bytes_changed(self):
        baseline = os.environ.get('SOURCE_TRIANGULATION_BASELINE_DIRECTORY')
        if not baseline: self.skipTest('Set SOURCE_TRIANGULATION_BASELINE_DIRECTORY to check preservation')
        for name in ('visual.glb', 'props.glb'):
            before, old = read_glb(Path(baseline)/name); after, new = read_glb(DIRECTORY/name)
            self.assertEqual(before, after, f'{name}: JSON metadata changed')
            self.assertEqual(len(old), len(new))
            intervals = []
            for mesh in after['meshes']:
                for p in mesh['primitives']:
                    extra = p.get('extras', {})
                    if 'sourceFaceRanges' not in extra and 'sourceBrushFace' not in extra: continue
                    accessor = after['accessors'][p['indices']]; view = after['bufferViews'][accessor['bufferView']]
                    start = view.get('byteOffset', 0)+accessor.get('byteOffset', 0)
                    intervals.append((start, start+accessor['count']*{5123: 2, 5125: 4}[accessor['componentType']]))
                    for fi, first, size in extra.get('sourceFaceRanges', []):
                        if self.model['faces'][fi]['disp'] >= 0:
                            np.testing.assert_array_equal(attr(before, old, p['indices'])[first:first+size], attr(after, new, p['indices'])[first:first+size])
            cursor = 0
            for start, end in sorted(intervals):
                self.assertEqual(old[cursor:start], new[cursor:start], f'{name}: data outside indices changed')
                cursor = max(cursor, end)
            self.assertEqual(old[cursor:], new[cursor:], f'{name}: trailing data changed')
            self.assertNotEqual(old, new, f'{name}: triangles were not refreshed')


if __name__ == '__main__': unittest.main()
