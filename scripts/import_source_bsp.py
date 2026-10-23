#!/usr/bin/env python3
"""Source engine maps (the noclip.website catalogue) -> MuJoCo terrain bundles.

    python3 scripts/import_source_bsp.py --game neotokyo                 # every Neo Tokyo map
    python3 scripts/import_source_bsp.py --game neotokyo --maps nt_rise_ctg nt_dusk_ctg
    python3 scripts/import_source_bsp.py --bsp path/or/url/to/map.bsp --name "My map"

Each map becomes public/assets/maps/<id>/ (map.xml + visual.glb + lighting.json + manifest.json) and is listed in
public/assets/maps/index.json, which the app reads to offer it as a terrain.

  collision  the world model's player-solid brushes (found through the BSP tree, so triggers and
             brush entities never turn into invisible walls): axis-aligned brushes become box
             geoms, the rest convex vertex meshes; displacement terrain is cut into per-quad convex
             prisms. All in geom group 3 (not rendered).
  visuals    the world model's drawn faces and displacements, with Source textures, face lightmap
             UVs, embedded RGBM6 lightmap atlases, and BSP ambient cubes / world lights for robots.
  placement  1 Source unit = 1 inch = 0.0254 m; the map is moved so the first player spawn sits at
             the origin facing +x (where every robot spawns), and the default ground plane is
             dropped by the app when a map terrain is selected.

Static props (models placed in the map) are not converted yet: they have their own model and
physics formats. Maps are third-party game data: the bundles stay out of git (public/assets/* is
ignored) — run this script to produce them locally.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import struct
import sys
import urllib.request

import numpy as np
from source_triangulation import gltf_face_triangles

STORAGE = "https://z.noclip.website"
SCALE = 0.0254                                  # metres per Source unit
GAMES = {
    # noclip scene groups (src/SourceEngine/Scenes_*.ts): storage path + map ids
    "neotokyo": ("NeoTokyo", "NeoTokyo/NeotokyoSource/maps", [
        "nt_ballistrade_ctg", "nt_bullet_tdm", "nt_dawn_ctg", "nt_decom_ctg", "nt_disengage_ctg",
        "nt_dusk_ctg", "nt_engage_ctg", "nt_ghost_ctg", "nt_isolation_ctg", "nt_marketa_ctg",
        "nt_oilstain_ctg", "nt_pissalley_ctg", "nt_redlight_ctg", "nt_ridgeline_ctg", "nt_rise_ctg",
        "nt_sentinel_ctg", "nt_shrine_ctg", "nt_skyline_ctg", "nt_subsurface_ctg", "nt_saitama_ctg",
        "nt_tarmac_ctg", "nt_threadplate_ctg", "nt_transit_ctg", "nt_vtol_ctg"]),
}
# texture mounts per game (noclip Scenes_*.ts): loose-file root with a dir.txt, then VPK archives
MOUNTS = {
    "neotokyo": ("NeoTokyo/NeotokyoSource/", ["HalfLife2/hl2_textures", "HalfLife2/hl2_misc"]),
}

# contents / surface flags (public/bspflags.h)
CONTENTS_SOLID, CONTENTS_WINDOW, CONTENTS_GRATE, CONTENTS_PLAYERCLIP = 0x1, 0x2, 0x8, 0x10000
COLLIDE = CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_GRATE | CONTENTS_PLAYERCLIP
SURF_SKY2D, SURF_SKY, SURF_TRIGGER, SURF_NODRAW, SURF_HINT, SURF_SKIP = 0x2, 0x4, 0x40, 0x80, 0x100, 0x200
SURF_HIDE = SURF_SKY2D | SURF_SKY | SURF_TRIGGER | SURF_NODRAW | SURF_HINT | SURF_SKIP


class BSP:
    def __init__(self, data: bytes):
        ident, self.version = struct.unpack_from("<4si", data, 0)
        if ident != b"VBSP":
            raise ValueError("not a Source BSP (VBSP)")
        self.data = data
        self.lumps = [struct.unpack_from("<iii4s", data, 8 + 16 * i) for i in range(64)]

    def lump(self, i: int) -> bytes:
        ofs, n, _, _ = self.lumps[i]
        b = self.data[ofs:ofs + n]
        if b[:4] == b"LZMA":
            raise ValueError(f"lump {i} is LZMA-compressed (newer Source branch): not supported yet")
        return b

    def lump_version(self, i: int) -> int:
        return self.lumps[i][2]

    def arr(self, i: int, dtype) -> np.ndarray:
        return np.frombuffer(self.lump(i), dtype=dtype)


def parse(bsp: BSP) -> dict:
    planes = bsp.arr(1, np.dtype([("n", "<f4", 3), ("d", "<f4"), ("t", "<i4")]))
    texdata = bsp.arr(2, np.dtype([("refl", "<f4", 3), ("name", "<i4"), ("w", "<i4", 4)]))
    verts = bsp.arr(3, "<f4").reshape(-1, 3).astype(np.float64)
    texinfo = bsp.arr(6, np.dtype([("vecs", "<f4", 16), ("flags", "<i4"), ("texdata", "<i4")]))
    using_hdr = bool(bsp.lump(53))
    lighting = bsp.lump(53) if using_hdr else bsp.lump(8)
    faces = bsp.arr(58 if using_hdr and bsp.lump(58) else 7, np.dtype([("plane", "<u2"), ("side", "u1"), ("onnode", "u1"), ("firstedge", "<i4"),
                                 ("numedges", "<i2"), ("texinfo", "<i2"), ("disp", "<i2"), ("fog", "<i2"),
                                 ("styles", "u1", 4), ("lightofs", "<i4"), ("area", "<f4"), ("lm", "<i4", 4),
                                 ("orig", "<i4"), ("nprims", "<u2"), ("fprim", "<u2"), ("smooth", "<u4")]))
    edges = bsp.arr(12, "<u2").reshape(-1, 2)
    surfedges = bsp.arr(13, "<i4")
    models = bsp.arr(14, np.dtype([("mins", "<f4", 3), ("maxs", "<f4", 3), ("origin", "<f4", 3),
                                   ("head", "<i4"), ("firstface", "<i4"), ("numfaces", "<i4")]))
    nodes = bsp.arr(5, np.dtype([("plane", "<i4"), ("child", "<i4", 2), ("mins", "<i2", 3), ("maxs", "<i2", 3),
                                 ("firstface", "<u2"), ("numfaces", "<u2"), ("area", "<i2"), ("pad", "<i2")]))
    leaf_size = 32 if bsp.lump_version(10) >= 1 else 56
    leafraw = bsp.lump(10)
    leafs = [struct.unpack_from("<iHHhhhhhhHHHHh", leafraw, i) for i in range(0, len(leafraw) - leaf_size + 1, leaf_size)]
    leafbrushes = bsp.arr(17, "<u2")
    brushes = bsp.arr(18, np.dtype([("first", "<i4"), ("num", "<i4"), ("contents", "<i4")]))
    sides = bsp.arr(19, np.dtype([("plane", "<u2"), ("texinfo", "<i2"), ("disp", "<i2"), ("bevel", "<i2")]))
    dispraw = bsp.lump(26)
    dispinfo = [(np.array(struct.unpack_from("<3f", dispraw, i)), struct.unpack_from("<i", dispraw, i + 12)[0],
                 struct.unpack_from("<i", dispraw, i + 20)[0]) for i in range(0, len(dispraw) - 175, 176)]
    dispverts = bsp.arr(33, "<f4").reshape(-1, 5)
    strdata, strtab = bsp.lump(43), bsp.arr(44, "<i4")
    texname = lambda td: strdata[strtab[texdata[td]["name"]]:].split(b"\0", 1)[0].decode("latin-1")
    entity_pairs = [re.findall(r'"([^"]*)"\s+"([^"]*)"', block)
                    for block in re.findall(r"\{([^{}]*)\}", bsp.lump(0).decode("latin-1", "replace"))]
    ents = [dict(pairs) for pairs in entity_pairs]
    return dict(planes=planes, texdata=texdata, verts=verts, texinfo=texinfo, faces=faces, edges=edges,
                surfedges=surfedges, models=models, nodes=nodes, leafs=leafs, leafbrushes=leafbrushes,
                brushes=brushes, sides=sides, dispinfo=dispinfo, dispverts=dispverts, texname=texname, ents=ents,
                lighting=lighting, using_hdr=using_hdr, entity_pairs=entity_pairs)


def world_brushes(m: dict) -> list[int]:
    """Brush indices reachable from the world model's head node (leaf -> leafbrushes)."""
    out, stack = set(), [int(m["models"][0]["head"])]
    while stack:
        n = stack.pop()
        if n < 0:
            leaf = m["leafs"][-n - 1]
            first, count = leaf[11], leaf[12]
            out.update(int(b) for b in m["leafbrushes"][first:first + count])
        else:
            stack.extend(int(c) for c in m["nodes"][n]["child"])
    return sorted(out)


