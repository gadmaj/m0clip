"""Verify shipped lossless textures and every non-image GLB byte against PNG masters."""
import copy
import io
import os
from pathlib import Path
import unittest
from PIL import Image
from optimize_map_textures import read_glb

ROOT=Path(__file__).resolve().parent.parent
MASTER=ROOT/'public/assets/maps/nt_ghost_ctg'
SHIPPED=Path(os.environ.get('OPTIMIZED_GHOST_DIRECTORY',ROOT/'dist/assets/maps/nt_ghost_ctg'))


def data(document,binary,index):
    view=document['bufferViews'][index];at=view.get('byteOffset',0)
    return binary[at:at+view['byteLength']]


class OptimizedTextures(unittest.TestCase):
    def test_native_pixels_geometry_animation_and_materials_are_preserved(self):
        optimized_count=0
        for name in ('visual.glb','props.glb'):
            before,old=read_glb(MASTER/name);after,current=read_glb(SHIPPED/name)
            self.assertLess(len(current),len(old))
            image_views={image['bufferView'] for image in before['images']}
            self.assertEqual(len(before['bufferViews']),len(after['bufferViews']))
            for original,optimized in zip(before['bufferViews'],after['bufferViews'],strict=True):
                metadata=lambda view:{k:v for k,v in view.items() if k not in ('byteOffset','byteLength')}
                self.assertEqual(metadata(original),metadata(optimized))
            for index in range(len(before['bufferViews'])):
                if index not in image_views:
                    self.assertEqual(data(before,old,index),data(after,current,index),(name,index))
            checked=set()
            for original,optimized in zip(before['images'],after['images'],strict=True):
                index=original['bufferView']
                self.assertEqual(index,optimized['bufferView'])
                if index in checked:continue
                checked.add(index)
                a=Image.open(io.BytesIO(data(before,old,index))).convert('RGBA')
                b=Image.open(io.BytesIO(data(after,current,index))).convert('RGBA')
                self.assertEqual(a.size,b.size,(name,index))
                self.assertEqual(a.tobytes(),b.tobytes(),(name,index))
                if optimized['mimeType']=='image/webp':optimized_count+=1
            normalized=copy.deepcopy(after)
            for original,optimized in zip(before['images'],normalized['images'],strict=True):
                optimized['mimeType']=original['mimeType']
            for texture in normalized['textures']:
                extension=texture.get('extensions',{}).pop('EXT_texture_webp',None)
                if extension:texture['source']=extension['source']
                if texture.get('extensions')=={}:del texture['extensions']
            for key in ('extensionsUsed','extensionsRequired'):
                if 'EXT_texture_webp' in normalized.get(key,[]) and 'EXT_texture_webp' not in before.get(key,[]):
                    normalized[key].remove('EXT_texture_webp')
                if key not in before and normalized.get(key)==[]:del normalized[key]
            normalized['bufferViews']=before['bufferViews']
            normalized['buffers']=before['buffers']
            self.assertEqual(before,normalized,name)
        self.assertGreater(optimized_count,100)


if __name__=='__main__':unittest.main()
