"""Ghost's complete exported corner frames against native BSP data and noclip's actual builder."""
import json
import os
from pathlib import Path
import struct
import subprocess
import unittest
import numpy as np
from import_source_bsp import BSP, parse, face_points

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT/'public/assets/maps/nt_ghost_ctg'


def read(path):
    data = path.read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+size]), data[28+size:]


def attr(document, binary, index):
    a = document['accessors'][index]; v = document['bufferViews'][a['bufferView']]
    width = {'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'SCALAR': 1}[a['type']]
    dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2'}[a['componentType']]
    return np.frombuffer(binary, dtype, a['count']*width, v.get('byteOffset', 0)+a.get('byteOffset', 0)).reshape(-1, width)


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-20)


class SurfaceFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT/'assets/bsp-cache/z.noclip.website_NeoTokyo_NeotokyoSource_maps_nt_ghost_ctg.bsp'
        if not path.exists(): raise unittest.SkipTest('Ghost source cache is not installed')
        cls.bsp = BSP(path.read_bytes()); cls.m = parse(cls.bsp)
        cls.manifest = json.loads((DIRECTORY/'manifest.json').read_text())

    def test_every_world_corner_matches_the_noclip_builder(self):
        reference = Path(os.environ.get('NOCLIP_REFERENCE', ROOT.parent/'noclip.website'))
        if not (reference/'node_modules/gl-matrix').exists(): self.skipTest('Local noclip reference dependencies are not installed')
        m = self.m; document, binary = read(DIRECTORY/'visual.glb')
        native_normals = np.frombuffer(self.bsp.lump(30), '<f4').reshape(-1, 3)
        normal_indices = np.frombuffer(self.bsp.lump(31), '<u2')
        starts = np.concatenate([[0], np.cumsum(m['faces']['numedges'])])
        c, s = np.cos(np.radians(-self.manifest['spawn_yaw'])), np.sin(np.radians(-self.manifest['spawn_yaw']))
        rotation = np.array([[c,-s,0],[s,c,0],[0,0,1]])
        cases = []; exported = []
        for primitive in document['meshes'][0]['primitives']:
            normals = attr(document, binary, primitive['attributes']['NORMAL'])
            tangents = attr(document, binary, primitive['attributes']['TANGENT']); offset = 0
            for fi, _, _ in primitive['extras']['sourceFaceRanges']:
                f = m['faces'][fi]; tex = m['texinfo'][f['texinfo']]['vecs'][:8].reshape(2,4)[:,:3]
                sign = -1 if np.dot(m['planes'][f['plane']]['n'], np.cross(unit(tex[0]), unit(tex[1]))) > 0 else 1
                case = dict(t=unit(tex[1]).tolist(), sign=sign)
                if f['disp'] >= 0:
                    start, first, power = m['dispinfo'][f['disp']]; side = (1 << power)+1
                    corners = face_points(m, f); index = np.argmin(np.linalg.norm(corners-start,axis=1)); corners = np.roll(corners,-index,axis=0)
                    count = side*side; case.update(corners=corners.tolist(), side=side, disp=m['dispverts'][first:first+count].ravel().tolist())
                else:
                    count = int(f['numedges']); case['normals'] = native_normals[normal_indices[starts[fi]:starts[fi+1]]].tolist()
                cases.append(case); exported.append((fi, f['disp']>=0, normals[offset:offset+count], tangents[offset:offset+count])); offset += count
            self.assertEqual(offset, len(normals))
        env = {**os.environ, 'NOCLIP_REFERENCE': str(reference)}
        result = subprocess.run(['node', 'scripts/source_surface_reference.cjs'], cwd=ROOT, env=env, input=json.dumps(cases), text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        expected = json.loads(result.stdout); vertices = displaced = 0
        for (fi, disp, normal, tangent), data in zip(exported, expected, strict=True):
            data = np.array(data)
            if not disp: data = data[::-1]
            # packed normal.xyz, alpha, tangent.xyz, Source tangent sign.
            n = unit(data[:,:3]) @ rotation.T
            t = data[:,4:7] @ rotation.T; sign = data[:,7:8]
            np.testing.assert_allclose(normal, n, atol=3e-6, err_msg=f'face {fi} corner normals')
            np.testing.assert_allclose(tangent[:,:3], t*sign, atol=3e-6, err_msg=f'face {fi} tangent S')
            np.testing.assert_array_equal(tangent[:,3:4], -sign)
            native_b = np.cross(t, n)
            gltf_b = np.cross(normal, tangent[:,:3])*tangent[:,3:4]
            np.testing.assert_allclose(gltf_b, native_b, atol=3e-6, err_msg=f'face {fi} tangent T')
            vertices += len(normal); displaced += disp
        self.assertEqual(len(exported), 12857); self.assertEqual(vertices, 67077); self.assertEqual(displaced, 123)

    def test_brush_corner_normals_and_reflection_coordinates(self):
        document, binary = read(DIRECTORY/'props.glb'); entities = {e.get('model'):e for e in self.m['ents'] if e.get('model','').startswith('*')}
        normals = np.frombuffer(self.bsp.lump(30),'<f4').reshape(-1,3); indices = np.frombuffer(self.bsp.lump(31),'<u2')
        starts = np.concatenate([[0],np.cumsum(self.m['faces']['numedges'])]); nodes = faces = vertices = 0
        from source_models import qangle
        world = qangle([0,-self.manifest['spawn_yaw'],0])
        for node in document['nodes']:
            extra = node.get('extras',{})
            if not extra.get('sourceBrush'):continue
            self.assertEqual(extra['sourceOrigin'],self.manifest['spawn_source']);self.assertEqual(extra['sourceYaw'],self.manifest['spawn_yaw'])
            entity = entities[extra['sourceBrush']]; r = world @ qangle([float(v) for v in entity.get('angles','0 0 0').split()])
            for p in document['meshes'][node['mesh']]['primitives']:
                fi = p['extras']['sourceBrushFace']; expected = unit(normals[indices[starts[fi]:starts[fi+1]]][::-1] @ r.T)
                np.testing.assert_allclose(attr(document,binary,p['attributes']['NORMAL']),expected,atol=2e-6)
                t = attr(document,binary,p['attributes']['TANGENT']);np.testing.assert_allclose(np.linalg.norm(t[:,:3],axis=1),1,atol=2e-6)
                np.testing.assert_allclose(np.sum(t[:,:3]*expected,axis=1),0,atol=2e-6)
                vertices += len(expected);faces += 1
            nodes += 1
        self.assertEqual((nodes,faces,vertices),(9,742,3538))

    def test_only_shading_frames_and_brush_coordinates_changed(self):
        baseline = os.environ.get('SOURCE_SURFACE_BASELINE_DIRECTORY')
        if not baseline:self.skipTest('Set SOURCE_SURFACE_BASELINE_DIRECTORY to the pre-refresh native assets')
        for name in ('visual.glb','props.glb'):
            a, old = read(Path(baseline)/name); b, new = read(DIRECTORY/name)
            for key in ('materials','images','textures','animations','skins','samplers'):self.assertEqual(a.get(key),b.get(key),key)
            self.assertEqual(len(a['meshes']),len(b['meshes']))
            changed = 0
            for ma, mb in zip(a['meshes'],b['meshes'],strict=True):
                for pa, pb in zip(ma['primitives'],mb['primitives'],strict=True):
                    self.assertEqual(pa['material'],pb['material']);np.testing.assert_array_equal(attr(a,old,pa['indices']),attr(b,new,pb['indices']))
                    for key, index in pa['attributes'].items():
                        if key=='NORMAL' and 'TANGENT' not in pa['attributes'] and 'TANGENT' in pb['attributes']:
                            changed += 1;continue
                        np.testing.assert_array_equal(attr(a,old,index),attr(b,new,pb['attributes'][key]),err_msg=key)
            self.assertGreater(changed,0)
            for image in a['images']:
                view=image['bufferView'];va=a['bufferViews'][view];vb=b['bufferViews'][view]
                self.assertEqual(old[va.get('byteOffset',0):va.get('byteOffset',0)+va['byteLength']],new[vb.get('byteOffset',0):vb.get('byteOffset',0)+vb['byteLength']])
            for na,nb in zip(a['nodes'],b['nodes'],strict=True):
                if na.get('extras',{}).get('sourceBrush'):
                    nb=json.loads(json.dumps(nb));nb['extras'].pop('sourceOrigin');nb['extras'].pop('sourceYaw')
                self.assertEqual(na,nb)


if __name__=='__main__':unittest.main()
