"""Derive private Horror Entity calibration and preservation evidence from real source.

Run after import_character_assets.py with the same --config and --source-root,
through flock /tmp/m0clip-blender-import.lock, --disable-autoexec --threads 2.
Restores source corner normals and every source weight after Blender's export
rounding/cutoff, using its existing GLB accessor layout. Source files, geometry,
hierarchy, inverse binds, clips and image bytes are never rewritten. Native tail
pivots are metadata; runtime qualification/publication remains a separate gate.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import runpy
import struct
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector


def record(path):
    payload = path.read_bytes()
    return {'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}


def inspect(config_path, source_root):
    config = json.loads(config_path.read_text())
    output = Path(config['output'])
    if not output.is_absolute():
        output = config_path.parent / output
    stage = output.parent
    raw = output.read_bytes()
    json_size, kind = struct.unpack_from('<I4s', raw, 12)
    if kind != b'JSON':
        raise ValueError('Missing GLB JSON')
    gltf = json.loads(raw[20:20 + json_size])
    binary = bytearray(raw[28 + json_size:])
    access = runpy.run_path(str(Path(__file__).with_name('import_native_character_gltf.py')))['accessor']
    primitive = gltf['meshes'][0]['primitives'][0]
    attrs = {name: access(gltf, binary, index) for name, index in primitive['attributes'].items()}
    positions = attrs['POSITION'].astype(float)
    indices = access(gltf, binary, primitive['indices']).ravel()
    skin = gltf['skins'][0]
    joints = np.concatenate([attrs[f'JOINTS_{i}'] for i in range(2)], 1)
    weights = np.concatenate([attrs[f'WEIGHTS_{i}'] for i in range(2)], 1).astype(float)
    inverses = access(gltf, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    parents = {child: i for i, node in enumerate(gltf['nodes']) for child in node.get('children', [])}
    names = {node['name']: i for i, node in enumerate(gltf['nodes'])}

    def worlds(overrides=None):
        result = {}
        def world(index):
            if index not in result:
                node = dict(gltf['nodes'][index])
                node.update((overrides or {}).get(index, {}))
                x, y, z, w = node.get('rotation', [0, 0, 0, 1])
                local = Matrix.Translation(Vector(node.get('translation', [0, 0, 0]))) @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*node.get('scale', [1, 1, 1]), 1))
                if 'matrix' in node:
                    local = Matrix(np.array(node['matrix']).reshape(4, 4).T.tolist())
                result[index] = world(parents[index]) @ local if index in parents else local
            return result[index]
        return [np.array(world(i)) for i in range(len(gltf['nodes']))]

    def deform(world):
        matrices = np.array([world[joint] for joint in skin['joints']]) @ inverses
        return np.einsum('vi,vijk,vk->vj', weights, matrices[joints], np.column_stack([positions, np.ones(len(positions))]))[:, :3]

    bpy.ops.wm.open_mainfile(filepath=str(source_root / config['source']), load_ui=False, use_scripts=False)
    mesh = bpy.data.objects['Cube']
    rig = next(modifier.object for modifier in mesh.modifiers if modifier.type == 'ARMATURE')
    mesh.data.calc_loop_triangles()
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    source_points = np.array([list(mesh.matrix_world @ vertex.co) for vertex in mesh.data.vertices])
    # Blender Z-up to glTF Y-up. This also establishes left/right: Blender +X
    # maps to MuJoCo +Y (left), and Blender -Y maps to MuJoCo +X (forward).
    axes = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)
    expected_rest = source_points @ axes.T
    rest_worlds = worlds()
    rest = deform(rest_worlds)
    correspondence = []
    for start in range(0, len(rest), 128):
        distance = ((rest[start:start + 128, None] - expected_rest[None]) ** 2).sum(2)
        correspondence.extend(distance.argmin(1).tolist())
    correspondence = np.array(correspondence)
    maximum_rest_error = float(np.abs(rest - expected_rest[correspondence]).max())
    source_weights = np.zeros((len(source_points), len(skin['joints'])))
    joint_names = [gltf['nodes'][i]['name'] for i in skin['joints']]
    for vertex in mesh.data.vertices:
        groups = [(joint_names.index(mesh.vertex_groups[group.group].name), group.weight)
                  for group in vertex.groups if group.weight > 0 and mesh.vertex_groups[group.group].name in joint_names]
        total = sum(weight for _, weight in groups)
        for joint, weight in groups:
            source_weights[vertex.index, joint] = weight / total
            mesh.vertex_groups[joint_names[joint]].add([vertex.index], weight / total, 'REPLACE')
    # Blender's exporter drops normalized influences smaller than 1e-4 even with
    # export_all_influences=True. Refill its existing eight slots from source,
    # retaining native skin joint indices and each positive relative weight.
    exporter_dropped_influences = 0
    for exported, source in enumerate(correspondence):
        native = source_weights[source]
        previous = {int(j): float(w) for j, w in zip(joints[exported], weights[exported]) if w > 0}
        exporter_dropped_influences += sum(weight > 0 and joint not in previous for joint, weight in enumerate(native))
        active = sorted(np.flatnonzero(native), key=lambda joint: (-native[joint], joint))
        if len(active) > 8:
            raise ValueError('Source exceeds the existing eight-slot native layout')
        joints[exported] = 0
        weights[exported] = 0
        for slot, joint in enumerate(active):
            joints[exported, slot] = joint
            weights[exported, slot] = native[joint]
    for i in range(2):
        attrs[f'JOINTS_{i}'][:] = joints[:, i * 4:i * 4 + 4]
        attrs[f'WEIGHTS_{i}'][:] = weights[:, i * 4:i * 4 + 4]
    weights = np.concatenate([attrs[f'WEIGHTS_{i}'] for i in range(2)], 1).astype(float)
    rest = deform(rest_worlds)
    maximum_rest_error = float(np.abs(rest - expected_rest[correspondence]).max())
    exported_weights = np.zeros((len(positions), len(joint_names)))
    for i in range(8):
        exported_weights[np.arange(len(positions)), joints[:, i]] += weights[:, i]
    maximum_weight_error = float(np.abs(exported_weights - source_weights[correspondence]).max())
    influence_masks_equal = bool(np.array_equal(exported_weights > 0, source_weights[correspondence] > 0))
    uv = mesh.data.uv_layers.active.data
    corner_normals = mesh.data.corner_normals
    mesh_world = rest_worlds[names['Cube']]
    normal_matrix = np.linalg.inv(mesh_world[:3, :3]).T
    exported_normals = attrs['NORMAL'] @ normal_matrix.T
    exported_normals /= np.linalg.norm(exported_normals, axis=1)[:, None]
    maximum_uv_error = 0.0
    maximum_normal_error = 0.0
    # Compare each GLB split vertex to actual authored corners at that vertex.
    loops = [[] for _ in source_points]
    for loop in mesh.data.loops:
        loops[loop.vertex_index].append(loop.index)
    for exported, source in enumerate(correspondence):
        candidates = loops[source]
        source_uvs = np.array([[uv[i].uv.x, 1 - uv[i].uv.y] for i in candidates])
        errors = np.abs(source_uvs - attrs['TEXCOORD_0'][exported]).max(1)
        minimum = float(errors.min())
        maximum_uv_error = max(maximum_uv_error, minimum)
        matching = [i for i, error in zip(candidates, errors) if error < 1e-5]
        source_normals = np.array([list(corner_normals[i].vector) for i in matching]) @ axes.T
        chosen = source_normals[np.abs(source_normals - exported_normals[exported]).max(1).argmin()]
        attrs['NORMAL'][exported] = chosen @ np.linalg.inv(normal_matrix).T
        restored = attrs['NORMAL'][exported] @ normal_matrix.T
        restored /= np.linalg.norm(restored)
        maximum_normal_error = max(maximum_normal_error, float(np.abs(chosen - restored).max()))
    def triangle_cycle(vertices):
        vertices = tuple(int(index) for index in vertices)
        return min(vertices[i:] + vertices[:i] for i in range(3))
    source_triangles = Counter(triangle_cycle(tri.vertices) for tri in mesh.data.loop_triangles)
    output_triangles = Counter(triangle_cycle(correspondence[tri]) for tri in indices.reshape(-1, 3))
    frame_reports = []
    rig.data.pose_position = 'POSE'
    clip = gltf['animations'][0]
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    for frame in range(61):
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        overrides = {}
        for channel in clip['channels']:
            sampler = clip['samplers'][channel['sampler']]
            times = access(gltf, binary, sampler['input']).ravel()
            values = access(gltf, binary, sampler['output'])
            path = channel['target']['path']
            interpolation = sampler.get('interpolation', 'LINEAR')
            if interpolation not in ('LINEAR', 'STEP'):
                raise ValueError('Unsupported source clip interpolation: ' + interpolation)
            time = frame / fps
            upper = min(int(np.searchsorted(times, time, side='right')), len(times) - 1)
            lower = max(0, upper - 1)
            alpha = float(np.clip((time - times[lower]) / (times[upper] - times[lower]), 0, 1)) if times[upper] != times[lower] else 0
            if interpolation == 'STEP':
                value = values[min(int(np.searchsorted(times, time + 1e-6, side='right')) - 1, len(times) - 1)].tolist()
            elif path == 'rotation':
                a, b = values[lower], values[upper]
                q = Quaternion((a[3], *a[:3])).slerp(Quaternion((b[3], *b[:3])), alpha)
                value = [q.x, q.y, q.z, q.w]
            else:
                value = ((1 - alpha) * values[lower] + alpha * values[upper]).tolist()
            overrides.setdefault(channel['target']['node'], {})[path] = value
        actual = deform(worlds(overrides))
        evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
        source = np.array([list(evaluated.matrix_world @ vertex.co) for vertex in evaluated.data.vertices]) @ axes.T
        frame_reports.append({'frame': frame, 'maximumCoordinateError': float(np.abs(actual - source[correspondence]).max()),
                              'boundsGltf': [actual.min(0).tolist(), actual.max(0).tolist()]})
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    bones = {}
    for bone in rig.data.bones:
        matrix = rig.matrix_world @ bone.matrix_local
        tail = rig.matrix_world @ bone.tail_local
        head = rig.matrix_world @ bone.head_local
        weighted = source_weights[:, joint_names.index(bone.name)] >= .25
        bones[bone.name] = {'parent': bone.parent.name if bone.parent else None,
            'headBlender': list(head), 'tailBlender': list(tail),
            'tailLocal': list(matrix.inverted() @ tail), 'length': bone.length,
            'verticesAtLeastQuarterWeight': int(weighted.sum()),
            'weightedBoundsBlender': [source_points[weighted].min(0).tolist(), source_points[weighted].max(0).tolist()] if weighted.any() else None}
    contacts = []
    for scissor in ['Bone.009', 'Bone.010']:
        scissor_ids = np.flatnonzero(source_weights[:, joint_names.index(scissor)] >= .5)
        for arm in ['Bone.006', 'Bone.008']:
            arm_ids = np.flatnonzero(source_weights[:, joint_names.index(arm)] >= .5)
            distances = ((source_points[scissor_ids, None] - source_points[arm_ids][None]) ** 2).sum(2)
            a, b = np.unravel_index(distances.argmin(), distances.shape)
            contacts.append({'scissor': scissor, 'arm': arm, 'distance': float(np.sqrt(distances[a, b])),
                             'scissorVertex': int(scissor_ids[a]), 'armVertex': int(arm_ids[b]),
                             'scissorPointBlender': source_points[scissor_ids[a]].tolist(),
                             'armPointBlender': source_points[arm_ids[b]].tolist()})
    calibration = {
        'coordinateSystem': 'Native GLB bone-local coordinates; meters are arbitrary source units before uniform sole fitting.',
        'alignmentXyzw': [.5, .5, .5, .5],
        'anatomyEvidence': 'Blender +X is the creature left; -Y is its face/scissor direction. GLB +Y up and +Z forward become MuJoCo +Z up and +X forward.',
        'segments': {}, 'attachments': {},
        'soles': {'nativeBones': ['Bone.011', 'Bone.012'],
                  'physicsBodies': ['left_ankle_roll_link', 'right_ankle_roll_link'],
                  'reason': 'Boot and shin vertices share each lower-leg bone; there are no authored ankle/foot bones. Do not sample R1 knee geometry as a sole.'},
        'unweightedNativeBone': 'Bone.015',
        'qualification': 'Source-derived calibration and algebraic attachment evidence; production retarget and Chrome still require parent qualification.'
    }
    for name, body, target, reversed_leg in [
            ('Bone.005', 'left_shoulder_yaw_link', 'left_elbow_link', False),
            ('Bone.006', 'left_elbow_link', 'left_wrist_roll_link', False),
            ('Bone.007', 'right_shoulder_yaw_link', 'right_elbow_link', False),
            ('Bone.008', 'right_elbow_link', 'right_wrist_roll_link', False),
            ('Bone.013', 'left_hip_yaw_link', 'left_knee_link', True),
            ('Bone.011', 'left_knee_link', 'left_ankle_roll_link', True),
            ('Bone.014', 'right_hip_yaw_link', 'right_knee_link', True),
            ('Bone.012', 'right_knee_link', 'right_ankle_roll_link', True)]:
        node = names[name]
        proximal = np.array(bones[name]['tailBlender'] if reversed_leg else bones[name]['headBlender']) @ axes.T
        distal = np.array(bones[name]['headBlender'] if reversed_leg else bones[name]['tailBlender']) @ axes.T
        inverse = np.linalg.inv(rest_worlds[node])
        pivot = (inverse @ np.append(proximal, 1))[:3]
        endpoint = (inverse @ np.append(distal, 1))[:3]
        direction = endpoint - pivot
        direction /= np.linalg.norm(direction)
        parent_name = bones[name]['parent']
        parent_anchor = (np.linalg.inv(rest_worlds[names[parent_name]]) @ np.append(proximal, 1))[:3]
        calibration['segments'][name] = {'physicsBody': body, 'targetPhysicsBody': target,
            'pivotLocal': pivot.tolist(), 'directionLocal': direction.tolist(),
            'distalLocal': endpoint.tolist(), 'nativeParent': parent_name,
            'parentAnchorLocal': parent_anchor.tolist(), 'lengthSourceUnits': bones[name]['length'],
            'anatomicalDirection': 'tail-to-head' if reversed_leg else 'head-to-tail'}
    for name, parent in [('Bone.009', 'Bone.008'), ('Bone.010', 'Bone.006')]:
        relative = np.linalg.inv(rest_worlds[names[parent]]) @ rest_worlds[names[name]]
        calibration['attachments'][name] = {'nativeParent': None, 'poseParent': parent,
            'bindRelativeMatrixColumnMajor': relative.T.ravel().tolist(),
            'reason': 'Closest majority-weighted authored handle/forearm surfaces; preserve original grip spacing, not a head-to-hand snap.',
            'bindReconstructionMaximumError': float(np.abs(rest_worlds[names[parent]] @ relative - rest_worlds[names[name]]).max())}
    (stage / 'calibration.json').write_text(json.dumps(calibration, indent=2) + '\n')
    # GLTFLoader's PropertyBinding.sanitizeNodeName removes punctuation. Retain
    # exact authored names in evidence, use actual runtime names in definitions.
    def runtime_name(name):
        return name.replace('.', '')
    bindings = {
        'Bone': ['pelvis'], 'Bone001': ['torso_link'], 'Bone002': ['torso_link'],
        'Bone003': ['head_yaw_link', 'head_pitch_link', 'torso_link'],
    }
    for name, segment in calibration['segments'].items():
        bindings[runtime_name(name)] = [segment['physicsBody']]
    definition = {
        'id': 'psx-horror-entity', 'label': 'Horror Entity',
        'url': '/assets/characters/psx-horror-entity/psx-horror-entity.glb',
        'preview': '/assets/characters/psx-horror-entity/preview.min.png',
        'attribution': {'title': config['attribution']['name'],
                        'creator': config['attribution']['creator'],
                        'source': config['attribution']['sourceUrl'],
                        'license': config['attribution']['license'],
                        'modifications': [config['attribution']['modifications'],
                            'Native boots inherit calf rotation; the source has no ankle/foot joints. Source-defined grip spacing and all native skin weights remain unchanged.']},
        'rig': {'root': 'Bone', 'alignment': calibration['alignmentXyzw'], 'bindings': bindings,
                'pivots': {runtime_name(name): segment['pivotLocal'] for name, segment in calibration['segments'].items()
                           if segment['anatomicalDirection'] == 'tail-to-head'},
                'aim': {runtime_name(name): {'direction': segment['directionLocal'],
                                             'target': [segment['targetPhysicsBody']]}
                        for name, segment in calibration['segments'].items()},
                'attachments': {runtime_name(name): runtime_name(item['poseParent'])
                                for name, item in calibration['attachments'].items()},
                'feet': [{'bone': 'Bone011', 'target': ['left_ankle_roll_link', 'left_ankle_pitch_link']},
                         {'bone': 'Bone012', 'target': ['right_ankle_roll_link', 'right_ankle_pitch_link']}]}
    }
    (stage / 'definition.json').write_text(json.dumps(definition, indent=2) + '\n')
    image = gltf['images'][0]
    view = gltf['bufferViews'][image['bufferView']]
    # Only the five native normal/joint/weight accessors may differ. Preserve
    # every other buffer byte, including indices, UVs, bind matrices and clips.
    editable = {primitive['attributes'][name] for name in ('NORMAL', 'JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1')}
    original_binary = raw[28 + json_size:]
    for index in range(len(gltf['accessors'])):
        if index not in editable and access(gltf, original_binary, index).tobytes() != access(gltf, binary, index).tobytes():
            raise ValueError('Native repair altered an unrelated accessor')
    final_raw = raw[:28 + json_size] + binary
    output.write_bytes(final_raw)
    image_bytes = binary[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
    texture_path = source_root / 'Creature/Material_Base_color.png'
    report = {'sourceArchive': config['sourceArchive'], 'sourceFiles': {name: record(source_root / name) for name in config['sourceFiles']},
        'sourceVertexCount': len(source_points), 'exportedSplitVertexCount': len(positions),
        'indexedTriangleCount': len(indices) // 3, 'nativeJointCount': len(skin['joints']),
        'nativeHierarchy': bones, 'indexedSourceTriangleMultisetPreserved': source_triangles == output_triangles,
        'triangleWindingPreserved': source_triangles == output_triangles,
        'sourceVerticesOverFourInfluences': int(((source_weights > 0).sum(1) > 4).sum()),
        'nativeBoneParentsPreserved': all(
            bones[name]['parent'] == (gltf['nodes'][parents[names[name]]]['name']
                if names[name] in parents and gltf['nodes'][parents[names[name]]]['name'] in bones else None)
            for name in bones),
        'maximumRestCoordinateError': maximum_rest_error, 'maximumUVError': maximum_uv_error,
        'maximumNormalError': maximum_normal_error, 'maximumWeightRatioError': maximum_weight_error,
        'everyNonzeroInfluencePreserved': influence_masks_equal,
        'maximumInfluences': int((weights > 0).sum(1).max()),
        'verticesOverFourInfluences': int(((weights > 0).sum(1) > 4).sum()),
        'maximumWeightSumError': float(np.abs(weights.sum(1) - 1).max()),
        'inverseBindMaximumIdentityError': float(np.abs(np.array([rest_worlds[joint] for joint in skin['joints']]) @ inverses - np.eye(4)).max()),
        'exporterDroppedInfluencesRestored': int(exporter_dropped_influences),
        'allUnrelatedAccessorsByteIdenticalToNativeExport': True,
        'clip': {'name': clip['name'], 'channels': len(clip['channels']), 'sourceFps': fps,
                 'framesCompared': frame_reports, 'maximumCoordinateError': max(item['maximumCoordinateError'] for item in frame_reports)},
        'originalTextureByteIdentical': image_bytes == texture_path.read_bytes(),
        'embeddedTexture': {'bytes': len(image_bytes), 'sha256': hashlib.sha256(image_bytes).hexdigest(),
                            'dimensions': list(struct.unpack_from('>II', image_bytes, 16))},
        'material': gltf['materials'][0], 'nearestWeightedScissorArmContacts': contacts,
        'output': record(output), 'qualification': 'Private native preservation diagnostics only; no Chrome/runtime/public qualification.'}
    (stage / 'native-diagnostics.json').write_text(json.dumps(report, indent=2) + '\n')
    if (maximum_rest_error > 1e-5 or maximum_uv_error > 1e-5 or maximum_normal_error > 1e-5 or
            maximum_weight_error > 1e-6 or not influence_masks_equal or source_triangles != output_triangles or
            report['clip']['maximumCoordinateError'] > 2e-5 or not report['originalTextureByteIdentical']):
        raise ValueError('Native preservation failed; see ' + str(stage / 'native-diagnostics.json'))
    native_tools = runpy.run_path(str(Path(__file__).with_name('import_native_character_gltf.py')))
    report['previewPose'] = native_tools['render_preview'](gltf, binary, output, stage / 'preview.png', config)
    encoded_preview = runpy.run_path(str(Path(__file__).with_name('encode_character_previews.py')))['encode_preview_with_host'](stage / 'preview.png')
    report['previewMaster'] = encoded_preview['png']
    report['preview'] = encoded_preview['preview']
    (stage / 'native-diagnostics.json').write_text(json.dumps(report, indent=2) + '\n')
    analysis_path = stage / 'analysis.json'
    analysis = json.loads(analysis_path.read_text())
    analysis['output'] = record(output)
    analysis['nativePreservationDiagnostics'] = 'native-diagnostics.json'
    analysis['previewMaster'] = report['previewMaster']
    analysis['preview'] = report['preview']
    analysis_path.write_text(json.dumps(analysis, indent=2) + '\n')
    (stage / 'attribution.json').write_text(json.dumps(config['attribution'], indent=2) + '\n')
    (stage / 'source-evidence.json').write_text(json.dumps({
        'sourceArchive': config['sourceArchive'], 'sourceFiles': report['sourceFiles'],
        'licenseEvidence': config['attribution']['licenseEvidence'],
        'redistributionApproved': False,
        'approvalFlagMeaning': 'Internal private staging decision, not a creator restriction.',
        'inspiration': 'Creator credits Plastiboo; no independent third-party clearance is asserted.',
        'publicationOwner': 'Parent integration task',
    }, indent=2) + '\n')
    runtime_files = ['psx-horror-entity.glb', 'preview.png', 'preview.min.png', 'attribution.json', 'definition.json']
    (stage / 'runtime-manifest.json').write_text(json.dumps({
        'id': definition['id'], 'publicationApproved': False,
        'approvalFlagMeaning': 'Parent publication decision pending, not a creator restriction.',
        'runtimeWhitelist': [{'path': name, **record(stage / name)} for name in runtime_files],
        'excludedFromPublication': ['source/', 'analysis.json', 'native-diagnostics.json', 'calibration.json',
                                    'source-evidence.json', 'runtime-manifest.json'],
    }, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key not in ('nativeHierarchy', 'clip')}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    inspect(args.config.resolve(), args.source_root.resolve())
