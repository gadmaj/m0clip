"""Ghost sky and authored glow sprites, following noclip.website Main.ts / Sprite.ts."""
import numpy as np
from source_assets import material, decode_vtf
from import_source_bsp import SCALE


def sky_face_uvs(transform=None):
    """noclip SkyboxRenderer seam clamp, followed by the authored VMT UV matrix."""
    uv = np.array([[np.clip(s*.5+.5, 1/512, 511/512), np.clip(1-(t*.5+.5), 1/512, 511/512), 1.]
                   for s, t in ((-1, -1), (-1, 1), (1, 1), (1, -1))])
    matrix = np.eye(3) if transform is None else np.asarray(transform).reshape(3, 3)
    return (uv @ matrix.T)[:, :2]


def export_extras(glb, exporter, model, rotation, origin):
    sky = model['ents'][0].get('skyname', '')
    sky_count = sprites = sky_transformed = 0
    for suffix, plane in zip(('rt', 'lf', 'bk', 'ft', 'up', 'dn'), (0x503, 0x413, 0x153, 0x043, 0x205, 0x304)):
        if not sky: break
        meta = material(exporter.fs, f'skybox/{sky}{suffix}')
        if not meta: continue
        texture = exporter.texture(meta['basetexture'])
        if texture is None: continue
        vertices = []
        uv = sky_face_uvs(meta.get('basetexturetransform'))
        if not np.allclose(np.asarray(meta.get('basetexturetransform', np.eye(3))).reshape(3, 3), np.eye(3)):
            sky_transformed += 1
        for s, t in ((-1, -1), (-1, 1), (1, 1), (1, -1)):
            g = [-s, s, -t, t, -1, 1]
            vertices.append([g[(plane >> shift) & 15] for shift in (8, 4, 0)])
        positions = np.array(vertices) @ rotation.T
        record = dict(name=f'skybox/{sky}{suffix}', pbrMetallicRoughness=dict(metallicFactor=0, roughnessFactor=1,
            baseColorTexture=dict(index=texture)), extras=dict(sourceVertexLighting=1, sourceUnlit=True))
        index = len(glb.json['materials']); glb.json['materials'].append(record)
        primitive = dict(attributes=dict(POSITION=glb.accessor(positions, 'VEC3'), NORMAL=glb.accessor(np.tile([0, 0, 1], (4, 1)), 'VEC3'),
            TEXCOORD_0=glb.accessor(uv, 'VEC2')), indices=glb.accessor([0, 2, 1, 0, 3, 2], 'SCALAR', index=True), material=index)
        glb.node(f'sky:{suffix}', [primitive], None, dict(sourceSky=True, sourceSkyTextureTransform=meta.get('basetexturetransform', np.eye(3).reshape(-1).tolist())))
        sky_count += 1
    for entity in model['ents']:
        if entity['classname'] not in ('env_sprite', 'env_glow', 'env_sprite_clientside'): continue
        if entity.get('targetname') and not int(entity.get('spawnflags', '0')) & 1: continue
        name = entity.get('model', '').removesuffix('.vmt').removesuffix('.spr').removeprefix('materials/')
        meta = material(exporter.fs, name)
        if not meta: continue
        texture = exporter.texture(meta['basetexture'])
        if texture is None: continue
        image = glb.json['images'][glb.json['textures'][texture]['source']]
        from PIL import Image
        import io
        view = glb.json['bufferViews'][image['bufferView']]
        width, height = Image.open(io.BytesIO(glb.buffer[view['byteOffset']:view['byteOffset']+view['byteLength']])).size
        scale = float(entity.get('scale', '1'))
        # Material_Generic passes entity modulation through fillColor(..., false):
        # these tint values stay linear. Some BSPs append a fourth legacy value;
        # renderamt supplies alpha, so only the first three rendercolor values belong here.
        color = [float(v) / 255 for v in entity.get('rendercolor', '255 255 255').split()[:3]]
        alpha = float(entity.get('renderamt', '255')) / 255
        record = dict(name=name, alphaMode='BLEND', doubleSided=True, pbrMetallicRoughness=dict(metallicFactor=0, roughnessFactor=1,
            baseColorFactor=[*color, alpha], baseColorTexture=dict(index=texture)), extras=dict(sourceVertexLighting=1, sourceUnlit=True))
        material_index = len(glb.json['materials']); glb.json['materials'].append(record)
        points = np.array([[-.5, -.5, 0], [.5, -.5, 0], [.5, .5, 0], [-.5, .5, 0]]) * [width*SCALE*scale, height*SCALE*scale, 1]
        primitive = dict(attributes=dict(POSITION=glb.accessor(points, 'VEC3'), NORMAL=glb.accessor(np.tile([0, 0, 1], (4, 1)), 'VEC3'),
            TEXCOORD_0=glb.accessor([[0, 1], [1, 1], [1, 0], [0, 0]], 'VEC2')),
            indices=glb.accessor([0, 1, 2, 0, 2, 3], 'SCALAR', index=True), material=material_index)
        position = np.array([float(v) for v in entity['origin'].split()])
        transform = np.eye(4); transform[:3, 3] = rotation @ (position-origin) * SCALE
        glb.node(f'sprite:{sprites}', [primitive], transform, dict(sourceSprite=True, sourceRenderMode=int(entity.get('rendermode', '9')),
            sourceSpriteAlpha=alpha))
        sprites += 1
    return dict(sky_faces=sky_count, sky_inward_faces=sky_count, sky_transformed_faces=sky_transformed, sprites=sprites)


