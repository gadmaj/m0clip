#!/usr/bin/env python3
"""Self-contained pure-Python FMX decoder for Unitree ai_sport config files.

Unitree's `file_mixer` ("FMX") wraps config YAML/JSON in a Blowfish-ECB
container. The R1 ai_sport module uses key-generation METHOD_2: a 937-byte key
is derived from a per-file 32-bit seed, then a *non-standard* Blowfish (arbitrary
key length, little-endian block words) decrypts the payload.

Container layout (little-endian):
    magic   4 bytes  b"FMX\\x01"
    seed    4 bytes  uint32  -> key material
    size    4 bytes  uint32  -> ciphertext length
    md5     8 bytes  first 8 bytes of md5(plaintext), as an integrity check
    body    size bytes (Blowfish-ECB ciphertext)

This module has NO external dependencies (no pycryptodome, no .so) so the repo
stays portable. Verified byte-for-byte against Unitree's on-robot decode.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

# ── FMX / key-generation constants ──────────────────────────────────────────
FMX_MAGIC = b"FMX\x01"
KEY_LENGTH = 937  # bytes of key material METHOD_2 expands from the seed

UT_CODEKEY_M1_METHOD_2 = 0x7B93A0C3
UT_CODEKEY_M2_METHOD_2 = 0x3C6EF35F


def generate_key_method_2(seed: int, key_length: int = KEY_LENGTH) -> bytes:
    """Replicate unitree::security::GenKey::Generate2 (the R1 ai_sport method)."""
    state = seed & 0xFFFFFFFFFFFFFFFF
    key = bytearray()
    for i in range(key_length):
        intermediate = (UT_CODEKEY_M1_METHOD_2 * state) & 0xFFFFFFFFFFFFFFFF
        term = ((i + 1) * UT_CODEKEY_M2_METHOD_2) % 0x100000000
        term %= 0x10000003
        state = (intermediate + term) & 0xFFFFFFFFFFFFFFFF
        cast32 = intermediate & 0xFFFFFFFF
        key.append((cast32 + term) & 0xFF)
    return bytes(key)


# ── Blowfish (non-standard: arbitrary key length, LE block words) ────────────
_INITIAL_P = [
    0x243F6A88, 0x85A308D3, 0x13198A2E, 0x03707344, 0xA4093822, 0x299F31D0,
    0x082EFA98, 0xEC4E6C89, 0x452821E6, 0x38D01377, 0xBE5466CF, 0x34E90C6C,
    0xC0AC29B7, 0xC97C50DD, 0x3F84D5B5, 0xB5470917, 0x9216D5D9, 0x8979FB1B,
]

# The 4x256 S-box init constants (Blowfish's published pi-digit tables) live in a
# sibling data module to keep this file readable. Import it whether fmx.py is run
# as a script, imported from tools/, or imported as tools.fmx.
try:
    from _blowfish_sbox import INITIAL_SBOX  # noqa: E402
except ImportError:  # pragma: no cover
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _blowfish_sbox import INITIAL_SBOX  # noqa: E402


class Blowfish:
    """ECB Blowfish matching Unitree's C++ impl (no 56-byte key cap, LE words)."""

    def __init__(self, key: bytes):
        self.p = _INITIAL_P[:]
        self.s = [row[:] for row in INITIAL_SBOX]
        if not key:
            raise ValueError("empty key")
        n = len(key)
        blen = n // _gcd(n, 4)
        kbuf = []
        for i in range(blen):
            # C++ union (little-endian): byte0 is the MSB, byte3 the LSB, so key
            # words are packed big-endian: key[4i] -> bits 24..31, key[4i+3] -> 0..7.
            b0 = key[(i * 4 + 0) % n]
            b1 = key[(i * 4 + 1) % n]
            b2 = key[(i * 4 + 2) % n]
            b3 = key[(i * 4 + 3) % n]
            kbuf.append((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)
        for i in range(18):
            self.p[i] ^= kbuf[i % blen]
        # Warm up P then S by encrypting a running zero block. Both must be
        # written IN PLACE — each EncryptBlock reads the P/S entries updated by
        # the previous iterations (the C++ writes straight into pary_/sbox_).
        l = r = 0
        for i in range(9):
            l, r = self._encrypt_block(l, r)
            self.p[2 * i], self.p[2 * i + 1] = l, r
        for i in range(512):
            l, r = self._encrypt_block(l, r)
            a = 2 * i
            self.s[a >> 8][a & 0xFF] = l
            a += 1
            self.s[a >> 8][a & 0xFF] = r

    def _feistel(self, v: int) -> int:
        # a is the HIGH byte, d the LOW byte (C++ union byte0=MSB .. byte3=LSB).
        a, b, c, d = (v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF
        return (((self.s[0][a] + self.s[1][b]) & 0xFFFFFFFF ^ self.s[2][c])
                + self.s[3][d]) & 0xFFFFFFFF

    def _encrypt_block(self, l: int, r: int):
        for i in range(16):
            l ^= self.p[i]
            r ^= self._feistel(l)
            l, r = r, l
        l, r = r, l
        r ^= self.p[16]
        l ^= self.p[17]
        return l & 0xFFFFFFFF, r & 0xFFFFFFFF

    def _decrypt_block(self, l: int, r: int):
        for i in range(16):
            l ^= self.p[17 - i]
            r ^= self._feistel(l)
            l, r = r, l
        l, r = r, l
        r ^= self.p[1]
        l ^= self.p[0]
        return l & 0xFFFFFFFF, r & 0xFFFFFFFF

    def decrypt(self, data: bytes) -> bytes:
        # Mirror C++ Blowfish::Decrypt: copy everything, decrypt only whole
        # 8-byte blocks in place. Any partial tail stays as raw ciphertext, so
        # the output length equals the input (and the file md5 still checks out).
        out = bytearray(data)
        for i in range(0, len(data) // 8 * 8, 8):
            b = out[i:i + 8]
            l = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)
            r = b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)
            l, r = self._decrypt_block(l, r)
            out[i:i + 8] = bytes([l & 0xFF, (l >> 8) & 0xFF, (l >> 16) & 0xFF, (l >> 24) & 0xFF,
                                  r & 0xFF, (r >> 8) & 0xFF, (r >> 16) & 0xFF, (r >> 24) & 0xFF])
        return bytes(out)


def _gcd(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return a


@dataclass
class FmxFile:
    seed: int
    size: int
    md5: bytes
    body: bytes


def _load(path: str) -> FmxFile:
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic != FMX_MAGIC:
            raise ValueError(f"{path}: not an FMX file (magic={magic!r})")
        seed = int.from_bytes(f.read(4), "little")
        size = int.from_bytes(f.read(4), "little")
        md5 = f.read(8)
        body = f.read(size)
    return FmxFile(seed, size, md5, body)


def is_fmx(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4) == FMX_MAGIC
    except OSError:
        return False


def decrypt_file(path: str) -> bytes:
    """Decrypt an FMX file (METHOD_2) and return the plaintext bytes.

    Raises ValueError on magic/size/md5 mismatch so callers can trust the output.
    """
    fx = _load(path)
    if fx.size != len(fx.body):
        raise ValueError(f"{path}: size field {fx.size} != body {len(fx.body)}")
    key = generate_key_method_2(fx.seed)
    plain = Blowfish(key).decrypt(fx.body)
    if hashlib.md5(plain).hexdigest()[:16] != fx.md5.hex():
        raise ValueError(f"{path}: md5 mismatch — wrong key method or corrupt file")
    return plain


def decrypt_text(path: str) -> str:
    return decrypt_file(path).decode("utf-8", errors="ignore")


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        sys.stdout.write(decrypt_text(p))
