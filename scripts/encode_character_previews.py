#!/usr/bin/env python3
"""Recompress explicit PNG masters into pixel-exact .min.png companions.

Usage: python3 scripts/encode_character_previews.py path/to/preview.png [...]
Only IDAT compression changes; every non-IDAT chunk and filtered scanline stays
identical. Requires host Python with Pillow for strict decoded-pixel readback.
PNG masters are never written. Blender importers invoke PYTHON or host python3.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib


def png_chunks(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Preview master is not a PNG')
    chunks = []
    offset = 8
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('Truncated PNG chunk')
        length, kind = struct.unpack_from('>I4s', data, offset)
        end = offset + length + 12
        if end > len(data):
            raise ValueError('Truncated PNG chunk payload')
        chunks.append((kind, data[offset:end]))
        offset = end
    if not chunks or chunks[-1][0] != b'IEND' or not any(kind == b'IDAT' for kind, _ in chunks):
        raise ValueError('PNG requires image data and a final IEND chunk')
    return chunks


def encode_preview(png_path, output=None):
    """Verify filtered data, all chunks and decoded RGBA before publication."""
    from PIL import Image

    png_path = Path(png_path)
    output = Path(output) if output is not None else png_path.with_suffix('.min.png')
    if png_path.suffix.lower() != '.png' or output.suffix.lower() != '.png':
        raise ValueError('Preview recompression requires PNG input and output')
    if png_path.resolve() == output.resolve():
        raise ValueError('Preview output must not replace its PNG master')
    png_bytes = png_path.read_bytes()
    chunks = png_chunks(png_bytes)
    filtered = zlib.decompress(b''.join(raw[8:-4] for kind, raw in chunks if kind == b'IDAT'))
    compressed = zlib.compress(filtered, level=9)
    idat = (struct.pack('>I', len(compressed)) + b'IDAT' + compressed
            + struct.pack('>I', zlib.crc32(b'IDAT' + compressed)))
    encoded_chunks = []
    inserted = False
    for kind, raw in chunks:
        if kind != b'IDAT':
            encoded_chunks.append(raw)
        elif not inserted:
            encoded_chunks.append(idat)
            inserted = True
    recompressed = png_bytes[:8] + b''.join(encoded_chunks)
    used_original = len(recompressed) >= len(png_bytes)
    encoded = png_bytes if used_original else recompressed
    with Image.open(png_path) as source:
        rgba = source.convert('RGBA')
        icc_profile = source.info.get('icc_profile', b'')
    pixels = rgba.tobytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.' + output.name + '.', suffix='.tmp',
                                         dir=output.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
        readback = temporary.read_bytes()
        readback_chunks = png_chunks(readback)
        if ([raw for kind, raw in readback_chunks if kind != b'IDAT']
                != [raw for kind, raw in chunks if kind != b'IDAT']):
            raise ValueError('PNG recompression changed non-IDAT chunks: ' + str(png_path))
        if zlib.decompress(b''.join(raw[8:-4] for kind, raw in readback_chunks if kind == b'IDAT')) != filtered:
            raise ValueError('PNG recompression changed filtered scanline data: ' + str(png_path))
        with Image.open(temporary) as decoded:
            if (decoded.format != 'PNG' or decoded.size != rgba.size
                    or decoded.convert('RGBA').tobytes() != pixels):
                raise ValueError('PNG readback changed preview dimensions or RGBA bytes: ' + str(png_path))
            if decoded.info.get('icc_profile', b'') != icc_profile:
                raise ValueError('PNG readback changed preview ICC profile: ' + str(png_path))
        result = {
            'png': {'path': str(png_path), 'bytes': len(png_bytes),
                    'sha256': hashlib.sha256(png_bytes).hexdigest()},
            'preview': {'path': str(output), 'bytes': len(readback),
                        'sha256': hashlib.sha256(readback).hexdigest()},
            'width': rgba.width, 'height': rgba.height,
            'rgbaSHA256': hashlib.sha256(pixels).hexdigest(),
            'filteredDataSHA256': hashlib.sha256(filtered).hexdigest(),
            'iccSHA256': hashlib.sha256(icc_profile).hexdigest() if icc_profile else None,
            'rgbaByteExact': True, 'iccByteExact': True,
            'filteredDataByteExact': True, 'nonIDATByteExact': True,
            'usedOriginalBytes': used_original,
            'savedBytes': len(png_bytes) - len(readback),
        }
        temporary.replace(output)
        return result
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def encode_preview_with_host(png_path):
    """Keep Pillow out of Blender's bundled Python; propagate encoder failures."""
    completed = subprocess.run(
        [os.environ.get('PYTHON', 'python3'), str(Path(__file__).resolve()), str(png_path)],
        check=True, stdout=subprocess.PIPE, text=True)
    result = json.loads(completed.stdout)
    print(completed.stdout, end='', flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('png', type=Path, nargs='+', help='Explicit PNG masters; no recursive discovery')
    args = parser.parse_args()
    for png in args.png:
        print(json.dumps(encode_preview(png)), flush=True)
