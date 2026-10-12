"""Tests for seed_admin.py.

Run from the repo root: python -m unittest discover -s scripts/seed-admin

The integration tests need the local Supabase (npm run db:start) and are
skipped otherwise. They only use throwaway @example.test accounts and delete
them afterwards.
"""

import json
import os
import sys
import unittest
import urllib.request
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import seed_admin as sa  # noqa: E402


class EmailTests(unittest.TestCase):
    def test_flag_wins_over_env_and_is_normalised(self):
        with mock.patch.dict(os.environ, {"ADMIN_EMAIL": "env@example.test"}):
            self.assertEqual(sa.resolve_email("  Flag@Example.TEST "), "flag@example.test")
            self.assertEqual(sa.resolve_email(None), "env@example.test")

    def test_missing_or_invalid_address(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(sa.SeedError, "pass --email or set ADMIN_EMAIL"):
                sa.resolve_email(None)
            with self.assertRaisesRegex(sa.SeedError, "not a valid email"):
                sa.resolve_email("no-at-sign")

    def test_masking_hides_the_name_but_keeps_the_domain(self):
        self.assertEqual(sa.mask_email("jij@voorbeeld.be"), "ji*@voorbeeld.be")
        self.assertEqual(sa.mask_email("someone.long@example.test"), "so**********@example.test")
        self.assertEqual(sa.mask_email("a@example.test"), "a*@example.test")


def local_stack():
    try:
        import psycopg

        with psycopg.connect(sa.devenv.DEFAULT_DATABASE_URL, connect_timeout=3):
            pass
        return sa.auth_admin_config()
    except Exception:
        return None


class SeedAdminIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = local_stack()
        if cls.stack is None:
            raise unittest.SkipTest("local Supabase not running")

    def setUp(self):
        self.email = f"seed-{uuid.uuid4().hex[:10]}@example.test"
        self.addCleanup(self.delete_account)

    def delete_account(self):
        import psycopg

        with psycopg.connect(sa.devenv.DEFAULT_DATABASE_URL) as conn:
            user_id = sa.find_user(conn, self.email)
        if not user_id:
            return
        api_url, key = self.stack
        request = urllib.request.Request(
            f"{api_url}/auth/v1/admin/users/{user_id}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            method="DELETE",
        )
        urllib.request.urlopen(request, timeout=30).close()

    def is_admin(self, user_id):
        import psycopg

        with psycopg.connect(sa.devenv.DEFAULT_DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute("select is_admin from public.profiles where id = %s", (user_id,))
            return cur.fetchone()[0]

    def seed(self, **kwargs):
        return sa.seed_admin(self.email, database_url=sa.devenv.DEFAULT_DATABASE_URL, **kwargs)

    def test_creates_the_account_and_makes_it_admin_idempotently(self):
        first = self.seed()
        self.assertEqual((first.created_account, first.is_admin, first.changed), (True, True, True))
        self.assertTrue(self.is_admin(first.user_id))

        again = sa.seed_admin(sa.resolve_email(self.email.upper()), database_url=sa.devenv.DEFAULT_DATABASE_URL)
        self.assertEqual((again.user_id, again.created_account, again.changed), (first.user_id, False, False))

    def test_the_created_account_can_sign_in_with_an_email_code(self):
        result = self.seed()
        api_url, key = self.stack
        request = urllib.request.Request(
            f"{api_url}/auth/v1/admin/users/{result.user_id}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            user = json.load(response)
        self.assertEqual(user["email"], self.email)
        self.assertIsNotNone(user.get("email_confirmed_at"), "account must be confirmed for OTP sign-in")

    def test_revoke_and_no_create(self):
        with self.assertRaisesRegex(sa.SeedError, "nothing to revoke"):
            self.seed(revoke=True)
        with self.assertRaisesRegex(sa.SeedError, "sign in once in the app"):
            self.seed(create=False)

        user_id = self.seed().user_id
        revoked = self.seed(revoke=True)
        self.assertEqual((revoked.is_admin, revoked.changed), (False, True))
        self.assertFalse(self.is_admin(user_id))


if __name__ == "__main__":
    unittest.main()
