import errno
import json
import os
import pty
import re
import select
import signal
import sys
import time
from contextlib import suppress


def run(secret: str, inline: str, probe: str, command: list[str]) -> dict[str, object]:
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(command[0], command)
        except OSError as exc:
            os.write(2, f"could not start ma: {exc}\n".encode())
            os._exit(127)

    output = bytearray()
    exit_code = None
    deadline = time.monotonic() + 60

    def transcript() -> str:
        return output.decode(errors="replace")

    def read() -> bool:
        remaining = max(0, deadline - time.monotonic())
        if not select.select([fd], [], [], remaining)[0]:
            raise TimeoutError("ma produced no more output before the deadline")
        try:
            data = os.read(fd, 4096)
        except OSError as exc:
            if exc.errno != errno.EIO:
                raise
            return False
        output.extend(data)
        if len(output) > 128 * 1024 or time.monotonic() >= deadline:
            raise RuntimeError("ma exceeded the output limit or deadline")
        return bool(data)

    def wait(pattern: str, start: int = 0) -> re.Match[str]:
        expected = re.compile(pattern, re.DOTALL)
        while True:
            if match := expected.search(transcript(), start):
                return match
            try:
                if read():
                    continue
            except TimeoutError as exc:
                raise TimeoutError(f"timed out waiting for {pattern!r}") from exc
            raise RuntimeError(f"ma closed its terminal before {pattern!r}")

    def send(line: str) -> None:
        data = line.encode()
        if os.write(fd, data) != len(data):
            raise RuntimeError("short write to pseudo-terminal")

    def interrupted(_signum: int, _frame: object) -> None:
        raise InterruptedError("pty driver interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(65)
    try:
        send("Ask.\n")
        question = wait(r"Question (\S+): Deploy key\?\r?\nUse /answer REQUEST_ID \(hidden input\)")
        answer = f"/answer {question.group(1)}"
        send(f"{answer} {inline}\n")
        refusal = wait(
            r"Do not put the secret on the command line; use /answer REQUEST_ID", question.end()
        )
        send(answer + "\n")
        prompt = wait(r"Secret: ", refusal.end())
        send(secret + "\n")
        done = wait(r"SECRET_TURN_DONE\r?\n", prompt.end())
        send(probe + "\n")
        probe_done = wait(r"ECHO_PROBE_DONE\r?\n", done.end())
        echoed = probe in transcript()[done.end() : probe_done.start()]
        send("\x04")
        while read():
            pass
        _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status)
        return {"exitCode": exit_code, "transcript": transcript(), "echoRestored": echoed}
    except (RuntimeError, OSError) as exc:
        raise SystemExit(f"{exc}; terminal output:\n{transcript()}") from None
    finally:
        signal.alarm(0)
        if exit_code is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                with suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)


if __name__ == "__main__":
    secret, inline, probe, *command = sys.argv[1:]
    json.dump(run(secret, inline, probe, command), sys.stdout)
