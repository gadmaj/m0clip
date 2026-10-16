"""Source engine material / texture access for scripts/import_source_bsp.py.

  Files      a map's own pakfile (BSP lump 40, a zip), the game's loose files (a dir.txt listing on
             the noclip storage), then Valve VPK archives (directory file + ranged reads of the data
             archives) — the same mounts noclip uses for the game.
  Materials  VMT KeyValues: $basetexture, following `patch` materials' `include`; alpha-test /
             translucent flags.
  Textures   VTF 7.x: the largest mip of the first frame, DXT1/3/5 and the common 8-bit formats,
             decoded to RGBA with numpy.
"""
from __future__ import annotations

import io
import os
import re
import struct
import urllib.request
import zipfile

import numpy as np

UA = {"User-Agent": "unitree-mujoco-web/import_source_bsp"}


def http(url: str, rng: tuple[int, int] | None = None) -> bytes:
    h = dict(UA)
    if rng:
        h["Range"] = f"bytes={rng[0]}-{rng[0] + rng[1] - 1}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=h)) as r:
        return r.read()


class VPK:
    """A VPK v1/v2 archive set: <base>_dir.vpk + <base>_NNN.vpk, over HTTP."""

    def __init__(self, base_url: str, cache: str):
        self.base = base_url
        self.cache = cache
        path = os.path.join(cache, re.sub(r"[^A-Za-z0-9._-]", "_", base_url) + "_dir.vpk")
        if not os.path.exists(path):
            os.makedirs(cache, exist_ok=True)
            open(path, "wb").write(http(base_url + "_dir.vpk"))
        d = open(path, "rb").read()
        sig, ver, tree = struct.unpack_from("<III", d, 0)
        if sig != 0x55AA1234:
            raise ValueError(f"not a VPK: {base_url}")
        hdr = 12 if ver == 1 else 28
        self.dir, self.entries = d, {}
        p, end = hdr, hdr + tree

        def cstr():
            nonlocal p
            e = d.index(b"\0", p)
            s = d[p:e].decode("latin-1")
            p = e + 1
            return s
        while p < end:
            ext = cstr()
            if not ext:
                break
            while True:
                folder = cstr()
                if not folder:
                    break
                while True:
                    name = cstr()
                    if not name:
                        break
                    _crc, pre, arch, off, ln, _term = struct.unpack_from("<IHHIIH", d, p)
                    p += 18
                    key = (f"{folder}/" if folder.strip() else "") + f"{name}.{ext}"
                    self.entries[key.lower()] = (pre, p, arch, off, ln)
                    p += pre
        self.data_start = end

    def read(self, path: str) -> bytes | None:
        e = self.entries.get(path.lower())
        if not e:
            return None
        pre, pre_ofs, arch, off, ln = e
        out = self.dir[pre_ofs:pre_ofs + pre]
        if ln:
            if arch == 0x7FFF:
                out += self.dir[self.data_start + off:self.data_start + off + ln]
            else:
                out += http(f"{self.base}_{arch:03d}.vpk", (off, ln))
        return out


class FileSystem:
    def __init__(self, pak: bytes | None, loose_base: str | None, vpks: list[VPK], cache: str):
        self.pak = zipfile.ZipFile(io.BytesIO(pak)) if pak else None
        self.pak_names = {n.lower(): n for n in self.pak.namelist()} if self.pak else {}
        self.loose_base, self.loose = loose_base, {}
        self.cache = cache
        if loose_base:
            listing = os.path.join(cache, re.sub(r"[^A-Za-z0-9._-]", "_", loose_base) + "dir.txt")
            if not os.path.exists(listing):
                os.makedirs(cache, exist_ok=True)
                open(listing, "wb").write(http(loose_base + "dir.txt"))
            for line in open(listing, encoding="latin-1").read().splitlines():
                if line.strip():
                    self.loose[line.strip().lower()] = line.strip()
        self.vpks = vpks

    def read(self, path: str) -> bytes | None:
        key = path.replace("\\", "/").lower().lstrip("/")
        if key in self.pak_names:
            return self.pak.read(self.pak_names[key])
        if key in self.loose:
            fn = os.path.join(self.cache, "files", re.sub(r"[^A-Za-z0-9._/-]", "_", key))
            if not os.path.exists(fn):
                os.makedirs(os.path.dirname(fn), exist_ok=True)
                open(fn, "wb").write(http(self.loose_base + self.loose[key]))
            return open(fn, "rb").read()
        for v in self.vpks:
            b = v.read(key)
            if b is not None:
                return b
        return None


