"""Native Dog geometry, skin weights, inverse binds and exported rest-pose transforms."""
import unittest
from pathlib import Path
import numpy as np
from import_source_visibility import load
from source_models import StudioModel
from source_animation import AnimationModel
from analyze_source_robot import CachedFiles

ROOT=Path(__file__).resolve().parent.parent
CACHE=ROOT/'assets/bsp-cache/vpk-files/https___z.noclip.website_HalfLife2_hl2_misc'


def accessor(glb,index):
    a=glb.json['accessors'][index];v=glb.json['bufferViews'][a['bufferView']]
    width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
    kind={5126:'<f4',5125:'<u4',5123:'<u2'}[a['componentType']]
    return np.frombuffer(glb.buffer,kind,a['count']*width,v.get('byteOffset',0)+a.get('byteOffset',0)).reshape(a['count'],width)


class DogTests(unittest.TestCase):
    def test_native_mesh_and_skin_are_not_replaced_or_cut(self):
        # Geometry files are already cached by import_source_dog; material lookup is not needed here.
        model=StudioModel(CachedFiles(CACHE),'models/dog.mdl')
        glb=load(ROOT/'public/assets/source-robots/halflife2-dog/dog.glb')
        meshes=model.selected(0);primitives=glb.json['meshes'][0]['primitives']
        self.assertEqual(len(primitives),len(meshes));self.assertEqual(sum(len(m.triangles) for m in meshes),5855)
        for original,primitive in zip(meshes,primitives):
            attributes=primitive['attributes']
            np.testing.assert_allclose(accessor(glb,attributes['POSITION']),original.positions*.0254,atol=1e-7)
            np.testing.assert_array_equal(accessor(glb,attributes['NORMAL']),original.normals)
            np.testing.assert_array_equal(accessor(glb,attributes['TEXCOORD_0']),original.uv)
            np.testing.assert_array_equal(accessor(glb,attributes['WEIGHTS_0']),original.weights)
            np.testing.assert_array_equal(accessor(glb,attributes['JOINTS_0'])[:,:3],original.joints)
            np.testing.assert_array_equal(accessor(glb,primitive['indices']).reshape(-1,3),original.triangles)
        native=AnimationModel(model.mdl)
        self.assertEqual(len(glb.json['skins'][0]['joints']),58)
        matrices=accessor(glb,glb.json['skins'][0]['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1)
        expected=np.array([bone['inverse'].copy() for bone in native.bones]);expected[:,:3,3]*=.0254
        np.testing.assert_allclose(matrices,expected,atol=1e-7)
        for bone,node in zip(native.bones,glb.json['skins'][0]['joints']):
            np.testing.assert_allclose(glb.json['nodes'][node]['translation'],bone['pos']*.0254,atol=1e-8)
            np.testing.assert_array_equal(glb.json['nodes'][node]['rotation'],bone['quat'])


if __name__=='__main__':unittest.main()
