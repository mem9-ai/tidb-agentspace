"""Offline helper regression: verify the number of uploads after lost replies and file removal."""
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import tempfile
from uuid import uuid4

base = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("private_csv", base / "console/public/skills/drive9-workspace/private_csv.py")
client = module_from_spec(spec)
spec.loader.exec_module(client)


class Store(dict):
    get_password = lambda self, service, name: self.get((service, name))

    def set_password(self, service, name, value):
        self[service, name] = value

    def delete_password(self, service, name):
        del self[service, name]


def run(directory):
    project = directory / "project"
    project.mkdir()
    (project / ".git").mkdir()
    nested = project / "nested"
    nested.mkdir()
    source = directory / "sales.csv"
    source.write_bytes(b"state,sales\nCA,40\n")
    store = Store()
    home = directory / "state"
    clock = [1800000000]
    calls = []
    workspaces = {}
    lost_reply = True

    def api(base, key, route, method="GET", body=None, headers=None):
        nonlocal lost_reply
        calls.append((method,route))
        if route == "workspaces":
            item = workspaces.setdefault(key, {"id":str(uuid4()), "data":None, "version":0, "expiresAt":clock[0]+86400})
            return json.dumps({"workspaceId":item["id"],"resourceId":"fs_123","expiresAt":item["expiresAt"]}).encode()
        item = workspaces[key]
        assert route.startswith("workspaces/" + item["id"] + "/sources/fs_123/")
        if route.endswith("metadata"):
            if item["data"] is None:
                raise client.Rejected(404, "NOT_FOUND")
            return json.dumps({"data":{"type":"file","version":str(item["version"])}}).encode()
        if method == "PUT":
            assert (headers.get("If-None-Match") == "*" and not item["version"]) or headers["If-Match"] == str(item["version"])
            item.update(data=body,version=item["version"]+1)
            if lost_reply:
                lost_reply = False
                raise TimeoutError("receipt lost")
            return b"{}"
        return item["data"]

    client.request = api
    def invoke(action, file=None, path=project):
        return client.private_csv(client.PRODUCTION,path,home,action,file,lambda:store,lambda:clock[0])
    try:
        invoke("upload", source)
        raise AssertionError("lost write receipt was confirmed")
    except TimeoutError:
        pass
    result = invoke("upload", source)
    assert not result["uploaded"] and len(workspaces) == 1
    cache = Path(result["source"])
    cache.unlink()
    source.unlink()
    resumed = invoke("resume", path=nested)
    assert not resumed["uploaded"] and resumed["workspaceId"] == result["workspaceId"]
    assert cache.read_bytes() == b"state,sales\nCA,40\n"
    assert sum(m == "PUT" for m,_ in calls) == 1
    assert sum(route == "workspaces" for _,route in calls) == 1
    source.write_bytes(b"state,sales\nOR,35\n")
    try:
        invoke("upload",source)
        raise AssertionError("implicit replacement")
    except ValueError:
        pass
    assert invoke("replace",source)["uploaded"]
    clock[0] = result["expiresAt"]
    assert invoke("resume")["status"] == "expired" and not store and cache.is_file()
    assert invoke("new",source)["workspaceId"] != result["workspaceId"]
    assert invoke("forget")["status"] == "forgotten" and not store


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        run(Path(directory))
    print("Lost receipt, remote-only resume, conditional replacement and expiry passed.")
