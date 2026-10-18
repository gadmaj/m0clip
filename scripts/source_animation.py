"""Source MDL local bone animations, following noclip.website Studio.ts (LICENSE.noclip).

Decode local animation tracks at authored keyframes; export standard glTF skeletal animation.
External .ani blocks / blended pose parameters are deliberately rejected rather than guessed.
"""
import struct
import numpy as np
from source_models import u32, i32, cstr


def euler_quat(euler):
    r, p, y = np.array(euler) * .5
    sr, sp, sy = np.sin([r, p, y]); cr, cp, cy = np.cos([r, p, y])
    return np.array([sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy,
                     cr*cp*sy-sr*sp*cy, cr*cp*cy+sr*sp*sy])


def decode_quat(data, offset, bits):
    if bits == 48:
        x, y, z = struct.unpack_from('<HHH', data, offset)
        v = np.array([(x-32768)/32768, (y-32768)/32768, ((z&32767)-16384)/16384])
        sign = -1 if z & 32768 else 1
    else:
        raw = int.from_bytes(data[offset:offset+8], 'little')
        v = np.array([((raw >> (21*i)) & 0x1fffff) - 0x100000 for i in range(3)]) / 0x100000
        sign = -1 if raw & (1 << 63) else 1
    return np.append(v, sign * np.sqrt(max(0, 1-float(v@v))))


def rle(data, base, relative, frame):
    if relative == 0: return 0
    offset = base + relative
    while True:
        valid, total = data[offset:offset+2]
        if not valid or not total: raise ValueError('invalid animation RLE run')
        if frame < total: return struct.unpack_from('<h', data, offset+2+min(frame, valid-1)*2)[0]
        frame -= total; offset += 2 + valid*2


class AnimationModel:
    def __init__(self, mdl):
        self.mdl = mdl
        self.bones = []
        for i in range(u32(mdl, 0x9c)):
            offset = u32(mdl, 0xa0) + i * 216
            self.bones.append(dict(name=cstr(mdl, offset + u32(mdl, offset)), parent=i32(mdl, offset+4),
                pos=np.frombuffer(mdl, '<f4', 3, offset+32).copy(),
                quat=np.frombuffer(mdl, '<f4', 4, offset+44).copy(),
                rot=np.frombuffer(mdl, '<f4', 3, offset+60).copy(),
                pos_scale=np.frombuffer(mdl, '<f4', 3, offset+72).copy(),
                rot_scale=np.frombuffer(mdl, '<f4', 3, offset+84).copy(),
                inverse=np.vstack([np.frombuffer(mdl, '<f4', 12, offset+96).reshape(3, 4), [0, 0, 0, 1]])))
        self.sequences = {}
        for i in range(u32(mdl, 0xbc)):
            offset = u32(mdl, 0xc0) + i * 212
            name = cstr(mdl, offset + u32(mdl, offset+4)).lower()
            anim = struct.unpack_from('<h', mdl, offset+u32(mdl, offset+60))[0]
            self.sequences[name] = dict(anim=anim, loop=bool(u32(mdl, offset+12) & 1))

    def sample(self, name):
        sequence = self.sequences.get(name.lower())
        if sequence is None: raise ValueError('unknown Source animation ' + name)
        data = self.mdl; offset = u32(data, 0xb8) + sequence['anim'] * 100
        fps, flags, frames = struct.unpack_from('<fII', data, offset+8)
        if u32(data, offset+0x34) != 0 or u32(data, offset+0x54) != 0:
            raise ValueError('external or sectioned Source animation is not supported yet')
        tracks = {}; track = offset + u32(data, offset+0x38)
        if u32(data, offset+0x38):
            while True:
                bone, flags, next_offset = struct.unpack_from('<BBH', data, track)
                if bone == 255: break
                if bone >= len(self.bones): raise ValueError('animation bone index out of range')
                if flags & 16: raise ValueError('delta animation needs a blend base')
                tracks[bone] = (track+4, flags)
                if not next_offset: break
                track += next_offset
        positions = np.zeros((frames, len(self.bones), 3)); quats = np.zeros((frames, len(self.bones), 4))
        for frame in range(frames):
            for i, bone in enumerate(self.bones):
                p, q = bone['pos'].copy(), bone['quat'].copy()
                if i in tracks:
                    cursor, flags = tracks[i]
                    if flags & 2: q = decode_quat(data, cursor, 48); cursor += 6
                    elif flags & 32: q = decode_quat(data, cursor, 64); cursor += 8
                    elif flags & 8:
                        values = [rle(data, cursor, struct.unpack_from('<H', data, cursor+j*2)[0], frame) for j in range(3)]
                        q = euler_quat(np.array(values)*bone['rot_scale']+bone['rot']); cursor += 6
                    if flags & 1: p = np.frombuffer(data, '<f2', 3, cursor).astype(float)
                    elif flags & 4:
                        values = [rle(data, cursor, struct.unpack_from('<H', data, cursor+j*2)[0], frame) for j in range(3)]
                        p = np.array(values)*bone['pos_scale']+bone['pos']
                if frame and quats[frame-1, i] @ q < 0: q = -q
                positions[frame, i] = p; quats[frame, i] = q / max(np.linalg.norm(q), 1e-12)
        return dict(times=np.arange(frames, dtype=np.float32)/fps, positions=positions, quaternions=quats,
                    loop=sequence['loop'])
