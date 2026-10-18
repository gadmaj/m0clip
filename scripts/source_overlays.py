"""Source BSP overlays, adapted from noclip.website SourceEngine/BSPFile.ts.

Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. Project onto
the authored plane, clip to each receiving triangle, interpolate its lightmap
UVs, and project back onto the actual surface (including displacements).
"""
from dataclasses import dataclass
import struct
import numpy as np
from import_source_bsp import SCALE, displacement, face_points, front_normal


@dataclass
class Overlay:
    id: int
    texinfo: int
    order: int
    faces: tuple
    origin: np.ndarray
    normal: np.ndarray
    points: np.ndarray
    uv: np.ndarray


def read_overlays(data):
    if len(data) % 352: raise ValueError('Truncated BSP overlay lump')
    result = []
    for offset in range(0, len(data), 352):
        ident, texinfo, flags = struct.unpack_from('<IHH', data, offset)
        count = flags & 0x3fff
        if count > 64: raise ValueError('BSP overlay has more than 64 receiving faces')
        faces = struct.unpack_from(f'<{count}i', data, offset + 8)
        u0, u1, v0, v1 = struct.unpack_from('<4f', data, offset + 264)
        corners = np.array(struct.unpack_from('<12f', data, offset + 280)).reshape(4, 3)
        origin = np.array(struct.unpack_from('<3f', data, offset + 328))
        normal = np.array(struct.unpack_from('<3f', data, offset + 340))
        basis_s = corners[:3, 2]
        basis_t = np.cross(normal, basis_s)
        if corners[3, 2] == 1: basis_t = -basis_t
        points = origin + corners[:, :1] * basis_s + corners[:, 1:2] * basis_t
        result.append(Overlay(ident, texinfo, flags >> 14, faces, origin, normal, points,
                              np.array([[u0, v0], [u0, v1], [u1, v1], [u1, v0]])))
    return result


def clip_polygon(polygon, triangle, normal):
    """Sutherland–Hodgman clipping; carry decal UVs through edge intersections."""
    polygon = np.asarray(polygon, float)
    for i in range(3):
        p0, p1, p2 = triangle[i], triangle[(i + 1) % 3], triangle[(i + 2) % 3]
        clip_normal = np.cross(normal, p1 - p0)
        clip_normal /= max(np.linalg.norm(clip_normal), 1e-15)
        if np.dot(clip_normal, p2 - p0) > 0: clip_normal = -clip_normal
        distances = (polygon[:, :3] - p0) @ clip_normal
        output = []
        for j, point in enumerate(polygon):
            following = polygon[(j + 1) % len(polygon)]
            d0, d1 = distances[j], distances[(j + 1) % len(polygon)]
            if d0 <= 1e-8: output.append(point)
            if (d0 < -1e-8 and d1 > 1e-8) or (d1 < -1e-8 and d0 > 1e-8):
                output.append(point + (following - point) * (d0 / (d0 - d1)))
        if len(output) < 3: return None
        polygon = np.array(output)
    return polygon


def project_overlay(overlay, triangle, light_uv):
    """Return position, face normal, decal UV and inherited lightmap UV arrays."""
    normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
    magnitude = np.linalg.norm(normal)
    if magnitude < 1e-9: return None
    normal /= magnitude
    denominator = normal @ overlay.normal
    if abs(denominator) < 1e-8: return None
    projected = triangle - ((triangle - overlay.origin) @ overlay.normal)[:, None] * overlay.normal
    # Reject non-overlapping triangles before polygon clipping, especially on terrain grids.
    axes = np.flatnonzero(np.abs(overlay.normal) < .999999)
    if (overlay.points[:, axes].max(0) < projected[:, axes].min(0) - 1e-6).any() or \
       (overlay.points[:, axes].min(0) > projected[:, axes].max(0) + 1e-6).any(): return None
    polygon = clip_polygon(np.column_stack([overlay.points, overlay.uv]), projected, overlay.normal)
    if polygon is None: return None
    e0, e1 = projected[1] - projected[0], projected[2] - projected[0]
    gram = np.array([[e0 @ e0, e0 @ e1], [e0 @ e1, e1 @ e1]])
    if abs(np.linalg.det(gram)) < 1e-12: return None
    weights = np.linalg.solve(gram, np.stack([(polygon[:, :3] - projected[0]) @ e0,
                                             (polygon[:, :3] - projected[0]) @ e1]))
    bary = np.column_stack([1 - weights.sum(0), weights.T])
    lmuv = bary @ light_uv
    points = polygon[:, :3].copy()
    points -= ((points - triangle[0]) @ normal / denominator)[:, None] * overlay.normal
    points += normal * .1  # noclip's 0.1 Source-unit lift avoids z fighting.
    return points, normal, polygon[:, 3:], lmuv


