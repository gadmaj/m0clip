"""Ghost visibility metadata matches native BSP leaves and preserves all asset bytes."""
import base64
import json
import os
from pathlib import Path
import struct
import unittest
from import_source_bsp import BSP, parse
from import_source_visibility import load
from source_models import static_props
from source_visibility import visibility_data, visible_faces

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT/'public/assets/maps/nt_ghost_ctg'


class VisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bsp = BSP((ROOT/'assets/bsp-cache/z.noclip.website_NeoTokyo_NeotokyoSource_maps_nt_ghost_ctg.bsp').read_bytes())
        cls.model = parse(cls.bsp)
        cls.data = json.loads((DIRECTORY/'visibility.json').read_text())

    def test_data_is_reproducible_from_native_bsp(self):
        manifest = json.loads((DIRECTORY/'manifest.json').read_text())
        self.assertEqual(self.data, visibility_data(self.bsp,self.model,manifest))
        self.assertEqual(manifest['visibility'],'visibility.json')

    def test_native_sky_pvs_contains_city(self):
        self.assertEqual(self.data['sky'],dict(origin=[3155.5,215.,238.5],scale=16.))
        point = self.data['sky']['origin']; index = self.data['head']
        while index >= 0:
            n = self.data['nodes'][index]
            index = n[4 if sum(point[i]*n[i] for i in range(3)) >= n[3] else 5]
        cluster = self.data['leafClusters'][-index-1]
        self.assertEqual(cluster,545)
        raw = base64.b64decode(self.data['visibility']); total = struct.unpack_from('<I',raw)[0]
        offset = struct.unpack_from('<I',raw,4+cluster*8)[0]; row = bytearray()
        while len(row) < (total+7)//8:
            value = raw[offset]; offset += 1
            if value: row.append(value)
            else: row.extend(bytes(raw[offset])); offset += 1
        clusters = {i for i in range(total) if row[i//8] & 1<<(i%8)}
        self.assertEqual(len(clusters),90)
        faces = [f for f in visible_faces(self.model) if clusters.intersection(self.data['faceClusters'][f])]
        self.assertEqual(len(faces),83)
        props = load(DIRECTORY/'props.glb')
        visible = [n['extras']['sourceStaticIndex'] for n in props.json['nodes']
                   if clusters.intersection(n.get('extras',{}).get('sourceVisibilityClusters',[]))]
        self.assertEqual(visible,[1276,1277,1278,1279,1280,1281,1282,1287,1288,1289])

    def test_every_index_range_preserves_face_order(self):
        world = load(DIRECTORY/'visual.glb'); faces = []
        for p in world.json['meshes'][0]['primitives']:
            count = 0
            for face,start,length in p['extras']['sourceFaceRanges']:
                self.assertEqual(start,count); self.assertGreater(length,0)
                faces.append(face); count += length
            self.assertEqual(count,world.json['accessors'][p['indices']]['count'])
        self.assertEqual(sorted(faces),sorted(visible_faces(self.model)))

    def test_static_visibility_uses_all_authored_leaves(self):
        props = load(DIRECTORY/'props.glb'); native = static_props(self.bsp); count = 0
        for node in props.json['nodes']:
            extra = node.get('extras',{}); index = extra.get('sourceStaticIndex')
            if not isinstance(index,int): continue
            expected = sorted({self.model['leafs'][i][1] for i in native[index].leaves if self.model['leafs'][i][1]!=65535})
            self.assertEqual(extra['sourceVisibilityClusters'],expected); count += 1
        self.assertEqual(count,1750)

    def test_metadata_only_preserves_all_binary_geometry_and_textures(self):
        baseline = os.environ.get('SOURCE_VISIBILITY_BASELINE')
        if not baseline: self.skipTest('Set SOURCE_VISIBILITY_BASELINE directory for byte preservation check')
        for name in ('visual','props'):
            before = load(Path(baseline)/(name+'.glb')); after = load(DIRECTORY/(name+'.glb'))
            self.assertEqual(before.buffer,after.buffer)
            for mesh in after.json['meshes']:
                for p in mesh['primitives']:
                    if 'extras' in p:
                        p['extras'].pop('sourceFaceRanges',None)
                        if not p['extras']: del p['extras']
            for node in after.json['nodes']:
                for field in ('sourceVisibilityClusters','sourceVisibilityFaces'): node.get('extras',{}).pop(field,None)
            self.assertEqual(before.json,after.json)


if __name__=='__main__': unittest.main()
