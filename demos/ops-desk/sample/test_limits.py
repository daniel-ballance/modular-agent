"""The verifier runs this file in a checkout of the coder's exact commit."""
import json
import sys
from pathlib import Path

from limits import percentage

cases = json.loads(Path(__file__).with_name("cases.json").read_text())
for value, expected in cases:
    actual = percentage(value)
    if actual != expected:
        sys.exit(f"percentage({value}): expected {expected}, got {actual}")
print(f"{len(cases)} percentage checks passed")
