#!/usr/bin/env python3
"""Convert Elegant Crow's downloaded FBX with its supplied 512px maps.

Run with Blender 4.5, not system Python:
  blender --background --factory-startup --threads 2 --python scripts/import_gingerbread.py -- \
    --source /private/gingerbread_man --output /private/converted

Without --provenance, output remains private inspection material. For licensed
distribution, pass the verified OpenGameArt attribution JSON; every source-file
hash must match before its CC-BY-SA-4.0 provenance is embedded in the GLB.
Native geometry, bind hierarchy, and all skin influences are retained. Blender's
FBX importer translates the original non-PBR material to Principled BSDF; the
unlinked supplied color and normal maps are explicitly connected for glTF.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy


def file_record(path):
    return dict(bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def matrix_rows(matrix):
    return [list(row) for row in matrix]


def bounds(points):
    return [[min(p[axis] for p in points) for axis in range(3)],
            [max(p[axis] for p in points) for axis in range(3)]]


def convert(source, output, provenance=None):
    fbx = source / 'gb_man.fbx'
    color_path = source / 'textures/512x512/gb_man_color_512.png'
    normal_path = source / 'textures/512x512/gb_man_normals_512.png'
    for path in (fbx, color_path, normal_path):
        if not path.is_file():
            raise FileNotFoundError(path)
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.threads_mode = 'FIXED'
    bpy.context.scene.render.threads = 2
    bpy.ops.import_scene.fbx(filepath=str(fbx), use_anim=True,
                             automatic_bone_orientation=False, ignore_leaf_bones=False)
    meshes = sorted((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: o.name)
    armatures = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if len(armatures) != 1 or not meshes:
        raise ValueError('Expected one authored armature and nonempty mesh geometry')
    armature = armatures[0]
    report = dict(source='https://elegantcrow.itch.io/rigged-gingerbread-man',
                  private_inspection_only=True, redistribution_permission='unresolved',
                  blender=bpy.app.version_string, source_files={}, bones=[], meshes=[],
                  materials=[], animations=[], source_axes='Blender FBX import: +Z up, +X character left, face toward -Y',
                  gltf_axes='+Y up, +X character left, face toward +Z; metres as imported, no rescaling',
                  matrix_convention='Source matrices below are row-major; glTF matrices use column-major arrays',
                  conversion_changes=['Use supplied 512px color and tangent-space normal PNGs',
                                      'Connect color to Base Color, normal via tangent Normal Map strength 1',
                                      'Keep FBX-imported PBR factors and opaque surface; do not connect atlas alpha',
                                      'Export +Y-up glTF, UV-split vertices and tangents; retain every skin influence',
                                      'Normalize non-unit source weight sums while preserving relative influence ratios',
                                      'No decimation, weld, rig replacement, animation synthesis or transform application'])
    for path in sorted(source.rglob('*')):
        if path.is_file():
            report['source_files'][str(path.relative_to(source))] = file_record(path)
    if provenance is not None:
        if provenance.get('license') != 'CC-BY-SA-4.0':
            raise ValueError('Expected the verified CC-BY-SA-4.0 OpenGameArt grant')
        for field in ('name', 'creator', 'copyright', 'licenseUrl', 'sourceUrl', 'modifications'):
            if not provenance.get(field):
                raise ValueError('Missing license provenance field: ' + field)
        if provenance.get('sourceFiles') != report['source_files']:
            raise ValueError('Source bytes do not match the licensed provenance')
        report['source'] = provenance['sourceUrl']
        report['private_inspection_only'] = False
        report['redistribution_permission'] = 'CC-BY-SA-4.0; retain attribution, license, changes and ShareAlike'
        report['attribution'] = provenance
    bone_names = [b.name for b in armature.data.bones]
    for bone in armature.data.bones:
        local = bone.parent.matrix_local.inverted() @ bone.matrix_local if bone.parent else bone.matrix_local
        translation, rotation, scale = local.decompose()
        report['bones'].append(dict(name=bone.name, parent=bone.parent.name if bone.parent else None,
                                    head=list(bone.head_local), tail=list(bone.tail_local),
                                    matrix_armature=matrix_rows(bone.matrix_local),
                                    matrix_parent=matrix_rows(local), position=list(translation),
                                    quaternion_xyzw=[rotation.x, rotation.y, rotation.z, rotation.w],
                                    scale=list(scale), deform=bone.use_deform))
    report['armature'] = dict(name=armature.name, matrix_world=matrix_rows(armature.matrix_world))
    all_world = []
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        world = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
        all_world.extend(world)
        influences = []
        group_totals = {}
        excess_mass = []
        for vertex in mesh.vertices:
            weights = sorted(((obj.vertex_groups[g.group].name, float(g.weight))
                              for g in vertex.groups if g.weight > 0), key=lambda item: -item[1])
            if any(name not in bone_names for name, _ in weights):
                raise ValueError('Mesh contains weights referencing a non-bone group')
            influences.append([dict(bone=name, weight=weight) for name, weight in weights])
            for name, weight in weights:
                group_totals[name] = group_totals.get(name, 0) + weight
            excess_mass.append(sum(weight for _, weight in weights[4:]))
        report['meshes'].append(dict(name=obj.name, vertices=len(mesh.vertices),
                                     polygons=len(mesh.polygons), triangles=len(mesh.loop_triangles),
                                     matrix_world=matrix_rows(obj.matrix_world), bounds_world=bounds(world),
                                     materials=[m.name for m in mesh.materials],
                                     uv_layers=[layer.name for layer in mesh.uv_layers],
                                     armature_modifiers=[dict(name=m.name, target=m.object.name if m.object else None)
                                                         for m in obj.modifiers if m.type == 'ARMATURE'],
                                     max_influences=max(map(len, influences)),
                                     vertices_over_four_influences=sum(len(w) > 4 for w in influences),
                                     max_weight_mass_beyond_four=max(excess_mass),
                                     weight_sum_range=[min(sum(w['weight'] for w in v) for v in influences),
                                                       max(sum(w['weight'] for w in v) for v in influences)],
                                     weighted_bones=group_totals,
                                     positions_local=[list(v.co) for v in mesh.vertices],
                                     positions_world=[list(p) for p in world], skin_weights=influences))
    report['bounds_world'] = bounds(all_world)
    report['triangles'] = sum(m['triangles'] for m in report['meshes'])
    report['vertices'] = sum(m['vertices'] for m in report['meshes'])
    report['animations'] = [dict(name=a.name, frame_range=list(a.frame_range)) for a in bpy.data.actions]
    color = bpy.data.images.load(str(color_path), check_existing=True)
    normal = bpy.data.images.load(str(normal_path), check_existing=True)
    color.colorspace_settings.name = 'sRGB'
    normal.colorspace_settings.name = 'Non-Color'
    if list(color.size) != [512, 512] or list(normal.size) != [512, 512]:
        raise ValueError('Expected the original supplied 512px maps')
    used_materials = {m for obj in meshes for m in obj.data.materials}
    for material in sorted(used_materials, key=lambda m: m.name):
        if not material.use_nodes:
            raise ValueError('FBX import did not provide a node material')
        tree = material.node_tree
        bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
        base = tree.nodes.new('ShaderNodeTexImage')
        base.name = 'Authored 512px color'
        base.image = color
        tree.links.new(base.outputs['Color'], bsdf.inputs['Base Color'])
        normal_texture = tree.nodes.new('ShaderNodeTexImage')
        normal_texture.name = 'Authored 512px normals'
        normal_texture.image = normal
        normal_map = next((n for n in tree.nodes if n.type == 'NORMAL_MAP'), None)
        if normal_map is None:
            normal_map = tree.nodes.new('ShaderNodeNormalMap')
        normal_map.space = 'TANGENT'
        normal_map.inputs['Strength'].default_value = 1
        tree.links.new(normal_texture.outputs['Color'], normal_map.inputs['Color'])
        tree.links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
        report['materials'].append(dict(name=material.name,
                                       roughness=bsdf.inputs['Roughness'].default_value,
                                       metallic=bsdf.inputs['Metallic'].default_value,
                                       color=str(color_path.relative_to(source)),
                                       normal=str(normal_path.relative_to(source)),
                                       normal_strength=1, alpha_mode='OPAQUE',
                                       note='Original FBX has no linked images; maps supplied separately in archive'))
    glb_path = output / 'gingerbread-man-512.glb'
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format='GLB', export_yup=True,
                              export_texcoords=True, export_normals=True, export_tangents=True,
                              export_materials='EXPORT', export_image_format='AUTO',
                              export_skins=True, export_all_influences=True,
                              export_def_bones=False, export_animations=True,
                              export_apply=False, export_cameras=False, export_lights=False)
    data = glb_path.read_bytes()
    json_length, json_type = struct.unpack_from('<I4s', data, 12)
    if json_type != b'JSON':
        raise ValueError('Exporter did not write a GLB JSON chunk')
    gltf = json.loads(data[20:20 + json_length])
    binary_header = 20 + json_length
    binary_length, binary_type = struct.unpack_from('<I4s', data, binary_header)
    if binary_type != b'BIN\0':
        raise ValueError('Exporter did not embed a GLB binary chunk')
    binary = data[binary_header + 8:binary_header + 8 + binary_length]
    if provenance is not None:
        gltf['asset']['copyright'] = provenance['copyright']
        gltf['asset']['extras'] = dict(attribution=provenance)
        for scene in gltf.get('scenes', []):
            scene.setdefault('extras', {})['attribution'] = provenance
        encoded = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        encoded += b' ' * (-len(encoded) % 4)
        # Only replace the JSON chunk. Geometry, skin, images and binary offsets stay unchanged.
        glb_path.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(encoded) + 8 + len(binary)) +
                             struct.pack('<I4s', len(encoded), b'JSON') + encoded +
                             struct.pack('<I4s', len(binary), b'BIN\0') + binary)
        (output / 'attribution.json').write_text(json.dumps(provenance, indent=2) + '\n')
    report['gltf'] = dict(asset=gltf['asset'], nodes=gltf['nodes'], skins=gltf.get('skins', []),
                          meshes=gltf.get('meshes', []), materials=gltf.get('materials', []),
                          animations=gltf.get('animations', []), images=[], inverse_bind_matrices=[])
    for image in gltf.get('images', []):
        view = gltf['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        image_data = binary[start:start + view['byteLength']]
        report['gltf']['images'].append(dict(name=image.get('name'), mimeType=image['mimeType'],
                                           bytes=len(image_data), sha256=hashlib.sha256(image_data).hexdigest()))
    for skin in gltf.get('skins', []):
        accessor = gltf['accessors'][skin['inverseBindMatrices']]
        view = gltf['bufferViews'][accessor['bufferView']]
        if accessor['componentType'] != 5126 or accessor['type'] != 'MAT4':
            raise ValueError('Unexpected inverse-bind accessor format')
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        stride = view.get('byteStride', 64)
        report['gltf']['inverse_bind_matrices'].append([
            list(struct.unpack_from('<16f', binary, start + i * stride)) for i in range(accessor['count'])])
    report['output'] = dict(path=str(glb_path), **file_record(glb_path))
    metadata_path = output / 'analysis.json'
    metadata_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(output=report['output'], metadata=str(metadata_path),
                          source_vertices=report['vertices'], triangles=report['triangles'],
                          bones=len(report['bones']), parts=[m['name'] for m in report['meshes']],
                          bounds=report['bounds_world'], animations=report['animations'],
                          materials=report['materials'],
                          maximum_influences=max(m['max_influences'] for m in report['meshes'])), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Extracted gingerbread_man directory')
    parser.add_argument('--output', required=True, type=Path, help='Output directory; private unless provenance supplied')
    parser.add_argument('--provenance', type=Path, help='Verified OpenGameArt attribution JSON with matching source hashes')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    provenance = json.loads(args.provenance.read_text()) if args.provenance else None
    convert(args.source.resolve(), args.output.resolve(), provenance)
