"""Source BSP corner normals and tangent space, following noclip.website BSPFile.ts.

Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. Keep the original
positions, winding, UVs and lightmap packing; only restore the shading frame.
"""
import numpy as np
from import_source_bsp import displacement, face_points, SURF_HIDE, SCALE
from source_models import qangle


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-20)


def displacement_normals(grid):
    # noclip averages the two unit triangle normals from every adjacent quad.
    # Both triangles contribute to all four corners, independently of draw indices.
    a, b, c, d = grid[:-1, :-1], grid[:-1, 1:], grid[1:, :-1], grid[1:, 1:]
    normals = unit(np.cross(b-a, c-a)) + unit(np.cross(d-b, c-b))
    total = np.zeros_like(grid)
    for dy, dx in ((0, 0), (0, 1), (1, 0), (1, 1)):
        total[dy:dy+len(normals), dx:dx+normals.shape[1]] += normals
    # The Source vertex shader normalizes the averaged result before using it.
    return unit(total).reshape(-1, 3)


class SurfaceFrames:
    def __init__(self, bsp, model):
        self.model = model
        self.normals = np.frombuffer(bsp.lump(30), '<f4').reshape(-1, 3)
        self.indices = np.frombuffer(bsp.lump(31), '<u2')
        counts = model['faces']['numedges'].astype(np.int64)
        self.starts = np.concatenate([[0], np.cumsum(counts)])
        if self.starts[-1] != len(self.indices) or np.any(counts < 0):
            raise ValueError('BSP corner-normal indices do not match face order')
        if len(self.indices) and self.indices.max() >= len(self.normals):
            raise ValueError('BSP corner-normal index is out of range')

    def frame(self, fi, rotation):
        m = self.model; face = m['faces'][fi]
        if face['disp'] >= 0:
            grid, _ = displacement(m, face)
            points = grid.reshape(-1, 3)
            normals = displacement_normals(grid)
        else:
            # The existing glTF reverses Source's clockwise polygon vertices.
            points = face_points(m, face)[::-1]
            normals = self.normals[self.indices[self.starts[fi]:self.starts[fi+1]]][::-1]
        tex = m['texinfo'][face['texinfo']]['vecs'][:8].reshape(2, 4)[:, :3]
        s, t = unit(tex)
        sign = -1 if np.dot(m['planes'][face['plane']]['n'], np.cross(s, t)) > 0 else 1
        source_s = unit(np.cross(normals, t))
        # Source: basis0=S*w, basis1=cross(S,N). glTF: basis1=cross(N,T)*w.
        tangents = np.column_stack([(source_s * sign) @ rotation.T, np.full(len(normals), -sign)])
        return points, unit(normals @ rotation.T), tangents


def read_attribute(glb, index, width):
    accessor = glb.json['accessors'][index]; view = glb.json['bufferViews'][accessor['bufferView']]
    if accessor['componentType'] != 5126 or accessor['type'] != f'VEC{width}' or view.get('byteStride', width*4) != width*4:
        raise ValueError('Unexpected surface-frame attribute layout')
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    size = accessor['count'] * width * 4
    if accessor.get('byteOffset', 0) + size > view['byteLength']:
        raise ValueError('Truncated surface-frame attribute')
    return np.frombuffer(glb.buffer, '<f4', accessor['count'] * width, start).reshape(-1, width).copy()


def write_attribute(glb, primitive, name, values):
    values = np.asarray(values, '<f4'); attrs = primitive['attributes']
    if name not in attrs:
        attrs[name] = glb.accessor(values, f'VEC{values.shape[1]}'); return
    existing = read_attribute(glb, attrs[name], values.shape[1])
    if existing.shape != values.shape: raise ValueError('Surface-frame vertex count changed')
    accessor = glb.json['accessors'][attrs[name]]; view = glb.json['bufferViews'][accessor['bufferView']]
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    glb.buffer[start:start+values.nbytes] = values.tobytes()
    if 'min' in accessor: accessor['min'] = values.min(0).tolist()
    if 'max' in accessor: accessor['max'] = values.max(0).tolist()


