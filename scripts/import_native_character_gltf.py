"""Native glTF preservation path for import_character_assets.py.

Keep embedded source accessors, joint transforms, inverse binds, clips and PNGs.
Only normalize both four-slot weight sets together. Blender supplies the actual
model preview, never the runtime GLB: its glTF round-trip can alter bind data.
"""
import base64
import copy
import json
import struct

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector


def accessor(gltf, binary, index):
    item = gltf['accessors'][index]
    view = gltf['bufferViews'][item['bufferView']]
    dtype = np.dtype({5121: 'u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}[item['componentType']])
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[item['type']]
    return np.ndarray((item['count'], width), dtype=dtype, buffer=binary,
        offset=view.get('byteOffset', 0) + item.get('byteOffset', 0),
        strides=(view.get('byteStride', dtype.itemsize * width), dtype.itemsize))


def pack(source, output, attribution, texture_limit):
    gltf = json.loads(source.read_text())
    # This path deliberately accepts the embedded, single-skin source shape we
    # preserve. Unsupported inputs must not fall through to a lossy export.
    if (source.suffix.lower() != '.gltf' or len(gltf['buffers']) != 1 or
            len(gltf['skins']) != 1 or len(gltf['meshes']) != 1 or
            len(gltf['meshes'][0]['primitives']) != 1):
        raise ValueError('Native packing requires one embedded glTF buffer, mesh, primitive and skin')
    uri = gltf['buffers'][0]['uri']
    if not uri.startswith('data:') or ';base64,' not in uri:
        raise ValueError('Native packing requires an embedded base64 buffer')
    binary = bytearray(base64.b64decode(uri.split(',', 1)[1]))
    if len(binary) != gltf['buffers'][0]['byteLength']:
        raise ValueError('Native buffer length mismatch')
    original_binary = bytes(binary)
    primitive = gltf['meshes'][0]['primitives'][0]
    attributes = primitive['attributes']
    weights = [accessor(gltf, binary, attributes[name]) for name in ('WEIGHTS_0', 'WEIGHTS_1')]
    if any(weight.dtype != np.dtype('<f4') or weight.shape != (len(weights[0]), 4) for weight in weights):
        raise ValueError('Native weight sets must be matching float32 VEC4 accessors')
    original_weights = np.concatenate(weights, axis=1).astype(float)
    totals = original_weights.sum(1)
    if not np.isfinite(original_weights).all() or (original_weights < 0).any() or (totals <= 0).any():
        raise ValueError('Native skin contains invalid weights')
    normalized = original_weights / totals[:, None]
    for index, weight in enumerate(weights):
        weight[:] = normalized[:, index * 4:index * 4 + 4]
    normalized_weights = np.concatenate(weights, axis=1).astype(float)
    if not np.array_equal(original_weights > 0, normalized_weights > 0):
        raise ValueError('Weight normalization removed a native influence')
    weight_indices = {attributes['WEIGHTS_0'], attributes['WEIGHTS_1']}
    for index in range(len(gltf['accessors'])):
        if index not in weight_indices and accessor(gltf, original_binary, index).tobytes() != accessor(gltf, binary, index).tobytes():
            raise ValueError('Weight normalization changed another accessor')
    # Release bytearray views before appending embedded PNG payloads.
    del weight, weights
    image_report = []
    for image in gltf['images']:
        uri = image.pop('uri')
        if not uri.startswith('data:image/png;base64,'):
            raise ValueError('Native packing requires embedded PNG maps')
        payload = base64.b64decode(uri.split(',', 1)[1])
        if payload[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('Invalid native PNG signature')
        dimensions = list(struct.unpack_from('>II', payload, 16))
        if not min(dimensions) or max(dimensions) > texture_limit:
            raise ValueError('Native map exceeds textureMaxDimension; increase the limit instead of resampling')
        binary.extend(b'\0' * (-len(binary) % 4))
        image['bufferView'] = len(gltf['bufferViews'])
        gltf['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(payload)})
        binary.extend(payload)
        image_report.append({'name': image['name'], 'dimensions': dimensions, 'originalPngBytesPreserved': True})
    gltf['buffers'] = [{'byteLength': len(binary)}]
    gltf['asset']['copyright'] = attribution['copyright']
    gltf['asset'].setdefault('extras', {})['attribution'] = copy.deepcopy(attribution)
    for scene in gltf['scenes']:
        scene.setdefault('extras', {})['attribution'] = copy.deepcopy(attribution)
    encoded = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(binary)) +
        struct.pack('<I4s', len(encoded), b'JSON') + encoded +
        struct.pack('<I4s', len(binary), b'BIN\0') + binary)
    report = {'images': image_report, 'jointCount': len(gltf['skins'][0]['joints']),
        'vertices': len(accessor(gltf, binary, attributes['POSITION'])),
        'triangles': len(accessor(gltf, binary, primitive['indices'])) // 3,
        'nativeClips': [{'name': clip['name'], 'channels': len(clip['channels'])} for clip in gltf['animations']],
        'allNonWeightAccessorsByteIdentical': True,
        'nativeNodeTransformsHierarchyInverseBindsAndAnimationKeysPreserved': True,
        'allNonzeroInfluencesPreserved': True,
        'sourceWeightTotalRange': [float(totals.min()), float(totals.max())],
        'maximumNormalizedRatioError': float(np.abs(normalized - normalized_weights).max())}
    return gltf, binary, report


def render_preview(gltf, binary, output, preview, config):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(output))
    scene = bpy.context.scene
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 2
    mesh_node = next(node for node in gltf['nodes'] if node.get('mesh') == 0 and node.get('skin') == 0)
    mesh = bpy.data.objects[mesh_node['name']]
    rig = next(modifier.object for modifier in mesh.modifiers if modifier.type == 'ARMATURE')
    rig.data.pose_position = 'POSE'
    # The importer restores inverse-bind rest bones and activates an action.
    # Reconstruct the final GLB's static node pose instead of rendering either.
    rig.animation_data_clear()
    parents = {child: i for i, node in enumerate(gltf['nodes']) for child in node.get('children', [])}
    worlds = {}
    def world(index):
        if index not in worlds:
            node = gltf['nodes'][index]
            x, y, z, w = node.get('rotation', [0, 0, 0, 1])
            local = Matrix.Translation(Vector(node.get('translation', [0, 0, 0]))) @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*node.get('scale', [1, 1, 1]), 1))
            if 'matrix' in node:
                local = Matrix(np.array(node['matrix']).reshape(4, 4).T.tolist())
            worlds[index] = world(parents[index]) @ local if index in parents else local
        return worlds[index]
    skin = gltf['skins'][0]
    inverse_binds = accessor(gltf, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    conversion = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    desired = {}
    for joint, inverse_bind in zip(skin['joints'], inverse_binds):
        name = gltf['nodes'][joint]['name']
        bone = rig.data.bones[name]
        deformation = conversion @ world(joint) @ Matrix(inverse_bind.tolist()) @ conversion.inverted()
        desired[name] = rig.matrix_world.inverted() @ deformation @ rig.matrix_world @ bone.matrix_local
    for bone in rig.data.bones:
        args = {'parent_matrix': desired[bone.parent.name], 'parent_matrix_local': bone.parent.matrix_local} if bone.parent else {}
        rig.pose.bones[bone.name].matrix_basis = bone.convert_local_to_pose(desired[bone.name], bone.matrix_local, invert=True, **args)
    bpy.context.view_layer.update()
    evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    points = np.array([list(evaluated.matrix_world @ vertex.co) for vertex in evaluated.data.vertices])
    attributes = gltf['meshes'][0]['primitives'][0]['attributes']
    positions = accessor(gltf, binary, attributes['POSITION'])
    joints = np.concatenate([accessor(gltf, binary, attributes[f'JOINTS_{i}']) for i in range(2)], axis=1)
    weights = np.concatenate([accessor(gltf, binary, attributes[f'WEIGHTS_{i}']) for i in range(2)], axis=1).astype(float)
    weights /= weights.sum(1)[:, None]
    matrices = np.array([np.array(world(joint)) for joint in skin['joints']]) @ inverse_binds
    expected = np.einsum('vi,vijk,vk->vj', weights, matrices[joints], np.column_stack([positions, np.ones(len(positions))]))[:, :3]
    expected = np.column_stack([expected[:, 0], -expected[:, 2], expected[:, 1]])
    if points.shape != expected.shape:
        raise ValueError('Preview import changed authored vertex count')
    maximum_error = float(np.abs(points - expected).max())
    if maximum_error > 1e-5:
        raise ValueError(f'Preview does not match native evaluated pose: {maximum_error}')
    for obj in scene.objects:
        obj.hide_render = obj != mesh
    # Same preview settings as the regular importer; no material/fill correction.
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
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
    direction = Vector(config.get('previewDirection', [1, -3, 0.6])).normalized()
    camera_data = bpy.data.cameras.new('Character preview camera')
    camera = bpy.data.objects.new('Character preview camera', camera_data)
    scene.collection.objects.link(camera)
    camera.location = center + direction * extent * 3
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = extent * 1.18
    scene.camera = camera
    for name, offset, power, size in [('Key', (2, -3, 4), 500, 3), ('Fill', (-3, -1, 2), 250, 4), ('Rim', (1, 3, 3), 350, 2)]:
        light_data = bpy.data.lights.new(name, 'AREA')
        light_data.energy = power * extent * extent
        light_data.shape = 'DISK'
        light_data.size = size * extent
        light = bpy.data.objects.new(name, light_data)
        scene.collection.objects.link(light)
        light.location = center + Vector(offset) * extent
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    preview.parent.mkdir(parents=True, exist_ok=True)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(preview)
    bpy.ops.render.render(write_still=True)
    # Blender embeds wall-clock dates and render timings. Drop metadata only,
    # retaining every pixel/colour chunk so repeated imports are reproducible.
    png = preview.read_bytes()
    deterministic = bytearray(png[:8])
    offset = 8
    while offset < len(png):
        length, kind = struct.unpack_from('>I4s', png, offset)
        end = offset + length + 12
        if kind not in (b'eXIf', b'tEXt', b'iTXt', b'zTXt', b'tIME'):
            deterministic.extend(png[offset:end])
        offset = end
    preview.write_bytes(deterministic)
    return {'maximumNativePoseCoordinateError': maximum_error, 'boundsBlender': [points.min(0).tolist(), points.max(0).tolist()]}


def convert(config, source, output, preview, analysis, source_records, record, encode_preview):
    texture_limit = config.get('textureMaxDimension', 512)
    if not isinstance(texture_limit, int) or isinstance(texture_limit, bool) or texture_limit < 1:
        raise ValueError('textureMaxDimension must be a positive integer')
    gltf, binary, report = pack(source, output, config['attribution'], texture_limit)
    report.update({'source': config['source'], 'sourceFiles': source_records,
        'sourceArchive': config.get('sourceArchive'), 'attribution': config['attribution'],
        'redistributionApproved': bool(config.get('redistributionApproved')),
        'blender': bpy.app.version_string, 'nativeGltfPacking': True, 'output': record(output)})
    if preview:
        report['previewPose'] = render_preview(gltf, binary, output, preview, config)
        encoded_preview = encode_preview(preview)
        report['previewMaster'] = encoded_preview['png']
        report['preview'] = encoded_preview['preview']
    analysis.parent.mkdir(parents=True, exist_ok=True)
    analysis.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'analysis': str(analysis),
        'vertices': report['vertices'], 'triangles': report['triangles'],
        'jointCount': report['jointCount'], 'nativeClipCount': len(report['nativeClips']),
        'model': report['output'], 'preview': report.get('preview')}))
