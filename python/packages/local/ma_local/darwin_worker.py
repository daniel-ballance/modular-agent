"""Keep the command group alive and owned until the parent closes its pipe."""

import os
import select
import signal
import subprocess
import sys
import time


def main():
    lifetime, cwd, command = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    child = subprocess.Popen(
        ["/bin/bash", "-c", command],
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=sys.stdout,
        stderr=sys.stdout,
    )
    # Install this after spawn so bash does not inherit an ignored SIGTERM.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        while child.poll() is None:
            if select.select([lifetime], [], [], 0.01)[0]:
                return
        print(child.returncode, file=sys.stderr, flush=True)
        select.select([lifetime], [], [])
    finally:
        group = os.getpgrp()
        os.killpg(group, signal.SIGTERM)
        time.sleep(0.25)
        os.killpg(group, signal.SIGKILL)


if __name__ == "__main__":
    main()
