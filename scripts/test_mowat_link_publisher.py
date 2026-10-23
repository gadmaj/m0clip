#!/usr/bin/env python3
"""Exercise the manual publisher against temporary Git repositories without network access."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).resolve().parents[1] / "deploy/development/publish-mowat-link.py"
spec = importlib.util.spec_from_file_location("publisher", source)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
env = publisher.git_environment()


def run(*args):
    return subprocess.check_output(args, env=env, stderr=subprocess.PIPE).decode().strip()


with tempfile.TemporaryDirectory(prefix="test-mowat-link-") as temp:
    root = Path(temp)
    origin, seed, cache = root / "origin.git", root / "seed", root / "publisher.git"
    run("git", "init", "--bare", str(origin))
    run("git", "init", "-b", "exp", str(seed))
    (seed / "mowat").mkdir()
    (seed / "index.html").write_text("The existing homepage")
    (seed / "mowat/index.html").write_text("The previous entry point")
    (seed / "mowat/current.json").write_text(json.dumps({"url": "https://previous.example/"}))
    run("git", "-C", str(seed), "add", ".")
    run("git", "-C", str(seed), "commit", "-m", "Seed")
    run("git", "-C", str(seed), "push", str(origin), "exp")
    # Uncommitted website work must not be read, changed or accidentally published.
    (seed / "index.html").write_text("Uncommitted homepage edit")
    files = publisher.staged_files()
    commit, changed = publisher.publish_redirect(cache, str(origin), "exp", files)
    assert changed
    names = run("git", "--git-dir", str(origin), "diff-tree", "--no-commit-id", "--name-only", "-r", commit)
    assert names.splitlines() == ["mowat/current.json", "mowat/index.html"], names
    assert run("git", "--git-dir", str(origin), "show", f"{commit}:index.html") == "The existing homepage"
    assert (seed / "index.html").read_text() == "Uncommitted homepage edit"
    for path, content in files.items():
        actual = subprocess.check_output(["git", "--git-dir", str(origin), "show", f"{commit}:{path}"], env=env)
        assert actual == content, path
    print("PASS: Only the staged redirect files change; remote and working-tree edits are preserved.")
    again, changed = publisher.publish_redirect(cache, str(origin), "exp", files)
    assert not changed and again == commit
    print("PASS: Identical staged bytes create no additional commit.")

    # Both files are compared, not just the canonical manifest URL.
    updated_files = files | {"mowat/index.html": files["mowat/index.html"] + b"\n"}
    original_command = publisher.command
    push_count = 0

    def concurrent_command(args, **kwargs):
        global push_count
        if args[:3] == ["git", "--git-dir", str(cache)] and args[3] == "push":
            push_count += 1
            if push_count == 1:
                run("git", "-C", str(seed), "fetch", str(origin), "exp")
                run("git", "-C", str(seed), "merge", "--ff-only", "FETCH_HEAD")
                (seed / "unrelated.txt").write_text("Concurrent website edit")
                run("git", "-C", str(seed), "add", "unrelated.txt")
                run("git", "-C", str(seed), "commit", "-m", "Concurrent edit")
                run("git", "-C", str(seed), "push", str(origin), "exp")
        return original_command(args, **kwargs)

    publisher.command = concurrent_command
    commit, changed = publisher.publish_redirect(cache, str(origin), "exp", updated_files)
    assert changed and push_count == 2, push_count
    assert run("git", "--git-dir", str(origin), "show", f"{commit}:unrelated.txt") == "Concurrent website edit"
    assert (seed / "index.html").read_text() == "Uncommitted homepage edit"
    print("PASS: A landing-only update retries a concurrent push without losing unrelated edits.")
    publisher.command = original_command

    for invalid_files in ({"index.html": b"not allowed"}, files | {"unrelated.txt": b"not allowed"}):
        try:
            publisher.publish_redirect(cache, str(origin), "exp", invalid_files)
        except ValueError:
            pass
        else:
            raise AssertionError("Publisher accepted paths outside the exact mowat file set")
    assert run("git", "--git-dir", str(origin), "rev-parse", "refs/heads/exp") == commit
    print("PASS: Invalid publication paths cannot alter unrelated website files.")