def brush_hull(m: dict, b) -> np.ndarray | None:
    """Corner points of a convex brush: pairwise-triple plane intersections inside every plane."""
    sd = m["sides"][b["first"]:b["first"] + b["num"]]
    pl = m["planes"][sd["plane"]]
    N, D = pl["n"].astype(np.float64), pl["d"].astype(np.float64)
    k = len(N)
    if k < 4:
        return None
    i, j, l = np.array([(a, c, e) for a in range(k) for c in range(a + 1, k) for e in range(c + 1, k)]).T
    A = np.stack([N[i], N[j], N[l]], axis=1)
    det = np.linalg.det(A)
    ok = np.abs(det) > 1e-6
    if not ok.any():
        return None
    P = np.linalg.solve(A[ok], np.stack([D[i], D[j], D[l]], axis=1)[ok][..., None])[..., 0]
    P = P[(P @ N.T <= D + 0.05).all(axis=1)]
    if len(P) < 4:
        return None
    P = np.unique(np.round(P, 3), axis=0)
    ext = P.max(0) - P.min(0)
    if len(P) < 4 or (ext < 0.5).any():                     # degenerate / sliver
        return None
    return P


def face_points(m: dict, f) -> np.ndarray:
    se = m["surfedges"][f["firstedge"]:f["firstedge"] + f["numedges"]]
    idx = np.where(se >= 0, m["edges"][np.abs(se), 0], m["edges"][np.abs(se), 1])
    return m["verts"][idx]