def export_details(glb, exporter, bsp, model, rotation, origin):
    import struct
    from source_lightmaps import unpack_rgbexp32
    game = bsp.lump(35); data = None
    for i in range(struct.unpack_from('<I', game, 0)[0]):
        tag, flags, version, offset, length = struct.unpack_from('<4sHHii', game, 4+i*16)
        if tag == b'prpd' and version == 4: data = bsp.data[offset:offset+length]
    if data is None: return 0
    offset = 4 + struct.unpack_from('<I', data, 0)[0]*128
    count = struct.unpack_from('<I', data, offset)[0]; offset += 4
    definitions = [struct.unpack_from('<8f', data, offset+i*32) for i in range(count)]
    offset += count*32
    count = struct.unpack_from('<I', data, offset)[0]; offset += 4
    name = model['ents'][0].get('detailmaterial', 'detail/detailsprites')
    meta = material(exporter.fs, name)
    if not meta: return 0
    texture = exporter.texture(meta['basetexture'])
    if texture is None: return 0
    restored = 0
    for i in range(count):
        at = offset+i*52
        if data[at+40] != 2 or data[at+44] != 1: continue
        definition = definitions[struct.unpack_from('<H', data, at+24)[0]]
        tlx, tly, lrx, lry, u0, v0, u1, v1 = definition
        half_width, height = (lrx-tlx)/2, lry-tly
        points = np.array([[-half_width, 0, -height], [half_width, 0, -height], [half_width, 0, 0], [-half_width, 0, 0]]) * SCALE
        color = unpack_rgbexp32(np.frombuffer(data, np.uint8, 4, at+28)).tolist()
        record = dict(name=name, alphaMode='MASK', alphaCutoff=meta['alphatestreference'], doubleSided=True,
            pbrMetallicRoughness=dict(metallicFactor=0, roughnessFactor=1, baseColorFactor=[*color, 1], baseColorTexture=dict(index=texture)),
            extras=dict(sourceVertexLighting=1, sourceUnlit=True))
        index = len(glb.json['materials']); glb.json['materials'].append(record)
        primitive = dict(attributes=dict(POSITION=glb.accessor(points, 'VEC3'), NORMAL=glb.accessor(np.tile([0, 1, 0], (4, 1)), 'VEC3'),
            TEXCOORD_0=glb.accessor([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], 'VEC2')),
            indices=glb.accessor([0, 1, 2, 0, 2, 3], 'SCALAR', index=True), material=index)
        position = np.frombuffer(data, '<f4', 3, at)
        transform = np.eye(4); transform[:3, 3] = rotation @ (position-origin)*SCALE
        glb.node(f'detail:{i}', [primitive], transform, dict(sourceDetail=True))
        restored += 1
    return restored