# ---- VMT ---------------------------------------------------------------------------------------

def parse_vmt(text: str) -> tuple[str, dict]:
    """(shader, flat lower-cased key -> value) of a KeyValues material (nested blocks flattened)."""
    toks = re.findall(r'"([^"]*)"|([{}])|([^\s{}"]+)', re.sub(r"//[^\n]*", "", text))
    words = [a or b or c for a, b, c in toks]
    shader = words[0].lower() if words else ""
    kv, i = {}, 1
    while i < len(words):
        w = words[i]
        if w in "{}":
            i += 1
            continue
        if i + 1 < len(words) and words[i + 1] not in "{}":
            kv.setdefault(w.lower(), words[i + 1])
            i += 2
        else:
            i += 1
    return shader, kv


def material(fs: FileSystem, name: str, depth: int = 0) -> dict | None:
    """{basetexture, alphatest, translucent} for a material name ('concrete/wall01')."""
    raw = fs.read(f"materials/{name.lower()}.vmt")
    if raw is None:
        return None
    shader, kv = parse_vmt(raw.decode("latin-1", "replace"))
    if shader == "patch" and "include" in kv and depth < 4:
        inc = re.sub(r"^materials/|\.vmt$", "", kv["include"].replace("\\", "/").lower())
        base = material(fs, inc, depth + 1) or {}
        if "$basetexture" in kv:
            base["basetexture"] = kv["$basetexture"]
        return base or None
    if "$basetexture" not in kv:
        return None
    flag = lambda k: kv.get(k, "0").strip() not in ("0", "")
    return {"basetexture": kv["$basetexture"], "alphatest": flag("$alphatest"), "translucent": flag("$translucent")}


# ---- VTF ---------------------------------------------------------------------------------------

def _rgb565(c: np.ndarray) -> np.ndarray:
    r, g, b = (c >> 11) & 31, (c >> 5) & 63, c & 31
    return np.stack([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)], -1).astype(np.int32)