def displacement(m: dict, f) -> tuple[np.ndarray, np.ndarray]:
    """side x side grid of displaced points for a displacement face (noclip buildDisplacement), and
    the undisplaced grid on its base quad."""
    start, vstart, power = m["dispinfo"][f["disp"]]
    corners = face_points(m, f)
    s = int(np.argmin(np.linalg.norm(corners - start, axis=1)))
    c = np.roll(corners, -s, axis=0)
    n = (1 << power) + 1
    t = np.linspace(0, 1, n)
    v0 = c[0] + (c[1] - c[0]) * t[:, None]                   # along y
    v1 = c[3] + (c[2] - c[3]) * t[:, None]
    base = v0[:, None, :] + (v1 - v0)[:, None, :] * t[None, :, None]
    dv = m["dispverts"][vstart:vstart + n * n]
    return base + (dv[:, :3] * dv[:, 3:4]).reshape(n, n, 3), base


def disp_hfield(g: np.ndarray, base: np.ndarray, nrm: np.ndarray) -> dict | None:
    """A displacement grid (metres, rows along corner0->1, columns along corner0->3) as a MuJoCo
    heightfield in the frame of its base quad, z = the face normal (solid side underneath). Lateral
    offsets of displaced points are dropped. None when the base quad is not a rectangle."""
    c0, c1, c3, c2 = base[0, 0], base[-1, 0], base[0, -1], base[-1, -1]
    e1, e2 = c1 - c0, c3 - c0
    l1, l2 = np.linalg.norm(e1), np.linalg.norm(e2)
    if l1 < 1e-3 or l2 < 1e-3 or abs(e1 @ e2) / (l1 * l2) > 0.03:
        return None
    if np.linalg.norm(c0 + e1 + e2 - c2) > 0.03 * max(l1, l2):
        return None                                  # a trapezoid, not a rectangle
    # local axes: x along columns, y along rows; swap to put +z on the face normal's side
    x, y, grid = e2 / l2, e1 / l1, g
    if np.cross(x, y) @ nrm < 0:
        x, y, grid = y, x, g.transpose(1, 0, 2)
        l1, l2 = l2, l1
    z = np.cross(x, y)
    center = c0 + (e1 + e2) / 2
    h = (grid - center) @ z                          # nrow x ncol, rows along y
    lo, hi = float(h.min()), float(h.max())
    span = max(hi - lo, 1e-3)
    w, qx, qy, qz = rot_to_quat(np.stack([x, y, z], 1))
    return dict(nrow=h.shape[0], ncol=h.shape[1], size=[l2 / 2, l1 / 2, span, 0.1],
                elev=((h - lo) / span)[::-1],   # MuJoCo's first elevation row is at +y
                pos=center + z * lo, quat=[w, qx, qy, qz])


def rot_to_quat(Rm: np.ndarray) -> tuple[float, float, float, float]:
    """3x3 rotation (columns = local axes in world) -> wxyz."""
    t = np.trace(Rm)
    if t > 0:
        s = 2 * np.sqrt(t + 1)
        return s / 4, (Rm[2, 1] - Rm[1, 2]) / s, (Rm[0, 2] - Rm[2, 0]) / s, (Rm[1, 0] - Rm[0, 1]) / s
    i = int(np.argmax(np.diag(Rm)))
    if i == 0:
        s = 2 * np.sqrt(1 + Rm[0, 0] - Rm[1, 1] - Rm[2, 2])
        return (Rm[2, 1] - Rm[1, 2]) / s, s / 4, (Rm[0, 1] + Rm[1, 0]) / s, (Rm[0, 2] + Rm[2, 0]) / s
    if i == 1:
        s = 2 * np.sqrt(1 + Rm[1, 1] - Rm[0, 0] - Rm[2, 2])
        return (Rm[0, 2] - Rm[2, 0]) / s, (Rm[0, 1] + Rm[1, 0]) / s, s / 4, (Rm[1, 2] + Rm[2, 1]) / s
    s = 2 * np.sqrt(1 + Rm[2, 2] - Rm[0, 0] - Rm[1, 1])
    return (Rm[1, 0] - Rm[0, 1]) / s, (Rm[0, 2] + Rm[2, 0]) / s, (Rm[1, 2] + Rm[2, 1]) / s, s / 4


