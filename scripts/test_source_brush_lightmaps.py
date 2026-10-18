"""Ghost's directional brush lightmaps against noclip's real packer, with buffer preservation."""
import copy
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import unittest
import numpy as np
from PIL import Image
from import_source_bsp import BSP, parse
from import_source_props import GLB
from source_brush_lightmaps import restore_brush_lightmaps
from source_lightmaps import LightmapAtlas

ROOT=Path(__file__).resolve().parent.parent
DIRECTORY=ROOT/'public/assets/maps/nt_ghost_ctg'


def read(path):
    data=path.read_bytes();size=struct.unpack_from('<I',data,12)[0]
    return json.loads(data[20:20+size]),data[28+size:]


class BrushLightmapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bsp=BSP((ROOT/'assets/bsp-cache/z.noclip.website_NeoTokyo_NeotokyoSource_maps_nt_ghost_ctg.bsp').read_bytes())
        cls.model=parse(cls.bsp);cls.document,cls.binary=read(DIRECTORY/'props.glb')
        cls.faces=[];cls.bound=[]
        for n in cls.document['nodes']:
            if not n.get('extras',{}).get('sourceBrush'):continue
            for p in cls.document['meshes'][n['mesh']]['primitives']:
                fi=p['extras']['sourceBrushFace'];cls.faces.append(fi)
                material=cls.document['materials'][p['material']]
                if isinstance(material['extras'].get('sourceMaterial',{}).get('bumpmapIndex'),int):cls.bound.append((fi,material))

    def image(self, index):
        texture=self.document['textures'][index];image=self.document['images'][texture['source']]
        view=self.document['bufferViews'][image['bufferView']];offset=view.get('byteOffset',0)
        return np.array(Image.open(io.BytesIO(self.binary[offset:offset+view['byteLength']])).convert('RGBA'))

    def test_native_bsp_samples_match_noclip_directional_packer(self):
        reference=Path(os.environ.get('NOCLIP_REFERENCE',ROOT.parent/'noclip.website'))
        if not reference.exists():self.skipTest('Local noclip reference is unavailable')
        m=self.model;atlas=LightmapAtlas(m,self.faces);cases=[];records=[]
        self.assertEqual(len(self.bound),8)
        for fi,material in self.bound:
            face=m['faces'][fi];self.assertTrue(int(m['texinfo'][face['texinfo']]['flags'])&0x800)
            width,height=map(int,face['lm'][2:]+1);styles=[int(s) for s in face['styles'] if s!=255]
            self.assertEqual(styles,[0]);size=width*height*4*4;offset=int(face['lightofs'])
            cases.append(dict(width=width,height=height,samples=list(m['lighting'][offset:offset+size*len(styles)]),intensities=[1]*len(styles)))
            records.append((fi,material,width,height))
        env={**os.environ,'NOCLIP_REFERENCE':str(reference)}
        result=subprocess.run(['node','scripts/source_lightmap_reference.cjs'],cwd=ROOT,env=env,input=json.dumps(cases),capture_output=True,text=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stderr[-3000:]);expected=json.loads(result.stdout)
        checked=set()
        for (fi,material,width,height),packed in zip(records,expected,strict=True):
            expected=np.array(packed,np.uint8).reshape(4,height,width,4);page,x,y=atlas.faces[fi]
            layers=material['extras']['sourceBumpLightmaps'];self.assertEqual(len(layers),3)
            for layer,index in enumerate(layers,1):
                texture=self.document['textures'][index];sampler=self.document['samplers'][texture['sampler']]
                self.assertEqual((sampler['wrapS'],sampler['wrapT'],sampler['minFilter'],sampler['magFilter']),(33071,33071,9729,9729))
                actual=self.image(index)
                np.testing.assert_array_equal(actual[y:y+height,x:x+width],expected[layer],err_msg=f'face {fi}, layer {layer}')
                padded=np.pad(expected[layer],((1,1),(1,1),(0,0)),mode='edge')
                np.testing.assert_array_equal(actual[y-1:y+height+1,x-1:x+width+1],padded)
                checked.add(index)
        self.assertEqual(len(checked),3);self.assertEqual(len({id(m) for _,m in self.bound}),2)

    def test_existing_model_geometry_images_and_animation_are_unchanged(self):
        base=os.environ.get('SOURCE_BRUSH_LIGHTMAP_BASELINE')
        if not base:self.skipTest('Set SOURCE_BRUSH_LIGHTMAP_BASELINE to the pre-refresh props.glb')
        before,old=read(Path(base));after=copy.deepcopy(self.document)
        self.assertEqual(self.binary[:len(old)],old)
        self.assertEqual(len(after['images']),len(before['images'])+3)
        self.assertEqual(after['images'][:len(before['images'])],before['images'])
        self.assertEqual(after['textures'][:len(before['textures'])],before['textures'])
        for original,current in zip(before['materials'],after['materials'],strict=True):
            if 'sourceBumpLightmaps' not in original.get('extras',{}):current.get('extras',{}).pop('sourceBumpLightmaps',None)
        after['images']=before['images'];after['textures']=before['textures'];after['samplers']=before['samplers']
        after['bufferViews']=before['bufferViews'];after['buffers']=before['buffers']
        after['extras'].pop('sourceBrushBumpLightmaps')
        if not after['extras'] and 'extras' not in before:del after['extras']
        self.assertEqual(after,before)

    def test_refresh_is_idempotent(self):
        glb=GLB();glb.json=copy.deepcopy(self.document);glb.buffer=bytearray(self.binary)
        report=restore_brush_lightmaps(glb,self.model)
        self.assertEqual(report,dict(faces=8,materials=2,directional_textures=3,atlas_pages=1))
        self.assertEqual(glb.json,self.document);self.assertEqual(glb.buffer,self.binary)


if __name__=='__main__':unittest.main()
