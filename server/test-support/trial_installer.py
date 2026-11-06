"""Installer reuse and user-edit preservation; no network, package or home writes."""
import hashlib
import io
import json
from pathlib import Path
import runpy
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

assets = Path(__file__).resolve().parents[2] / "console/public/skills/drive9-workspace"
installer = runpy.run_path(str(assets / "install.py"))
base = "https://drive9.ai/studio/skills/drive9-workspace/"


def download(url, timeout):
    assert timeout == 15 and url.startswith(base)
    response = io.BytesIO((assets / url[len(base):]).read_bytes())
    response.geturl = lambda: url
    return response


with tempfile.TemporaryDirectory(prefix="tidb-installer-test-") as directory:
    root = Path(directory)
    skills = root / "skill"
    runtime = root / "runtime"
    skills.mkdir()
    (skills / ".drive9-installed").touch()
    executable = runtime / ("Scripts/python.exe" if installer["os"].name == "nt" else "bin/python")
    executable.parent.mkdir(parents=True)
    executable.touch()
    # Existing published files may be updated; locally customized ones must not be replaced.
    previous = {}
    for name in ("SKILL.md", "report.py", "private_csv.py"):
        data = ("Previously published " + name).encode()
        previous[name] = hashlib.sha256(data).hexdigest()
        (skills / name).write_bytes(data)
    installer["install_assets"].__globals__["LEGACY_ASSETS"] = previous
    with patch("urllib.request.urlopen", side_effect=download) as fetch, patch("venv.EnvBuilder") as venv, patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="25.6.0,46.0.5\n")) as run:
        installer["install_assets"](skills, runtime)
        assert fetch.call_count == len(installer["ASSETS"])
        assert run.call_count == 1  # Metadata check, no pip installation.
        assert "pip" not in run.call_args.args[0]
        venv.assert_not_called()
        for name, digest in installer["ASSETS"].items():
            assert hashlib.sha256((skills / name).read_bytes()).hexdigest() == digest
        assert json.loads((skills / ".drive9-assets.json").read_text()) == installer["ASSETS"]
        fetch.reset_mock()
        run.reset_mock()
        installer["install_assets"](skills, runtime)
        fetch.assert_not_called()
        run.assert_not_called()
        (skills / "SKILL.md").write_text("My customization")
        try:
            installer["install_assets"](skills, runtime)
            raise AssertionError("Custom skill must be preserved")
        except SystemExit as error:
            assert "Local changes" in str(error)
        assert (skills / "SKILL.md").read_text() == "My customization"
        fetch.assert_not_called()