def world_surfaces(m: dict) -> np.ndarray:
    """Every drawn world triangle (faces + displacements), Source units — for spawn probing."""
    out = []
    w = m["models"][0]
    for fi in range(w["firstface"], w["firstface"] + w["numfaces"]):
        f = m["faces"][fi]
        if f["texinfo"] < 0 or m["texinfo"][f["texinfo"]]["flags"] & (SURF_SKY | SURF_SKY2D):
            continue
        if f["disp"] >= 0:
            g, _ = displacement(m, f)
            a, b, c, d = g[:-1, :-1], g[:-1, 1:], g[1:, 1:], g[1:, :-1]
            out.append(np.concatenate([np.stack([a, d, c], -2), np.stack([a, c, b], -2)], 0).reshape(-1, 3, 3))
        else:
            p = face_points(m, f)
            if len(p) >= 3:
                out.append(np.stack([np.repeat(p[:1], len(p) - 2, 0), p[1:-1], p[2:]], 1))
    return np.concatenate(out, 0) if out else np.zeros((0, 3, 3))


def heights_at(tris: np.ndarray, x: float, y: float) -> np.ndarray:
    """z of every triangle crossed by the vertical line through (x, y)."""
    A, B, C = tris[:, 0], tris[:, 1], tris[:, 2]
    v0, v1 = (C - A)[:, :2], (B - A)[:, :2]
    v2 = np.array([x, y]) - A[:, :2]
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    ok = np.abs(den) > 1e-9
    u = np.where(ok, (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / np.where(ok, den, 1), -1)
    v = np.where(ok, (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / np.where(ok, den, 1), -1)
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1)
    return (A[:, 2] + u * (C - A)[:, 2] + v * (B - A)[:, 2])[hit]


def spawn(m: dict) -> tuple[np.ndarray, float, str]:
    """A player spawn with a surface under it (<= 64 units = 1.6 m down) and 64 units of headroom,
    returned with its floor height as z. Neo Tokyo's info_player_start is often a leftover outside
    the play space, so team spawns come first."""
    tris = world_surfaces(m)
    cands = []
    for cls in ("info_player_attacker", "info_player_defender", "info_player_start", "info_player_deathmatch"):
        cands += [(cls, e) for e in m["ents"] if e.get("classname") == cls and "origin" in e]
    for cls, e in cands:
        o = np.array([float(x) for x in e["origin"].split()])
        hz = heights_at(tris, o[0], o[1])
        below = hz[(hz <= o[2] + 16) & (hz >= o[2] - 64)]
        if not len(below):
            continue
        floor = below.max()
        if ((hz > floor + 4) & (hz < floor + 64)).any():
            continue                                         # something overhead / inside a wall
        yaw = float(e["angles"].split()[1]) if "angles" in e else 0.0
        return np.array([o[0], o[1], floor]), yaw, cls
    mins, maxs = m["models"][0]["mins"], m["models"][0]["maxs"]
    return (np.array(mins, float) + np.array(maxs, float)) / 2, 0.0, "map centre"


def front_normal(pts: np.ndarray) -> np.ndarray:
    """Outward normal of a face from its vertex winding (Source: clockwise seen from the front).
    The face's plane `side` flag is not a reliable guide to which way it faces."""
    n = np.cross(pts[1] - pts[0], pts[2] - pts[0])
    return -n / (np.linalg.norm(n) + 1e-12)


def facing(tris: np.ndarray, nrm: np.ndarray) -> np.ndarray:
    """Wind triangles counter-clockwise around `nrm` (Source stores faces clockwise; renderers take
    counter-clockwise as the front)."""
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    flip = n @ nrm < 0
    tris = tris.copy()
    tris[flip] = tris[flip][:, ::-1]
    return tris


def map_light(m: dict, spawn_yaw: float) -> dict | None:
    """The map's sun (light_environment) for the app's lighting: azimuth / elevation in degrees in the
    app frame (map rotated by -spawn_yaw), colours as 0xRRGGBB, three.js-scale intensities."""
    e = next((e for e in m["ents"] if e.get("classname") == "light_environment"), None)
    if not e:
        return None
    ang = [float(x) for x in e.get("angles", "0 0 0").split()]
    pitch = -float(e["pitch"]) if "pitch" in e else ang[0]          # "pitch" key: negative = down
    rgbv = lambda k, d: ([float(x) for x in e.get(k, d).split()] + [255.0])[:4]
    col, amb = rgbv("_light", "255 255 255 200"), rgbv("_ambient", "60 70 90 60")
    tohex = lambda c: (int(min(c[0], 255)) << 16) | (int(min(c[1], 255)) << 8) | int(min(c[2], 255))
    return dict(azimuth=round(((ang[1] + 180 - spawn_yaw + 180) % 360) - 180, 1),
                elevation=round(float(np.clip(pitch, 5, 89)), 1),
                # brightness is compressed (sqrt) and floored so night maps stay readable
                color=tohex(col), intensity=round(float(np.clip(np.sqrt(col[3] / 255) * 1.8, 0.6, 4)), 2),
                ambientColor=tohex(amb), ambient=round(float(np.clip(np.sqrt(amb[3] / 255) * 1.2, 0.35, 2)), 2))


def load_textures(fs, names: list[str], max_px: int = 512) -> dict:
    """material name -> (encoded image bytes, mime, alpha mode) for every material that resolves."""
    from concurrent.futures import ThreadPoolExecutor
    from PIL import Image
    import source_assets as A

    def one(name):
        try:
            mat = A.material(fs, name)
            if not mat:
                return name, None
            # Some shipped Ghost VMTs accidentally use a .vmt extension for a VTF reference.
            texture_path = mat["basetexture"].replace("\\", "/").lower().removesuffix(".vtf").removesuffix('.vmt')
            raw = fs.read("materials/" + texture_path + ".vtf")
            img = A.decode_vtf(raw) if raw else None
            if img is None:
                return name, None
            im = Image.fromarray(img, "RGBA")
            if max(im.size) > max_px:
                sc = max_px / max(im.size)
                im = im.resize((max(1, round(im.width * sc)), max(1, round(im.height * sc))), Image.LANCZOS)
            alpha = (mat["alphatest"] or mat["translucent"]) and np.asarray(im)[..., 3].min() < 250
            buf = io.BytesIO()
            if alpha or mat.get('selfillum'):
                im.save(buf, "PNG", optimize=True)
                mode = ("MASK" if mat["alphatest"] else "BLEND") if alpha else 'OPAQUE'
                return name, (buf.getvalue(), "image/png", mode)
            im.convert("RGB").save(buf, "JPEG", quality=85)
            return name, (buf.getvalue(), "image/jpeg", "OPAQUE")
        except Exception as e:                          # a bad texture keeps its average colour
            print(f"    texture {name}: {e}", file=sys.stderr)
            return name, None
    with ThreadPoolExecutor(16) as ex:
        return {n: r for n, r in ex.map(one, names) if r}


def write_glb(path: str, prims: dict, textures: dict, title: str, lightmaps=None):
    """Binary glTF: one node, one mesh, a primitive per material. Positions are the MuJoCo frame
    (metres, Z up): the app's renderer is Z-up, so they are not converted to glTF's Y-up."""
    binbuf = bytearray()
    js = {"asset": {"version": "2.0", "generator": "unitree-mujoco-web import_source_bsp"},
          "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": "map", "mesh": 0, "extras": {"up": "+Z"}}],
          "meshes": [{"name": title, "primitives": []}], "materials": [], "accessors": [], "bufferViews": [],
          "buffers": [], "samplers": [{"wrapS": 10497, "wrapT": 10497, "magFilter": 9729, "minFilter": 9987}]}

    def view(data: bytes, target: int | None = None) -> int:
        while len(binbuf) % 4:
            binbuf.append(0)
        v = {"buffer": 0, "byteOffset": len(binbuf), "byteLength": len(data)}
        if target:
            v["target"] = target
        binbuf.extend(data)
        js["bufferViews"].append(v)
        return len(js["bufferViews"]) - 1

    def acc(arr: np.ndarray, typ: str, comp: int, target: int, minmax=False) -> int:
        a = {"bufferView": view(arr.tobytes(), target), "componentType": comp, "count": len(arr), "type": typ}
        if minmax:
            a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        js["accessors"].append(a)
        return len(js["accessors"]) - 1

    atlas_textures = []
    for png in lightmaps.images() if lightmaps else []:
        js.setdefault("images", []).append({"bufferView": view(png), "mimeType": "image/png"})
        js.setdefault("textures", []).append({"sampler": 0, "source": len(js["images"]) - 1})
        atlas_textures.append(len(js["textures"]) - 1)
    texture_indices = {}
    for key in sorted(prims):
        pr = prims[key]
        name = pr['material']
        P = np.concatenate(pr["p"]).astype(np.float32)
        N = np.concatenate(pr["n"]).astype(np.float32)
        UV = np.concatenate(pr["uv"]).astype(np.float32)
        I = np.concatenate(pr["i"]).astype(np.uint32).ravel()
        mat = {"name": name, "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.85}}
        tex = textures.get(name)
        if tex:
            data, mime, mode = tex
            if name not in texture_indices:
                js.setdefault("images", []).append({"bufferView": view(data), "mimeType": mime})
                js.setdefault("textures", []).append({"sampler": 0, "source": len(js["images"]) - 1})
                texture_indices[name] = len(js["textures"]) - 1
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": texture_indices[name]}
            if mode != "OPAQUE":
                mat["alphaMode"], mat["doubleSided"] = mode, True
                if mode == "MASK":
                    mat["alphaCutoff"] = 0.5
        else:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = [*map(float, pr["refl"]), 1.0]
        if atlas_textures:
            mat['extras'] = {'sourceLightmap': atlas_textures[pr['page']]}
        js["materials"].append(mat)
        js["meshes"][0]["primitives"].append({
            "attributes": {"POSITION": acc(P, "VEC3", 5126, 34962, True), "NORMAL": acc(N, "VEC3", 5126, 34962),
                           "TEXCOORD_0": acc(UV, "VEC2", 5126, 34962),
                           "TEXCOORD_1": acc(np.concatenate(pr['lmuv']).astype(np.float32), "VEC2", 5126, 34962)},
            "indices": acc(I, "SCALAR", 5125, 34963), "material": len(js["materials"]) - 1})
    while len(binbuf) % 4:
        binbuf.append(0)
    js["buffers"].append({"byteLength": len(binbuf)})
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(binbuf)))
        fh.write(struct.pack("<II", len(jb), 0x4E4F534A) + jb)
        fh.write(struct.pack("<II", len(binbuf), 0x004E4942) + bytes(binbuf))


