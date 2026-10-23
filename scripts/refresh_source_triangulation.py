#!/usr/bin/env python3
"""Restore only Ghost's world/brush triangle indices, retaining all other GLB data."""
import argparse
import json
from pathlib import Path
from import_source_bsp import BSP, parse
from optimize_map_textures import read_glb, write_glb
from source_triangulation import restore_triangles


def refresh_file(path, bsp, model):
    document, raw = read_glb(path)
    binary = bytearray(raw)
    report = restore_triangles(document, binary, bsp, model)
    write_glb(path, document, binary)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True)
    parser.add_argument('--directory', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    bsp = BSP((root/'assets/bsp-cache'/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    model = parse(bsp)
    directory = args.directory or root/'public/assets/maps'/args.map
    report = {name: refresh_file(directory/name, bsp, model) for name in ['visual.glb', 'props.glb']}
    (directory/'triangulation-report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))
