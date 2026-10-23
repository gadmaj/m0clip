#!/usr/bin/env python3
"""Hash the development workspace, ignored assets and native reference before SSH transfer."""
import argparse
import hashlib
import json
import os
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
EXCLUDED = {'node_modules', '__pycache__', '.venv', '.wireit', '.pytest_cache'}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def root_names(base, requested):
    names = requested or [PROJECT.name, 'noclip.website']
    backup = 'unitree-ghost-before-native-vtf'
    if not requested and (base / backup).is_dir():
        names.append(backup)
    for name in names:
        if name in ('.', '..') or Path(name).name != name:
            raise ValueError('Workspace roots must be immediate directory names')
        if not (base / name).is_dir() or (base / name).is_symlink():
            raise ValueError(f'Missing workspace directory: {name}')
    return names


def inventory(base, roots):
    files = {}
    def record(path):
        name = path.relative_to(base).as_posix()
        if path.is_symlink():
            files[name] = {'link': os.readlink(path)}
        elif path.is_file():
            files[name] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
        else:
            raise ValueError(f'Cannot migrate special file: {name}')
    for name in roots:
        for directory, dirs, names in os.walk(base / name, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED)
            for entry in dirs[:]:
                path = Path(directory) / entry
                if path.is_symlink():
                    record(path)
                    dirs.remove(entry)
            for entry in sorted(names):
                record(Path(directory) / entry)
    return files


def verify(base, manifest):
    if manifest.get('version') != 1:
        raise ValueError('Unsupported migration manifest')
    roots = root_names(base, manifest['roots'])
    for name, expected in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or relative.parts[0] not in roots:
            raise ValueError('Invalid manifest path')
        path = base / relative
        if 'link' in expected:
            valid = path.is_symlink() and os.readlink(path) == expected['link']
        else:
            valid = (path.is_file() and not path.is_symlink()
                     and path.stat().st_size == expected['bytes']
                     and digest(path) == expected['sha256'])
        if not valid:
            raise ValueError(f'Transfer verification failed: {name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('write', 'verify'))
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--base', type=Path, default=PROJECT.parent)
    parser.add_argument('--root', action='append', help='Immediate workspace directory; repeat to include more')
    args = parser.parse_args()
    base = args.base.resolve()
    if args.action == 'write':
        roots = root_names(base, args.root)
        files = inventory(base, roots)
        manifest = {'version': 1, 'roots': roots, 'excluded_directories': sorted(EXCLUDED), 'files': files}
        output = args.manifest.resolve()
        if any(output.is_relative_to(base / root) for root in roots):
            raise ValueError('Write the manifest beside the workspace directories, outside their inventories')
        output.write_text(json.dumps(manifest, indent=2) + '\n')
    else:
        manifest = json.loads(args.manifest.read_text())
        verify(base, manifest)
    count = len(manifest['files'])
    size = sum(entry.get('bytes', 0) for entry in manifest['files'].values())
    print(f'{args.action}: {count} files/links, {size} bytes, {len(manifest["roots"])} workspace directories')


if __name__ == '__main__':
    main()
