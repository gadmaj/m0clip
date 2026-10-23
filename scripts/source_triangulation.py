"""Native Source face triangles, preserving authored diagonals and front winding.

Follows noclip.website BSPFile.ts and TopologyHelpers.ts (MIT, LICENSE.noclip).
Importers reverse the vertex list for glTF; keep native triangle membership while
reversing winding, rather than building a different fan from the new first corner.
"""
import struct
import numpy as np


def native_face_triangles(bsp, face):
    count = int(face['numedges'])
    if count < 3:
        return np.empty((0, 3), dtype=np.int64)
    primitive_count = int(face['nprims']) & 0x7fff
    if primitive_count:
        index = int(face['fprim'])
        if bsp.version == 22:
            kind, first, size, _, vertices = struct.unpack_from('<B3xIIHH', bsp.lump(37), index * 16)
        else:
            kind, first, size, _, vertices = struct.unpack_from('<BxHHHH', bsp.lump(37), index * 10)
        if vertices:
            return None  # noclip skips dynamic primitives
        if primitive_count != 1:
            raise ValueError('Source static face has more than one primitive')
        if kind != 0 or size != (count - 2) * 3:
            raise ValueError('Unsupported Source face primitive topology')
        raw = bsp.lump(39)
        if (first + size) * 2 > len(raw):
            raise ValueError('Truncated Source face primitive indices')
        indices = np.frombuffer(raw, '<u2', size, first * 2).astype(np.int64).reshape(-1, 3)
        if indices.min() < 0 or indices.max() >= count:
            raise ValueError('Source face primitive index is out of range')
        return indices
    return np.column_stack([np.zeros(count - 2, dtype=np.int64), np.arange(1, count - 1), np.arange(2, count)])


def gltf_face_triangles(bsp, face):
    triangles = native_face_triangles(bsp, face)
    if triangles is None:
        return None
    # Reverse both the corner lookup and winding, retaining each native triangle.
    return (int(face['numedges']) - 1 - triangles)[:, [0, 2, 1]]


def restore_triangles(document, binary, bsp, model):
    """Restore indices in place after material export, retaining every other buffer byte."""
    faces = changed = authored = 0
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            ranges = primitive.get('extras', {}).get('sourceFaceRanges')
            brush = primitive.get('extras', {}).get('sourceBrushFace')
            if ranges is None and brush is None:
                continue
            accessor = document['accessors'][primitive['indices']]
            view = document['bufferViews'][accessor['bufferView']]
            dtype = {5123: '<u2', 5125: '<u4'}.get(accessor['componentType'])
            if dtype is None or accessor['type'] != 'SCALAR' or view.get('byteStride'):
                raise ValueError('Unexpected Source index accessor')
            offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
            indices = np.frombuffer(binary, dtype, accessor['count'], offset)
            vertex_offset = 0
            for face_index, first, size in ranges or [(brush, 0, len(indices))]:
                face = model['faces'][face_index]
                if face['disp'] >= 0:
                    side = (1 << int(model['dispinfo'][int(face['disp'])][2])) + 1
                    vertex_offset += side * side
                    continue
                triangles = gltf_face_triangles(bsp, face)
                if triangles is None:
                    raise ValueError('Existing Ghost asset contains an unsupported dynamic primitive')
                replacement = triangles.ravel() + vertex_offset
                if len(replacement) != size or first + size > len(indices):
                    raise ValueError('Source face triangle range differs from the existing GLB')
                changed += int(not np.array_equal(indices[first:first+size], replacement))
                indices[first:first+size] = replacement
                faces += 1
                authored += bool(int(face['nprims']) & 0x7fff)
                vertex_offset += int(face['numedges'])
            if vertex_offset != document['accessors'][primitive['attributes']['POSITION']]['count']:
                raise ValueError('Source face vertices do not match the existing GLB')
    return dict(faces=faces, changed_faces=changed, authored_primitive_faces=authored)
