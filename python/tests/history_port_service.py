"""Disposable custom history service for the public history binding kit."""

import os
import sys

from modular_agent import serve_history, sqlite_history_port


def main() -> None:
    directory, token_file, port = sys.argv[1:]
    ttl_ms = 1000 if os.environ.get("MODULAR_AGENT_KIT_RESTART_PHASE") == "restart" else 6000

    # Route every request through a developer's port, not the file-history branch.
    with sqlite_history_port(directory, ttl_ms=ttl_ms) as backend:
        serve_history(backend, address=("127.0.0.1", int(port)), token_file=token_file)


if __name__ == "__main__":
    main()
