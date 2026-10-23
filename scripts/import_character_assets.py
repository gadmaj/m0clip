#!/usr/bin/env python3
"""Blender-only licensed character conversion; invoke with -- --config asset.json.

Config paths source/output/preview/analysis are relative to the config directory
unless absolute. --source-root overrides sourceRoot for extracted source files.
Supported inputs: FBX, BLEND and glTF. Config attribution is embedded verbatim;
public output requires redistributionApproved=true and source-file SHA256 records.
Optional meshNames excludes source control-shape meshes, imageOverrides selects
supplied texture variants, and materialTextures connects explicitly supplied maps.
Optional textureMaxDimension defaults to 512; set it to preserve higher-resolution maps.
nativeGltfPacking retains embedded glTF data directly and renders its native pose;
it never publishes Blender's potentially lossy glTF round-trip.
Preview paths name retained PNG masters; runtime companions are .min.png files,
recompressed and checked by host PYTHON (default python3), which requires Pillow.
No geometry simplification, rig replacement or skin-influence truncation occurs.
Run through flock /tmp/m0clip-blender-import.lock, --disable-autoexec --threads 2.
"""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import struct
import sys

import bpy
from mathutils import Vector

encode_preview = runpy.run_path(str(Path(__file__).with_name('encode_character_previews.py')))['encode_preview_with_host']


