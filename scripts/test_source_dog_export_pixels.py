"""Exported base/normal/emissive pixels retain all Source channels, including alpha-zero RGB."""
import io
from pathlib import Path
import unittest
import numpy as np
from PIL import Image
from optimize_map_textures import read_glb

ROOT=Path(__file__).resolve().parent.parent


def pixels(document,binary,texture):
    image=document['images'][document['textures'][texture]['source']]
    view=document['bufferViews'][image['bufferView']];at=view.get('byteOffset',0)
    return np.array(Image.open(io.BytesIO(binary[at:at+view['byteLength']])).convert('RGBA'))


class ExportPixels(unittest.TestCase):
    def test_source_texture_channels_survive_export(self):
        source,raw=read_glb(ROOT/'public/assets/source-robots/halflife2-dog/dog.glb')
        exported,data=read_glb(Path('/tmp/source-dog-export.glb'))
        for material in source['materials']:
            copy=next(m for m in exported['materials'] if m['name']==material['name'])
            for group,key in [('pbrMetallicRoughness','baseColorTexture'),(None,'normalTexture'),(None,'emissiveTexture')]:
                original=material[group] if group else material
                result=copy[group] if group else copy
                if key not in original:continue
                a=pixels(source,raw,original[key]['index']);b=pixels(exported,data,result[key]['index'])
                np.testing.assert_array_equal(a,b,err_msg=f"{material['name']} {key}")


if __name__=='__main__':unittest.main()
