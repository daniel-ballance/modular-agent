"""One command's lifetime watcher. The shell is born inside its cgroup.

The watcher is outside that group so it can kill and reap every descendant.
PR_SET_CHILD_SUBREAPER: https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
"""

import ctypes
import json
import os
import select
import sys
import time
from pathlib import Path

from .containment import journal, kill, remove


def main():
    record, lifetime, output, cwd = (
        Path(sys.argv[1]),
        int(sys.argv[2]),
        int(sys.argv[3]),
        sys.argv[4],
    )
    data = json.loads(record.read_text())
    group = Path(data["group"])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Cannot establish command subreaper")
    ready_read, ready_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(ready_read)
            # No command can fork or exec before it enters the journalled cgroup.
            (group / "cgroup.procs").write_text(str(os.getpid()))
            os.write(ready_write, b"1")
            os.close(ready_write)
            os.close(lifetime)
            os.setsid()
            os.chdir(cwd)
            os.dup2(output, 1)
            os.dup2(output, 2)
            null = os.open(os.devnull, os.O_RDONLY)
            os.dup2(null, 0)
            os.execv("/bin/bash", ["/bin/bash", "-c", sys.argv[5]])
        except BaseException as exc:
            os.write(2, str(exc).encode())
            os._exit(127)
    os.close(output)
    os.close(ready_write)
    try:
        # EOF can arrive during startup. Do not kill an empty group before its
        # child joins, then block reaping a command that escaped that kill.
        # Child failure closes the pipe too, so admission failure cannot hang us.
        try:
            os.read(ready_read, 1)
        finally:
            os.close(ready_read)
        while True:
            # EOF is reliable on SIGKILL. The command never inherits this pipe.
            if select.select([lifetime], [], [], 0.01)[0]:
                if not os.read(lifetime, 1):
                    break
            while True:
                try:
                    child, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    return
                if not child:
                    break
                if child == pid:
                    journal(
                        record.with_suffix(".result"),
                        {"exit_code": os.waitstatus_to_exitcode(status)},
                    )
    finally:
        kill(group)
        # Reap foreground, background, setsid and double-fork descendants.
        while True:
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                break
        for _ in range(500):
            if remove(group):
                record.unlink(missing_ok=True)
                break
            time.sleep(0.01)
        os.close(lifetime)


if __name__ == "__main__":
    main()
