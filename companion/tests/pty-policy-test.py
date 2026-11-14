#!/usr/bin/env python3
"""PTY smoke test for the handoff-auto creation policy (Pi side).

A: fresh workspace, answer "No"          -> no handoff.md at all
B: fresh workspace, answer "Yes"         -> handoff.md created
C: existing handoff, answer "No"         -> handoff.md untouched (no new round)
D: existing handoff, answer "Yes"        -> a new round appended
"""
import fcntl
import os
import pty
import select
import shutil
import struct
import sys
import termios
import time

CONFIG = "/tmp/handoff-policy-config.json"
PRIOR = "## prior — 2026-01-01\n\nprior round\n\nCANARY-HANDOFF-BODY-9f3a\n"
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_available(fd, seconds):
    out = b""
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out += data
    return out


def run_case(workdir, dialog_keys, label, preexisting, takeover_option=None):
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir, exist_ok=True)
    handoff = os.path.join(workdir, "handoff.md")
    if preexisting:
        with open(handoff, "w", encoding="utf-8") as fh:
            fh.write(PRIOR)

    env = dict(os.environ)
    env["HANDOFF_AUTO_CONFIG"] = CONFIG
    env["TERM"] = "xterm-256color"

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.environ.clear()
        os.environ.update(env)
        os.execv("/usr/bin/pi", ["pi", "--approve"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
    screen = read_available(fd, 8)  # startup + extension session_start
    if takeover_option == "review":
        os.write(fd, b"\x1b[B\r")  # takeover dialog: "Review the handoff first"
    else:
        os.write(fd, b"\x1b[B\x1b[B\r")  # takeover dialog: "Ignore for now"
    screen += read_available(fd, 4)
    os.write(fd, b"hi\r")  # one user message so the branch is not empty
    screen += read_available(fd, 25)  # let the turn finish: the session must be idle
    os.write(fd, b"\x04")  # Ctrl+D -> the exit offer
    screen += read_available(fd, 4)
    os.write(fd, dialog_keys)
    screen += read_available(fd, 25)

    deadline = time.time() + 20
    exited = False
    while time.time() < deadline:
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            exited = True
            break
        if wpid == pid:
            exited = True
            break
        read_available(fd, 0.5)
    if not exited:
        try:
            os.kill(pid, 9)
        except OSError:
            pass

    text = screen.decode("utf-8", "replace")
    flat = " ".join(text.split())
    exists = os.path.exists(handoff)
    body = open(handoff, encoding="utf-8").read() if exists else ""
    rounds = body.count("<!-- handoff-auto:")
    fresh = not preexisting

    # The document body must never be pasted into the conversation.
    canary_pasted = "CANARY-HANDOFF-BODY-9f3a" in flat
    if fresh:
        ok = (not exists) if dialog_keys == b"\r" else exists
        detail = f"exists={exists} rounds={rounds}"
    else:
        if dialog_keys == b"\r":  # "Yes" -> a new round
            ok = exists and rounds == 1
        else:  # "No" -> untouched
            ok = exists and rounds == 0 and body == PRIOR
        detail = f"exists={exists} rounds={rounds} unchanged={body == PRIOR}"

    if takeover_option != "review" and canary_pasted:
        ok = False
        detail += " BODY-PASTED-INTO-CONVERSATION"

    print(f"=== {label}: {detail} -> {'PASS' if ok else 'FAIL'}")
    for probe in [
        "No handoff.md in this workspace",
        "Write a handoff for the next session?",
        "No — exit without creating one",
        "Yes — create a handoff for the next session",
    ]:
        print(f"    probe {probe!r}: {'FOUND' if probe in flat else 'absent'}")
    if not ok:
        print("    --- body ---")
        print(body[:1200])
    return ok


def main():
    with open(CONFIG, "w", encoding="utf-8") as fh:
        fh.write(
            '{"autoTakeover": true, "writeOnExit": true, "pi": '
            '{"useModelSummary": false, "exitOffer": true, "takeoverConfirm": true, '
            '"summaryTimeoutSec": 20, "checkpointOnSettle": false}}\n'
        )
    results = [
        run_case("/tmp/handoff-case-a", b"\r", "A fresh + No", False),
        run_case("/tmp/handoff-case-b", b"\x1b[B\r", "B fresh + Yes", False),
        run_case("/tmp/handoff-case-c", b"\x1b[B\r", "C existing + No", True),
        run_case("/tmp/handoff-case-d", b"\r", "D existing + Yes", True),
    ]
    print("\nALL PASS" if all(results) else "\nFAILURES PRESENT")
    return 0 if all(results) else 1

if __name__ == "__main__":
    sys.exit(main())
