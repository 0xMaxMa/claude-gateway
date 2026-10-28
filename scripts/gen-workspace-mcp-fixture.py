# Regenerates mcp/fixtures/workspace-mcp-tools.json: the {name, description} of
# every tool the Google Workspace connectors expose, as the MCP tools/list returns them.
#
# Mirrors the sidecar spec a client pushes for these connectors:
#   workspace-mcp==2.1.1 --transport streamable-http --tools <service>
#     --tool-tier complete --disabled-tools start_google_auth <DISABLED[service]>
#
# Run from the repo root, offline from uv's cache:
#   UV_OFFLINE=1 UV_EXCLUDE_NEWER=2026-10-21T00:00:00Z uv run --no-project \
#     --python 3.12 --with workspace-mcp==2.1.1 python scripts/gen-workspace-mcp-fixture.py
import asyncio
import json
import os
import subprocess
import sys
from importlib import metadata
from pathlib import Path

WORKSPACE_MCP_VERSION = "2.1.1"

CONNECTORS = {
    "gmail": "gmail",
    "google-calendar": "calendar",
    "google-docs": "docs",
    "google-drive": "drive",
    "google-sheets": "sheets",
}

DISABLED = {
    "gmail": ["modify_gmail_message_labels", "batch_modify_gmail_message_labels", "manage_gmail_label", "list_gmail_filters", "manage_gmail_filter"],
    "calendar": ["create_calendar"],
    "drive": ["manage_drive_access", "set_drive_file_permissions"],
    "docs": ["manage_document_comment"],
    "sheets": ["manage_spreadsheet_comment"],
}

FIXTURE = Path(__file__).resolve().parent.parent / "mcp" / "fixtures" / "workspace-mcp-tools.json"

SIDECAR_ENV = {
    "MCP_ENABLE_OAUTH21": "true",
    "EXTERNAL_OAUTH21_PROVIDER": "true",
    "WORKSPACE_MCP_STATELESS_MODE": "true",
    "WORKSPACE_MCP_HOST": "127.0.0.1",
    "WORKSPACE_MCP_PORT": "0",
    "GOOGLE_OAUTH_CLIENT_ID": "fixture-client-id",
    "FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY": "fixture-signing-key",
}


def list_service_tools(service: str) -> list[dict[str, str]]:
    import main as workspace_main
    from core.server import server
    from fastmcp import Client

    async def tools_list() -> list[dict[str, str]]:
        async with Client(server) as client:
            return [{"name": tool.name, "description": tool.description} for tool in await client.list_tools()]

    def emit(**_: object) -> None:
        sys.__stdout__.write(json.dumps(asyncio.run(tools_list())))
        sys.__stdout__.flush()
        os._exit(0)

    server.run = emit
    sys.argv = ["workspace-mcp", "--transport", "streamable-http", "--tools", service, "--tool-tier", "complete",
                "--disabled-tools", "start_google_auth", *DISABLED[service]]
    sys.stdout = sys.stderr
    workspace_main.main()
    raise SystemExit(f"workspace-mcp {service} exited without starting its server")


def generate() -> None:
    installed = metadata.version("workspace-mcp")
    if installed != WORKSPACE_MCP_VERSION:
        raise SystemExit(f"expected workspace-mcp {WORKSPACE_MCP_VERSION}, found {installed}")
    catalogs = {}
    for connector, service in sorted(CONNECTORS.items()):
        child = subprocess.run([sys.executable, __file__, service], env={**os.environ, **SIDECAR_ENV},
                               capture_output=True, text=True, timeout=120)
        if child.returncode != 0:
            raise SystemExit(f"{service} failed ({child.returncode}):\n{child.stderr}")
        tools = json.loads(child.stdout)
        leaked = {"start_google_auth", *DISABLED[service]} & {tool["name"] for tool in tools}
        if leaked:
            raise SystemExit(f"{service} still lists disabled tools: {sorted(leaked)}")
        catalogs[connector] = tools
    FIXTURE.write_text(json.dumps(catalogs, indent=1) + "\n")
    print(", ".join(f"{connector} {len(tools)}" for connector, tools in catalogs.items()))


if __name__ == "__main__":
    if len(sys.argv) == 2:
        list_service_tools(sys.argv[1])
    else:
        generate()
