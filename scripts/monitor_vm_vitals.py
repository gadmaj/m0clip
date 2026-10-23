#!/usr/bin/env python3
"""Guest-visible resource pressure; no privileged probes, external dependencies or host claims."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import threading
import time

STATE = Path.home() / '.local/state/m0clip-vitals'
MAX_LOG_BYTES = 8 * 1024 * 1024
LOG_BACKUPS = 7


@dataclass
class Snapshot:
    monotonic: float
    cpu: list[int]
    memory: dict[str, int]
    vm: dict[str, int]
    cgroups: dict[str, dict[str, str | int | None]]


def numbers(path: Path) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in path.read_text().splitlines():
        fields = line.split()
        if len(fields) >= 2:
            result[fields[0].rstrip(':')] = int(fields[1])
    return result


def cpu_counters() -> list[int]:
    with Path('/proc/stat').open() as stream:
        fields = stream.readline().split()
    if fields[0] != 'cpu' or len(fields) < 9:
        raise ValueError('Missing aggregate Linux CPU counters')
    # guest and guest_nice are already included in user/nice: never count them twice.
    return [int(value) for value in fields[1:9]]


def cpu_rates(before: list[int], after: list[int]) -> dict[str, float] | None:
    delta = [new - old for old, new in zip(before, after, strict=True)]
    total = sum(delta)
    if len(delta) != 8 or min(delta) < 0 or total <= 0:
        return None  # Counter discontinuity is not evidence of zero contention.
    return {key: round(value * 100 / total, 3) for key, value in {
        'work_pct': total - delta[3] - delta[4] - delta[7],
        'idle_pct': delta[3], 'iowait_pct': delta[4], 'steal_pct': delta[7],
    }.items()}


def pressure() -> dict[str, object]:
    result = {}
    for resource in ('cpu', 'memory', 'io'):
        try:
            rows = {}
            for line in (Path('/proc/pressure') / resource).read_text().splitlines():
                fields = line.split()
                rows[fields[0]] = {key: float(value) for key, value in
                                   (field.split('=') for field in fields[1:]) if key != 'total'}
            result[resource] = rows
        except OSError as error:
            result[resource] = {'unavailable': str(error)}
    return result


def cgroups() -> dict[str, dict[str, str | int | None]]:
    root = Path('/sys/fs/cgroup')
    user = root / 'user.slice' / f'user-{os.getuid()}.slice'
    paths = {root, user, *user.glob('session-*.scope')}
    relative = next(line.split('::', 1)[1] for line in
                    Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    current = root / relative.lstrip('/')
    while current != root and current.is_relative_to(root):
        paths.add(current)
        current = current.parent
    result: dict[str, dict[str, str | int | None]] = {}
    for path in sorted(paths):
        name = '/' + str(path.relative_to(root)) if path != root else '/'
        try:
            stat = numbers(path / 'cpu.stat')
            events = numbers(path / 'memory.events') if (path / 'memory.events').exists() else {}
            result[name] = {
                'cpu_max': (path / 'cpu.max').read_text().strip() if path != root else 'root controller',
                'nr_throttled': stat.get('nr_throttled'),
                'throttled_usec': stat.get('throttled_usec'),
                'oom_kill': events.get('oom_kill'),
                'memory_max': (path / 'memory.max').read_text().strip() if path != root else 'root controller',
            }
        except OSError as error:
            result[name] = {'unavailable': str(error)}
    return result


def snapshot() -> Snapshot:
    return Snapshot(time.monotonic(), cpu_counters(), numbers(Path('/proc/meminfo')),
                    numbers(Path('/proc/vmstat')), cgroups())


def disk_space(path: str) -> dict[str, int]:
    stat = os.statvfs(path)
    return {'total_bytes': stat.f_blocks * stat.f_frsize,
            'available_bytes': stat.f_bavail * stat.f_frsize}


def sample(before: Snapshot, after: Snapshot) -> dict[str, object]:
    elapsed = after.monotonic - before.monotonic
    if elapsed <= 0:
        raise ValueError('Nonpositive monotonic sample interval')
    cpu = cpu_rates(before.cpu, after.cpu)
    memory = after.memory
    page_bytes = os.sysconf('SC_PAGE_SIZE')
    swap = {}
    for name in ('pswpin', 'pswpout'):
        delta = after.vm[name] - before.vm[name]
        swap[name + '_bytes_per_second'] = round(delta * page_bytes / elapsed, 2) if delta >= 0 else None
    groups = after.cgroups
    warnings = []
    if cpu is None:
        warnings.append('cpu_counter_discontinuity')
    elif cpu['steal_pct'] >= 5:
        warnings.append('high_cpu_steal: guest-visible host-contention signal, not thermal proof')
    if memory['MemAvailable'] < max(1024 * 1024, memory['MemTotal'] // 10):
        warnings.append('low_available_memory')
    if memory['SwapTotal'] and memory['SwapFree'] * 100 < memory['SwapTotal'] * 5:
        warnings.append('swap_nearly_full: inspect swap activity and memory pressure, not capacity alone')
    for name, values in groups.items():
        previous = before.cgroups.get(name, {})
        for counter in ('nr_throttled', 'throttled_usec', 'oom_kill'):
            old, new = previous.get(counter), values.get(counter)
            values[counter + '_delta'] = new - old if isinstance(old, int) and isinstance(new, int) and new >= old else None
        if values.get('nr_throttled_delta'):
            warnings.append(f'cpu_quota_throttling: {name}')
        if values.get('oom_kill_delta'):
            warnings.append(f'new_oom_kill: {name}')
    root = disk_space('/')
    if root['available_bytes'] < 5 * 1024**3:
        warnings.append('root_disk_below_5GiB_available')
    return {'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'interval_seconds': round(elapsed, 3),
            'vcpus': os.cpu_count(), 'cpu': cpu, 'load_average': list(os.getloadavg()),
            'memory': {key + '_bytes': memory[key] * 1024 for key in
                       ('MemTotal', 'MemAvailable', 'Cached', 'Shmem', 'SwapTotal', 'SwapFree')},
            'swap_activity': swap, 'pressure': pressure(), 'cgroups': groups,
            'root_disk': root, 'shared_memory_disk': disk_space('/dev/shm'), 'warnings': warnings,
            'scope': 'Guest-visible counters only; no access to Proxmox host temperatures, reservations or thermal throttling.'}


def log_handler(path: Path, max_bytes: int = MAX_LOG_BYTES, backups: int = LOG_BACKUPS) -> RotatingFileHandler:
    handler = RotatingFileHandler(path, maxBytes=max_bytes, backupCount=backups, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(message)s'))
    return handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interval', type=float, default=10)
    parser.add_argument('--output-dir', type=Path, default=STATE)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()
    if args.status:
        latest = json.loads((args.output_dir / 'current.json').read_text())
        latest['sample_age_seconds'] = round(time.time() - (args.output_dir / 'current.json').stat().st_mtime, 1)
        print(json.dumps(latest, indent=2))
        return
    if args.interval < 1:
        parser.error('--interval must be at least one second')
    os.umask(0o077)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda _signal, _frame: stop.set())
    logger = logging.getLogger('m0clip-vitals')
    logger.setLevel(logging.INFO)
    handler = log_handler(args.output_dir / 'samples.jsonl')
    logger.addHandler(handler)
    previous = snapshot()
    previous_warnings = None
    print(f'm0clip-vitals monitoring every {args.interval:g}s; sample logs capped at 64MiB', flush=True)
    try:
        while not stop.wait(args.interval):
            current = snapshot()
            row = sample(previous, current)
            previous = current
            encoded = json.dumps(row, separators=(',', ':'))
            logger.info(encoded)
            temporary = args.output_dir / 'current.json.tmp'
            temporary.write_text(encoded + '\n')
            temporary.replace(args.output_dir / 'current.json')
            if row['warnings'] != previous_warnings:
                print(json.dumps({'warnings': row['warnings'], 'time': row['time']}), flush=True)
                previous_warnings = row['warnings']
            if args.once:
                print(json.dumps(row, indent=2))
                break
    finally:
        handler.close()
        logger.removeHandler(handler)


if __name__ == '__main__':
    main()
