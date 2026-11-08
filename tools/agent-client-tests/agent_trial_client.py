"""Run against a disposable regional fixture using a unique native credential-store entry."""

import json
import runpy
import hashlib
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from unittest.mock import patch
from urllib.error import HTTPError

helper = (
    Path(__file__).resolve().parents[2]
    / "console/public/skills/drive9-workspace/report.py"
)
spec = spec_from_file_location("trial_client", helper)
client = module_from_spec(spec)
spec.loader.exec_module(client)


def run(origin, directory):
    project = directory / "project"
    project.mkdir()
    (project / ".git").mkdir()
    nested = project / "src"
    nested.mkdir()
    home = directory / "profile"

    def invoke(action, root=project):
        output = subprocess.check_output(
            [
                sys.executable,
                "-IB",
                __file__,
                "client",
                origin,
                str(root),
                str(home),
                action,
            ],
            timeout=45,
        )
        return json.loads(output)

    def locked():
        raise client.KeyringError("test store locked")

    try:
        with ThreadPoolExecutor(2) as pool:
            first, second = list(
                pool.map(lambda p: invoke("start", p), (project, nested))
            )
        assert first["status"] == second["status"] == "synced", first.get("message")
        assert (
            first["reportId"] == second["reportId"]
            and first["version"] == second["version"] == 1
        )
        assert (
            "240 orders" in first["markdown"]
            and "$48,000.00" in first["markdown"]
            and "$100,000.00" in first["markdown"]
        )
        link = first["studioUrl"]
        assert second["studioUrl"] == link
        assert link.startswith(origin + "/report/#v1.")
        grant = urlsplit(link).fragment
        assert urlsplit(first['insightsUrl']).fragment == grant
        assert urlsplit(first['insightsUrl']).query == 'view=markets'
        assert '$68,000.00 / $100,000.00 = 68.0%' in first['markdown']

        def view():
            req = Request(
                origin + "/api/v1/agent-trial/report-view",
                headers={"Authorization": "TrialView " + grant},
            )
            with urlopen(req, timeout=10) as response:
                return json.load(response)

        assert view()["revision"] == 1
        continued = invoke("products", nested)
        assert continued["studioUrl"] == link
        assert continued['insightsUrl'] == first['insightsUrl']
        assert view()["leadingStateProducts"]["Monitors"] == 18000
        assert (
            continued["report"] == first["report"]
            and continued["reportId"] == first["reportId"]
        )
        assert (
            continued["expiresAt"] == first["expiresAt"] and continued["version"] == 2
        )
        assert "Monitors leads with $18,000.00 (37.5%" in continued["markdown"]
        assert invoke("start")["markdown"] == continued["markdown"]
        file = Path(continued["report"])
        binding = home / hashlib.sha256(f"{origin}\0{os.path.normcase(str(project.resolve()))}".encode()).hexdigest() / "binding.json"
        state = json.loads(binding.read_text())
        assert set(state) == {"reportId", "file", "status", "expiresAt", "projectFile", "projectHash"}
        try:
            client.trial(origin, project, home, "products", store_factory=locked)
            raise AssertionError("Locked credential store must stop the workflow")
        except ValueError as error:
            assert "credential store is unavailable or locked" in str(error)
        assert file.resolve().is_relative_to(project.resolve())
        assert view()["markdown"] == file.read_text()
        assert Path(continued["source"]).read_bytes() == (binding.parent / "us-sales-v1.csv").read_bytes()
        file.write_text("My local edits")
        try:
            invoke("start")
            raise AssertionError("Local edits must be preserved")
        except subprocess.CalledProcessError:
            assert file.read_text() == "My local edits"
        file.write_text(continued["markdown"])
        assert invoke("unshare")["status"] == "sharing-revoked"
        assert invoke("unshare")["status"] == "sharing-revoked"
        try:
            view()
            raise AssertionError("The shared link must be closed")
        except HTTPError as error:
            assert error.code == 410
        with patch.object(client, "api", side_effect=client.URLError("simulated outage")):
            try:
                client.trial(origin, project, home, "start")
                raise AssertionError("Unconfirmed save must not fabricate another report")
            except ValueError as error:
                assert "Remote save unconfirmed" in str(error)
        assert file.read_text() == continued["markdown"]
        closed = invoke("start")
        assert "studioUrl" not in closed and closed["markdown"] == continued["markdown"]
        assert file.read_text() == continued["markdown"]
        service = "Drive9 Agent Trial " + binding.parent.name
        assert client.native_store().get_password(service, "project") is not None
        state["expiresAt"] = 1
        client.save_state(binding, state)
        assert invoke("start")["status"] == invoke("products")["status"] == "expired"
        assert client.native_store().get_password(service, "project") is None
        assert file.read_text() == continued["markdown"]
        replaced = invoke("new")
        assert (
            replaced["status"] == "synced" and replaced["reportId"] != first["reportId"]
        )
        assert invoke("forget")["status"] == "forgotten"
        assert client.native_store().get_password(service, "project") is None
        print(
            "Two concurrent cold processes: one report, revision 1 → 2, native key removed on expiry and on forget."
        )
    finally:
        invoke("forget")

    try:
        client.trial(origin, project, directory / "locked", "start", store_factory=locked)
        raise AssertionError("Missing secure store must not create a local-only journey")
    except ValueError as error:
        assert "credential store is unavailable or locked" in str(error)


if __name__ == "__main__":
    if sys.argv[1] == "client":
        _, _, origin, project, home, action = sys.argv
        print(json.dumps(client.trial(origin, Path(project), Path(home), action)))
    else:
        runpy.run_path(str(Path(__file__).with_name("trial_installer.py")))
        with tempfile.TemporaryDirectory(prefix="drive9-report-test-") as directory:
            run(sys.argv[1], Path(directory))
