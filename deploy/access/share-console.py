#!/usr/bin/env python3
"""Share the signed-in seat0 X11 desktop over this SSH channel."""
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import threading
import sys


def checked(*args):
    return subprocess.check_output(args, text=True, timeout=8).strip()


def console():
    sid = checked("loginctl", "show-seat", "seat0", "-p", "ActiveSession", "--value")
    if not sid:
        raise RuntimeError("No signed-in desktop is active on seat0.")
    values = checked(
        "loginctl", "show-session", sid,
        "-p", "User", "-p", "Type", "-p", "Display", "-p", "Active",
    )
    props = dict(line.split("=", 1) for line in values.splitlines() if "=" in line)
    if props.get("User") != str(os.getuid()) or props.get("Type") != "x11":
        raise RuntimeError("The active console must be this user's existing X11 desktop.")
    display = props.get("Display", "")
    if not re.fullmatch(r":[0-9]+(?:\.[0-9]+)?", display):
        raise RuntimeError("The active desktop has no local X11 display.")
    authorities = []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            if (proc / "comm").read_text().strip() not in {
                "plasmashell", "kwin_x11", "ksmserver",
            }:
                continue
            env = dict(
                item.split("=", 1) for item in
                (proc / "environ").read_bytes().decode().split("\0") if "=" in item
            )
            if env.get("DISPLAY", "").split(".")[0] != display.split(".")[0]:
                continue
            auth = env.get("XAUTHORITY")
            if auth and Path(auth).is_file() and auth not in authorities:
                authorities.append(auth)
        except (OSError, UnicodeError):
            continue
    authorities.append(str(Path.home() / ".Xauthority"))
    for auth in authorities:
        env = dict(os.environ, DISPLAY=display, XAUTHORITY=auth)
        probe = subprocess.run(
            ["xdpyinfo"], env=env, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=8,
        )
        if probe.returncode == 0:
            match = re.search(r"dimensions:\s+([0-9]+)x([0-9]+)", probe.stdout)
            return sid, display, auth, (list(map(int, match.groups())) if match else None)
    raise RuntimeError("Cannot authenticate to the signed-in console display.")


def main():
    os.umask(0o077)
    sid, display, auth, dimensions = console()
    if sys.argv[1:] == ["--check"]:
        print(json.dumps({"session": sid, "display": display, "dimensions": dimensions}))
        return
    if sys.argv[1:]:
        raise RuntimeError("Only --check is supported.")
    logs = Path.home() / ".local/state/m0clip-access"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    logfile = logs / "console-sharing.log"
    fd = os.open(logfile, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    os.close(fd)
    args = [
        "/usr/bin/x11vnc", "-norc", "-display", display, "-auth", auth,
        "-inetd", "-q", "-nopw", "-once", "-shared", "-repeat",
        "-noremote", "-novncconnect", "-nocmds", "-noxdamage", "-nowireframe",
        "-desktop", f"m0clip existing desktop {display}",
        "-o", str(logfile),
    ]
    # inetd expects one duplex socket, while SSH exposes separate stdin/stdout.
    # Keep the socket private to these processes; do not create a network listener.
    channel, child = socket.socketpair()
    process = subprocess.Popen(args, stdin=child, stdout=child, stderr=subprocess.DEVNULL)
    child.close()

    def stop(_signal=None, _frame=None):
        if process.poll() is None:
            process.terminate()

    def input_to_socket():
        try:
            while True:
                data = os.read(0, 65536)
                if not data:
                    break
                channel.sendall(data)
        except OSError:
            pass
        finally:
            try:
                channel.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=input_to_socket, daemon=True).start()
    try:
        while True:
            data = channel.recv(65536)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except (OSError, BrokenPipeError):
        pass
    finally:
        channel.close()
        stop()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Existing desktop unavailable: {error}", file=sys.stderr)
        sys.exit(1)
