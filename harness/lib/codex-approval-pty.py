"""Small POSIX terminal bridge; no model prompts or trust-file writes."""
import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def approve(project):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("codex", ["codex", "--no-alt-screen", "-C", project])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
    deadline = time.monotonic() + 60
    stage, buffer, size = 0, b"", 0
    # Strip terminal styling/cursor controls solely for recognizing fixed UI labels.
    ansi = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])")
    def send(keys):
        # A rendered menu can precede its input handler becoming ready.
        time.sleep(0.5)
        os.write(fd, keys)

    try:
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.2)[0]:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                _, status = os.waitpid(pid, 0)
                if stage != 5 or os.waitstatus_to_exitcode(status) != 0:
                    raise RuntimeError("Codex exited before native approval completed")
                return
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            size += len(chunk)
            if size > 4 * 1024 * 1024:
                raise RuntimeError("Codex terminal output exceeded its limit")
            buffer += chunk
            text = re.sub(rb"\s+", b"", ansi.sub(b"", buffer))
            if stage == 0 and b"Hooksneedreview" in text and b"3hooksareneworchanged." in text and b"Pressentertoconfirm" in text:
                send(b"\r")  # Review; the Node caller checked the entire inventory.
                stage, buffer = 1, b""
            elif stage == 1 and b"3hooksneedreviewbeforetheycanrun." in text and b"Pressttotrustall;entertoreviewhooks;esctoclose" in text:
                send(b"t")
                stage, buffer = 2, b""
            elif stage == 2 and b"Pressentertoviewhooks;esctoclose" in text:
                send(b"\x1b")
                stage, buffer = 3, b""
            elif stage == 3 and b"AskCodextodoanything" in text:
                send(b"/quit")
                stage, buffer = 4, b""
            elif stage == 4 and b"/quit" in text:
                # Let Codex's paste detector settle before submitting the slash command.
                send(b"\r")
                stage, buffer = 5, b""
        raise RuntimeError(f"Native Codex approval timed out at UI step {stage}")
    finally:
        # The PTY child owns its process group; never signal host Codex sessions.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(fd)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    try:
        approve(sys.argv[1])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
