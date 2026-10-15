"""Shared helpers for the scripts: the repo-root .env file, the local-only
guard and the --target option (local or staging).

The scripts import this with `sys.path.insert(0, <scripts dir>)`, so they keep
working as plain files (`python scripts/<dir>/<script>.py`) on Windows and WSL.

Every database says which environment it is in private.app_environment (see
the environment_guard migration). A host check alone is not enough: staging is
reached through an SSH tunnel on 127.0.0.1. So the scripts also check that
marker: the default target (local) refuses a database marked 'staging' or
'production', and --target staging requires the marker 'staging'.
"""

from __future__ import annotations

import contextlib
import os
import re
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlparse

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def parse_env(text: str) -> dict[str, str]:
    """Parses KEY=VALUE lines: comments, blank lines, `export`, quotes. No expansion."""
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not _KEY.fullmatch(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            comment = value.find(" #")
            if comment >= 0:
                value = value[:comment].rstrip()
        values[key] = value
    return values


def load_env_file(path: Path = ENV_FILE) -> dict[str, str]:
    """Copies variables from `path` into os.environ unless already set; returns what was loaded."""
    if not path.exists():
        return {}
    loaded = {}
    for key, value in parse_env(path.read_text(encoding="utf-8")).items():
        if key not in os.environ:
            os.environ[key] = value
            loaded[key] = value
    return loaded


def database_url() -> str:
    return os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL


def require_local(url: str, allow_remote: bool) -> None:
    """Exits unless `url` points at this machine (or allow_remote is set)."""
    host = urlparse(url).hostname or ""
    if host not in LOCAL_HOSTS and not allow_remote:
        sys.exit(f"Refusing to use non-local host {host!r}; pass --allow-remote to override")


TARGETS = ("local", "staging")


def add_target_argument(parser) -> None:
    parser.add_argument(
        "--target", choices=TARGETS, default="local",
        help="local (default: DATABASE_URL) or staging (the homeserver VM through an SSH tunnel, "
             "after confirmation)",
    )
    parser.add_argument("--yes", action="store_true", help="with --target staging: do not ask for confirmation")


def database_environment(conn) -> str | None:
    """The marker in private.app_environment, or None when there is none (yet)."""
    with conn.cursor() as cur:
        cur.execute("select to_regclass('private.app_environment') is not null")
        if not cur.fetchone()[0]:
            return None
        cur.execute("select name from private.app_environment")
        row = cur.fetchone()
    return row[0] if row else None


def check_target(environment: str | None, target: str) -> None:
    """Exits unless the database's environment marker fits the target."""
    if target == "staging":
        if environment != "staging":
            sys.exit(f"Refusing: --target staging, but the database says {environment or 'nothing'!r}")
    elif environment not in (None, "local"):
        sys.exit(f"Refusing: this database says it is {environment!r}; pass --target {environment} on purpose")


def confirm(question: str, *, yes: bool) -> None:
    """Asks to type 'staging' before changing staging; --yes skips it, no TTY refuses."""
    if yes:
        return
    if not sys.stdin.isatty():
        sys.exit("Refusing to change staging without confirmation: run it in a terminal or pass --yes")
    try:
        answer = input(f"{question} Type 'staging' to continue: ")
    except EOFError:  # e.g. stdin redirected from NUL, which Windows reports as a terminal
        sys.exit("\nRefusing to change staging without confirmation: no input")
    if answer.strip() != "staging":
        sys.exit("Cancelled")


@dataclass(frozen=True)
class StagingEndpoints:
    database_url: str
    api_url: str | None = None
    service_key: str | None = None


@contextlib.contextmanager
def staging_endpoints(*, with_api: bool = False) -> Iterator[StagingEndpoints]:
    """Tunnels to the staging VM, with the secrets read over SSH (never printed)."""
    sys.path.insert(0, str(ROOT / "infra" / "staging"))
    import stagingctl  # noqa: PLC0415 (only needed for --target staging)

    remote = [5432, 8000] if with_api else [5432]
    with stagingctl.background_tunnel(remote) as ports:
        password = quote(stagingctl.read_secret("POSTGRES_PASSWORD"), safe="")
        yield StagingEndpoints(
            database_url=f"postgresql://postgres:{password}@127.0.0.1:{ports[5432]}/postgres",
            api_url=f"http://127.0.0.1:{ports[8000]}" if with_api else None,
            service_key=stagingctl.read_secret("SERVICE_ROLE_KEY") if with_api else None,
        )
