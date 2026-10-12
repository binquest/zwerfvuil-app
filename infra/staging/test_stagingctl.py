import io
import shlex
import tarfile
import tempfile
import unittest
from pathlib import Path

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
        command = stagingctl.tunnel_command("binquest-staging")
        forwards = [command[i + 1] for i, arg in enumerate(command) if arg == "-L"]
        self.assertEqual(forwards, ["127.0.0.1:58000:127.0.0.1:8000", "127.0.0.1:55432:127.0.0.1:5432"])
        self.assertIn("ExitOnForwardFailure=yes", command)
        self.assertEqual(command[-1], "binquest-staging")


class ConfigTest(unittest.TestCase):
    def test_ssh_host_default_and_override(self):
        self.assertEqual(stagingctl.ssh_host({}), "binquest-staging")
        self.assertEqual(stagingctl.ssh_host({"STAGING_SSH_HOST": "other"}), "other")


if __name__ == "__main__":
    unittest.main()
