import hashlib
import io
import shlex
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import stagingctl


class RemoteCommandTest(unittest.TestCase):
    def test_quotes_values_and_arguments(self):
        command = stagingctl.remote_command("vm/30-firewall.sh", ["confirm", "a b"], {"LAN_CIDR": "10.0.0.0/8; rm -rf /"})
        self.assertIn("LAN_CIDR='10.0.0.0/8; rm -rf /'", command)
        self.assertIn("'a b'", command)
        self.assertIn('bash "$d/vm/30-firewall.sh" confirm', command)

    def test_passes_ssh_source_and_cleans_up(self):
        command = stagingctl.remote_command("vm/status.sh", [], {})
        self.assertIn('BQ_SSH_FROM="${SSH_CLIENT%% *}"', command)
        self.assertTrue(command.startswith("d=$(mktemp -d) && tar -xzf - -C \"$d\" && sudo -n env "))
        self.assertTrue(command.endswith('rm -rf "$d"; exit $rc'))

    def test_command_is_valid_posix_shell(self):
        command = stagingctl.remote_command("vm/status.sh", ["x'y"], {"A": "it's"})
        shlex.split(command)  # raises on unbalanced quotes

    def test_rejects_paths_outside_vm(self):
        for script in ("../x.sh", "vm/../../x.sh", "files/etc/x.sh", "vm/x.py", "vm/a b.sh"):
            with self.assertRaises(ValueError, msg=script):
                stagingctl.remote_command(script, [], {})

    def test_rejects_invalid_variable_names(self):
        with self.assertRaises(ValueError):
            stagingctl.remote_command("vm/status.sh", [], {"A;B": "x"})


class PackTest(unittest.TestCase):
    def test_packs_only_vm_and_files_with_lf_and_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "vm").mkdir()
            (root / "files" / "etc").mkdir(parents=True)
            (root / "vm" / "a.sh").write_bytes(b"echo a\r\necho b\r\n")
            (root / "files" / "etc" / "x.conf").write_bytes(b"x\r\n")
            (root / ".env").write_text("LAN_CIDR=1.2.3.0/24\n")
            (root / "stagingctl.py").write_text("")

            with tarfile.open(fileobj=io.BytesIO(stagingctl.pack(root)), mode="r:gz") as tar:
                members = {m.name: m for m in tar.getmembers()}
                self.assertEqual(set(members), {"vm/a.sh", "files/etc/x.conf"})
                self.assertEqual(members["vm/a.sh"].mode, 0o755)
                self.assertEqual(members["files/etc/x.conf"].mode, 0o644)
                self.assertEqual(tar.extractfile("vm/a.sh").read(), b"echo a\necho b\n")


class TunnelTest(unittest.TestCase):
    def test_binds_only_loopback_on_both_ends(self):
        command = stagingctl.tunnel_command("binquest-staging", [(local, remote) for local, remote, _ in stagingctl.TUNNELS])
        forwards = [command[i + 1] for i, arg in enumerate(command) if arg == "-L"]
        self.assertEqual(forwards, [
            "127.0.0.1:58000:127.0.0.1:8000",
            "127.0.0.1:55432:127.0.0.1:5432",
            "127.0.0.1:58025:127.0.0.1:8025",
        ])
        self.assertIn("ExitOnForwardFailure=yes", command)
        self.assertIn("BatchMode=yes", command)
        self.assertEqual(command[-1], "binquest-staging")

    def test_free_ports_differ(self):
        self.assertNotEqual(stagingctl.free_port(), 0)


class DeployPackTest(unittest.TestCase):
    def test_deploy_archive_has_function_shared_code_and_templates(self):
        with tarfile.open(fileobj=io.BytesIO(stagingctl.pack(extra=stagingctl.DEPLOY_SOURCES)), mode="r:gz") as tar:
            names = set(tar.getnames())
        for expected in ("deploy/functions/submit-checkin/index.ts", "deploy/functions/submit-checkin/deno.json",
                         "deploy/functions/_shared/jpeg.ts", "deploy/templates/otp-code.html", "vm/80-deploy.sh"):
            self.assertIn(expected, names)
        self.assertFalse([n for n in names if "/tests/" in n or n.rsplit("/", 1)[-1] == ".env"], "no tests or .env files")

    def test_secret_names_are_validated(self):
        with self.assertRaises(ValueError):
            stagingctl.read_secret("X; rm -rf /")


class ClipboardTest(unittest.TestCase):
    SECRET = "s3cr3t-value-for-test"

    def _copy(self, clear_after):
        calls = {}

        def fake_run(args, **kwargs):
            calls["run"] = (args, kwargs)
            return mock.Mock(returncode=0, stderr="")

        def fake_popen(args, **kwargs):
            calls["popen"] = args
            return mock.Mock()

        with mock.patch.object(stagingctl.sys, "platform", "win32"), \
                mock.patch.object(stagingctl.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(stagingctl.subprocess, "Popen", side_effect=fake_popen), \
                mock.patch.object(stagingctl.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True), \
                mock.patch.object(stagingctl.subprocess, "CREATE_NEW_PROCESS_GROUP", 512, create=True):
            stagingctl.copy_to_clipboard(self.SECRET, clear_after)
        return calls

    def test_value_goes_through_stdin_only(self):
        calls = self._copy(clear_after=60)
        args, kwargs = calls["run"]
        self.assertEqual(kwargs["input"], self.SECRET + "\n")
        self.assertIn("Set-Clipboard", " ".join(args))
        for argv in (args, calls["popen"]):
            self.assertNotIn(self.SECRET, " ".join(argv))

    def test_clearing_compares_a_hash_and_can_be_switched_off(self):
        calls = self._copy(clear_after=60)
        digest = hashlib.sha256(self.SECRET.encode()).hexdigest()
        self.assertIn(digest, " ".join(calls["popen"]))
        self.assertIn("Start-Sleep -Seconds 60", " ".join(calls["popen"]))
        self.assertNotIn("popen", self._copy(clear_after=0))

    def test_refuses_outside_windows(self):
        with mock.patch.object(stagingctl.sys, "platform", "linux"), self.assertRaises(SystemExit):
            stagingctl.copy_to_clipboard(self.SECRET, 60)


class ConfigTest(unittest.TestCase):
    def test_ssh_host_default_and_override(self):
        self.assertEqual(stagingctl.ssh_host({}), "binquest-staging")
        self.assertEqual(stagingctl.ssh_host({"STAGING_SSH_HOST": "other"}), "other")


if __name__ == "__main__":
    unittest.main()
