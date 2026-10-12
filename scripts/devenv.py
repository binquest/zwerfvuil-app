"""Shared helpers for the scripts: the repo-root .env file and the local-only guard.

The scripts import this with `sys.path.insert(0, <scripts dir>)`, so they keep
working as plain files (`python scripts/<dir>/<script>.py`) on Windows and WSL.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

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
