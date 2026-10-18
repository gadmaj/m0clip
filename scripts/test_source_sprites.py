"""Ghost glow color factors match the BSP and noclip's non-gamma modulation path."""
import json
from pathlib import Path
import struct
import unittest
from import_source_bsp import BSP,parse


class SpriteTests(unittest.TestCase):
    def test_native_glow_colors_and_valid_rgba(self):
        root=Path(__file__).resolve().parent.parent
        model=parse(BSP((root/'assets/bsp-cache/z.noclip.website_NeoTokyo_NeotokyoSource_maps_nt_ghost_ctg.bsp').read_bytes()))
        entities=[e for e in model['ents'] if e.get('classname')=='env_sprite']
        data=(root/'public/assets/maps/nt_ghost_ctg/props.glb').read_bytes();size=struct.unpack_from('<I',data,12)[0];gltf=json.loads(data[20:20+size])
        nodes=[n for n in gltf['nodes'] if n.get('extras',{}).get('sourceSprite')]
        self.assertEqual(len(nodes),150);self.assertEqual(len(entities),150)
        appended=0;colored=0
        for node,entity in zip(nodes,entities):
            tint=list(map(float,entity['rendercolor'].split()))
            appended+=len(tint)>3;colored+=tint[:3]!=[255,255,255]
            material=gltf['materials'][gltf['meshes'][node['mesh']]['primitives'][0]['material']]
            actual=material['pbrMetallicRoughness']['baseColorFactor']
            self.assertEqual(len(actual),4)
            self.assertEqual(actual[:3],[v/255 for v in tint[:3]])
            self.assertEqual(actual[3],float(entity['renderamt'])/255)
            self.assertEqual(node['extras']['sourceSpriteAlpha'],actual[3])
        self.assertEqual(appended,53);self.assertEqual(colored,91)


if __name__=='__main__':unittest.main()
