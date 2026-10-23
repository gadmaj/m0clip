#!/usr/bin/env python3
"""Build native-VTF Ghost visuals without duplicate decoded preview images.

PNG masters and ordinary GLBs remain untouched. The required runtime extension
provides the same RGBA pixels lazily for lossless export; every removed preview
is checked against its native VTF before the variant is written.
"""
import argparse
import io
import json
import os
from pathlib import Path
import tempfile
import zlib
from PIL import Image
from optimize_map_textures import read_glb, write_glb, optimize
from source_assets import decode_vtf

EXTENSION = 'M0CLIP_texture_vtf'


def image_sources(texture):
    if 'source' in texture:
        yield texture, 'source'
    for extension in texture.get('extensions', {}).values():
        if isinstance(extension, dict) and type(extension.get('source')) is int:
            yield extension, 'source'


def buffer_view_references(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'bufferView' and type(item) is int:
                yield item
            else:
                yield from buffer_view_references(item)
    elif isinstance(value, list):
        for item in value:
            yield from buffer_view_references(item)


def remap_buffer_views(value, remap):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'bufferView' and type(item) is int:
                value[key] = remap[item]
            else:
                remap_buffer_views(item, remap)
    elif isinstance(value, list):
        for item in value:
            remap_buffer_views(item, remap)


def build_variant(source, target, cache):
    document, binary = read_glb(source)
    views = document['bufferViews']

    def data(index):
        view = views[index]
        start = view.get('byteOffset', 0)
        end = start + view['byteLength']
        if view.get('buffer', 0) != 0 or start < 0 or end > len(binary):
            raise ValueError('Source bufferView is outside the GLB binary chunk')
        return binary[start:end]

    native_buffers = {}
    fallback_images = set()
    checked = 0
    for texture in document.get('textures', []):
        meta = texture.get('extras', {}).get('sourceVtf')
        if not meta:
            continue
        sources = list(image_sources(texture))
        if not sources or len({parent[key] for parent, key in sources}) != 1:
            raise ValueError('Native texture must have one unambiguous preview image')
        image_index = sources[0][0][sources[0][1]]
        image = document['images'][image_index]
        if 'bufferView' not in image:
            raise ValueError('Native preview must be embedded for exact-pixel verification')
        native_index = meta['bufferView']
        if native_index not in native_buffers:
            stored = data(native_index)
            if meta.get('compression') not in (None, 'zlib'):
                raise ValueError('Unsupported native VTF compression')
            native_buffers[native_index] = zlib.decompress(stored) if meta.get('compression') == 'zlib' else stored
        pixels = decode_vtf(native_buffers[native_index], meta['frame'], meta['face'])
        with Image.open(io.BytesIO(data(image['bufferView']))) as encoded:
            original = encoded.convert('RGBA')
            if pixels is None or original.size != (pixels.shape[1], pixels.shape[0]) or original.tobytes() != pixels.tobytes():
                raise ValueError(f'Native export pixels differ: {meta["path"]} frame {meta["frame"]} face {meta["face"]}')
        descriptor = dict(meta)
        image_metadata = {key: value for key, value in image.items() if key not in ('bufferView', 'mimeType', 'uri')}
        if image_metadata:
            descriptor['image'] = image_metadata
        texture.pop('source', None)
        extensions = texture.setdefault('extensions', {})
        extensions.pop('EXT_texture_webp', None)
        extensions[EXTENSION] = descriptor
        del texture['extras']['sourceVtf']
        if not texture['extras']:
            del texture['extras']
        fallback_images.add(image_index)
        checked += 1
    if not checked:
        raise ValueError('Ghost visual contains no native Source textures')

    remaining_images = {parent[key] for texture in document['textures'] for parent, key in image_sources(texture)}
    removed_images = fallback_images - remaining_images
    removed_image_views = {document['images'][index]['bufferView'] for index in removed_images}
    kept_images = [index for index in range(len(document['images'])) if index not in removed_images]
    image_remap = {old: new for new, old in enumerate(kept_images)}
    document['images'] = [document['images'][index] for index in kept_images]
    if not document['images']:
        del document['images']
    for texture in document['textures']:
        for parent, key in image_sources(texture):
            parent[key] = image_remap[parent[key]]

    referenced_views = set(buffer_view_references(document))
    removed_views = removed_image_views - referenced_views
    kept_views = [index for index in range(len(views)) if index not in removed_views]
    view_remap = {old: new for new, old in enumerate(kept_views)}
    remap_buffer_views(document, view_remap)
    compact = bytearray()
    output_views = []
    for index in kept_views:
        payload = data(index)
        view = dict(views[index])
        compact.extend(bytes(-len(compact) % 4))
        view['byteOffset'] = len(compact)
        compact.extend(payload)
        output_views.append(view)
    document['bufferViews'] = output_views
    has_webp = any('EXT_texture_webp' in texture.get('extensions', {}) for texture in document['textures'])
    for key in ('extensionsUsed', 'extensionsRequired'):
        values = document.setdefault(key, [])
        if not has_webp and 'EXT_texture_webp' in values:
            values.remove('EXT_texture_webp')
        if EXTENSION not in values:
            values.append(EXTENSION)
    write_glb(target, document, compact)
    optimized = optimize(target, cache, workers=2)
    return dict(file=target.name, original_bytes=source.stat().st_size,
                native_textures=checked, removed_images=len(removed_images),
                removed_image_views=len(removed_views),
                removed_encoded_image_bytes=sum(views[index]['byteLength'] for index in removed_views),
                variant_bytes=target.stat().st_size, exact_rgba=True,
                remaining_images=optimized)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--cache', type=Path, default=Path('node_modules/.cache/ghost-lossless-textures'))
    args = parser.parse_args()
    output = args.output.resolve()
    directory = args.output / 'assets/maps/nt_ghost_ctg'
    if not directory.is_dir():
        return
    public = (Path(__file__).resolve().parent.parent / 'public').resolve()
    if output.is_relative_to(public) or not directory.resolve().is_relative_to(output):
        raise ValueError('Native Ghost variants require a real build-output directory, not source assets or a linked map directory')
    manifest_path = directory / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    args.cache.mkdir(parents=True, exist_ok=True)
    reports = []
    variants = {}
    for name in ('visual', 'props'):
        source = directory / f'{name}.glb'
        if not source.exists():
            continue
        target = directory / f'{name}-native.glb'
        reports.append(build_variant(source, target, args.cache))
        variants[name] = target.name
    if 'visual' not in variants:
        raise ValueError('Ghost visual.glb is missing')
    manifest['native_textures'] = variants
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(manifest, stream, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(manifest_path)
    print(json.dumps(dict(extension=EXTENSION, native_textures=variants, files=reports), indent=2), flush=True)


if __name__ == '__main__':
    main()
