#!/usr/bin/env python3
"""Render approved GLB rest-pose turntables with Blender, then encode GIF/still pairs.

blender -b --python scripts/generate-character-turntables.py -- --job job.json
A job lists explicit approved existing runtime assets, their SHA256 and attribution.
All output goes to a new private directory; this never imports pending intakes.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import sys

import bpy
from mathutils import Vector


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path, value):
    """Replace a checkpoint only after its complete replacement is durable."""
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.' + path.name + '-',
                                     dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def validate_completed(record, entry, output, count, fps):
    """Reuse receipts only for this exact approved source/job and served bytes."""
    if any(record.get(key) != value for key, value in entry.items()):
        raise ValueError('Completed metadata differs from the explicit job: ' + entry['id'])
    if digest(Path(entry['input'])) != entry['sha256']:
        raise ValueError('Completed runtime asset hash changed: ' + entry['id'])
    encoding = record['encoding']
    if (len(encoding['sourceFrames']) != count
            or encoding['animation']['durationMs'] != round(count * 100 / fps) * 10
            or encoding['width'] != 320 or encoding['height'] != 240):
        raise ValueError('Completed render format/timing differs from the explicit job: ' + entry['id'])
    destination = output / 'assets' / entry['id']
    for saved, filename in [(encoding['still']['preview'], 'still.min.png'),
                            (encoding['animation'], 'turntable.gif')]:
        if Path(saved['path']) != destination / filename or digest(destination / filename) != saved['sha256']:
            raise ValueError('Completed encoded asset path/hash changed: ' + entry['id'])
    if json.loads((destination / 'attribution.json').read_text()) != entry['attribution']:
        raise ValueError('Completed attribution differs from the approved job: ' + entry['id'])


def render(entry, output, count, fps):
    source = Path(entry['input']).resolve()
    if source.suffix != '.glb' or digest(source) != entry['sha256']:
        raise ValueError('Runtime GLB hash mismatch: ' + entry['id'])
    if not entry['approvedRuntimeAsset'] or not entry['attribution']['license']:
        raise ValueError('An existing approved asset and its real attribution are required')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    scene = bpy.context.scene
    for obj in scene.objects:
        obj.animation_data_clear()
        if obj.type == 'ARMATURE':
            obj.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    meshes = [obj for obj in scene.objects if obj.type == 'MESH']
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not points:
        raise ValueError('Runtime asset contains no mesh geometry')
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = (low + high) / 2
    radius = max((point - center).length for point in points)
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 8
    scene.cycles.seed = 0
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 2
    scene.render.resolution_x = 320
    scene.render.resolution_y = 240
    scene.render.resolution_percentage = 100
    scene.render.use_persistent_data = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.world = bpy.data.worlds.new('Preview world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.24, .24, .24, 1)
    data = bpy.data.cameras.new('Turntable camera')
    camera = bpy.data.objects.new('Turntable camera', data)
    scene.collection.objects.link(camera)
    data.type = 'ORTHO'
    data.ortho_scale = radius * 2.5 * 4 / 3
    scene.camera = camera
    for name, offset, power in [('Key', (2, -3, 4), 500), ('Fill', (-3, -1, 2), 250), ('Rim', (1, 3, 3), 350)]:
        lamp = bpy.data.lights.new(name, 'AREA')
        lamp.energy = power * radius * radius
        lamp.size = radius * 4
        obj = bpy.data.objects.new(name, lamp)
        scene.collection.objects.link(obj)
        obj.location = center + Vector(offset) * radius
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
    masters = Path(tempfile.mkdtemp(prefix='render-' + entry['id'] + '-', dir=output))
    frames = []
    for index in range(count):
        angle = -math.pi / 3 + index * 2 * math.pi / count
        camera.location = center + Vector((math.cos(angle), math.sin(angle), .22)) * radius * 4
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.keyframe_insert(data_path='location', frame=index)
        camera.keyframe_insert(data_path='rotation_euler', frame=index)
        frames.append(str(masters / f'{index:04d}.png'))
    scene.frame_start = 0
    scene.frame_end = count - 1
    scene.render.filepath = str(masters) + os.sep
    bpy.ops.render.render(animation=True)
    # Never encode into the public-facing identity directory: an interrupted
    # encoder must leave evidence, not poison the destination of a later resume.
    invocation = Path(tempfile.mkdtemp(prefix='encode-' + entry['id'] + '-', dir=output))
    encoded_root = invocation / 'verified'
    encoder = Path(__file__).with_name('encode_character_previews.py')
    encoded = subprocess.run([os.environ.get('PYTHON', 'python3'), str(encoder),
        '--animation-output', str(encoded_root), '--fps', str(fps), *frames],
        check=True, text=True, stdout=subprocess.PIPE)
    result = json.loads(encoded.stdout)
    destination = output / 'assets' / entry['id']
    result['still']['png']['path'] = str(destination / 'still.png')
    result['still']['preview']['path'] = str(destination / 'still.min.png')
    result['animation']['path'] = str(destination / 'turntable.gif')
    atomic_json(encoded_root / 'encoding.json', result)
    atomic_json(encoded_root / 'attribution.json', entry['attribution'])
    record = {**entry, 'mode': '360-degree camera orbit, native rest pose; no simulated motion',
              'encoding': result}
    # The receipt travels with the verified directory. If publication succeeds
    # but inventory checkpointing is interrupted, resume can validate and recover
    # this complete transaction without re-rendering or trusting a partial folder.
    atomic_json(encoded_root / '.completion.json', record)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ValueError('Destination appeared during render; verified staging retained: ' + str(destination))
    encoded_root.rename(destination)
    invocation.rmdir()
    shutil.rmtree(masters)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--resume', action='store_true', help='Reuse only hash-matching completed private outputs')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    job = json.loads(args.job.read_text())
    output = Path(job['output']).resolve()
    repository = Path(__file__).resolve().parent.parent
    if output.is_relative_to(repository) or (output.exists() and not args.resume):
        raise ValueError('Output must be new private staging, or explicit --resume outside the repository')
    count, fps = job.get('frames', 48), job.get('fps', 12)
    if not 12 <= count <= 120 or not 1 <= fps <= 30:
        raise ValueError('Use 12–120 frames and 1–30 fps')
    output.mkdir(parents=True, exist_ok=args.resume)
    inventory_path = output / 'inventory.json'
    previous = []
    if args.resume and inventory_path.is_file():
        previous = json.loads(inventory_path.read_text())
    completed = {entry['id']: entry for entry in previous}
    approved = {entry['id']: entry for entry in job['characters']}
    if len(completed) != len(previous) or len(approved) != len(job['characters']):
        raise ValueError('Duplicate character IDs in job or completed inventory')
    if completed.keys() - approved.keys():
        raise ValueError('Completed inventory contains characters outside the explicit job')
    # Validate every existing receipt before adding anything. Crucially, keep
    # the entire completed map; checkpointing an addition never drops records
    # that a later iteration has not visited yet.
    for entry in job['characters']:
        if not entry['id'] or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in entry['id']):
            raise ValueError('Invalid character ID')
        if not entry['approvedRuntimeAsset'] or not entry['attribution']['license']:
            raise ValueError('An approved runtime asset and its real attribution are required')
        if entry['id'] in completed:
            validate_completed(completed[entry['id']], entry, output, count, fps)
    for entry in job['characters']:
        if entry['id'] in completed:
            continue
        destination = output / 'assets' / entry['id']
        if destination.exists():
            receipt = destination / '.completion.json'
            if receipt.is_file():
                recovered = json.loads(receipt.read_text())
                validate_completed(recovered, entry, output, count, fps)
                completed[entry['id']] = recovered
                atomic_json(inventory_path, list(completed.values()))
                continue
            # Legacy or interrupted output without a verified transaction marker
            # is not accepted or overwritten. Preserve it verbatim before a new
            # invocation encodes into its own fresh staging directory.
            quarantine = Path(tempfile.mkdtemp(prefix='incomplete-' + entry['id'] + '-', dir=output))
            destination.rename(quarantine / 'assets')
            atomic_json(quarantine / 'origin.json', {'originalPath': str(destination), 'id': entry['id']})
        completed[entry['id']] = render(entry, output, count, fps)
        atomic_json(inventory_path, list(completed.values()))
    catalog = {'characters': {entry['id']: {
        'still': f"/assets/previews/animated/{entry['id']}/still.min.png",
        'animation': f"/assets/previews/animated/{entry['id']}/turntable.gif",
        'caption': '360° view · rest pose',
    } for entry in job['characters']}, 'policies': {}}
    atomic_json(output / 'catalog.json', catalog)


if __name__ == '__main__':
    main()
