#!/usr/bin/env python3
"""Restore Ghost's directional brush lightmaps without reimporting models or surface geometry."""
import argparse
import json
from pathlib import Path
import struct
from import_source_bsp import BSP, parse
from import_source_props import GLB
from source_brush_lightmaps import restore_brush_lightmaps


def refresh(directory, bsp):
    path = directory/'props.glb'; data = path.read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
    glb = GLB(); glb.json = json.loads(data[20:20+size]); glb.buffer = bytearray(data[28+size:])
    report = restore_brush_lightmaps(glb, parse(bsp)); glb.write(path)
    (directory/'brush-lightmaps-report.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True)
    args = parser.parse_args(); root = Path(__file__).resolve().parent.parent
    bsp = BSP((root/'assets/bsp-cache'/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    print(json.dumps(refresh(root/'public/assets/maps'/args.map, bsp), indent=2))