def record(path):
    return {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def bounds(points):
    return [[min(p[i] for p in points) for i in range(3)],
            [max(p[i] for p in points) for i in range(3)]]


def convert(config_path, source_root=None):
    config = json.loads(config_path.read_text())
    base = config_path.parent
    def path(key, default=None):
        value = config.get(key, default)
        if value is None:
            return None
        result = Path(value)
        return result if result.is_absolute() else base / result
    root = source_root or path('sourceRoot', '.')
    source = root / config['source']
    output = path('output')
    attribution = config['attribution']
    for field in ('name', 'creator', 'copyright', 'license', 'sourceUrl', 'modifications'):
        if not attribution.get(field):
            raise ValueError('Missing attribution field: ' + field)
    if '/public/' in str(output.resolve()):
        if not config.get('redistributionApproved') or not attribution.get('licenseUrl') or not config.get('sourceFiles'):
            raise ValueError('Public assets require proven redistribution and source hashes')
    source_records = {}
    for name, expected in config.get('sourceFiles', {}).items():
        actual = record(root / name)
        if actual['sha256'] != expected:
            raise ValueError('Source hash mismatch: ' + name)
        source_records[name] = actual
    if config.get('nativeGltfPacking'):
        native = runpy.run_path(str(Path(__file__).with_name('import_native_character_gltf.py')))
        native['convert'](config, source, output, path('preview'),
                          path('analysis', str(output.with_name('analysis.json'))),
                          source_records, record, encode_preview)
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    suffix = source.suffix.lower()
    if suffix == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    elif suffix == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(source), use_anim=True, ignore_leaf_bones=True,
                                 automatic_bone_orientation=False)
    elif suffix in ('.gltf', '.glb'):
        bpy.ops.import_scene.gltf(filepath=str(source))
    else:
        raise ValueError('Unsupported source format: ' + suffix)
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    scene = bpy.context.scene
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 2
    mesh_names = config.get('meshNames')
    meshes = [o for o in scene.objects if o.type == 'MESH' and len(o.data.polygons)
              and (mesh_names is None or o.name in mesh_names)]
    if not meshes:
        raise ValueError('No authored surface meshes selected')
    armatures = list({m.object for o in meshes for m in o.modifiers if m.type == 'ARMATURE' and m.object})
    if not armatures:
        raise ValueError('No working authored skin: rig asset before conversion')
    applied_scales = []
    if config.get('applyRigObjectScale'):
        for armature in armatures:
            armature.data.pose_position = 'REST'
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        before = {}
        for obj in meshes:
            evaluated = obj.evaluated_get(depsgraph)
            before[obj.name] = [evaluated.matrix_world @ v.co for v in evaluated.data.vertices]
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes + armatures:
            obj.select_set(True)
            applied_scales.append({'name': obj.name, 'scale': list(obj.scale)})
        bpy.context.view_layer.objects.active = armatures[0]
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bpy.context.view_layer.update()
        maximum_error = 0.0
        for obj in meshes:
            evaluated = obj.evaluated_get(depsgraph)
            original = before[obj.name]
            if len(original) != len(evaluated.data.vertices):
                raise ValueError('Applying rig scale changed authored vertex count')
            maximum_error = max(maximum_error, max(
                ((evaluated.matrix_world @ vertex.co) - point).length
                for vertex, point in zip(evaluated.data.vertices, original)))
        if maximum_error > 1e-5:
            raise ValueError(f'Applying rig scale changed evaluated bind shape: {maximum_error}')
        print(json.dumps({'appliedRigObjectScales': applied_scales, 'maximumBindShapeError': maximum_error}))
    used_materials = {m for o in meshes for m in o.data.materials if m}
    images = set()
    for material in used_materials:
        if material.use_nodes:
            for node in material.node_tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image:
                    old = node.image
                    override = config.get('imageOverrides', {}).get(old.name)
                    if override:
                        node.image = bpy.data.images.load(str(root / override), check_existing=True)
                    elif old.source == 'FILE' and not old.packed_file:
                        resolved = Path(bpy.path.abspath(old.filepath))
                        if not resolved.is_file():
                            raise FileNotFoundError('Missing authored image: ' + str(resolved))
                        old.reload()
                    images.add(node.image)
        texture = config.get('materialTextures', {}).get(material.name)
        if texture:
            material.use_nodes = True
            tree = material.node_tree
            bsdf = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if bsdf is None:
                raise ValueError('Explicit map connection requires existing Principled material')
            for role, filename in texture.items():
                image = bpy.data.images.load(str(root / filename), check_existing=True)
                node = tree.nodes.new('ShaderNodeTexImage'); node.image = image
                if role == 'baseColor':
                    tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
                elif role == 'normal':
                    image.colorspace_settings.name = 'Non-Color'
                    normal = tree.nodes.new('ShaderNodeNormalMap')
                    tree.links.new(node.outputs['Color'], normal.inputs['Color'])
                    tree.links.new(normal.outputs['Normal'], bsdf.inputs['Normal'])
                else:
                    raise ValueError('Unsupported texture role: ' + role)
                images.add(image)
    image_report = []
    texture_limit = config.get('textureMaxDimension', 512)
    if not isinstance(texture_limit, int) or isinstance(texture_limit, bool) or texture_limit < 1:
        raise ValueError('textureMaxDimension must be a positive integer')
    for image in images:
        original = list(image.size)
        if not min(original):
            raise ValueError('Unreadable source texture: ' + image.name)
        ratio = min(1, texture_limit / max(original))
        if ratio < 1:
            image.scale(max(1, round(original[0] * ratio)), max(1, round(original[1] * ratio)))
        image.pack()
        image_report.append({'name': image.name, 'sourceDimensions': original, 'dimensions': list(image.size)})
    report = {'source': config['source'], 'sourceFiles': source_records,
              'sourceArchive': config.get('sourceArchive'), 'attribution': attribution,
              'redistributionApproved': bool(config.get('redistributionApproved')),
              'blender': bpy.app.version_string, 'sourceForward': config.get('sourceForward'),
              'gltfAxes': '+Y up; Blender -Y forward becomes glTF +Z forward',
              'meshes': [], 'armatures': [], 'images': image_report,
              'animations': [{'name': a.name, 'frameRange': list(a.frame_range)} for a in bpy.data.actions]}
    all_points = []
    for armature in armatures:
        armature.data.pose_position = 'REST'
        report['armatures'].append({'name': armature.name, 'bones': [
            {'name': b.name, 'parent': b.parent.name if b.parent else None,
             'headWorld': list(armature.matrix_world @ b.head_local),
             'tailWorld': list(armature.matrix_world @ b.tail_local), 'deform': b.use_deform}
            for b in armature.data.bones]})
    bpy.context.view_layer.update()
    for obj in meshes:
        obj.data.calc_loop_triangles()
        points = [obj.matrix_world @ v.co for v in obj.data.vertices]; all_points.extend(points)
        skin_targets = [m.object for m in obj.modifiers if m.type == 'ARMATURE' and m.object]
        attachment = None
        ancestor = obj
        while ancestor.parent:
            if ancestor.parent_type == 'BONE' and ancestor.parent in armatures:
                if ancestor.parent_bone not in ancestor.parent.data.bones:
                    raise ValueError('Invalid native bone attachment: ' + obj.name)
                attachment = {'armature': ancestor.parent.name, 'bone': ancestor.parent_bone}
                break
            ancestor = ancestor.parent
        rigid = not skin_targets and config.get('allowRigidBoneAttachments') and attachment
        bone_names = {b.name for a in skin_targets for b in a.data.bones}
        counts = []
        sums = []
        for vertex in obj.data.vertices:
            weights = [g.weight for g in vertex.groups if g.weight > 0 and obj.vertex_groups[g.group].name in bone_names]
            counts.append(len(weights)); sums.append(sum(weights))
        if not rigid and (not min(counts) or max(counts) > 8):
            raise ValueError('Every skinned vertex must have one to eight real weights; unweighted meshes require a proven native bone attachment: ' + obj.name)
        # glTF requires a unit total. Normalize before Blender's validator can
        # clamp individual source weights above one and alter their ratios.
        if not rigid:
            for vertex, total in zip(obj.data.vertices, sums):
                weighted_groups = [(g.group, g.weight) for g in vertex.groups
                                   if g.weight > 0 and obj.vertex_groups[g.group].name in bone_names]
                for group, weight in weighted_groups:
                    obj.vertex_groups[group].add([vertex.index], weight / total, 'REPLACE')
        obj['sourcePartNames'] = [m.name if m else obj.name for m in obj.data.materials]
        report['meshes'].append({'name': obj.name, 'vertices': len(obj.data.vertices),
            'triangles': len(obj.data.loop_triangles), 'boundsWorld': bounds(points),
            'materials': [m.name if m else None for m in obj.data.materials],
            'maxInfluences': max(counts), 'sourceWeightSumRange': [min(sums), max(sums)],
            'weightsNormalizedPreservingRatios': not bool(rigid),
            'nativeBoneAttachment': attachment, 'rigidNativeAttachment': bool(rigid),
            'verticesOverFourInfluences': sum(c > 4 for c in counts)})
    report['boundsWorld'] = bounds(all_points)
    report['triangles'] = sum(m['triangles'] for m in report['meshes'])
    report['vertices'] = sum(m['vertices'] for m in report['meshes'])
    scene['attribution'] = attribution
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes + armatures:
        obj.select_set(True)
    # Retain ancestors even when an authored mesh/armature uses an empty transform.
    for obj in meshes + armatures:
        parent = obj.parent
        while parent:
            parent.select_set(True); parent = parent.parent
    output.parent.mkdir(parents=True, exist_ok=True)
    for armature in armatures:
        armature.data.pose_position = 'POSE'
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=True,
        export_materials='EXPORT', export_image_format='AUTO', export_skins=True,
        export_all_influences=True, export_def_bones=config.get('exportDeformOnly', False),
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
        export_apply=False, export_extras=True, export_cameras=False, export_lights=False)
    data = output.read_bytes(); size, kind = struct.unpack_from('<I4s', data, 12)
    if kind != b'JSON':
        raise ValueError('Expected GLB JSON chunk')
    gltf = json.loads(data[20:20 + size]); remainder = data[20 + size:]
    gltf['asset']['copyright'] = attribution['copyright']
    gltf['asset'].setdefault('extras', {})['attribution'] = attribution
    for gltf_scene in gltf.get('scenes', []):
        gltf_scene.setdefault('extras', {})['attribution'] = attribution
    encoded = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    output.write_bytes(struct.pack('<4sII', b'glTF', 2, 20 + len(encoded) + len(remainder)) +
                       struct.pack('<I4s', len(encoded), b'JSON') + encoded + remainder)
    report['output'] = record(output)
    report['gltf'] = {'skins': [{'name': s.get('name'), 'jointCount': len(s['joints'])} for s in gltf.get('skins', [])],
        'animations': [{'name': a.get('name'), 'channels': len(a['channels'])} for a in gltf.get('animations', [])],
        'materials': gltf.get('materials', []), 'meshCount': len(gltf.get('meshes', []))}
    preview = path('preview')
    if preview:
        for armature in armatures:
            armature.data.pose_position = 'REST'
        bpy.context.view_layer.update()
        for obj in scene.objects:
            obj.hide_render = obj not in meshes
        scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = 24
        scene.render.resolution_x = 384; scene.render.resolution_y = 384; scene.render.resolution_percentage = 100
        scene.render.film_transparent = True
        scene.view_settings.view_transform = 'Standard'
        scene.world = bpy.data.worlds.new('Character preview world'); scene.world.use_nodes = True
        scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.24, 0.24, 0.24, 1)
        low, high = (Vector(v) for v in report['boundsWorld']); center = (low + high) * 0.5
        extent = max(high - low)
        direction = Vector(config.get('previewDirection', [1, -3, 0.6])).normalized()
        camera_data = bpy.data.cameras.new('Character preview camera')
        camera = bpy.data.objects.new('Character preview camera', camera_data); scene.collection.objects.link(camera)
        camera.location = center + direction * extent * 3
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera_data.type = 'ORTHO'; camera_data.ortho_scale = extent * 1.18; scene.camera = camera
        for name, offset, power, size in [('Key', (2, -3, 4), 500, 3), ('Fill', (-3, -1, 2), 250, 4), ('Rim', (1, 3, 3), 350, 2)]:
            light_data = bpy.data.lights.new(name, 'AREA'); light_data.energy = power * extent * extent; light_data.shape = 'DISK'; light_data.size = size * extent
            light = bpy.data.objects.new(name, light_data); scene.collection.objects.link(light)
            light.location = center + Vector(offset) * extent
            light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
        preview.parent.mkdir(parents=True, exist_ok=True)
        scene.render.image_settings.file_format = 'PNG'; scene.render.filepath = str(preview)
        bpy.ops.render.render(write_still=True)
        encoded_preview = encode_preview(preview)
        report['previewMaster'] = encoded_preview['png']
        report['preview'] = encoded_preview['preview']
    analysis = path('analysis', str(output.with_name('analysis.json')))
    analysis.parent.mkdir(parents=True, exist_ok=True); analysis.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'analysis': str(analysis), 'triangles': report['triangles'],
                      'vertices': report['vertices'], 'rigs': report['gltf']['skins'], 'animations': report['gltf']['animations']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--source-root', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    convert(args.config.resolve(), args.source_root.resolve() if args.source_root else None)
