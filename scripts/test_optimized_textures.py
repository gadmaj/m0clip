"""Verify built native-backed Source textures and scene semantics against PNG masters."""
import copy
import io
import os
from pathlib import Path
import hashlib
import json
import zlib
import unittest
from PIL import Image
from optimize_map_textures import read_glb
from source_assets import decode_vtf
from build_native_map_visuals import EXTENSION

ROOT=Path(__file__).resolve().parent.parent
MASTER=ROOT/'public/assets/maps/nt_ghost_ctg'
SHIPPED=Path(os.environ.get('OPTIMIZED_GHOST_DIRECTORY',ROOT/'dist/assets/maps/nt_ghost_ctg'))


def data(document,binary,index):
    view=document['bufferViews'][index];at=view.get('byteOffset',0)
    return binary[at:at+view['byteLength']]


def _view_identity(document,binary,index):
    view=document['bufferViews'][index]
    return {'SHA256':hashlib.sha256(data(document,binary,index)).hexdigest(),
            'layout':{key:value for key,value in view.items() if key not in ('buffer','byteOffset')}}


def _references(value,document,binary):
    if isinstance(value,dict):
        return {key:(_view_identity(document,binary,item) if key=='bufferView' and type(item)is int
                     else _references(item,document,binary)) for key,item in value.items()}
    if isinstance(value,list):return [_references(item,document,binary) for item in value]
    return value


def _scene(document,binary):
    result={key:value for key,value in document.items() if key not in
            ('buffers','bufferViews','images','textures','extensionsUsed','extensionsRequired')}
    result=_references(result,document,binary)
    for key in ('extensionsUsed','extensionsRequired'):
        result[key]=sorted(value for value in document.get(key,[]) if value not in (EXTENSION,'EXT_texture_webp'))
    return result


def _image(document,binary,texture,pixel_cache,native_cache):
    native=texture.get('extensions',{}).get(EXTENSION)
    if native:
        index=native['bufferView']
        key=('native',index,native['frame'],native['face'])
        if key not in pixel_cache:
            if index not in native_cache:
                stored=data(document,binary,index)
                native_cache[index]=zlib.decompress(stored) if native.get('compression')=='zlib' else stored
            pixels=decode_vtf(native_cache[index],native['frame'],native['face'])
            pixel_cache[key]=((pixels.shape[1],pixels.shape[0]),hashlib.sha256(pixels.tobytes()).hexdigest())
        return pixel_cache[key],native.get('image',{})
    index=texture.get('extensions',{}).get('EXT_texture_webp',{}).get('source',texture.get('source'))
    image=document['images'][index]
    key=('image',image['bufferView'])
    if key not in pixel_cache:
        with Image.open(io.BytesIO(data(document,binary,image['bufferView']))) as encoded:
            pixels=encoded.convert('RGBA')
            pixel_cache[key]=(pixels.size,hashlib.sha256(pixels.tobytes()).hexdigest())
    return pixel_cache[key],{key:value for key,value in image.items() if key not in ('bufferView','mimeType','uri')}


def _texture(document,binary,texture):
    result=copy.deepcopy(texture)
    native=result.get('extensions',{}).pop(EXTENSION,None) or result.get('extras',{}).pop('sourceVtf',None)
    if native:
        native.pop('image',None)
        result['nativeVtf']=_references(native,document,binary)
    result.pop('source',None)
    if 'extensions' in result:
        result['extensions'].pop('EXT_texture_webp',None)
        if not result['extensions']:del result['extensions']
    if result.get('extras')=={}:del result['extras']
    return result


class OptimizedTextures(unittest.TestCase):
    def test_native_pixels_geometry_animation_and_materials_are_preserved(self):
        variants=json.loads((SHIPPED/'manifest.json').read_text())['native_textures']
        for name in ('visual','props'):
            before,old=read_glb(MASTER/f'{name}.glb')
            after,current=read_glb(SHIPPED/variants[name])
            self.assertEqual(_scene(before,old),_scene(after,current),name)
            old_pixels,new_pixels,old_native,new_native={},{},{},{}
            for index,(original,optimized) in enumerate(zip(before['textures'],after['textures'],strict=True)):
                self.assertEqual(_image(before,old,original,old_pixels,old_native),
                                 _image(after,current,optimized,new_pixels,new_native),(name,index))
                self.assertEqual(_texture(before,old,original),_texture(after,current,optimized),(name,index))


if __name__=='__main__':unittest.main()
