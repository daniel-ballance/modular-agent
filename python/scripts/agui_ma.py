"""Launch the standard ma on the managed kit's disposable project and token."""

import json
import os
from pathlib import Path
import sys

config = json.loads(Path(os.environ["MA_AGUI_FIXTURE"]).read_text())
ma = str(Path(sys.executable).with_name("ma"))
os.execv(
    ma,
    [
        ma,
        "--agui",
        "--acp",
        "--listen",
        os.environ["MA_AGUI_LISTEN"],
        "--token-file",
        config["tokenFiles"]["owner"],
        "--project",
        config["project"],
    ],
)
