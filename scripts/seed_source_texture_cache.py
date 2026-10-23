#!/usr/bin/env python3
"""Reuse already validated PNG/native payloads when converting further Source maps."""
import argparse
import hashlib
from pathlib import Path
import zlib
from optimize_map_textures import read_glb


def seed(directory, cache):
    cache.mkdir(parents=True, exist_ok=True); images = payloads = 0
    for name in ('visual.glb', 'props.glb'):
        path = directory/name
        if not path.exists(): continue
        document, binary = read_glb(path); native = {}
        def view(index):
            v = document['bufferViews'][index]; start = v.get('byteOffset', 0)
            return binary[start:start+v['byteLength']]
        for texture in document['textures']:
            meta = texture.get('extras', {}).get('sourceVtf')
            if not meta or 'source' not in texture: continue
            image = document['images'][texture['source']]
            if image.get('mimeType') != 'image/png': continue
            index = meta['bufferView']
            if index not in native:
                stored = view(index); raw = zlib.decompress(stored) if meta.get('compression') == 'zlib' else stored
                digest = hashlib.sha256(raw).hexdigest(); native[index] = digest
                target = cache/f'v1-{digest}.vtf.zlib'
                if not target.exists():
                    target.write_bytes(stored if meta.get('compression') == 'zlib' else zlib.compress(raw, 9)); payloads += 1
            target = cache/f'v1-{native[index]}-{meta["frame"]}-{meta["face"]}.png'
            if not target.exists(): target.write_bytes(view(image['bufferView'])); images += 1
    return dict(directory=str(directory), images=images, native_payloads=payloads)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directories', nargs='+', type=Path)
    parser.add_argument('--cache', type=Path, default=Path('node_modules/.cache/source-texture-payloads'))
    args = parser.parse_args()
    for directory in args.directories: print(seed(directory, args.cache), flush=True)
