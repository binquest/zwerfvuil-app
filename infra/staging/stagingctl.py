#!/usr/bin/env python3
"""Run the scripts in infra/staging/vm/ on the staging VM over SSH.

Usage (from the repo root):
    python infra/staging/stagingctl.py run vm/10-base.sh [args...]
    python infra/staging/stagingctl.py status
    python infra/staging/stagingctl.py tunnel

`tunnel` forwards Studio (with the API gateway) and Postgres of the VM to
localhost on this PC until Ctrl+C; they are not reachable any other way.

`run` packs infra/staging/ (without .env and Python files) into a tar
archive, unpacks it in a temporary directory on the VM and runs the script
there with sudo. Variables from infra/staging/.env (see .env.example) are
passed to the script as environment variables. Nothing is left on the VM.

The SSH host is STAGING_SSH_HOST (default: the alias binquest-staging from
~/.ssh/config). SSH runs with BatchMode, so it never asks for input.
"""

from __future__ import annotations

import argparse
import io
import os
import re
import shlex
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "scripts"))
import devenv  # noqa: E402

ENV_FILE = HERE / ".env"
DEFAULT_SSH_HOST = "binquest-staging"
# Packed for the VM; everything else in infra/staging stays on the PC.
PACKED_DIRS = ("vm", "files")
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
# (local port on the PC, port on the VM's 127.0.0.1, what it is). The local
# ports differ from the local Supabase stack (5432x) so they cannot be mixed up.
TUNNELS = (
    (58000, 8000, "Studio: http://localhost:58000 (user binquest), API gateway on the same port"),
    (55432, 5432, "Postgres: postgresql://postgres:<password>@localhost:55432/postgres"),
)


def load_config(path: Path = ENV_FILE) -> dict[str, str]:
    if not path.exists():
        return {}
    return devenv.parse_env(path.read_text(encoding="utf-8"))


def ssh_host(config: dict[str, str]) -> str:
    return os.environ.get("STAGING_SSH_HOST") or config.get("STAGING_SSH_HOST") or DEFAULT_SSH_HOST


def pack(root: Path = HERE) -> bytes:
    """A gzipped tar of vm/ and files/, with LF line endings and fixed modes."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for top in PACKED_DIRS:
            for path in sorted((root / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                data = path.read_bytes().replace(b"\r\n", b"\n")
                info = tarfile.TarInfo(path.relative_to(root).as_posix())
                info.size = len(data)
                info.mode = 0o755 if path.suffix == ".sh" else 0o644
                tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def remote_command(script: str, args: list[str], env: dict[str, str]) -> str:
    """The shell command run on the VM: unpack stdin, run the script as root, clean up."""
    if not re.fullmatch(r"vm/[A-Za-z0-9_.-]+\.sh", script):
        raise ValueError(f"not a script in vm/: {script!r}")
    assignments = []
    for name, value in sorted(env.items()):
        if not ENV_NAME.fullmatch(name):
            raise ValueError(f"invalid variable name {name!r}")
        assignments.append(f"{name}={shlex.quote(value)}")
    # BQ_SSH_FROM lets scripts check that a change does not lock out this session.
    assignments.append('BQ_SSH_FROM="${SSH_CLIENT%% *}"')
    run = " ".join(["sudo", "-n", "env", *assignments, "bash", f'"$d/{script}"', *map(shlex.quote, args)])
    return f'd=$(mktemp -d) && tar -xzf - -C "$d" && {run}; rc=$?; rm -rf "$d"; exit $rc'


def tunnel_command(host: str) -> list[str]:
    forwards = []
    for local, remote, _ in TUNNELS:
        forwards += ["-L", f"127.0.0.1:{local}:127.0.0.1:{remote}"]
    return ["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-N", *forwards, host]


def open_tunnel() -> int:
    for _, _, description in TUNNELS:
        print(description)
    print("Passwords: see docs/STAGING.md. Stop with Ctrl+C.", flush=True)
    try:
        return subprocess.run(tunnel_command(ssh_host(load_config())), check=False).returncode
    except KeyboardInterrupt:
        return 0


def run_script(script: str, args: list[str]) -> int:
    config = load_config()
    if not (HERE / script).is_file():
        sys.exit(f"{script} does not exist in {HERE}")
    env = {k: v for k, v in config.items() if k != "STAGING_SSH_HOST"}
    command = ["ssh", "-o", "BatchMode=yes", "-T", ssh_host(config), remote_command(script, args, env)]
    return subprocess.run(command, input=pack(), check=False).returncode


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a script from infra/staging/vm on the VM")
    run.add_argument("script", help="path relative to infra/staging, e.g. vm/10-base.sh")
    run.add_argument("args", nargs=argparse.REMAINDER, help="arguments for the script")
    sub.add_parser("status", help="run vm/status.sh")
    sub.add_parser("tunnel", help="forward Studio and Postgres to localhost until Ctrl+C")
    args = parser.parse_args(argv)

    if args.command == "status":
        sys.exit(run_script("vm/status.sh", []))
    if args.command == "tunnel":
        sys.exit(open_tunnel())
    sys.exit(run_script(args.script.replace("\\", "/"), args.args))


if __name__ == "__main__":
    main()
