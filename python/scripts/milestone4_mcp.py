"""Official-SDK stdio MCP proof server. Used by the opt-in ACP driver and offline tests."""

import argparse
import os
from pathlib import Path

from mcp import types
from mcp.server.mcpserver import MCPServer
from pydantic import BaseModel


class Proof(BaseModel):
    marker: str
    pid: int


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=Path, required=True)
    args = parser.parse_args()
    server = MCPServer("milestone-4-proof", log_level="ERROR")

    @server.tool(annotations=types.ToolAnnotations(read_only_hint=True, open_world_hint=False))
    def read_proof() -> Proof:
        """Read the milestone 4 proof marker from a server-side file. Takes no arguments."""
        return Proof(marker=args.file.read_text().strip(), pid=os.getpid())

    server.run()


if __name__ == "__main__":
    main()
