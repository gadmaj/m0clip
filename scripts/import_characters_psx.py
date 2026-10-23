#!/usr/bin/env python3
"""Convert the fixed original Characters PSX roster, preserving native anatomy.

flock /tmp/m0clip-blender-import.lock BLENDER --background --factory-startup \
  --disable-autoexec --threads 2 --python scripts/import_characters_psx.py -- \
  --config scripts/character-assets/characters-psx.json --source-root EXTRACTED

Only runtime GLBs, actual-model PNG masters/.min.png previews, catalog and notices enter outputRoot.
Per-member preservation diagnostics and the exact runtime whitelist enter
analysisRoot. The source root is supplied at invocation, never published.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import runpy
import struct
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector

COMMON = runpy.run_path(str(Path(__file__).with_name('import_character_assets.py')))
record = COMMON['record']
encode_preview = COMMON['encode_preview']


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def runtime_name(name):
    # THREE.PropertyBinding.sanitizeNodeName, also applied by GLTFLoader.
    return re.sub(r'[\[\]\.:/]', '', name.replace(' ', '_'))


def evaluated(mesh):
    obj = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return np.array([list(obj.matrix_world @ v.co) for v in obj.data.vertices])


def sample_source(scene, mesh, rig, frames):
    result = {}
    for pose in ('REST', 'POSE'):
        rig.data.pose_position = pose
        for frame in frames if pose == 'POSE' else [frames[0]]:
            scene.frame_set(int(frame), subframe=frame % 1)
            bpy.context.view_layer.update()
            result[f'{pose}:{frame}'] = evaluated(mesh)
    return result


def accessor(gltf, binary, index):
    item = gltf['accessors'][index]
    view = gltf['bufferViews'][item['bufferView']]
    dtype = np.dtype({5121: 'u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}[item['componentType']])
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[item['type']]
    return np.ndarray((item['count'], width), dtype=dtype, buffer=binary,
        offset=view.get('byteOffset', 0) + item.get('byteOffset', 0),
        strides=(view.get('byteStride', dtype.itemsize * width), dtype.itemsize))


def node_worlds(gltf, overrides=None):
    parents = {child: i for i, node in enumerate(gltf['nodes']) for child in node.get('children', [])}
    worlds = {}
    def world(index):
        if index not in worlds:
            node = {**gltf['nodes'][index], **(overrides or {}).get(index, {})}
            if 'matrix' in node:
                local = np.array(node['matrix']).reshape(4, 4).T
            else:
                from mathutils import Quaternion
                x, y, z, w = node.get('rotation', [0, 0, 0, 1])
                local = np.array(Matrix.Translation(Vector(node.get('translation', [0, 0, 0]))) @
                    Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*node.get('scale', [1, 1, 1]), 1)))
            worlds[index] = world(parents[index]) @ local if index in parents else local
        return worlds[index]
    for index in range(len(gltf['nodes'])):
        world(index)
    return worlds


def surface_diagnostics(mesh, gltf, binary, matrices):
    source_positions = np.array([list(mesh.matrix_world @ v.co) for v in mesh.data.vertices])
    normal_matrix = mesh.matrix_world.to_3x3().inverted().transposed()
    source_normals = np.array([list((normal_matrix @ n.vector).normalized()) for n in mesh.data.corner_normals])
    source_uvs = np.array([list(d.uv) for d in mesh.data.uv_layers.active.data])
    loops_by_vertex = {}
    for loop in mesh.data.loops:
        loops_by_vertex.setdefault(loop.vertex_index, []).append(loop.index)
    conversion = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])
    maximum_position = maximum_uv = maximum_normal = 0.0
    triangles = 0
    for node_index, node in enumerate(gltf['nodes']):
        if 'mesh' not in node:
            continue
        for primitive in gltf['meshes'][node['mesh']]['primitives']:
            attributes = primitive['attributes']
            positions = accessor(gltf, binary, attributes['POSITION'])
            normals = accessor(gltf, binary, attributes['NORMAL'])
            uvs = accessor(gltf, binary, attributes['TEXCOORD_0']).astype(float).copy()
            uvs[:, 1] = 1 - uvs[:, 1]
            slots = sorted(int(k.split('_')[1]) for k in attributes if k.startswith('WEIGHTS_'))
            weights = np.concatenate([accessor(gltf, binary, attributes[f'WEIGHTS_{s}']) for s in slots], axis=1).astype(float)
            joints = np.concatenate([accessor(gltf, binary, attributes[f'JOINTS_{s}']) for s in slots], axis=1)
            weights /= weights.sum(1)[:, None]
            blended = np.einsum('vi,vijk->vjk', weights, matrices[joints])
            positions = np.einsum('vij,vj->vi', blended, np.column_stack([positions, np.ones(len(positions))]))[:, :3] @ conversion.T
            normal_world = np.linalg.inv(blended[:, :3, :3]).transpose(0, 2, 1)
            normals = np.einsum('vij,vj->vi', normal_world, normals) @ conversion.T
            normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-30)
            indices = accessor(gltf, binary, primitive['indices'])[:, 0]
            triangles += len(indices) // 3
            used = np.unique(indices)
            for position, normal, uv in zip(positions[used], normals[used], uvs[used]):
                distances = np.linalg.norm(source_positions - position, axis=1)
                maximum_position = max(maximum_position, float(distances.min()))
                vertices = np.where(distances < 3e-5)[0]
                loops = [loop for vertex in vertices for loop in loops_by_vertex.get(int(vertex), [])]
                if not loops:
                    raise ValueError('Exported geometry is not native surface geometry')
                chosen = min(loops, key=lambda i: np.max(np.abs(source_uvs[i] - uv)) + np.max(np.abs(source_normals[i] - normal)))
                maximum_uv = max(maximum_uv, float(np.abs(source_uvs[chosen] - uv).max()))
                maximum_normal = max(maximum_normal, float(np.abs(source_normals[chosen] - normal).max()))
    if triangles != len(mesh.data.loop_triangles) or maximum_uv > 2e-6 or maximum_normal > 2e-4:
        raise ValueError(f'Native geometry/UV/split-normal mismatch: {triangles}, {maximum_uv}, {maximum_normal}')
    return {'trianglesPreserved': triangles, 'maximumPositionError': maximum_position,
        'maximumUVError': maximum_uv, 'maximumSplitNormalError': maximum_normal}


def animation_diagnostics(gltf, binary, skin, expected, frames, fps):
    from mathutils import Quaternion
    inverse_binds = accessor(gltf, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    results = {}
    clip = gltf['animations'][0]
    for frame in frames:
        time = (frame - frames[0]) / fps
        overrides = {}
        for channel in clip['channels']:
            sampler = clip['samplers'][channel['sampler']]
            if sampler.get('interpolation', 'LINEAR') not in ('LINEAR', 'STEP'):
                raise ValueError('Unexpected exported animation interpolation')
            times = accessor(gltf, binary, sampler['input'])[:, 0]
            values = accessor(gltf, binary, sampler['output'])
            high = min(int(np.searchsorted(times, time, side='right')), len(times) - 1)
            low = max(0, high - 1)
            ratio = max(0, min(1, (time - times[low]) / (times[high] - times[low]))) if times[high] > times[low] else 0
            if sampler.get('interpolation') == 'STEP':
                ratio = 0
            path = channel['target']['path']
            if path == 'rotation':
                a, b = values[low], values[high]
                q = Quaternion((a[3], *a[:3])).slerp(Quaternion((b[3], *b[:3])), ratio)
                value = [q.x, q.y, q.z, q.w]
            else:
                value = ((1 - ratio) * values[low] + ratio * values[high]).tolist()
            overrides.setdefault(channel['target']['node'], {})[path] = value
        worlds = node_worlds(gltf, overrides)
        matrices = np.array([worlds[j] for j in skin['joints']]) @ inverse_binds
        points = []
        for mesh in gltf['meshes']:
            for primitive in mesh['primitives']:
                attributes = primitive['attributes']
                positions = accessor(gltf, binary, attributes['POSITION'])
                slots = sorted(int(k.split('_')[1]) for k in attributes if k.startswith('WEIGHTS_'))
                weights = np.concatenate([accessor(gltf, binary, attributes[f'WEIGHTS_{s}']) for s in slots], axis=1).astype(float)
                joints = np.concatenate([accessor(gltf, binary, attributes[f'JOINTS_{s}']) for s in slots], axis=1)
                weights /= weights.sum(1)[:, None]
                deformed = np.einsum('vi,vijk,vk->vj', weights, matrices[joints], np.column_stack([positions, np.ones(len(positions))]))[:, :3]
                points.extend(np.column_stack([deformed[:, 0], -deformed[:, 2], deformed[:, 1]]))
        distances = np.linalg.norm(np.array(points)[:, None] - expected[f'POSE:{frame}'][None, :], axis=2)
        error = float(max(distances.min(0).max(), distances.min(1).max()))
        if error > 3e-5:
            raise ValueError(f'Exported source animation deformation differs at frame {frame}: {error}')
        results[str(frame)] = {'seconds': time, 'maximumCoordinateError': error}
    return results


def restore_native_weights(gltf, binary, native_weights, totals):
    # Blender prunes small weights even with export_all_influences.
    # Rebuild all ratios from exact exported source-vertex identities.
    binary = bytearray(binary)
    joint_names = [gltf['nodes'][j]['name'] for j in gltf['skins'][0]['joints']]
    joint_indices = {name: index for index, name in enumerate(joint_names)}
    present = {int(v) for mesh in gltf['meshes'] for p in mesh['primitives']
        for v in accessor(gltf, binary, p['attributes']['_SOURCE_VERTEX'])[:, 0]}
    sets = (max(len(native_weights[v]) for v in present) + 3) // 4
    source_ids = []
    def add(values, component):
        binary.extend(b'\0' * (-len(binary) % 4))
        view = len(gltf['bufferViews'])
        gltf['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': values.nbytes})
        binary.extend(values.tobytes())
        index = len(gltf['accessors'])
        gltf['accessors'].append({'bufferView': view, 'componentType': component, 'count': len(values), 'type': 'VEC4'})
        return index
    for mesh in gltf['meshes']:
        for primitive in mesh['primitives']:
            attributes = primitive['attributes']
            identities = accessor(gltf, binary, attributes.pop('_SOURCE_VERTEX')).copy()[:, 0].astype(int)
            source_ids.append(identities)
            joints = np.zeros((len(identities), sets * 4), dtype='<u2')
            weights = np.zeros((len(identities), sets * 4), dtype='<f4')
            for row, identity in enumerate(identities):
                for column, (name, weight) in enumerate(native_weights[identity]):
                    joints[row, column] = joint_indices[name]
                    weights[row, column] = weight / totals[identity]
            for key in list(attributes):
                if key.startswith(('JOINTS_', 'WEIGHTS_')):
                    del attributes[key]
            for index in range(sets):
                attributes[f'JOINTS_{index}'] = add(joints[:, index * 4:index * 4 + 4].copy(), 5123)
                attributes[f'WEIGHTS_{index}'] = add(weights[:, index * 4:index * 4 + 4].copy(), 5126)
    references = []
    for mesh in gltf['meshes']:
        for primitive in mesh['primitives']:
            references.extend((primitive['attributes'], key) for key in primitive['attributes'])
            references.append((primitive, 'indices'))
    references.extend((skin, 'inverseBindMatrices') for skin in gltf['skins'])
    for clip in gltf['animations']:
        for sampler in clip['samplers']:
            references.extend([(sampler, 'input'), (sampler, 'output')])
    used = sorted({obj[key] for obj, key in references})
    mapping = {old: new for new, old in enumerate(used)}
    gltf['accessors'] = [gltf['accessors'][old] for old in used]
    for obj, key in references:
        obj[key] = mapping[obj[key]]
    used_views = sorted({a['bufferView'] for a in gltf['accessors']} | {i['bufferView'] for i in gltf['images']})
    mapping = {old: new for new, old in enumerate(used_views)}
    gltf['bufferViews'] = [gltf['bufferViews'][old] for old in used_views]
    for accessor_item in gltf['accessors']:
        accessor_item['bufferView'] = mapping[accessor_item['bufferView']]
    for image in gltf['images']:
        image['bufferView'] = mapping[image['bufferView']]
    return binary, source_ids


def calibration(rig):
    bones = {b.name.split(':')[-1]: b for b in rig.data.bones}
    required = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']
    required += [side + part for side in ('Left', 'Right') for part in
                 ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase')]
    if not all(name in bones for name in required):
        raise ValueError('Native anatomy is not the inspected Mixamo hierarchy')
    for side in ('Left', 'Right'):
        for parent, child in [('Arm', 'ForeArm'), ('ForeArm', 'Hand'), ('UpLeg', 'Leg'), ('Leg', 'Foot')]:
            if bones[side + child].parent != bones[side + parent]:
                raise ValueError('Native limb parent differs: ' + side + child)
    head = lambda name: rig.matrix_world @ bones[name].head_local
    forward = head('LeftToeBase') - head('LeftFoot')
    left = head('LeftUpLeg') - head('RightUpLeg')
    up = head('Head') - head('Hips')
    if forward.x <= 0 or left.y <= 0 or up.z <= 0:
        raise ValueError('Native rest geometry does not support +X forward/+Y left/Z up')
    bindings = {}
    def bind(bone, *targets):
        bindings[runtime_name(bones[bone].name)] = list(targets)
    bind('Hips', 'pelvis')
    for bone in ('Spine', 'Spine1', 'Spine2'):
        bind(bone, 'torso_link', 'pelvis')
    bind('Neck', 'head_pitch_link', 'torso_link')
    bind('Head', 'head_yaw_link', 'head_pitch_link', 'torso_link')
    aim = {}
    for side, prefix in [('Left', 'left'), ('Right', 'right')]:
        bind(side + 'Shoulder', prefix + '_shoulder_pitch_link', 'torso_link')
        bind(side + 'Arm', prefix + '_shoulder_yaw_link', prefix + '_shoulder_roll_link')
        bind(side + 'ForeArm', prefix + '_elbow_link')
        bind(side + 'Hand', prefix + '_wrist_roll_link', prefix + '_elbow_link')
        bind(side + 'UpLeg', prefix + '_hip_yaw_link', prefix + '_hip_roll_link')
        bind(side + 'Leg', prefix + '_knee_link')
        bind(side + 'Foot', prefix + '_ankle_roll_link', prefix + '_ankle_pitch_link')
        for parent, child in [('Shoulder', 'Arm'), ('Arm', 'ForeArm'), ('ForeArm', 'Hand'),
                              ('UpLeg', 'Leg'), ('Leg', 'Foot')]:
            aim[runtime_name(bones[side + parent].name)] = runtime_name(bones[side + child].name)
    return {'root': runtime_name(bones['Hips'].name), 'alignment': [2 ** -0.5, 0, 0, 2 ** -0.5],
        'bindings': bindings, 'aim': aim,
        'feet': [runtime_name(bones[side + 'Foot'].name) for side in ('Left', 'Right')]}, {
        'sourceForwardBlender': '+X', 'sourceLeftBlender': '+Y', 'sourceUpBlender': '+Z',
        'toeMinusFoot': list(forward), 'leftMinusRightHip': list(left), 'headMinusHips': list(up)}


def render_preview(scene, meshes, rig, preview, points):
    # Exact shared licensed-importer preview lighting and colour convention.
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    for obj in scene.objects:
        obj.hide_render = obj not in meshes
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.cycles.seed = 0
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 2
    scene.render.resolution_x = 384
    scene.render.resolution_y = 384
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.world = bpy.data.worlds.new('Character preview world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.24, 0.24, 0.24, 1)
    low, high = Vector(points.min(0)), Vector(points.max(0))
    center = (low + high) * 0.5
    extent = max(high - low)
    # Native PSX faces +X, unlike the shared importer's -Y-facing sources.
    direction = Vector((3, 1, 0.6)).normalized()
    camera_data = bpy.data.cameras.new('Character preview camera')
    camera = bpy.data.objects.new('Character preview camera', camera_data)
    scene.collection.objects.link(camera)
    camera.location = center + direction * extent * 3
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = extent * 1.18
    scene.camera = camera
    for name, offset, power, size in [('Key', (2, -3, 4), 500, 3), ('Fill', (-3, -1, 2), 250, 4), ('Rim', (1, 3, 3), 350, 2)]:
        data = bpy.data.lights.new(name, 'AREA')
        data.energy = power * extent * extent
        data.shape = 'DISK'
        data.size = size * extent
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = center + Vector(offset) * extent
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
    preview.parent.mkdir(parents=True, exist_ok=True)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(preview)
    bpy.ops.render.render(write_still=True)
    data = preview.read_bytes()
    result = bytearray(data[:8])
    offset = 8
    while offset < len(data):
        length, kind = struct.unpack_from('>I4s', data, offset)
        end = offset + length + 12
        if kind not in (b'eXIf', b'tEXt', b'iTXt', b'zTXt', b'tIME'):
            result.extend(data[offset:end])
        offset = end
    preview.write_bytes(result)


def member_label(member):
    source = Path(member['source'])
    tokens = source.stem.split('_')[1:]
    if source.parent.name == 'Killers':
        return 'PSX ' + ''.join(tokens)
    group = source.parent.name
    number = next(token for token in tokens if token.isdigit())
    role = next((token for token in tokens if token not in (group, number)), None)
    identity = group + number
    return f'PSX {role} · {identity}' if role else 'PSX ' + identity


def definition_for(config, member, descriptor):
    notice = config['attribution']
    label = member_label(member)
    return {'id': member['id'], 'label': label,
        'url': '/assets/characters/characters-psx/' + member['output'],
        'preview': '/assets/characters/characters-psx/' + str(Path(member['preview']).with_suffix('.min.png')),
        'attribution': {'title': label, 'creator': notice['creator'], 'source': notice['sourceUrl'],
            'license': notice['license'], 'licenseUrl': notice['licenseUrl'], 'modifications': [notice['modifications']]},
        'rig': descriptor}


def convert_member(config, member, root, output_root, analysis_root, temp):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    packed = {}
    native_materials = []
    for texture in member['textures']:
        if 'packedImage' in texture:
            with bpy.data.libraries.load(str(root / texture['source']), link=False) as (source, target):
                target.materials = [texture['packedImage']]
            material = target.materials[0]
            native_materials.append(material)
            image = next(n.image for n in material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
            payload = bytes(image.packed_file.data)
            if hashlib.sha256(payload).hexdigest() != texture['packedSHA256']:
                raise ValueError('Packed original image hash mismatch')
            destination = temp / (texture['packedImage'] + '.png')
            destination.write_bytes(payload)
            packed[texture['image']] = destination
    bpy.ops.import_scene.fbx(filepath=str(root / member['source']), use_anim=True,
        ignore_leaf_bones=False, automatic_bone_orientation=False)
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == 'MESH' and o.data.polygons]
    rigs = [o for o in scene.objects if o.type == 'ARMATURE']
    if len(meshes) != 1 or len(rigs) != 1:
        raise ValueError('Each original member must contain its native single mesh and rig')
    mesh, rig = meshes[0], rigs[0]
    if native_materials:
        if len(mesh.data.materials) != len(native_materials):
            raise ValueError('Original Blend material does not match FBX surface slots')
        for index, material in enumerate(native_materials):
            mesh.data.materials[index] = material
    if not any(m.type == 'ARMATURE' and m.object == rig for m in mesh.modifiers):
        raise ValueError('Missing native skin modifier')
    surface_vertices = sorted({loop.vertex_index for loop in mesh.data.loops})
    loose = len(mesh.data.vertices) - len(surface_vertices)
    cached = analysis_root / (member['id'] + '.json')
    if config.get('_resume') and cached.is_file():
        prior = json.loads(cached.read_text())
        output, preview = output_root / member['output'], output_root / member['preview']
        runtime_preview = preview.with_suffix('.min.png')
        if (prior.get('nativeUnreferencedVertexCount') == loose
                and prior.get('nativeUnreferencedVerticesExcludedFromRuntime') is True
                and prior['sourceMesh'].get('referencedVertices') == len(surface_vertices)
                and output.is_file() and preview.is_file() and runtime_preview.is_file()
                and record(output) == prior['output']
                and {**record(preview), 'path': str(preview)} == prior.get('previewMaster')
                and {**record(runtime_preview), 'path': str(runtime_preview)} == prior.get('preview')):
            descriptor, _ = calibration(rig)
            return definition_for(config, member, descriptor), prior
    actions = list(bpy.data.actions)
    if len(actions) != 1:
        raise ValueError('Expected original animation stack')
    action = actions[0]
    frames = sorted({float(action.frame_range[0]), float(action.frame_range[1]),
                     float(sum(action.frame_range) / 2)})
    original = sample_source(scene, mesh, rig, frames)
    report = {'id': member['id'], 'source': member['source'], 'sourceFiles': {
        name: record(root / name) for name in sorted({member['source']} | {t['source'] for t in member['textures']})},
        'blender': bpy.app.version_string, 'sourceNativeRig': {'name': rig.name, 'bones': [
            {'name': b.name, 'runtimeName': runtime_name(b.name), 'parent': b.parent.name if b.parent else None,
             'headWorld': list(rig.matrix_world @ b.head_local), 'tailWorld': list(rig.matrix_world @ b.tail_local),
             'deform': b.use_deform} for b in rig.data.bones]},
        'sourceActions': [{'name': a.name, 'frameRange': list(a.frame_range),
                           'fcurves': len(a.fcurves), 'keys': sum(len(f.keyframe_points) for f in a.fcurves)} for a in actions],
        'sourceMesh': {'name': mesh.name, 'vertices': len(mesh.data.vertices),
                       'referencedVertices': len(surface_vertices),
                       'polygons': len(mesh.data.polygons), 'uvLayers': [u.name for u in mesh.data.uv_layers],
                       'hasCustomNormals': mesh.data.has_custom_normals,
                       'materials': [m.name for m in mesh.data.materials]}, 'images': []}
    # Match the authored image references, not the character filename convention.
    for texture in member['textures']:
        referenced = [node for material in mesh.data.materials if material and material.use_nodes
            for node in material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image
            and node.image.name == texture['image']]
        filename = packed.get(texture['image'], root / texture['source'])
        image = bpy.data.images.load(str(filename), check_existing=False)
        if list(image.size) != [512, 512] or max(image.size) > config['textureMaxDimension']:
            raise ValueError('Unexpected source texture dimensions')
        if not referenced:
            identities = [(n.name, n.image.name if n.image else None)
                for m in mesh.data.materials if m and m.use_nodes
                for n in m.node_tree.nodes if n.type == 'TEX_IMAGE']
            raise ValueError('Native map reference mismatch: ' + str(identities))
        for node in referenced:
            node.image = image
        image.pack()
        report['images'].append({'source': texture['source'], 'packedImage': texture.get('packedImage'),
            'dimensions': list(image.size), 'originalPng': record(filename)})
    native_weights = []
    for vertex in mesh.data.vertices:
        values = [(mesh.vertex_groups[g.group].name, float(g.weight)) for g in vertex.groups
                  if g.weight > 0 and mesh.vertex_groups[g.group].name in rig.data.bones]
        if not values and vertex.index in surface_vertices:
            raise ValueError('Unweighted indexed native surface vertex')
        native_weights.append(values)
    total = [sum(w for _, w in values) for values in native_weights]
    surface_weights = [native_weights[index] for index in surface_vertices]
    surface_totals = [total[index] for index in surface_vertices]
    maximum = max(map(len, surface_weights))
    if maximum > 8:
        raise ValueError('Runtime supports at most eight native influences')
    report['influences'] = {'minimum': min(map(len, surface_weights)), 'maximum': maximum,
        'verticesOverFour': sum(len(v) > 4 for v in surface_weights),
        'weightSumRange': [min(surface_totals), max(surface_totals)], 'scope': 'Indexed native surface vertices'}
    # Bake only the imported object-unit scales, retaining all native bones.
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    scales = list(rig.scale)
    if max(scales) - min(scales) > 1e-6:
        raise ValueError('Nonuniform native rig scale requires explicit preservation handling')
    report['appliedObjectScales'] = {o.name: list(o.scale) for o in (mesh, rig)}
    bpy.ops.object.select_all(action='DESELECT')
    for obj in (mesh, rig):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for curve in action.fcurves:
        if curve.data_path.startswith('pose.bones[') and curve.data_path.endswith('.location'):
            factor = scales[curve.array_index]
            for key in curve.keyframe_points:
                key.co.y *= factor
                key.handle_left.y *= factor
                key.handle_right.y *= factor
    scaled = sample_source(scene, mesh, rig, frames)
    errors = {key: float(np.abs(value - scaled[key]).max()) for key, value in original.items()}
    if max(errors.values()) > 2e-5:
        raise ValueError('Applying source units changed native deformation: ' + str(errors))
    report['objectScaleMaximumCoordinateErrors'] = errors
    # Normalize all original weights together, without losing any influence.
    for index in surface_vertices:
        vertex, values, weight_sum = mesh.data.vertices[index], native_weights[index], total[index]
        for name, value in values:
            mesh.vertex_groups[name].add([vertex.index], value / weight_sum, 'REPLACE')
    rig.data.pose_position = 'REST'
    scene.frame_set(int(frames[0]), subframe=frames[0] % 1)
    bpy.context.view_layer.update()
    points = evaluated(mesh)[surface_vertices]
    report['boundsWorld'] = [points.min(0).tolist(), points.max(0).tolist()]
    mesh.data.calc_loop_triangles()
    report['triangles'] = len(mesh.data.loop_triangles)
    descriptor, report['calibrationEvidence'] = calibration(rig)
    identity = mesh.data.attributes.new('_SOURCE_VERTEX', 'FLOAT', 'POINT')
    for vertex, value in zip(mesh.data.vertices, identity.data):
        value.value = vertex.index
    mesh['sourcePartNames'] = [m.name for m in mesh.data.materials]
    mesh['sourceMember'] = member['source']
    mesh['sourceSHA256'] = config['sourceFiles'][member['source']]
    scene['attribution'] = config['attribution']
    output = output_root / member['output']
    preview = output_root / member['preview']
    output.parent.mkdir(parents=True, exist_ok=True)
    rig.data.pose_position = 'POSE'
    scene.frame_set(int(frames[0]), subframe=frames[0] % 1)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in (mesh, rig):
        obj.select_set(True)
        parent = obj.parent
        while parent:
            parent.select_set(True)
            parent = parent.parent
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_attributes=True,
        export_materials='EXPORT', export_image_format='AUTO', export_skins=True,
        export_all_influences=True, export_def_bones=False, export_animations=True,
        export_animation_mode='ACTIONS', export_force_sampling=True, export_apply=False,
        export_extras=True, export_cameras=False, export_lights=False)
    data = output.read_bytes()
    length, kind = struct.unpack_from('<I4s', data, 12)
    if kind != b'JSON':
        raise ValueError('Invalid GLB JSON chunk')
    gltf = json.loads(data[20:20 + length])
    binary = data[28 + length:]
    if len(gltf.get('skins', [])) != 1 or len(gltf['skins'][0]['joints']) != len(rig.data.bones):
        raise ValueError('Export omitted native bones')
    if len(gltf.get('animations', [])) != len(actions):
        raise ValueError('Export omitted native animation stack')
    binary, source_ids = restore_native_weights(gltf, binary, native_weights, total)
    from collections import Counter
    canonical = lambda triangle: min(tuple(triangle[i:]) + tuple(triangle[:i]) for i in range(3))
    native_triangles = Counter(canonical(tuple(t.vertices)) for t in mesh.data.loop_triangles)
    exported_triangles = Counter()
    primitives = [p for m in gltf['meshes'] for p in m['primitives']]
    for primitive, identities in zip(primitives, source_ids):
        indices = accessor(gltf, binary, primitive['indices'])[:, 0].reshape(-1, 3)
        exported_triangles.update(canonical(tuple(map(int, identities[t]))) for t in indices)
    if native_triangles != exported_triangles:
        raise ValueError('Export changed native triangle topology or winding')
    report['nativeTriangleTopologyAndWindingPreserved'] = True
    report['nativeUnreferencedVertexCount'] = loose
    report['nativeUnreferencedVerticesExcludedFromRuntime'] = True
    worlds = node_worlds(gltf)
    skin = gltf['skins'][0]
    matrices = accessor(gltf, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    matrices = np.array([worlds[j] for j in skin['joints']]) @ matrices
    joint_names = [gltf['nodes'][j]['name'] for j in skin['joints']]
    runtime_names = [runtime_name(n) for n in joint_names]
    if len(runtime_names) != len(set(runtime_names)) or not set(descriptor['bindings']) <= set(runtime_names):
        raise ValueError('Runtime sanitized bone names are ambiguous or missing')
    parents = {child: i for i, node in enumerate(gltf['nodes']) for child in node.get('children', [])}
    joint_errors = []
    for joint in skin['joints']:
        bone = rig.data.bones[gltf['nodes'][joint]['name']]
        parent = parents.get(joint)
        exported_parent = gltf['nodes'][parent]['name'] if parent in skin['joints'] else None
        if exported_parent != (bone.parent.name if bone.parent else None):
            raise ValueError('Export changed native joint parent')
        point = worlds[joint][:3, 3]
        point = np.array([point[0], -point[2], point[1]])
        joint_errors.append(float(np.abs(point - np.array(rig.matrix_world @ bone.head_local)).max()))
    if max(joint_errors) > 3e-5:
        raise ValueError('Export changed native joint rest positions')
    report['nativeJointHierarchyPreserved'] = True
    report['maximumNativeJointRestPositionError'] = max(joint_errors)
    gltf_points, gltf_weights = [], []
    for exported_mesh in gltf['meshes']:
        for primitive in exported_mesh['primitives']:
            attributes = primitive['attributes']
            positions = accessor(gltf, binary, attributes['POSITION'])
            slots = sorted(int(k.split('_')[1]) for k in attributes if k.startswith('WEIGHTS_'))
            weights = np.concatenate([accessor(gltf, binary, attributes[f'WEIGHTS_{s}']) for s in slots], axis=1).astype(float)
            joints = np.concatenate([accessor(gltf, binary, attributes[f'JOINTS_{s}']) for s in slots], axis=1)
            weights /= weights.sum(1)[:, None]
            deformed = np.einsum('vi,vijk,vk->vj', weights, matrices[joints], np.column_stack([positions, np.ones(len(positions))]))[:, :3]
            gltf_points.extend(np.column_stack([deformed[:, 0], -deformed[:, 2], deformed[:, 1]]))
            for position, js, ws in zip(deformed, joints, weights):
                gltf_weights.append((position, {joint_names[int(j)]: float(w) for j, w in zip(js, ws) if w > 0}))
    # UV and split-normal seams duplicate vertices; compare evaluated surfaces,
    # then check every duplicated output vertex against its source skin ratios.
    expected_pose = scaled[f'REST:{frames[0]}'][surface_vertices]
    output_points = np.array(gltf_points)
    distances = np.linalg.norm(output_points[:, None] - expected_pose[None, :], axis=2)
    maximum_error = float(max(distances.min(0).max(), distances.min(1).max()))
    if maximum_error > 3e-5:
        raise ValueError('Exported bind shape differs from native evaluated pose: ' + str(maximum_error))
    ratio_error = 0.0
    for (_, exported), index in zip(gltf_weights, np.concatenate(source_ids)):
        native = {n: w / total[index] for n, w in native_weights[index]}
        if set(exported) != set(native):
            raise ValueError('Export lost a native skin influence')
        ratio_error = max(ratio_error, max(abs(exported[n] - w) for n, w in native.items()))
    if ratio_error > 2e-5:
        raise ValueError('Export changed native weight ratios: ' + str(ratio_error))
    report['gltf'] = {'skins': len(gltf['skins']), 'joints': len(joint_names),
        'verticesIncludingSeams': len(output_points), 'nativeBindPoseMaximumCoordinateError': maximum_error,
        'maximumNormalizedWeightRatioError': ratio_error, 'allNonzeroInfluencesPreserved': True,
        'materials': gltf.get('materials'), 'animations': [{'name': a.get('name'), 'channels': len(a['channels'])} for a in gltf['animations']]}
    report['gltf']['surfacePreservation'] = surface_diagnostics(mesh, gltf, binary, matrices)
    report['gltf']['sourceAnimationDeformation'] = animation_diagnostics(
        gltf, binary, skin, {key: value[surface_vertices] for key, value in scaled.items()},
        frames, scene.render.fps / scene.render.fps_base)
    # Retain the exact source PNG bytes rather than an exporter re-encoding.
    replacement_images = {}
    if len(gltf.get('images', [])) != len(report['images']):
        raise ValueError('Export omitted an original material map')
    for image, texture_report in zip(gltf['images'], report['images']):
        texture = next(t for t in member['textures'] if t['source'] == texture_report['source'])
        replacement_images[image['bufferView']] = (packed.get(texture['image'], root / texture['source'])).read_bytes()
        image['mimeType'] = 'image/png'
        texture_report['originalPngBytesPreserved'] = True
    rebuilt = bytearray()
    for index, view in enumerate(gltf['bufferViews']):
        payload = replacement_images.get(index, binary[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']])
        rebuilt.extend(b'\0' * (-len(rebuilt) % 4))
        view['byteOffset'] = len(rebuilt)
        view['byteLength'] = len(payload)
        rebuilt.extend(payload)
    binary = rebuilt
    gltf['buffers'][0]['byteLength'] = len(binary)
    attribution = copy.deepcopy(config['attribution'])
    attribution['sourceMember'] = member['source']
    attribution['sourceFiles'] = report['sourceFiles']
    attribution['sourceArchive'] = config['sourceArchive']
    gltf['asset']['copyright'] = attribution['copyright']
    gltf['asset'].setdefault('extras', {})['attribution'] = attribution
    encoded = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    output.write_bytes(struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(binary)) +
        struct.pack('<I4s', len(encoded), b'JSON') + encoded + struct.pack('<I4s', len(binary), b'BIN\0') + binary)
    render_preview(scene, meshes, rig, preview, points)
    report['output'] = record(output)
    encoded_preview = encode_preview(preview)
    report['previewMaster'] = encoded_preview['png']
    report['preview'] = encoded_preview['preview']
    write_json(analysis_root / (member['id'] + '.json'), report)
    definition = definition_for(config, member, descriptor)
    print(json.dumps({'id': member['id'], 'output': report['output'], 'preview': report['preview'],
                      'nativeBones': len(joint_names), 'bindError': maximum_error}), flush=True)
    return definition, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--member', help='Convert one exact configured ID for source diagnostics')
    parser.add_argument('--resume', action='store_true', help='Reuse completed hash-matching member artifacts')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    config['_resume'] = args.resume
    root = args.source_root.resolve()
    output_root = (config_path.parent / config['outputRoot']).resolve()
    analysis_root = (config_path.parent / config['analysisRoot']).resolve()
    if not config['redistributionApproved'] or len(config['members']) != 79:
        raise ValueError('Only the licensed complete original 79-member roster is supported')
    for name, sha in config['sourceFiles'].items():
        if record(root / name)['sha256'] != sha:
            raise ValueError('Original source hash mismatch: ' + name)
    catalog, reports = {}, []
    with tempfile.TemporaryDirectory(prefix='m0clip-psx-conversion-') as directory:
        for member in config['members']:
            if args.member and member['id'] != args.member:
                continue
            definition, report = convert_member(config, member, root, output_root, analysis_root, Path(directory))
            catalog[member['id']] = definition
            reports.append(report)
    if args.member:
        if not reports:
            raise ValueError('Unknown configured member')
        return
    write_json(output_root / 'catalog.json', catalog)
    notice = copy.deepcopy(config['attribution'])
    notice['sourceArchive'] = config['sourceArchive']
    notice['includedMembers'] = len(catalog)
    notice['excluded'] = 'All 58 later extras and the newer 137-character collection'
    write_json(output_root / 'attribution.json', notice)
    mapping = {m['id']: {'source': m['source'], 'sourceSHA256': config['sourceFiles'][m['source']],
        'textures': [{**t, 'sourceSHA256': config['sourceFiles'][t['source']]} for t in m['textures']],
        'url': catalog[m['id']]['url'], 'preview': catalog[m['id']]['preview']} for m in config['members']}
    write_json(output_root / 'source-manifest.json', mapping)
    notice_text = (notice['copyright'] + '\nSource: ' + notice['sourceUrl'] + '\nCreator: ' + notice['creatorUrl'] +
        '\nLicense: Creative Commons Attribution 4.0 International\n' + notice['licenseUrl'] +
        '\nLegal code: https://creativecommons.org/licenses/by/4.0/legalcode\nChanges: ' + notice['modifications'] +
        '\nScope: original 79 characters only; no later extras. No endorsement is implied.\n')
    (output_root / 'LICENSE.txt').write_text(notice_text)
    runtime = {str(p.relative_to(output_root)): record(p) for p in sorted(output_root.rglob('*')) if p.is_file()}
    expected = ({m[k] for m in config['members'] for k in ('output', 'preview')}
        | {str(Path(m['preview']).with_suffix('.min.png')) for m in config['members']}
        | {'catalog.json', 'attribution.json', 'source-manifest.json', 'LICENSE.txt'})
    if set(runtime) != expected:
        raise ValueError('Runtime contains unexpected or missing files')
    write_json(analysis_root / 'runtime-whitelist.json', {'files': runtime,
        'totalBytes': sum(v['bytes'] for v in runtime.values()), 'count': len(runtime)})
    write_json(analysis_root / 'qa-invariants.json', {
        'applicationBehaviorTested': False,
        'requirements': [
            'Use each catalog URL and sanitized native binding; no R1 proxy geometry.',
            'One native SkinnedMesh and one native skeleton per character.',
            'Preserve all source bones, source clips, geometry, UVs, normals and both weight sets where present.',
            'Retarget using +X forward calibration; native rest shape must not inflate or stretch.',
            'Source animation clips are retained data, not independently playable controls.',
            'Compare anatomy, feet, accessories and material pixels with actual previews.',
            'sourceVerticesOverFourInfluences counts unique referenced source vertices; compare seam-expanded runtime weights with canonical GLB accessors.',
        ],
        'characters': {r['id']: {
            'sourceVertices': r['sourceMesh']['vertices'],
            'referencedSourceVertices': r['sourceMesh']['referencedVertices'],
            'unreferencedSourceVerticesExcluded': r['nativeUnreferencedVertexCount'],
            'runtimeVerticesIncludingSeams': r['gltf']['verticesIncludingSeams'],
            'triangles': r['triangles'], 'bones': r['gltf']['joints'],
            'skins': r['gltf']['skins'], 'clips': len(r['gltf']['animations']),
            'maximumInfluences': r['influences']['maximum'],
            'sourceVerticesOverFourInfluences': r['influences']['verticesOverFour'],
            'boundsBlender': r['boundsWorld'],
            'materialNames': [m['name'] for m in r['gltf']['materials']],
            'root': catalog[r['id']]['rig']['root'],
            'alignment': catalog[r['id']]['rig']['alignment'],
            'model': r['output'], 'preview': r['preview'],
        } for r in reports},
    })
    write_json(analysis_root / 'summary.json', {'members': len(reports), 'glbs': 79, 'previews': 79,
        'sourceVertices': sum(r['sourceMesh']['vertices'] for r in reports),
        'referencedSourceVertices': sum(r['sourceMesh']['referencedVertices'] for r in reports),
        'unreferencedSourceVerticesExcluded': sum(r['nativeUnreferencedVertexCount'] for r in reports),
        'triangles': sum(r['triangles'] for r in reports),
        'nativeBoneCounts': sorted({r['gltf']['joints'] for r in reports}),
        'maximumBindCoordinateError': max(r['gltf']['nativeBindPoseMaximumCoordinateError'] for r in reports),
        'maximumWeightRatioError': max(r['gltf']['maximumNormalizedWeightRatioError'] for r in reports),
        'maximumInfluences': max(r['influences']['maximum'] for r in reports),
        'runtimeBytes': sum(v['bytes'] for v in runtime.values()),
        'runtimeFiles': len(runtime), 'applicationBehaviorTested': False})


if __name__ == '__main__':
    main()