def convert(data: bytes, mid: str, name: str, game: str, out_root: str, mounts=None) -> dict:
    bsp = BSP(data)
    m = parse(bsp)
    fs = mounts(bsp) if mounts else None
    origin, yaw, spawn_cls = spawn(m)
    c, s = np.cos(np.radians(-yaw)), np.sin(np.radians(-yaw))
    R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    to_m = lambda p: ((np.asarray(p, float) - origin) @ R.T) * SCALE
    quat = f"{np.cos(np.radians(-yaw) / 2):.6f} 0 0 {np.sin(np.radians(-yaw) / 2):.6f}"
    f6 = lambda a: " ".join(f"{x:.4f}".rstrip("0").rstrip(".") if abs(x) >= 5e-5 else "0" for x in np.ravel(a))
    out = os.path.join(out_root, mid)
    os.makedirs(out, exist_ok=True)

    assets, geoms = [], []
    FR = 'friction="1 0.005 0.0001"'
    # ---- collision: world brushes
    nbox = nmesh = 0
    axis_aligned = lambda N: (np.abs(np.abs(N).max(1) - 1) < 1e-4).all()
    for bi in world_brushes(m):
        b = m["brushes"][bi]
        if not (b["contents"] & COLLIDE):
            continue
        P = brush_hull(m, b)
        if P is None:
            continue
        sd = m["sides"][b["first"]:b["first"] + b["num"]]
        N = m["planes"][sd[sd["bevel"] == 0]["plane"]]["n"]
        Pm = to_m(P)
        if len(N) == 6 and axis_aligned(N):
            lo, hi = P.min(0), P.max(0)                     # box in map axes, then yawed with the map
            geoms.append(f'<geom type="box" pos="{f6(to_m((lo + hi) / 2))}" size="{f6((hi - lo) / 2 * SCALE)}" '
                         f'quat="{quat}" group="3" {FR}/>')
            nbox += 1
        else:
            assets.append(f'<mesh name="{mid}_c{nmesh}" vertex="{f6(Pm)}"/>')
            geoms.append(f'<geom type="mesh" mesh="{mid}_c{nmesh}" group="3" {FR}/>')
            nmesh += 1

    # ---- visuals (per material: positions, normals, UVs) + displacement collision
    prims: dict[str, dict] = {}

    from source_lightmaps import LightmapAtlas, write_ambient
    w = m["models"][0]
    visible = [fi for fi in range(w['firstface'], w['firstface'] + w['numfaces'])
               if m['faces'][fi]['texinfo'] >= 0
               and not (m['texinfo'][m['faces'][fi]['texinfo']]['flags'] & SURF_HIDE)
               and m['texinfo'][m['faces'][fi]['texinfo']]['texdata'] >= 0
               and not m['texname'](m['texinfo'][m['faces'][fi]['texinfo']]['texdata']).lower().startswith('tools/')]
    lightmaps = LightmapAtlas(m, visible)
    write_ambient(os.path.join(out, 'lighting.json'), bsp, m, origin, yaw)
    lightmaps.write_styles(out, m)

    def add(tex: str, refl, P, N, UV, I, LMUV, page):
        pr = prims.setdefault((tex, page), {"material": tex, "page": page, "p": [], "n": [], "uv": [],
                                          "lmuv": [], "i": [], "nv": 0, "refl": refl})
        pr["p"].append(P); pr["n"].append(N); pr["uv"].append(UV); pr["i"].append(I + pr["nv"])
        pr['lmuv'].append(LMUV)
        pr["nv"] += len(P)

    ndisp = nhf = 0
    w = m["models"][0]
    for fi in range(w["firstface"], w["firstface"] + w["numfaces"]):
        f = m["faces"][fi]
        if f["texinfo"] < 0:
            continue
        ti = m["texinfo"][f["texinfo"]]
        if ti["flags"] & SURF_HIDE or ti["texdata"] < 0:
            continue
        tex = m["texname"](ti["texdata"]).lower()
        if tex.startswith("tools/"):
            continue
        td = m["texdata"][ti["texdata"]]
        refl = np.clip(td["refl"], 0, 1)
        sv, tv = ti["vecs"][0:4].astype(float), ti["vecs"][4:8].astype(float)
        tw, th = max(int(td["w"][0]), 1), max(int(td["w"][1]), 1)
        uv_of = lambda pts: np.stack([(pts @ sv[:3] + sv[3]) / tw, (pts @ tv[:3] + tv[3]) / th], -1)
        front = R @ front_normal(face_points(m, f))
        if f["disp"] >= 0:
            gs, bs = displacement(m, f)
            g, base = to_m(gs), to_m(bs)
            n = g.shape[0]
            a = (np.arange(n - 1)[:, None] * n + np.arange(n - 1)[None, :]).ravel()
            idx = np.concatenate([np.stack([a, a + n, a + n + 1], 1), np.stack([a, a + n + 1, a + 1], 1)])
            P = g.reshape(-1, 3)
            t0 = np.cross(P[idx[0, 1]] - P[idx[0, 0]], P[idx[0, 2]] - P[idx[0, 0]])
            if t0 @ front < 0:
                idx = idx[:, ::-1]
            vn = np.zeros_like(P)
            fn = np.cross(P[idx[:, 1]] - P[idx[:, 0]], P[idx[:, 2]] - P[idx[:, 0]])
            for k in range(3):
                np.add.at(vn, idx[:, k], fn)
            vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-9)
            add(tex, refl, P, vn, uv_of(bs.reshape(-1, 3)), idx,
                lightmaps.uv(m, fi, bs.reshape(-1, 3), n), lightmaps.faces[fi][0])
            hf = disp_hfield(g, base, front)
            if hf:
                name = f"{mid}_h{nhf}"
                assets.append(f'<hfield name="{name}" nrow="{hf["nrow"]}" ncol="{hf["ncol"]}" '
                              f'size="{f6(hf["size"])}" elevation="{f6(hf["elev"])}"/>')
                geoms.append(f'<geom type="hfield" hfield="{name}" pos="{f6(hf["pos"])}" quat="{f6(hf["quat"])}" '
                             f'group="3" {FR}/>')
                nhf += 1
            else:                       # skewed base quad: convex prisms over 2x2-quad cells
                for y in range(0, n - 1, 2):
                    for x in range(0, n - 1, 2):
                        top = g[y:y + 3, x:x + 3].reshape(-1, 3)
                        pr = np.concatenate([top, top - front * 0.15])
                        assets.append(f'<mesh name="{mid}_d{ndisp}" vertex="{f6(pr)}"/>')
                        geoms.append(f'<geom type="mesh" mesh="{mid}_d{ndisp}" group="3" {FR}/>')
                        ndisp += 1
        else:
            pts = face_points(m, f)[::-1]        # Source winds front faces clockwise
            if len(pts) >= 3:
                k = len(pts)
                idx = gltf_face_triangles(bsp, f)
                if idx is None: continue
                add(tex, refl, to_m(pts), np.repeat(front[None], k, 0), uv_of(pts), idx,
                    lightmaps.uv(m, fi, pts), lightmaps.faces[fi][0])

    for old in os.listdir(out):
        if old.startswith("vis_") and old.endswith(".stl"):
            os.remove(os.path.join(out, old))
    nvis = sum(int(sum(len(i) for i in pr["i"])) for pr in prims.values())
    files = ["map.xml"]
    material_names = sorted({pr['material'] for pr in prims.values()})
    textures = load_textures(fs, material_names) if fs else {}
    write_glb(os.path.join(out, "visual.glb"), prims, textures, f"{name} ({game})", lightmaps)

    xml = (f'<mujoco model="{mid}">\n  <!-- {name} ({game}), generated by scripts/import_source_bsp.py -->\n'
           f'  <asset>\n    ' + "\n    ".join(assets) + "\n  </asset>\n"
           f'  <worldbody>\n    ' + "\n    ".join(geoms) + "\n  </worldbody>\n</mujoco>\n")
    with open(os.path.join(out, "map.xml"), "w") as fh:
        fh.write(xml)
    info = dict(id=mid, name=name, game=game, files=files, visual="visual.glb", boxes=nbox, hulls=nmesh,
                hfields=nhf, disp_prisms=ndisp, vis_triangles=nvis, textured=len(textures), materials=len(material_names),
                source_lightmaps={'version': 1, 'pages': len(lightmaps.pages), 'faces': lightmaps.lit_faces,
                                  'hdr': m['using_hdr'], 'encoding': 'RGBM6'},
                light=map_light(m, yaw), spawn=spawn_cls, spawn_source=[float(x) for x in origin], spawn_yaw=yaw)
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    return info