def apply_world_frames(glb, frames, manifest):
    rotation = qangle([0, -manifest['spawn_yaw'], 0]); origin = np.array(manifest['spawn_source'])
    faces = vertices = smoothed = 0
    for primitive in glb.json['meshes'][0]['primitives']:
        positions = read_attribute(glb, primitive['attributes']['POSITION'], 3)
        old = read_attribute(glb, primitive['attributes']['NORMAL'], 3)
        normals, tangents = [], []; offset = 0
        ranges = primitive.get('extras', {}).get('sourceFaceRanges')
        if not ranges: raise ValueError('World surface has no Source face ranges')
        for fi, _, _ in ranges:
            points, n, t = frames.frame(fi, rotation)
            expected = (points-origin) @ rotation.T * SCALE
            if not np.allclose(positions[offset:offset+len(n)], expected, atol=2e-5, rtol=1e-6):
                raise ValueError(f'World vertex order differs from Source face {fi}')
            smoothed += int(np.count_nonzero(np.linalg.norm(old[offset:offset+len(n)]-n, axis=1) > 1e-4))
            normals.append(n); tangents.append(t); offset += len(n); faces += 1
        if offset != len(positions): raise ValueError('World surface-frame vertex count differs')
        write_attribute(glb, primitive, 'NORMAL', np.concatenate(normals))
        write_attribute(glb, primitive, 'TANGENT', np.concatenate(tangents)); vertices += offset
    return dict(faces=faces, vertices=vertices, changed_normals=smoothed)


def brush_faces(model, entity):
    brush = model['models'][int(entity['model'][1:])]
    for fi in range(brush['firstface'], brush['firstface']+brush['numfaces']):
        face = model['faces'][fi]
        if face['texinfo'] < 0: continue
        info = model['texinfo'][face['texinfo']]
        if info['texdata'] < 0 or info['flags'] & SURF_HIDE: continue
        if model['texname'](info['texdata']).lower().startswith('tools/'): continue
        if face['disp'] >= 0: raise ValueError('Unexpected displacement in a Ghost brush entity')
        if face['numedges'] >= 3: yield fi


def apply_brush_frames(glb, frames, manifest):
    rotation = qangle([0, -manifest['spawn_yaw'], 0]); origin = np.array(manifest['spawn_source'])
    nodes = [n for n in glb.json['nodes'] if n.get('extras', {}).get('sourceBrush')]
    entities = [e for e in frames.model['ents'] if e.get('model', '').startswith('*')
                and e['classname'] in ('func_illusionary', 'func_brush', 'func_wall', 'func_detail')]
    entities = [e for e in entities if list(brush_faces(frames.model, e))]
    if len(nodes) != len(entities): raise ValueError('Brush entity inventory differs from Source')
    count = vertices = changed = 0
    for node, entity in zip(nodes, entities):
        if node['extras']['sourceBrush'] != entity['model'] or node['extras']['sourceClass'] != entity['classname']:
            raise ValueError('Brush entity order differs from Source')
        r = qangle([float(v) for v in entity.get('angles', '0 0 0').split()])
        pos = np.array([float(v) for v in entity.get('origin', '0 0 0').split()])
        primitives = glb.json['meshes'][node['mesh']]['primitives']; faces = list(brush_faces(frames.model, entity))
        if len(primitives) != len(faces): raise ValueError('Brush primitive count differs from Source faces')
        for primitive, fi in zip(primitives, faces):
            points, normal, tangent = frames.frame(fi, rotation @ r)
            expected = (points @ r.T + pos - origin) @ rotation.T * SCALE
            positions = read_attribute(glb, primitive['attributes']['POSITION'], 3)
            if not np.allclose(positions, expected, atol=2e-5, rtol=1e-6): raise ValueError(f'Brush vertex order differs: {fi}')
            old = read_attribute(glb, primitive['attributes']['NORMAL'], 3)
            changed += int(np.count_nonzero(np.linalg.norm(old-normal, axis=1) > 1e-4))
            write_attribute(glb, primitive, 'NORMAL', normal); write_attribute(glb, primitive, 'TANGENT', tangent)
            primitive.setdefault('extras', {})['sourceBrushFace'] = fi
            count += 1; vertices += len(normal)
        node['extras'].update(sourceOrigin=manifest['spawn_source'], sourceYaw=manifest['spawn_yaw'])
    return dict(entities=len(nodes), faces=count, vertices=vertices, changed_normals=changed)
