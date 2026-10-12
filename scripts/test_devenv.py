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


class TargetTests(unittest.TestCase):
    def test_local_target_refuses_databases_marked_otherwise(self):
        devenv.check_target(None, "local")
        devenv.check_target("local", "local")
        for marker in ("staging", "production"):
            with self.assertRaises(SystemExit, msg=marker) as ctx:
                devenv.check_target(marker, "local")
            self.assertIn(f"--target {marker}", str(ctx.exception))

    def test_staging_target_requires_the_staging_marker(self):
        devenv.check_target("staging", "staging")
        for marker in (None, "local", "production"):
            with self.assertRaises(SystemExit, msg=str(marker)):
                devenv.check_target(marker, "staging")

    def test_database_environment_reads_the_marker(self):
        class Cursor:
            def __init__(self, results):
                self.results = results

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql):
                pass

            def fetchone(self):
                return self.results.pop(0)

        class Conn:
            def __init__(self, *results):
                self.results = list(results)

            def cursor(self):
                return Cursor(self.results)

        self.assertIsNone(devenv.database_environment(Conn((False,))), "no table yet")
        self.assertIsNone(devenv.database_environment(Conn((True,), None)), "table without row")
        self.assertEqual(devenv.database_environment(Conn((True,), ("staging",))), "staging")


class ConfirmTests(unittest.TestCase):
    def test_yes_skips_the_question(self):
        with mock.patch("builtins.input", side_effect=AssertionError("asked")):
            devenv.confirm("Import?", yes=True)

    def test_without_a_terminal_it_refuses(self):
        with mock.patch.object(sys.stdin, "isatty", return_value=False), self.assertRaises(SystemExit):
            devenv.confirm("Import?", yes=False)

    def test_end_of_input_refuses(self):
        with mock.patch.object(sys.stdin, "isatty", return_value=True), \
                mock.patch("builtins.input", side_effect=EOFError), self.assertRaises(SystemExit):
            devenv.confirm("Import?", yes=False)

    def test_only_the_word_staging_continues(self):
        with mock.patch.object(sys.stdin, "isatty", return_value=True):
            with mock.patch("builtins.input", return_value=" staging "):
                devenv.confirm("Import?", yes=False)
            for answer in ("y", "yes", "Staging", ""):
                with mock.patch("builtins.input", return_value=answer), self.assertRaises(SystemExit, msg=answer):
                    devenv.confirm("Import?", yes=False)


if __name__ == "__main__":
    unittest.main()