def fetch(url: str, cache: str) -> bytes:
    if os.path.exists(url):
        return open(url, "rb").read()
    path = os.path.join(cache, re.sub(r"[^A-Za-z0-9._-]", "_", url.split("://", 1)[-1]))
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        print(f"  downloading {url}", file=sys.stderr)
        req = urllib.request.Request(url, headers={"User-Agent": "unitree-mujoco-web/import_source_bsp"})
        with urllib.request.urlopen(req) as r, open(path + ".part", "wb") as fh:
            fh.write(r.read())
        os.replace(path + ".part", path)
    return open(path, "rb").read()


def pretty(mid: str) -> str:
    core = re.sub(r"^nt_|_(ctg|tdm|vip)$", "", mid)
    return core.replace("_", " ").title()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--game", choices=sorted(GAMES))
    ap.add_argument("--maps", nargs="*", help="map ids (default: every map of --game)")
    ap.add_argument("--bsp", help="a single .bsp path or URL instead of --game")
    ap.add_argument("--name", help="display name with --bsp")
    ap.add_argument("--storage", default=STORAGE, help="noclip data storage base URL")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--out", default=os.path.join(root, "public", "assets", "maps"))
    ap.add_argument("--cache", default=os.path.join(root, "assets", "bsp-cache"))
    ap.add_argument("--no-textures", action="store_true", help="flat texture-average colours only")
    a = ap.parse_args()

    import source_assets as A
    vpks: dict[str, A.VPK] = {}

    def mounts(bsp: BSP):
        if a.no_textures:
            return None
        loose, archives = MOUNTS.get(a.game or "", (None, []))
        for v in archives:
            if v not in vpks:
                vpks[v] = A.VPK(f"{a.storage}/{v}", a.cache)
        fs = A.FileSystem(bsp.lump(40), f"{a.storage}/{loose}" if loose else None,
                          [vpks[v] for v in archives], a.cache)
        flashlight = os.path.join(a.out, '..', 'source', 'flashlight.png')
        if not os.path.exists(flashlight):
            raw = fs.read('materials/effects/flashlight001.vtf')
            if raw:
                from PIL import Image
                image = A.decode_vtf(raw)
                if image is not None:
                    os.makedirs(os.path.dirname(flashlight), exist_ok=True)
                    Image.fromarray(image, 'RGBA').save(flashlight)
        return fs

    jobs = []
    if a.bsp:
        mid = re.sub(r"\.bsp$", "", os.path.basename(a.bsp))
        jobs.append((a.bsp, mid, a.name or pretty(mid), "Source"))
    elif a.game:
        label, path, ids = GAMES[a.game]
        for mid in a.maps or ids:
            jobs.append((f"{a.storage}/{path}/{mid}.bsp", mid, pretty(mid), label))
    else:
        ap.error("pass --game or --bsp")

    index_path = os.path.join(a.out, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {"maps": []}
    for src, mid, name, game in jobs:
        print(f"{mid}:", file=sys.stderr)
        try:
            info = convert(fetch(src, a.cache), mid, name, game, a.out, mounts)
        except Exception as e:                                 # one bad map must not stop the batch
            print(f"  FAILED: {e}", file=sys.stderr)
            continue
        print(f"  {info['boxes']} boxes, {info['hulls']} hulls, {info['hfields']} heightfields, "
              f"{info['disp_prisms']} displacement prisms, "
              f"{info['vis_triangles']} visual triangles, {info['textured']}/{info['materials']} materials textured",
              file=sys.stderr)
        index["maps"] = [x for x in index["maps"] if x["id"] != mid] + [{"id": mid, "name": name, "game": game}]
    index["maps"].sort(key=lambda x: (x["game"], x["name"]))
    os.makedirs(a.out, exist_ok=True)
    with open(index_path, "w") as fh:
        json.dump(index, fh, indent=1)


if __name__ == "__main__":
    main()
