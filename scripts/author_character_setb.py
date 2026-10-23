#!/usr/bin/env python3
"""Blender authoring for the inspected SetB assets; no downloads or UI integration.

Run serialized with --disable-autoexec --threads 2 --python this.py --
  --asset astronaut-low-poly|dragon-wyvern|ralph --source file.blend --output file.blend
Astronaut's missing creator texture is deliberately NOT reconstructed or replaced.
Coordinates below are measured in the downloaded source geometry, not a proxy rig.
"""
import argparse
import json
import math
from pathlib import Path
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector


def make_rig(mesh, specifications, choose):
    data = bpy.data.armatures.new(mesh.name + ' authored deform skeleton')
    armature = bpy.data.objects.new(mesh.name + ' Armature', data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, head, tail, parent in specifications:
        bone = data.edit_bones.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    groups = {name: mesh.vertex_groups.new(name=name) for name, *_ in specifications}
    segments = {name: (Vector(head), Vector(tail)) for name, head, tail, _ in specifications}
    for vertex in mesh.data.vertices:
        candidates = choose(vertex.co)
        distances = []
        for name in candidates:
            head, tail = segments[name]
            delta = tail - head
            t = max(0.0, min(1.0, (vertex.co - head).dot(delta) / delta.length_squared))
            distances.append(((vertex.co - head - delta * t).length, name))
        distances.sort()
        # Compact inverse-distance support blends joints; no body-part rigid proxy.
        nearest = distances[:2]
        weights = [1 / max(0.025, distance) ** 4 for distance, _ in nearest]
        total = sum(weights)
        for (_, name), weight in zip(nearest, weights):
            groups[name].add([vertex.index], weight / total, 'REPLACE')
    modifier = mesh.modifiers.new('Authored smooth deform skin', 'ARMATURE')
    modifier.object = armature
    mesh.parent = armature
    armature['rigAuthoring'] = 'm0clip: anatomical joint placement from inspected original geometry; region-restricted normalized distance skinning, up to two influences; no remeshing or proxy geometry'
    return armature


def astronaut(mesh):
    # Source is +Y up, +Z front (backpack at -Z); rotate to Blender +Z up/-Y front.
    transform = Matrix.Rotation(math.pi / 2, 4, 'X') @ mesh.matrix_world
    mesh.data.transform(transform)
    mesh.matrix_world = Matrix.Identity(4)
    specs = [('pelvis', (0, -.04, .05), (0, -.04, .45), None),
             ('spine', (0, -.04, .45), (0, -.04, 1.13), 'pelvis'),
             ('chest', (0, -.04, 1.13), (0, -.04, 1.58), 'spine'),
             ('neck', (0, -.04, 1.58), (0, -.04, 1.77), 'chest'),
             ('head', (0, -.04, 1.77), (0, -.04, 2.47), 'neck')]
    for side, sign in [('L', 1), ('R', -1)]:
        def p(x, y, z): return (sign * x, y, z)
        specs += [('upper_arm.' + side, p(.57, -.04, 1.34), p(1.39, -.04, 1.34), 'chest'),
                  ('forearm.' + side, p(1.39, -.04, 1.34), p(2.10, -.04, 1.34), 'upper_arm.' + side),
                  ('hand.' + side, p(2.10, -.04, 1.34), p(2.48, -.04, 1.29), 'forearm.' + side),
                  ('thigh.' + side, p(.29, -.04, .08), p(.32, -.04, -1.14), 'pelvis'),
                  ('shin.' + side, p(.32, -.04, -1.14), p(.32, -.04, -2.35), 'thigh.' + side),
                  ('foot.' + side, p(.32, -.04, -2.35), p(.32, -.49, -2.63), 'shin.' + side)]
    def choose(v):
        side = 'L' if v.x >= 0 else 'R'
        if v.z > 1.65: return ['neck', 'head']
        if abs(v.x) > .62 and v.z > 1.03:
            return ['upper_arm.' + side, 'forearm.' + side, 'hand.' + side]
        if v.z < .05: return ['thigh.' + side, 'shin.' + side, 'foot.' + side, 'pelvis']
        return ['pelvis', 'spine', 'chest', 'neck']
    return make_rig(mesh, specs, choose)


def dragon(mesh):
    # Source +Z up, -Y front: observed snout -Y, tail +Y, wings +/-X.
    specs = [('pelvis', (0, .18, .98), (0, -.21, 1.03), None),
             ('spine', (0, -.21, 1.03), (0, -.62, 1.11), 'pelvis'),
             ('chest', (0, -.62, 1.11), (0, -.93, 1.22), 'spine'),
             ('neck', (0, -.93, 1.22), (0, -1.38, 1.42), 'chest'),
             ('head', (0, -1.38, 1.42), (0, -2.04, 1.19), 'neck'),
             ('jaw', (0, -1.43, 1.17), (0, -1.94, .84), 'head'),
             ('tail.01', (0, .23, 1.02), (0, .83, .74), 'pelvis'),
             ('tail.02', (0, .83, .74), (0, 1.39, .40), 'tail.01'),
             ('tail.03', (0, 1.39, .40), (0, 1.97, .51), 'tail.02'),
             ('tail.04', (0, 1.97, .51), (0, 2.09, .91), 'tail.03'),
             ('tail.05', (0, 2.09, .91), (0, 1.62, 1.17), 'tail.04')]
    for side, sign in [('L', 1), ('R', -1)]:
        def p(x, y, z): return (sign * x, y, z)
        specs += [('upper_arm.' + side, p(.22, -.70, 1.18), p(1.52, -.11, 1.03), 'chest'),
                  ('forearm.' + side, p(1.52, -.11, 1.03), p(2.61, -.25, 1.32), 'upper_arm.' + side),
                  ('hand.' + side, p(2.61, -.25, 1.32), p(4.40, .36, 1.61), 'forearm.' + side),
                  ('wing_fan.' + side, p(1.52, -.11, 1.03), p(2.67, 1.48, 1.45), 'upper_arm.' + side),
                  ('thigh.' + side, p(.26, .13, .99), p(.44, .47, .57), 'pelvis'),
                  ('shin.' + side, p(.44, .47, .57), p(.37, .15, .15), 'thigh.' + side),
                  ('foot.' + side, p(.37, .15, .15), p(.40, -.26, .04), 'shin.' + side)]
    def choose(v):
        side = 'L' if v.x >= 0 else 'R'
        if abs(v.x) > .70 and v.z > .66:
            return ['upper_arm.' + side, 'forearm.' + side, 'hand.' + side, 'wing_fan.' + side]
        if v.y > .57 and abs(v.x) < .30:
            return ['tail.01', 'tail.02', 'tail.03', 'tail.04', 'tail.05']
        if v.z < .74 and v.y > -.42:
            return ['thigh.' + side, 'shin.' + side, 'foot.' + side, 'pelvis']
        if v.y < -1.33:
            return ['jaw', 'head'] if v.z < 1.1 else ['head', 'neck']
        return ['pelvis', 'spine', 'chest', 'neck', 'head']
    return make_rig(mesh, specs, choose)


def bake_ralph_actions(armature):
    """Evaluate the source constraints before replacing them with reusable keys."""
    source_actions = [a for a in bpy.data.actions if not a.name.startswith('SphereAction')]
    native_matrix = armature.matrix_basis.copy()
    constraints = [(c, c.influence) for p in armature.pose.bones for c in p.constraints]
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.data.pose_position = 'POSE'
    samples = []
    for action in source_actions:
        armature.animation_data.action = None
        armature.matrix_basis = native_matrix
        for bone in armature.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
        for constraint, influence in constraints:
            constraint.influence = influence
        armature.animation_data.action = action
        frames = []
        for frame in range(math.floor(action.frame_range[0]), math.ceil(action.frame_range[1]) + 1):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            matrices = {}
            for bone in armature.pose.bones:
                kwargs = {}
                if bone.parent:
                    kwargs = {'parent_matrix': bone.parent.matrix, 'parent_matrix_local': bone.parent.bone.matrix_local}
                matrices[bone.name] = bone.bone.convert_local_to_pose(
                    bone.matrix, bone.bone.matrix_local, invert=True, **kwargs)
            frames.append((frame, armature.matrix_basis.copy(), matrices))
        samples.append((action.name, frames))
    armature.animation_data_clear()
    for bone in armature.pose.bones:
        for constraint in list(bone.constraints):
            bone.constraints.remove(constraint)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    armature.animation_data_create()
    armature.rotation_mode = 'QUATERNION'
    for name, frames in samples:
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        armature.animation_data.action = action
        previous = {}
        for frame, object_matrix, matrices in frames:
            armature.location, armature.rotation_quaternion, armature.scale = object_matrix.decompose()
            for key in ('location', 'rotation_quaternion', 'scale'):
                armature.keyframe_insert(data_path=key, frame=frame, group='Native armature transform')
            for bone in armature.pose.bones:
                bone.rotation_mode = 'QUATERNION'
                location, rotation, scale = matrices[bone.name].decompose()
                if bone.name in previous and rotation.dot(previous[bone.name]) < 0:
                    rotation.negate()
                previous[bone.name] = rotation.copy()
                bone.location, bone.rotation_quaternion, bone.scale = location, rotation, scale
                for key in ('location', 'rotation_quaternion', 'scale'):
                    bone.keyframe_insert(data_path=key, frame=frame, group=bone.name)
    armature.animation_data.action = None
    armature.matrix_basis = native_matrix
    for bone in armature.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    armature['animationBake'] = 'All nine complete source actions visually sampled at every original integer frame, including every helper bone and armature object transform; stale source keys targeting nonexistent bones and duplicate NLA stashes are replaced by evaluated transforms.'


def prepare_ralph(texture_root):
    armature = bpy.data.objects['Armature']
    keep = set(armature.children_recursive) | {armature}
    for obj in list(bpy.data.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)
    # All nine full source actions retained; discard only unrelated swatch actions.
    for action in list(bpy.data.actions):
        if action.name.startswith('SphereAction'):
            bpy.data.actions.remove(action)
    for image in bpy.data.images:
        if image.source != 'FILE':
            continue
        filename = Path(image.filepath).name.replace('(1)', '')
        matches = [p for p in texture_root.rglob(filename) if '__MACOSX' not in str(p)]
        if len(matches) == 1:
            image.filepath = str(matches[0]); image.reload()
        elif matches:
            wanted = 'Ralph_1.0_Bakes' if 'Ralph_1.0_Bakes' in image.filepath else 'Base_Bakes'
            image.filepath = str(next(p for p in matches if wanted in str(p))); image.reload()
    # Explicit triangulation avoids exporter tangent loss on authored n-gon caps.
    for obj in keep:
        if obj.type == 'MESH' and any(len(p.vertices) > 4 for p in obj.data.polygons):
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], ngon_method='BEAUTY')
            bm.to_mesh(obj.data); bm.free()
    bake_ralph_actions(armature)
    armature.data.pose_position = 'REST'
    return armature


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asset', required=True, choices=['astronaut-low-poly', 'dragon-wyvern', 'ralph'])
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--texture-root', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=str(args.source), load_ui=False, use_scripts=False)
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.update()
    if args.asset == 'ralph':
        armature = prepare_ralph(args.texture_root)
    else:
        mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
        armature = astronaut(mesh) if args.asset == 'astronaut-low-poly' else dragon(mesh)
    bpy.context.view_layer.update()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output), compress=True)
    print(json.dumps({'asset': args.asset, 'bones': len(armature.data.bones), 'output': str(args.output)}))
