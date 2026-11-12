"""Exercise the downloaded Python client's routing boundary and a scoped native Workspace."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

sdk = Path(sys.argv[1]) if len(sys.argv) == 2 else Path(__file__).resolve().parents[2] / "src/clients/python"
sys.path.insert(0, str(sdk))
import workspace_agent as client


def reject_mismatched_route():
    region = {"apiOrigin": "https://region.example", "apiPathPrefix": "", "regionId": "region:one"}
    replies = [
        {"workspaceId": "ws_one", "accessToken": "global-token"},
        ("https://different.example", "region:one"),
        {"workspaceId": "ws_one", "region": region, "accessToken": "region-token"},
    ]
    with patch.object(client, "_request", side_effect=replies) as request:
        try:
            client.connect_workspace(endpoint="https://global.example/api", api_key="test-key")
        except ValueError as error:
            assert "do not match" in str(error)
        else:
            raise AssertionError("Accepted a mismatched Region route")
        assert all(call.args[0].startswith("https://global.example/api/") for call in request.call_args_list)


if __name__ == "__main__":
    reject_mismatched_route()
    config = json.load(sys.stdin)
    workspace = client.connect_workspace(endpoint=config["endpoint"], api_key=config["key"])
    page = workspace.list_resources(limit=1)
    ids = {entry["id"] for entry in page["data"]}
    cursors = set()
    while page.get("nextCursor"):
        cursor = page["nextCursor"]
        assert cursor not in cursors
        cursors.add(cursor)
        page = workspace.list_resources(cursor=cursor, limit=1)
        ids.update(entry["id"] for entry in page["data"])
    assert cursors and ids == {"db_live", "fs_live"}
    try:
        workspace.list_files("fs_shared")
    except RuntimeError as error:
        assert "403" in str(error) or "404" in str(error)
    else:
        raise AssertionError("Unselected File System was accessible")
    shared = client.connect_workspace(endpoint=config["endpoint"], api_key=config["sdkKey"])
    assert any(f["path"] == "/sdk.txt" for f in shared.list_files("fs_shared")["data"])
    assert shared.query("db_pg", "SELECT 1 AS value")["rows"] == [{"value": 1}]
