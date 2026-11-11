"""A standard-library client for the TiDB AgentSpace API."""

import json
import re
from http.client import HTTPConnection, HTTPSConnection
from urllib.parse import quote, urlencode, urlsplit


_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _endpoint(value):
    parts = urlsplit(value)
    if (
        not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or not re.fullmatch(r"(?:/[A-Za-z0-9_-]+)*/?", parts.path)
        or not (parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in _LOOPBACK))
    ):
        raise ValueError("Expected an HTTPS API endpoint or a local development endpoint.")
    return parts


def _request(url, token, body=None, *, route=False):
    if not token or any(c.isspace() for c in token):
        raise ValueError("Expected a bearer credential.")
    parts = urlsplit(url)
    transport = HTTPSConnection if parts.scheme == "https" else HTTPConnection
    conn = transport(parts.hostname, parts.port, timeout=30)
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    try:
        path = parts.path + ("?" + parts.query if parts.query else "")
        conn.request("GET" if payload is None else "POST", path, payload, headers)
        response = conn.getresponse()
        # http.client never follows redirects with credentials.
        if route and response.status == 307:
            return response.getheader("Location"), response.getheader("X-Region-Id")
        if route or not 200 <= response.status < 300:
            message = f"Workspace API returned HTTP {response.status} ({parts.path})."
            try:
                error = json.loads(response.read(8192)).get("error", {}).get("code")
                if isinstance(error, str) and re.fullmatch(r"[A-Z0-9_]{1,80}", error):
                    message += " " + error
            except (ValueError, AttributeError):
                pass
            raise RuntimeError(message)
        return json.load(response)
    finally:
        conn.close()


class Workspace:
    """Use a short-lived Region token. Reconnect when it expires."""

    def __init__(self, root, token):
        self._root = root
        self._token = token

    def list_resources(self, *, cursor=None, limit=None):
        return self._list("resources", cursor=cursor, limit=limit)

    def list_files(self, file_system_id, path="/", *, cursor=None, limit=None):
        return self._list("files", resourceId=file_system_id, path=path, cursor=cursor, limit=limit)

    def _list(self, resource, **params):
        query = urlencode({k: v for k, v in params.items() if v is not None})
        return _request(self._root + "/" + resource + ("?" + query if query else ""), self._token)

    def query(self, database_id, sql, *, read_only=True):
        return _request(self._root + "/queries", self._token, {
            "resourceId": database_id, "sql": sql, "readOnly": read_only,
        })


def connect_workspace(*, endpoint, api_key):
    """Exchange a Workspace Key at Global and bind data calls to its verified Region."""
    endpoint = endpoint.rstrip("/")
    global_url = _endpoint(endpoint)
    if not global_url.path.endswith("/api"):
        raise ValueError("The Workspace endpoint must end in /api.")
    issue = endpoint + "/v1/token-issuances"
    identity = _request(issue, api_key, {"audience": "global"})
    workspace_id = identity["workspaceId"]
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", workspace_id) or workspace_id in {".", ".."}:
        raise ValueError("Invalid Workspace identity.")
    workspace_path = "/v1/workspaces/" + quote(workspace_id, safe="")
    location, region_id = _request(
        endpoint + workspace_path + "/region-route", identity["accessToken"], route=True
    )
    issued = _request(issue, api_key, {"audience": "region"})
    region = issued["region"]
    origin = _endpoint(region["apiOrigin"])
    prefix = region["apiPathPrefix"]
    if (
        origin.path
        or (origin.hostname in _LOOPBACK and global_url.hostname not in _LOOPBACK)
        or not re.fullmatch(r"(?:/[A-Za-z0-9_-]+)*", prefix)
        or not re.fullmatch(r"region:[A-Za-z0-9_.:-]{1,100}", region_id or "")
        or region["regionId"] != region_id
        or issued["workspaceId"] != workspace_id
        or location != region["apiOrigin"] + prefix
    ):
        raise ValueError("Global route and issued Region identity do not match.")
    return Workspace(location + "/api" + workspace_path, issued["accessToken"])
