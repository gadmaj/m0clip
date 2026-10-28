#!/usr/bin/env python3
"""Recompress explicit PNG masters into pixel-exact .min.png companions.

Usage: python3 scripts/encode_character_previews.py path/to/preview.png [...]
Only IDAT compression changes; every non-IDAT chunk and filtered scanline stays
identical. Requires host Python with Pillow for strict decoded-pixel readback.
PNG masters are never written. Blender importers invoke PYTHON or host python3.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib


def admit_output(destination, additional=0):
    """Optional shared admission bounds resolved destinations and retained bytes."""
    root = os.environ.get('PREVIEW_BUDGET_ROOT')
    if not root:
        return
    root = Path(root).resolve(strict=True)
    destination = Path(destination).resolve()
    if root == destination or root not in destination.parents:
        raise ValueError('Artwork output must be within shared artwork budget root')
    cap = int(os.environ['PREVIEW_BUDGET_BYTES'])
    floor = int(os.environ['PREVIEW_MIN_FREE_BYTES'])
    reserve = int(os.environ['PREVIEW_RESERVE_BYTES'])
    if cap <= 0 or min(floor, reserve, additional) < 0:
        raise ValueError('Invalid artwork byte admission')
    used = 0
    for directory, directories, files in os.walk(root):
        for name in directories + files:
            entry = Path(directory) / name
            if entry.is_symlink():
                raise ValueError('Artwork budget roots must not contain borrowed links')
        used += sum((Path(directory) / name).stat().st_size for name in files)
    disk = os.statvfs(root)
    if used + additional + reserve > cap or disk.f_bavail * disk.f_frsize - additional - reserve < floor:
        raise ValueError(f'Artwork budget/floor reached: retained={used}, next={additional}, reserve={reserve}')


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
    admit_output(output, len(encoded))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        # The admitted output parent also contains the exclusively created temp;
        # no caller-controlled path component is added by NamedTemporaryFile.
        with tempfile.NamedTemporaryFile(prefix='.' + output.name + '.', suffix='.tmp',
                                         dir=output.parent, delete=False) as handle:
            temporary = Path(handle.name)
            admit_output(temporary, len(encoded))
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
        admit_output(output)
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


def encode_animation(frames, output_root, fps=12, timestamps=None):
    """Encode rendered masters only; GIF is lossy, reduced-motion PNG is exact."""
    from PIL import Image

    frames = [Path(frame).resolve() for frame in frames]
    output_root = Path(output_root).resolve()
    if not 2 <= len(frames) <= 120 or not 1 <= fps <= 30:
        raise ValueError('Animation requires 2–120 explicit frames at 1–30 fps')
    if output_root.exists():
        raise ValueError('Animation output must be a new private staging directory')
    admit_output(output_root)
    images, records = [], []
    for frame in frames:
        with Image.open(frame) as source:
            rgba = source.convert('RGBA')
        if images and rgba.size != images[0].size:
            raise ValueError('Animation frame dimensions differ')
        if max(rgba.size) > 512:
            raise ValueError('Preview frames must be at most 512 pixels per side')
        # Composite transparent authored pixels onto the gallery charcoal.
        background = Image.new('RGBA', rgba.size, (24, 26, 23, 255))
        background.alpha_composite(rgba)
        image = background.convert('RGB')
        images.append(image)
        records.append({'sha256': hashlib.sha256(frame.read_bytes()).hexdigest(),
                        'rgbSHA256': hashlib.sha256(image.tobytes()).hexdigest()})
    if len({record['rgbSHA256'] for record in records}) < 2:
        raise ValueError('Animation masters contain no visual change')
    # GIF stores centiseconds; distribute rounding instead of speeding up 12 fps.
    durations = [round((index + 1) * 100 / fps) * 10 - round(index * 100 / fps) * 10
                 for index in range(len(frames))]
    if timestamps is not None:
        if len(timestamps) != len(frames):
            raise ValueError('One actual simulation timestamp is required per frame')
        intervals = [b - a for a, b in zip(timestamps, timestamps[1:])]
        if any(not 0 < interval <= 5 for interval in intervals):
            raise ValueError('Simulation timestamps must increase with gaps at most 5 seconds')
        durations = [max(10, round(interval * 100) * 10) for interval in intervals]
        durations.append(durations[-1])
    palettes = [image.quantize(colors=256) for image in images]
    gif_bytes = io.BytesIO()
    palettes[0].save(gif_bytes, format='GIF', save_all=True, append_images=palettes[1:],
                     duration=durations, loop=0, disposal=2, optimize=False)
    still_bytes = io.BytesIO()
    images[0].save(still_bytes, format='PNG')
    # Reserve actual GIF bytes and both still files before any output write.
    # encode_preview never retains a recompression larger than its input.
    admit_output(output_root, len(gif_bytes.getbuffer()) + 2 * len(still_bytes.getbuffer()))
    output_root.mkdir(parents=True)
    still_master = output_root / 'still.png'
    admit_output(still_master, len(still_bytes.getbuffer()))
    still_master.write_bytes(still_bytes.getbuffer())
    still = encode_preview(still_master)
    output = output_root / 'turntable.gif'
    admit_output(output, len(gif_bytes.getbuffer()))
    output.write_bytes(gif_bytes.getbuffer())
    with Image.open(output) as decoded:
        if decoded.format != 'GIF' or decoded.size != images[0].size or decoded.n_frames < 2:
            raise ValueError('GIF readback lost animation or dimensions')
        decoded_frames = decoded.n_frames
        decoded_ms = 0
        for index in range(decoded_frames):
            decoded.seek(index)
            decoded.convert('RGB').load()
            decoded_ms += decoded.info.get('duration', 0)
    result = {'still': still, 'animation': {'path': str(output), 'bytes': output.stat().st_size,
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'frames': decoded_frames,
        'durationMs': decoded_ms, 'encoding': 'GIF89a, per-frame 256-color palette (lossy)'},
        'width': images[0].width, 'height': images[0].height, 'sourceFrames': records}
    receipt = json.dumps(result, indent=2) + '\n'
    receipt_path = output_root / 'encoding.json'
    admit_output(receipt_path, len(receipt.encode()))
    receipt_path.write_text(receipt)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('png', type=Path, nargs='+', help='Explicit PNG masters; no recursive discovery')
    parser.add_argument('--animation-output', type=Path, help='New private directory for GIF + real still')
    parser.add_argument('--fps', type=int, default=12)
    parser.add_argument('--timestamps', type=Path, help='JSON array of actual simulation seconds')
    args = parser.parse_args()
    if args.animation_output:
        timestamps = json.loads(args.timestamps.read_text()) if args.timestamps else None
        print(json.dumps(encode_animation(args.png, args.animation_output, args.fps, timestamps)), flush=True)
    else:
        for png in args.png:
            print(json.dumps(encode_preview(png)), flush=True)
