#!/usr/bin/env python3
"""Manually publish the staged m0clip.com redirect to gadmaj.org/mowat."""
import argparse
import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import urllib.request

HOME = Path.home()
REPOSITORY = HOME / ".local/share/unitree-dev/website-publisher.git"
REMOTE = "git@github.com:gadmaj/website.git"
BRANCH = "exp"
CANONICAL_ORIGIN = "https://m0clip.com"
STAGED_DIRECTORY = Path(__file__).resolve().parent / "mowat"
PUBLISHED_PATHS = ("mowat/index.html", "mowat/current.json")


def command(args, *, env=None, data=None, check=True):
    result = subprocess.run(
        args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, timeout=30,
    )
    if check and result.returncode:
        detail = result.stderr.decode(errors="replace").strip()
        raise RuntimeError(f"{args[0]} failed: {detail[:1200]}")
    return result


def healthy_canonical_origin():
    def get(url):
        request = urllib.request.Request(url, headers={"User-Agent": "m0clip-redirect-publisher/1"})
        with urllib.request.urlopen(request, timeout=12) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            if response.status != 200 or len(body) > 2 * 1024 * 1024:
                raise RuntimeError("Unexpected app response.")
            if response.headers.get_content_type() != "text/html":
                raise RuntimeError("The app did not return HTML.")
            if response.geturl() != url:
                raise RuntimeError("The app redirected instead of serving the requested origin.")
            return body
    expected = get("http://127.0.0.1:4173/")
    actual = get(CANONICAL_ORIGIN + "/")
    if hashlib.sha256(expected).digest() != hashlib.sha256(actual).digest():
        raise RuntimeError("m0clip.com is not serving the current local app page.")


def git_environment():
    env = dict(os.environ)
    env.update(
        GIT_TERMINAL_PROMPT="0",
        GIT_AUTHOR_NAME="MoWAT hosting",
        GIT_COMMITTER_NAME="MoWAT hosting",
        GIT_AUTHOR_EMAIL="gadmaj@users.noreply.github.com",
        GIT_COMMITTER_EMAIL="gadmaj@users.noreply.github.com",
        GIT_SSH_COMMAND=shlex.join([
            "/usr/bin/ssh", "-i", str(HOME / ".ssh/id_ed25519_unitree_website"),
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={HOME / '.ssh/unitree-github-known_hosts'}",
            "-o", "ConnectTimeout=10",
        ]),
    )
    return env


def staged_files():
    return {path: (STAGED_DIRECTORY / Path(path).name).read_bytes() for path in PUBLISHED_PATHS}


def publish_redirect(repository, remote, branch, files):
    """Replace only the two mowat files, preserving the latest remote tree."""
    if set(files) != set(PUBLISHED_PATHS):
        raise ValueError("Publication must contain exactly the two mowat redirect files.")
    env = git_environment()
    repository.parent.mkdir(parents=True, exist_ok=True)
    if not repository.exists():
        command(["git", "init", "--bare", str(repository)], env=env)

    def git(*args, data=None, check=True, extra_env=None):
        return command(
            ["git", "--git-dir", str(repository), *args],
            data=data, check=check, env=(env | (extra_env or {})),
        )

    for attempt in range(3):
        git("fetch", "--depth=1", remote, f"refs/heads/{branch}")
        parent = git("rev-parse", "FETCH_HEAD").stdout.decode().strip()
        git("cat-file", "-e", f"{parent}:mowat/index.html")
        with tempfile.TemporaryDirectory(prefix="mowat-publish-") as temp:
            index_env = {"GIT_INDEX_FILE": str(Path(temp) / "index")}
            git("read-tree", parent, extra_env=index_env)
            for path in PUBLISHED_PATHS:
                blob = git("hash-object", "-w", "--stdin", data=files[path]).stdout.decode().strip()
                git("update-index", "--add", "--cacheinfo",
                    f"100644,{blob},{path}", extra_env=index_env)
            tree = git("write-tree", extra_env=index_env).stdout.decode().strip()
        previous_tree = git("rev-parse", f"{parent}^{{tree}}").stdout.decode().strip()
        if tree == previous_tree:
            return parent, False
        commit = git(
            "commit-tree", tree, "-p", parent,
            data=b"Point MoWAT entry at canonical m0clip.com\n",
        ).stdout.decode().strip()
        pushed = git("push", remote, f"{commit}:refs/heads/{branch}", check=False)
        if pushed.returncode == 0:
            return commit, True
        if attempt == 2:
            detail = pushed.stderr.decode(errors="replace")[:1200]
            raise RuntimeError(f"Could not publish after three attempts: {detail}")
    raise RuntimeError("Publishing did not complete.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--publish", action="store_true", help="Check m0clip.com, then push only the two staged mowat files.")
    mode.add_argument("--dry-run", action="store_true", help="List staged files without network requests or publication (default).")
    args = parser.parse_args()
    os.umask(0o077)
    files = staged_files()
    if not args.publish:
        for path, content in files.items():
            print(f"{path}: {len(content)} bytes, sha256 {hashlib.sha256(content).hexdigest()}")
        print("No publication. Use --publish only after the canonical domain is healthy.")
        return
    healthy_canonical_origin()
    commit, changed = publish_redirect(REPOSITORY, REMOTE, BRANCH, files)
    print(f"m0clip redirect {'published' if changed else 'already current'}: {CANONICAL_ORIGIN}/ ({commit})")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"m0clip redirect not published: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
