#!/usr/bin/env python3
"""Retain authored NeoTokyo 32³ color-correction tables without changing map geometry."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from import_source_bsp import BSP, GAMES, MOUNTS, STORAGE, SCALE, parse
from source_assets import FileSystem, VPK


def refresh(directory, model, fs):
    manifest = json.loads((directory/'manifest.json').read_text())
    yaw = np.radians(-manifest['spawn_yaw']); c, s = np.cos(yaw), np.sin(yaw)
    rotation = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    origin = np.array(manifest['spawn_source']); layers = []; payloads = {}
    # noclip logic_auto.spawn fires OnMapSpawn, including duplicate output keys.
    # OnNewGame is not fired by that reference class. Resolve the initial color
    # controller state without changing the rest of the game's entity behavior.
    startup = []
    for pairs in model.get('entity_pairs', [list(e.items()) for e in model['ents']]):
        lower = [(k.lower(), v) for k, v in pairs]
        if dict(lower).get('classname') != 'logic_auto': continue
        for key, value in lower:
            if key != 'onmapspawn': continue
            parts = value.split('\\x1b') if '\\x1b' in value else value.split(',')
            if len(parts) != 5: raise ValueError('Invalid initial Source entity output')
            target, action, _, delay, times = parts
            if float(delay) <= 0 and int(times) != 0: startup.append((target.lower(), action.lower()))
    for raw_entity in model['ents']:
        entity = {k.lower(): v for k, v in raw_entity.items()}
        if entity.get('classname') != 'color_correction': continue
        if entity.get('parentname'): raise ValueError('Parented color-correction entities need native transforms')
        filename = entity.get('filename', '').lower().replace('\\', '/')
        data = fs.read(filename)
        if data is None: raise FileNotFoundError(filename)
        if len(data) < 32*32*32*3: raise ValueError(f'Truncated color-correction table: {filename}')
        digest = hashlib.sha256(data).hexdigest()
        file = payloads.setdefault(digest, f'source-color-{len(payloads)}.rgb')
        (directory/file).write_bytes(data)
        point = np.array([float(v) for v in entity.get('origin', '0 0 0').split()])
        enabled = not bool(float(entity.get('startdisabled', entity.get('start_disabled', '0'))))
        for target, action in startup:
            if target != entity.get('targetname', '').lower(): continue
            if action == 'enable': enabled = True
            elif action == 'disable': enabled = False
            elif action == 'toggle': enabled = not enabled
        layers.append(dict(file=file, source=filename, origin=(((point-origin) @ rotation.T)*SCALE).tolist(),
                           enabled=enabled,
                           minfalloff=float(entity.get('minfalloff', '-1'))*SCALE,
                           maxfalloff=float(entity.get('maxfalloff', '-1'))*SCALE))
    if layers:
        manifest['color_corrections'] = layers
        temporary = directory/'manifest.color-part.json'; temporary.write_text(json.dumps(manifest, indent=2)+'\n'); temporary.replace(directory/'manifest.json')
    return dict(map=directory.name, layers=len(layers), enabled=sum(l['enabled'] for l in layers), tables=len(payloads))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--maps', nargs='+', choices=GAMES['neotokyo'][2], default=GAMES['neotokyo'][2])
    args = parser.parse_args(); root = Path(__file__).resolve().parent.parent; cache = root/'assets/bsp-cache'
    loose, names = MOUNTS['neotokyo']; archives = [VPK(f'{STORAGE}/{name}', str(cache)) for name in names]
    for name in args.maps:
        bsp = BSP((cache/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{name}.bsp').read_bytes()); model = parse(bsp)
        if not any(e.get('classname') == 'color_correction' for e in model['ents']): continue
        fs = FileSystem(bsp.lump(40), f'{STORAGE}/{loose}', archives, str(cache))
        print(json.dumps(refresh(root/'public/assets/maps'/name, model, fs)), flush=True)
