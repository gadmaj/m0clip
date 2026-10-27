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
import subprocess
import sys

import bpy
from mathutils import Vector


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    masters = output / 'masters' / entry['id']
    masters.mkdir(parents=True)
    frames = []
    for index in range(count):
        angle = -math.pi / 3 + index * 2 * math.pi / count
        camera.location = center + Vector((math.cos(angle), math.sin(angle), .22)) * radius * 4
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        frame = masters / f'{index:04d}.png'
        scene.render.filepath = str(frame)
        bpy.ops.render.render(write_still=True)
        frames.append(str(frame))
    encoder = Path(__file__).with_name('encode_character_previews.py')
    encoded = subprocess.run([os.environ.get('PYTHON', 'python3'), str(encoder),
        '--animation-output', str(output / 'assets' / entry['id']), '--fps', str(fps), *frames],
        check=True, text=True, stdout=subprocess.PIPE)
    result = json.loads(encoded.stdout)
    (output / 'assets' / entry['id'] / 'attribution.json').write_text(
        json.dumps(entry['attribution'], ensure_ascii=False, indent=2) + '\n')
    return {**entry, 'mode': '360-degree camera orbit, native rest pose; no simulated motion',
            'encoding': result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    job = json.loads(args.job.read_text())
    output = Path(job['output']).resolve()
    repository = Path(__file__).resolve().parent.parent
    if output.is_relative_to(repository) or output.exists():
        raise ValueError('Output must be a new private directory outside the repository')
    count, fps = job.get('frames', 48), job.get('fps', 12)
    if not 12 <= count <= 120 or not 1 <= fps <= 30:
        raise ValueError('Use 12–120 frames and 1–30 fps')
    output.mkdir(parents=True)
    inventory = []
    for entry in job['characters']:
        if not entry['id'] or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in entry['id']):
            raise ValueError('Invalid character ID')
        inventory.append(render(entry, output, count, fps))
        (output / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    catalog = {'characters': {entry['id']: {
        'still': f"/assets/previews/animated/{entry['id']}/still.min.png",
        'animation': f"/assets/previews/animated/{entry['id']}/turntable.gif",
        'caption': '360° view · rest pose',
    } for entry in inventory}, 'policies': {}}
    (output / 'catalog.json').write_text(json.dumps(catalog, indent=2) + '\n')


if __name__ == '__main__':
    main()
