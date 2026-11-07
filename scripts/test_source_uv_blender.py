"""Blender-side UV sampler probes for test_source_base_uv_runtime.cjs.

Image-vector chains come from the actual imported GLB. Emission-only material
copies isolate those samplers from lighting; the imported geometry, UVs, images
and original materials stay unchanged. This is not a full-scene appearance test.
"""
import hashlib
import json
from pathlib import Path
import sys


def main():
    import bpy
    from mathutils import Matrix

    source, directory, expected_sha = sys.argv[sys.argv.index('--') + 1:]
    source, directory = Path(source), Path(directory)
    if not directory.is_dir() or hashlib.sha256(source.read_bytes()).hexdigest() != expected_sha:
        raise ValueError('Missing probe directory or changed GLB input')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == 'MESH']
    targets = []
    for mesh in meshes:
        for slot, material in enumerate(mesh.data.materials):
            for node in material.node_tree.nodes:
                if node.type != 'TEX_IMAGE':
                    continue
                normal = any(link.to_node.type == 'NORMAL_MAP' for output in node.outputs for link in output.links)
                targets.append((material.name + (' normalMap' if normal else ' map'), mesh, slot, material, node.name))
    if sorted(target[0] for target in targets) != ['source map', 'studio map', 'studio normalMap']:
        raise ValueError('GLB does not contain the three required image bindings')

    camera = bpy.data.objects.new('UV probe', bpy.data.cameras.new('UV probe'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = 'ORTHO'
    # A tiny pixel footprint stays away from nearest-sampler boundaries despite ray jitter.
    camera.data.ortho_scale = .0001
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 1
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.dither_intensity = 0

    def sampler_copy(material, image_name, identity=False):
        copy = material.copy()
        tree = copy.node_tree
        image = tree.nodes[image_name]
        output = next(node for node in tree.nodes if node.type == 'OUTPUT_MATERIAL' and node.is_active_output)
        emission = tree.nodes.new('ShaderNodeEmission')
        for link in list(output.inputs['Surface'].links):
            tree.links.remove(link)
        tree.links.new(image.outputs['Color'], emission.inputs['Color'])
        tree.links.new(emission.outputs[0], output.inputs['Surface'])
        if identity:
            for link in list(image.inputs['Vector'].links):
                tree.links.remove(link)
            uv = tree.nodes.new('ShaderNodeUVMap')
            tree.links.new(uv.outputs['UV'], image.inputs['Vector'])
        return copy

    cases = []
    for label, mesh, slot, material, image_name in targets:
        for obj in meshes:
            obj.hide_render = obj != mesh
        bpy.context.view_layer.update()
        corners = {}
        for loop, uv in zip(mesh.data.loops, mesh.data.uv_layers.active.data):
            corners[tuple(round(value, 6) for value in uv.uv)] = mesh.matrix_world @ mesh.data.vertices[loop.vertex_index].co
        # glTF's top-left texture origin is represented by flipped Blender UVs.
        p00, p10, p01 = corners[(0., 1.)], corners[(1., 1.)], corners[(0., 0.)]
        x, y = p10 - p00, p01 - p00
        right, up = x.normalized(), y.normalized()
        normal = right.cross(up).normalized()
        actual, reference = sampler_copy(material, image_name), sampler_copy(material, image_name, True)
        try:
            for index, (u, v) in enumerate(((.125, .125), (.375, .125), (.125, .625), (.875, .625))):
                authored = (.35 - .5 * v, 2 * u + .1)
                paths = {}
                for kind, probe_material, at in (('actual', actual, (u, v)), ('reference', reference, (authored[0] % 1, authored[1] % 1))):
                    mesh.data.materials[slot] = probe_material
                    location = p00 + x * at[0] + y * at[1] + normal * 2
                    camera.matrix_world = Matrix(((right.x, up.x, normal.x, location.x), (right.y, up.y, normal.y, location.y), (right.z, up.z, normal.z, location.z), (0, 0, 0, 1)))
                    output = directory / (label.replace(' ', '-') + '-' + str(index) + '-' + kind + '.png')
                    if output.exists():
                        raise FileExistsError(output)
                    scene.render.filepath = str(output)
                    bpy.ops.render.render(write_still=True)
                    paths[kind] = str(output)
                cases.append(dict(binding=label, uv=[u, v], authored=list(authored), **paths))
        finally:
            mesh.data.materials[slot] = material
            bpy.data.materials.remove(actual)
            bpy.data.materials.remove(reference)
    if hashlib.sha256(source.read_bytes()).hexdigest() != expected_sha:
        raise ValueError('GLB changed during import/render')
    print('SOURCE_UV_BLENDER ' + json.dumps(dict(explicitCompletion=True, sourceSha256=expected_sha, blender=bpy.app.version_string, cases=cases)))


if __name__ == '__main__':
    main()