def face_triangles(model, atlas, fi):
    face = model['faces'][fi]
    if face['disp'] >= 0:
        grid, base = displacement(model, face)
        size = len(grid); points = grid.reshape(-1, 3)
        uv = atlas.uv(model, fi, base.reshape(-1, 3), size)
        start = (np.arange(size - 1)[:, None] * size + np.arange(size - 1)).ravel()
        indices = np.concatenate([np.stack([start, start + size, start + size + 1], 1),
                                  np.stack([start, start + size + 1, start + 1], 1)])
        first = points[indices[0]]
        if np.cross(first[1] - first[0], first[2] - first[0]) @ front_normal(face_points(model, face)) < 0:
            indices = indices[:, ::-1]
    else:
        points = face_points(model, face)[::-1]
        indices = np.stack([np.zeros(len(points) - 2, int), np.arange(1, len(points) - 1),
                            np.arange(2, len(points))], 1)
        uv = atlas.uv(model, fi, points)
    return points[indices], uv[indices]


def export_overlays(glb, exporter, bsp, model, atlas, manifest):
    overlays = read_overlays(bsp.lump(45))
    yaw = np.radians(-manifest['spawn_yaw']); c, s = np.cos(yaw), np.sin(yaw)
    rotation = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    origin = np.array(manifest['spawn_source'])
    materials, cached_faces = {}, {}
    restored, empty, missing = [], [], []
    triangle_count = 0
    for overlay in overlays:
        name = model['texname'](model['texinfo'][overlay.texinfo]['texdata']).lower()
        surfaces = {}
        for fi in overlay.faces:
            if fi not in atlas.faces: continue
            if fi not in cached_faces: cached_faces[fi] = face_triangles(model, atlas, fi)
            triangles, light_uv = cached_faces[fi]
            for triangle, uv in zip(triangles, light_uv):
                projected = project_overlay(overlay, triangle, uv)
                if projected is None: continue
                surfaces.setdefault(atlas.faces[fi][0], []).append(projected)
        primitives = []
        for page, pieces in surfaces.items():
            key = (name, page)
            if key not in materials:
                record = dict(name=name, pbrMetallicRoughness=dict(metallicFactor=0, roughnessFactor=.85),
                              extras=dict(sourceLightmap=page, sourceDecal=True))
                exporter.apply(record, name)
                meta = record['extras'].get('sourceMaterial')
                if not meta:
                    missing.append(name); continue
                if meta['unlit']:
                    record['extras'].update(sourceVertexLighting=1, sourceUnlit=True)
                materials[key] = len(glb.json['materials']); glb.json['materials'].append(record)
            points, normals, uv, lmuv, indices = [], [], [], [], []
            count = 0
            for position, normal, coords, light in pieces:
                tri = np.stack([np.zeros(len(position) - 2, int), np.arange(1, len(position) - 1), np.arange(2, len(position))], 1)
                cross = np.cross(position[tri[:, 1]] - position[tri[:, 0]], position[tri[:, 2]] - position[tri[:, 0]])
                tri = tri[np.linalg.norm(cross, axis=1) > 1e-9]
                if not len(tri): continue
                if np.cross(position[tri[0, 1]] - position[tri[0, 0]], position[tri[0, 2]] - position[tri[0, 0]]) @ normal < 0:
                    tri = tri[:, ::-1]
                indices.append(tri + count); count += len(position)
                points.append(((position - origin) @ rotation.T) * SCALE)
                normals.append(np.tile(rotation @ normal, (len(position), 1))); uv.append(coords); lmuv.append(light)
            if not indices: continue
            combined = np.concatenate(indices)
            triangle_count += len(combined)
            primitives.append(dict(attributes=dict(POSITION=glb.accessor(np.concatenate(points), 'VEC3'),
                NORMAL=glb.accessor(np.concatenate(normals), 'VEC3'), TEXCOORD_0=glb.accessor(np.concatenate(uv), 'VEC2'),
                TEXCOORD_1=glb.accessor(np.concatenate(lmuv), 'VEC2')),
                indices=glb.accessor(combined.ravel(), 'SCALAR', index=True), material=materials[key]))
        if primitives:
            glb.node(f'overlay:{overlay.id}:{name}', primitives, None, dict(sourceOverlay=True,
                sourceOverlayId=overlay.id, sourceRenderOrder=overlay.order))
            restored.append(overlay.id)
        else: empty.append(overlay.id)
    return dict(requested=len(overlays), restored=len(restored), triangles=triangle_count,
                empty=empty, missing_materials=sorted(set(missing)))