def _dxt_color(blk: np.ndarray, dxt1: bool) -> np.ndarray:
    """blk: (n, 8) colour blocks -> (n, 16, 4) RGBA."""
    c0 = blk[:, 0].astype(np.uint16) | (blk[:, 1].astype(np.uint16) << 8)
    c1 = blk[:, 2].astype(np.uint16) | (blk[:, 3].astype(np.uint16) << 8)
    p0, p1 = _rgb565(c0), _rgb565(c1)
    four = (c0 > c1) | ~dxt1
    pal = np.zeros((len(blk), 4, 4), np.int32)
    pal[:, 0, :3], pal[:, 1, :3] = p0, p1
    pal[:, 2, :3] = np.where(four[:, None], (2 * p0 + p1) // 3, (p0 + p1) // 2)
    pal[:, 3, :3] = np.where(four[:, None], (p0 + 2 * p1) // 3, 0)
    pal[:, :, 3] = 255
    if dxt1:
        pal[:, 3, 3] = np.where(four, 255, 0)
    bits = blk[:, 4:8].astype(np.uint32)
    idx = bits[:, 0] | (bits[:, 1] << 8) | (bits[:, 2] << 16) | (bits[:, 3] << 24)
    sel = (idx[:, None] >> (2 * np.arange(16, dtype=np.uint32))) & 3
    return np.take_along_axis(pal, sel[:, :, None].astype(np.int64).repeat(4, 2), 1)


def _dxt(data: bytes, w: int, h: int, kind: int) -> np.ndarray:
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    bs = 8 if kind == 1 else 16
    b = np.frombuffer(data, np.uint8, bw * bh * bs).reshape(-1, bs)
    if kind == 1:
        px = _dxt_color(b, True)
    else:
        px = _dxt_color(b[:, 8:], False)
        if kind == 3:
            a = b[:, :8]
            px[:, :, 3] = np.stack([a & 15, a >> 4], -1).reshape(-1, 16) * 17
        else:
            a0, a1 = b[:, 0].astype(np.int32), b[:, 1].astype(np.int32)
            pal = np.zeros((len(b), 8), np.int32)
            pal[:, 0], pal[:, 1] = a0, a1
            big = a0 > a1
            for i in range(1, 7):
                pal[:, i + 1] = np.where(big, ((7 - i) * a0 + i * a1) // 7, 0)
            for i in range(1, 5):
                pal[:, i + 1] = np.where(big, pal[:, i + 1], ((5 - i) * a0 + i * a1) // 5)
            pal[:, 6] = np.where(big, pal[:, 6], 0)
            pal[:, 7] = np.where(big, pal[:, 7], 255)
            bits = np.zeros(len(b), np.uint64)
            for i in range(6):
                bits |= b[:, 2 + i].astype(np.uint64) << np.uint64(8 * i)
            sel = (bits[:, None] >> (np.uint64(3) * np.arange(16, dtype=np.uint64))) & np.uint64(7)
            px[:, :, 3] = np.take_along_axis(pal, sel.astype(np.int64), 1)
    img = px.reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)
    return img[:h, :w].astype(np.uint8)


# format id -> (bytes per pixel, channel order) for uncompressed formats
_RAW = {0: (4, "RGBA"), 1: (4, "ABGR"), 2: (3, "RGB"), 3: (3, "BGR"), 5: (1, "I"), 6: (2, "IA"),
        8: (1, "A"), 11: (4, "ARGB"), 12: (4, "BGRA"), 16: (4, "BGRX")}
_DXT = {13: 1, 20: 1, 14: 3, 15: 5}


def _mip_size(fmt: int, w: int, h: int) -> int:
    if fmt in _DXT:
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * (8 if _DXT[fmt] == 1 else 16)
    return w * h * _RAW[fmt][0]


def decode_vtf(data: bytes) -> np.ndarray | None:
    """Largest mip, first frame / face, as an (h, w, 4) uint8 RGBA array; None if unsupported."""
    if data[:4] != b"VTF\0":
        return None
    v0, v1, hsize, w, h, flags, frames = struct.unpack_from("<IIIHHIH", data, 4)
    fmt, mips, lfmt, lw, lh = struct.unpack_from("<iBiBB", data, 52)
    if fmt not in _DXT and fmt not in _RAW:
        return None
    faces = 6 if flags & 0x4000 else 1                  # TEXTUREFLAGS_ENVMAP
    depth = struct.unpack_from("<H", data, 63)[0] if (v0, v1) >= (7, 2) else 1
    start = None
    if (v0, v1) >= (7, 3):
        nres = struct.unpack_from("<I", data, 68)[0]
        for i in range(nres):
            tag, _, off = struct.unpack_from("<3sBI", data, 80 + 8 * i)
            if tag == b"\x30\0\0":
                start = off
    if start is None:
        start = hsize + (_mip_size(lfmt, lw, lh) if lfmt in _DXT or lfmt in _RAW else 0)
    # mips run smallest first; skip to the largest
    off = start
    for m in range(mips - 1, 0, -1):
        off += _mip_size(fmt, max(1, w >> m), max(1, h >> m)) * frames * faces * max(1, depth >> m)
    raw = data[off:off + _mip_size(fmt, w, h)]
    if fmt in _DXT:
        return _dxt(raw, w, h, _DXT[fmt])
    bpp, order = _RAW[fmt]
    px = np.frombuffer(raw, np.uint8, w * h * bpp).reshape(h, w, bpp)
    out = np.full((h, w, 4), 255, np.uint8)
    for i, ch in enumerate(order):
        if ch in "RGBA":
            out[:, :, "RGBA".index(ch)] = px[:, :, i]
        elif ch == "I":
            out[:, :, :3] = px[:, :, i:i + 1]
    if order == "IA":
        out[:, :, 3] = px[:, :, 1]
    return out
