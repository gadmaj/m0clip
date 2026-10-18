#!/usr/bin/env python3
"""Restore Ghost's native corner normals and tangent frames without changing geometry or textures."""
import argparse
import json
from pathlib import Path
import struct
from import_source_bsp import BSP, parse
from import_source_props import GLB
from source_surface_frames import SurfaceFrames, apply_world_frames, apply_brush_frames


def refresh(directory, bsp):
    manifest = json.loads((directory/'manifest.json').read_text()); frames = SurfaceFrames(bsp, parse(bsp)); report = {}
    for filename, apply in (('visual.glb', apply_world_frames), ('props.glb', apply_brush_frames)):
        path = directory/filename; data = path.read_bytes(); size = struct.unpack_from('<I', data, 12)[0]
        glb = GLB(); glb.json = json.loads(data[20:20+size]); glb.buffer = bytearray(data[28+size:])
        report[filename] = apply(glb, frames, manifest)
        glb.write(path)
    (directory/'surface-frames-report.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--map', choices=['nt_ghost_ctg'], required=True)
    args = parser.parse_args(); root = Path(__file__).resolve().parent.parent
    bsp = BSP((root/'assets/bsp-cache'/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    print(json.dumps(refresh(root/'public/assets/maps'/args.map, bsp), indent=2))
