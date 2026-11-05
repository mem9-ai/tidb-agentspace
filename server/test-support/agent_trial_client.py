"""Run against a disposable regional fixture using a unique native credential-store entry."""

import json
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

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
        continued = invoke("products", nested)
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
        binding = file.parent / "binding.json"
        state = json.loads(binding.read_text())
        assert set(state) == {"reportId", "file", "status", "expiresAt"}
        fallback = client.trial(origin, project, home, "products", store_factory=locked)
        assert fallback["status"] == "local-only" and fallback["report"] != str(file)
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

    local = client.trial(
        origin, project, directory / "locked", "start", store_factory=locked
    )
    assert (
        local["status"] == "local-only"
        and "$48,000.00" in Path(local["report"]).read_text()
    )


if __name__ == "__main__":
    if sys.argv[1] == "client":
        _, _, origin, project, home, action = sys.argv
        print(json.dumps(client.trial(origin, Path(project), Path(home), action)))
    else:
        with tempfile.TemporaryDirectory(prefix="drive9-report-test-") as directory:
            run(sys.argv[1], Path(directory))
