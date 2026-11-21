"""Entry point for the standard agent."""

import sys


def main() -> None:
    if sys.platform not in {"linux", "darwin"}:
        print("ma supports only Linux and macOS", file=sys.stderr)
        raise SystemExit(1)
    from .cli import main as cli_main

    cli_main()
