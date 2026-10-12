#!/usr/bin/env python3
"""Make an account admin in the local Supabase, creating the account if needed.

Usage (from anywhere, paths are resolved from the repo root):
    python scripts/seed-admin/seed_admin.py --email jij@voorbeeld.be
    python scripts/seed-admin/seed_admin.py                  # uses ADMIN_EMAIL
    python scripts/seed-admin/seed_admin.py --revoke --email jij@voorbeeld.be

The email address comes from --email, else from ADMIN_EMAIL (shell or the
gitignored repo-root .env). It is never written to a file and is masked in
the output. A missing account is created through the Auth admin API
(confirmed, without password); sign in with the 6-digit email code after.
Running it again is safe. Only local databases unless --allow-remote.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import devenv  # noqa: E402

EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
DEFAULT_API_URL = "http://127.0.0.1:54321"


class SeedError(Exception):
    """A problem the user can fix (shown without a traceback)."""


@dataclass(frozen=True)
class SeedResult:
    user_id: str
    created_account: bool
    is_admin: bool
    changed: bool


def resolve_email(cli_value: str | None) -> str:
    """--email wins over ADMIN_EMAIL; the address is normalised to lower case."""
    email = (cli_value or os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    if not email:
        raise SeedError("no email address: pass --email or set ADMIN_EMAIL (shell or the repo-root .env)")
    if not EMAIL.fullmatch(email):
        raise SeedError(f"not a valid email address: {mask_email(email)}")
    return email


def mask_email(email: str) -> str:
    """jij@voorbeeld.be -> ji*@voorbeeld.be (keeps the domain, hides the name)."""
    local, sep, domain = email.partition("@")
    if not sep:
        return "*" * len(email)
    keep = local[:2] if len(local) > 2 else local[:1]
    return f"{keep}{'*' * max(1, len(local) - len(keep))}@{domain}"


def find_user(conn, email: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute("select id from auth.users where lower(email) = %s", (email,))
        row = cur.fetchone()
    return str(row[0]) if row else None


def auth_admin_config() -> tuple[str, str]:
    """API URL and service role key: from the environment, else from `supabase status`."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if url and key:
        return url.rstrip("/"), key
    cli = devenv.ROOT / "node_modules" / "supabase" / "dist" / "supabase.js"
    try:
        out = subprocess.run(
            ["node", str(cli), "status", "-o", "json"],
            cwd=devenv.ROOT, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
        ).stdout
        status = json.loads(out[out.index("{"): out.rindex("}") + 1])
        return (url or status["API_URL"]).rstrip("/"), key or status["SERVICE_ROLE_KEY"]
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        raise SeedError(f"cannot read the service role key from `supabase status` ({error}); is Supabase running?")


def create_user(api_url: str, service_key: str, email: str) -> str:
    """Creates a confirmed account without password via the Auth admin API."""
    devenv.require_local(api_url, allow_remote=False)
    request = urllib.request.Request(
        f"{api_url}/auth/v1/admin/users",
        data=json.dumps({"email": email, "email_confirm": True}).encode(),
        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)["id"]
    except urllib.error.HTTPError as error:
        raise SeedError(f"creating the account failed: HTTP {error.code} {error.read()[:200]!r}")
    except urllib.error.URLError as error:
        raise SeedError(f"cannot reach the Auth API at {api_url} ({error.reason}); is Supabase running?")


def set_admin(conn, user_id: str, is_admin: bool) -> bool:
    """Sets profiles.is_admin; returns whether it changed. Creates the profile if missing."""
    with conn.cursor() as cur:
        cur.execute("select is_admin from public.profiles where id = %s for update", (user_id,))
        row = cur.fetchone()
        if row is None:
            cur.execute("insert into public.profiles (id, is_admin) values (%s, %s)", (user_id, is_admin))
            return True
        if row[0] == is_admin:
            return False
        cur.execute("update public.profiles set is_admin = %s where id = %s", (is_admin, user_id))
        return True


def seed_admin(email: str, *, revoke: bool = False, create: bool = True, database_url: str) -> SeedResult:
    import psycopg  # imported lazily so the pure helpers can be tested without it

    with psycopg.connect(database_url) as conn:
        user_id = find_user(conn, email)
    created = False
    if user_id is None:
        if revoke:
            raise SeedError(f"no account for {mask_email(email)}, nothing to revoke")
        if not create:
            raise SeedError(f"no account for {mask_email(email)}; sign in once in the app or drop --no-create")
        api_url, key = auth_admin_config()
        user_id = create_user(api_url, key, email)
        created = True
    with psycopg.connect(database_url) as conn:
        changed = set_admin(conn, user_id, not revoke)
    return SeedResult(user_id=user_id, created_account=created, is_admin=not revoke, changed=changed)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--email", help="account to change (default: ADMIN_EMAIL)")
    parser.add_argument("--revoke", action="store_true", help="remove admin rights instead of granting them")
    parser.add_argument("--no-create", action="store_true", help="fail instead of creating a missing account")
    parser.add_argument("--allow-remote", action="store_true", help="allow a non-local DATABASE_URL")
    args = parser.parse_args(argv)

    devenv.load_env_file()
    url = devenv.database_url()
    devenv.require_local(url, args.allow_remote)
    try:
        email = resolve_email(args.email)
        result = seed_admin(email, revoke=args.revoke, create=not args.no_create, database_url=url)
    except SeedError as error:
        sys.exit(f"Seed admin: {error}")

    who = mask_email(email)
    if result.created_account:
        print(f"Seed admin: created account {who}")
    state = "admin" if result.is_admin else "not admin"
    print(f"Seed admin: {who} is {state}{'' if result.changed else ' (unchanged)'}")
    if result.created_account:
        print("Sign in in the app with this address; the 6-digit code arrives in Mailpit (http://127.0.0.1:54324).")


if __name__ == "__main__":
    main()
