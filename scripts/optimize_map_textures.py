#!/usr/bin/env python3
"""Losslessly optimize Source map build artifacts; original PNG masters stay untouched.

Requires Pillow with WebP support. Only accept an encoding after every decoded RGBA
byte matches the source. Geometry, animation, texture indices and material settings
are preserved. GLTFLoader supports the standard EXT_texture_webp extension.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import struct
from PIL import Image, features


def read_glb(path):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', raw)
    if (magic, version, length) != (0x46546c67, 2, len(raw)): raise ValueError('Invalid GLB header')
    size, tag = struct.unpack_from('<II', raw, 12)
    if tag != 0x4e4f534a: raise ValueError('Invalid GLB JSON chunk')
    return json.loads(raw[20:20+size]), raw[28+size:]


def write_glb(path, document, binary):
    binary += bytes(-len(binary) % 4)
    document['buffers'] = [dict(byteLength=len(binary))]
    js = json.dumps(document, separators=(',', ':')).encode()
    js += b' '*(-len(js) % 4)
    raw = struct.pack('<III', 0x46546c67, 2, 28+len(js)+len(binary))
    raw += struct.pack('<II', len(js), 0x4e4f534a)+js
    raw += struct.pack('<II', len(binary), 0x004e4942)+binary
    temporary = path.with_suffix('.optimized.glb')
    temporary.write_bytes(raw); temporary.replace(path)


def encode(png, cache):
    key = hashlib.sha256(png).hexdigest()
    path = cache/(key+'.webp')
    original = Image.open(io.BytesIO(png)).convert('RGBA')
    if path.exists(): encoded = path.read_bytes()
    else:
        output = io.BytesIO()
        original.save(output, 'WEBP', lossless=True, exact=True, method=4)
        encoded = output.getvalue()
    decoded = Image.open(io.BytesIO(encoded)).convert('RGBA')
    if original.size != decoded.size or original.tobytes() != decoded.tobytes():
        raise ValueError(f'Lossless texture pixel check failed: {key}')
    if not path.exists():
        # Multiple image entries can share a payload; cache writes must be atomic.
        import tempfile
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as file:
            temporary = Path(file.name); file.write(encoded)
        temporary.replace(path)
    return encoded if len(encoded) < len(png) else None


def optimize(path, cache, workers=4):
    document, binary = read_glb(path)
    old_bytes = path.stat().st_size
    image_views = {image['bufferView'] for image in document.get('images', [])
                   if image.get('mimeType') == 'image/png' and 'bufferView' in image}
    # A buffer view cannot simultaneously hold image bytes and geometry/accessor data.
    if image_views.intersection(a.get('bufferView') for a in document.get('accessors', [])):
        raise ValueError('Image data overlaps a geometry accessor')
    def convert(index):
        view = document['bufferViews'][index]; at = view.get('byteOffset', 0)
        return index, encode(binary[at:at+view['byteLength']],cache)
    replacements = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for count, (index, encoded) in enumerate(pool.map(convert, sorted(image_views)), 1):
            if encoded: replacements[index] = encoded
            if count % 100 == 0: print(f'{path.name}: checked {count}/{len(image_views)} textures', flush=True)
    if replacements:
        compact = bytearray()
        for index, view in enumerate(document['bufferViews']):
            old_at, old_length = view.get('byteOffset', 0), view['byteLength']
            data = replacements.get(index, binary[old_at:old_at+old_length])
            compact.extend(bytes(-len(compact) % 4))
            view['byteOffset'], view['byteLength'] = len(compact),len(data)
            compact.extend(data)
        changed = set()
        for index, image in enumerate(document['images']):
            if image.get('bufferView') in replacements:
                image['mimeType'] = 'image/webp'; changed.add(index)
        for texture in document['textures']:
            if texture.get('source') in changed:
                texture.setdefault('extensions', {})['EXT_texture_webp'] = {'source':texture.pop('source')}
        for key in ('extensionsUsed', 'extensionsRequired'):
            if 'EXT_texture_webp' not in document.setdefault(key, []): document[key].append('EXT_texture_webp')
        write_glb(path, document, compact)
    return dict(file=path.name, original_bytes=old_bytes, optimized_bytes=path.stat().st_size,
                textures_checked=len(image_views), textures_optimized=len(replacements),
                exact_rgba=True, original_geometry=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--cache', type=Path, default=Path('node_modules/.cache/ghost-lossless-textures'))
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    from import_source_bsp import GAMES
    if args.directory.name not in GAMES['neotokyo'][2]: parser.error('Choose a converted NeoTokyo map directory')
    public = Path(__file__).resolve().parent.parent/'public'
    if args.directory.resolve().is_relative_to(public): parser.error('Use a build output directory; public contains the original PNG masters')
    if not features.check('webp'): raise RuntimeError('Pillow must include WebP support')
    args.cache.mkdir(parents=True,exist_ok=True)
    reports = [optimize(args.directory/name,args.cache,args.workers)
               for name in ('visual.glb','props.glb') if (args.directory/name).exists()]
    report = dict(encoding='lossless WebP', files=reports,
                  original_bytes=sum(r['original_bytes'] for r in reports),
                  optimized_bytes=sum(r['optimized_bytes'] for r in reports))
    if reports: (args.directory/'texture-optimization.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2),flush=True)


if __name__ == '__main__': main()
