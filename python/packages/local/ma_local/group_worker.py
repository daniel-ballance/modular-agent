"""Process-group command supervisor; a pipe keeps it tied to the agent's lifetime."""

import os
import select
import signal
import subprocess
import sys


def main():
    lifetime, cwd, command = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    if select.select([lifetime], [], [], 0)[0]:
        return
    child = subprocess.Popen(
        ["bash", "-c", command],
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=sys.stdout,
        stderr=sys.stdout,
        start_new_session=True,
    )
    try:
        while child.poll() is None:
            if select.select([lifetime], [], [], 0.02)[0]:
                break
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    code = child.wait()
    print(code, file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
