#!/usr/bin/env python3
"""Manage the staging VM (binquest-staging) over SSH from this PC.

Usage (from the repo root):
    python infra/staging/stagingctl.py run vm/10-base.sh [args...]
    python infra/staging/stagingctl.py status
    python infra/staging/stagingctl.py tunnel
    python infra/staging/stagingctl.py deploy
    python infra/staging/stagingctl.py migrate [--apply]
    python infra/staging/stagingctl.py studio-login [--clear-after SECONDS]

`studio-login` shows the Studio user name and copies the dashboard password
to the Windows clipboard (Set-Clipboard). The password is never printed and
never passed as a command-line argument; the clipboard is cleared again after
60 seconds if it still holds the password.

`run` packs infra/staging/vm and infra/staging/files into a tar archive,
unpacks it in a temporary directory on the VM and runs the script there with
sudo. Variables from infra/staging/.env (see .env.example) are passed to the
script as environment variables. Nothing is left on the VM.

`tunnel` forwards Studio (with the API gateway), Postgres and Mailpit of the
VM to localhost on this PC until Ctrl+C; they are not reachable any other way.

`deploy` ships the edge functions and the email templates from supabase/ and
installs them with vm/80-deploy.sh.

`migrate` pushes supabase/migrations to the staging database through an SSH
tunnel (`supabase db push`). Without --apply it only shows what would be
pushed. After applying it marks the database as 'staging'.

Secrets are read from the VM when needed (`sudo bq-secret NAME`), kept in
memory and never printed. The SSH host is STAGING_SSH_HOST (default: the alias
binquest-staging from ~/.ssh/config). SSH runs with BatchMode, so it never
asks for input.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import os
import re
import shlex
import socket
import subprocess
import sys
import tarfile
import time
from collections.abc import Iterator
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import devenv  # noqa: E402

ENV_FILE = HERE / ".env"
DEFAULT_SSH_HOST = "binquest-staging"
# Packed for the VM; everything else in infra/staging stays on the PC.
PACKED_DIRS = ("vm", "files")
# What `deploy` ships, as archive path -> source directory.
DEPLOY_SOURCES = {
    "deploy/functions/submit-checkin": ROOT / "supabase" / "functions" / "submit-checkin",
    "deploy/functions/_shared": ROOT / "supabase" / "functions" / "_shared",
    "deploy/templates": ROOT / "supabase" / "templates",
}
SUPABASE_CLI = ROOT / "node_modules" / "supabase" / "dist" / "supabase.js"
SETTINGS_ENV = HERE / "files" / "opt" / "binquest" / "compose" / "settings.env"
POWERSHELL = ["powershell.exe", "-NoProfile", "-NonInteractive"]
# Reads one line from stdin and puts it on the clipboard: the value never
# appears in a command line.
SET_CLIPBOARD = "$v = [Console]::In.ReadLine(); Set-Clipboard -Value $v"
# Clears the clipboard after a delay, only if it still holds the value whose
# SHA-256 is given (so the background process never sees the value itself).
CLEAR_CLIPBOARD = (
    "Start-Sleep -Seconds {seconds}; $c = Get-Clipboard -Raw; if ($c) {{ "
    "$h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash("
    "[Text.Encoding]::UTF8.GetBytes($c))).Replace('-', '').ToLower(); "
    "if ($h -eq '{digest}') {{ Add-Type -AssemblyName System.Windows.Forms; "
    "[System.Windows.Forms.Clipboard]::Clear() }} }}"
)
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
# (local port on the PC, port on the VM's 127.0.0.1, what it is). The local
# ports differ from the local Supabase stack (5432x) so they cannot be mixed up.
TUNNELS = (
    (58000, 8000, "Studio: http://localhost:58000 (user binquest), API gateway on the same port"),
    (55432, 5432, "Postgres: postgresql://postgres:<password>@localhost:55432/postgres"),
    (58025, 8025, "Mailpit (login codes): http://localhost:58025"),
)


def load_config(path: Path = ENV_FILE) -> dict[str, str]:
    if not path.exists():
        return {}
    return devenv.parse_env(path.read_text(encoding="utf-8"))


def ssh_host(config: dict[str, str] | None = None) -> str:
    config = load_config() if config is None else config
    return os.environ.get("STAGING_SSH_HOST") or config.get("STAGING_SSH_HOST") or DEFAULT_SSH_HOST


def pack(root: Path = HERE, extra: dict[str, Path] | None = None) -> bytes:
    """A gzipped tar of vm/ and files/ (plus `extra` dirs), with LF line endings and fixed modes."""
    sources = [(top, root / top) for top in PACKED_DIRS] + list((extra or {}).items())
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for prefix, source in sources:
            for path in sorted(source.rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                data = path.read_bytes().replace(b"\r\n", b"\n")
                info = tarfile.TarInfo(f"{prefix}/{path.relative_to(source).as_posix()}")
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


def run_script(script: str, args: list[str], extra: dict[str, Path] | None = None) -> int:
    config = load_config()
    if not (HERE / script).is_file():
        sys.exit(f"{script} does not exist in {HERE}")
    env = {k: v for k, v in config.items() if k != "STAGING_SSH_HOST"}
    command = ["ssh", "-o", "BatchMode=yes", "-T", ssh_host(config), remote_command(script, args, env)]
    return subprocess.run(command, input=pack(extra=extra), check=False).returncode


def read_secret(name: str) -> str:
    """One secret from the VM, kept in memory only."""
    if not ENV_NAME.fullmatch(name):
        raise ValueError(f"invalid secret name {name!r}")
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-T", ssh_host(), f"sudo -n bq-secret {name}"],
        capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL, check=False,
    )
    value = result.stdout.strip()
    if result.returncode != 0 or not value:
        sys.exit(f"Cannot read {name} from the VM: {result.stderr.strip() or 'empty'}")
    return value


def tunnel_command(host: str, forwards: list[tuple[int, int]]) -> list[str]:
    args = []
    for local, remote in forwards:
        args += ["-L", f"127.0.0.1:{local}:127.0.0.1:{remote}"]
    return ["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-N", *args, host]


def open_tunnel() -> int:
    for _, _, description in TUNNELS:
        print(description)
    print("Passwords: see docs/STAGING.md. Stop with Ctrl+C.", flush=True)
    try:
        command = tunnel_command(ssh_host(), [(local, remote) for local, remote, _ in TUNNELS])
        return subprocess.run(command, check=False).returncode
    except KeyboardInterrupt:
        return 0


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


@contextlib.contextmanager
def background_tunnel(remote_ports: list[int], timeout: float = 30) -> Iterator[dict[int, int]]:
    """Forwards the VM's 127.0.0.1:<port> to free local ports while the block runs.

    Yields {remote port: local port}. Only the ssh process started here is
    stopped afterwards.
    """
    ports = {remote: free_port() for remote in remote_ports}
    process = subprocess.Popen(
        tunnel_command(ssh_host(), [(local, remote) for remote, local in ports.items()]),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + timeout
        while not all(_port_open(local) for local in ports.values()):
            if process.poll() is not None:
                sys.exit(f"SSH tunnel failed: {process.stderr.read().decode(errors='replace').strip()}")
            if time.monotonic() > deadline:
                sys.exit("SSH tunnel did not come up")
            time.sleep(0.2)
        yield ports
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


def deploy() -> int:
    for archive_path, source in DEPLOY_SOURCES.items():
        if not source.is_dir():
            sys.exit(f"{source} is missing ({archive_path})")
    return run_script("vm/80-deploy.sh", [], extra=DEPLOY_SOURCES)


def supabase_cli(args: list[str], env: dict[str, str]) -> int:
    command = ["node", str(SUPABASE_CLI), *args]
    return subprocess.run(command, cwd=ROOT, env={**os.environ, "CI": "1", **env}, check=False).returncode


def migrate(apply: bool) -> int:
    import psycopg  # only needed here; part of scripts/requirements.txt

    with background_tunnel([5432]) as ports:
        password = read_secret("POSTGRES_PASSWORD")
        port = ports[5432]
        with psycopg.connect(host="127.0.0.1", port=port, dbname="postgres", user="postgres",
                             password=password, connect_timeout=10) as conn:
            environment = devenv.database_environment(conn)
        if environment not in (None, "staging"):
            sys.exit(f"Refusing: the database behind the tunnel says it is {environment!r}, not 'staging'")

        # Plain connection inside the SSH tunnel (the tunnel encrypts it); the
        # self-hosted Postgres does not offer TLS.
        db_url = f"postgresql://postgres@127.0.0.1:{port}/postgres?sslmode=disable"
        cli_env = {"PGPASSWORD": password}
        print(f"Staging database (environment: {environment or 'not marked yet'}), "
              "migrations in supabase/migrations:", flush=True)
        rc = supabase_cli(["db", "push", "--db-url", db_url, "--dry-run"], cli_env)
        if rc or not apply:
            if not apply and not rc:
                print("Dry run only. Apply with: python infra/staging/stagingctl.py migrate --apply", flush=True)
            return rc
        rc = supabase_cli(["db", "push", "--db-url", db_url, "--yes"], cli_env)
        if rc:
            return rc
        with psycopg.connect(host="127.0.0.1", port=port, dbname="postgres", user="postgres",
                             password=password, connect_timeout=10) as conn:
            conn.execute(
                "insert into private.app_environment (name) values ('staging') "
                "on conflict (singleton) do update set name = excluded.name, updated_at = now()"
            )
            conn.commit()
            print(f"Database marked as: {devenv.database_environment(conn)}", flush=True)
        return supabase_cli(["migration", "list", "--db-url", db_url], cli_env)


def copy_to_clipboard(value: str, clear_after: int) -> None:
    """Puts `value` on the Windows clipboard via stdin; optionally clears it later."""
    if sys.platform != "win32":
        sys.exit("studio-login copies to the Windows clipboard (Set-Clipboard); run it in Windows PowerShell")
    result = subprocess.run([*POWERSHELL, "-Command", SET_CLIPBOARD], input=value + "\n",
                            capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.exit(f"Set-Clipboard failed: {result.stderr.strip()}")
    if clear_after > 0:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
        script = CLEAR_CLIPBOARD.format(seconds=int(clear_after), digest=digest)
        # Its own hidden console, so it outlives this terminal and ignores its
        # Ctrl+C. (With DETACHED_PROCESS, PowerShell cannot read the clipboard.)
        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        subprocess.Popen([*POWERSHELL, "-Command", script], creationflags=flags,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def studio_login(clear_after: int) -> int:
    user = devenv.parse_env(SETTINGS_ENV.read_text(encoding="utf-8")).get("DASHBOARD_USERNAME")
    if not user:
        sys.exit(f"DASHBOARD_USERNAME missing in {SETTINGS_ENV}")
    copy_to_clipboard(read_secret("DASHBOARD_PASSWORD"), clear_after)
    print("Studio:   http://localhost:58000 (needs the tunnel: python infra/staging/stagingctl.py tunnel)")
    print(f"User:     {user}")
    cleared = f"; cleared again after {clear_after} s" if clear_after > 0 else ""
    print(f"Password: copied to the clipboard (paste it with Ctrl+V){cleared}")
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a script from infra/staging/vm on the VM")
    run.add_argument("script", help="path relative to infra/staging, e.g. vm/10-base.sh")
    run.add_argument("args", nargs=argparse.REMAINDER, help="arguments for the script")
    sub.add_parser("status", help="run vm/status.sh")
    sub.add_parser("tunnel", help="forward Studio, Postgres and Mailpit to localhost until Ctrl+C")
    sub.add_parser("deploy", help="install the edge functions and email templates on the VM")
    mig = sub.add_parser("migrate", help="push supabase/migrations to staging (dry run unless --apply)")
    mig.add_argument("--apply", action="store_true", help="really push the migrations")
    login = sub.add_parser("studio-login", help="show the Studio user, copy the password to the clipboard")
    login.add_argument("--clear-after", type=int, default=60, metavar="SECONDS",
                       help="clear the clipboard after this many seconds if it still holds the password "
                            "(0: never; default 60)")
    args = parser.parse_args(argv)

    if args.command == "status":
        sys.exit(run_script("vm/status.sh", []))
    if args.command == "tunnel":
        sys.exit(open_tunnel())
    if args.command == "deploy":
        sys.exit(deploy())
    if args.command == "migrate":
        sys.exit(migrate(args.apply))
    if args.command == "studio-login":
        sys.exit(studio_login(args.clear_after))
    sys.exit(run_script(args.script.replace("\\", "/"), args.args))


if __name__ == "__main__":
    main()
