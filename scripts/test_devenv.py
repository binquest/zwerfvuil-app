"""Tests for devenv.py. Run from the repo root: python -m unittest discover -s scripts"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import devenv  # noqa: E402


class ParseEnvTests(unittest.TestCase):
    def test_parses_values_comments_quotes_and_export(self):
        text = "\n".join([
            "# comment",
            "",
            "ADMIN_EMAIL=jij@voorbeeld.be",
            "export OSM_CONTACT = https://example.org  # inline comment",
            'QUOTED="a # not a comment"',
            "SINGLE='x'",
            "EMPTY=",
            "not a line",
            "1BAD=x",
        ])
        self.assertEqual(devenv.parse_env(text), {
            "ADMIN_EMAIL": "jij@voorbeeld.be",
            "OSM_CONTACT": "https://example.org",
            "QUOTED": "a # not a comment",
            "SINGLE": "x",
            "EMPTY": "",
        })


class LoadEnvFileTests(unittest.TestCase):
    def test_shell_values_win_over_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("ZW_TEST_A=from-file\nZW_TEST_B=from-file\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {"ZW_TEST_A": "from-shell"}, clear=False):
                loaded = devenv.load_env_file(path)
                self.assertEqual(os.environ["ZW_TEST_A"], "from-shell")
                self.assertEqual(os.environ["ZW_TEST_B"], "from-file")
                self.assertEqual(loaded, {"ZW_TEST_B": "from-file"})

    def test_missing_file_is_fine(self):
        self.assertEqual(devenv.load_env_file(Path(tempfile.gettempdir()) / "does-not-exist.env"), {})


class RequireLocalTests(unittest.TestCase):
    def test_only_local_hosts_unless_allowed(self):
        devenv.require_local("postgresql://u:p@127.0.0.1:54322/postgres", allow_remote=False)
        devenv.require_local("http://localhost:54321", allow_remote=False)
        devenv.require_local("postgresql://u:p@db.example.com/postgres", allow_remote=True)
        with self.assertRaises(SystemExit):
            devenv.require_local("postgresql://u:p@db.example.com/postgres", allow_remote=False)
        with self.assertRaises(SystemExit):
            devenv.require_local("http://100.64.0.1:54321", allow_remote=False)

    def test_database_url_defaults_to_the_local_stack(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(devenv.database_url(), devenv.DEFAULT_DATABASE_URL)


if __name__ == "__main__":
    unittest.main()
