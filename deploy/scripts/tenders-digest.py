#!/usr/bin/env python3
"""Daily tenders digest — deterministic, no LLM in the loop.

Run by `hermes cron` with --no-agent, so this script IS the job and whatever it
prints is delivered verbatim to Telegram. That split is deliberate: the agent
curates `criteria/relevance.md` and diagnoses broken scrapers, but sending the
same digest every morning needs no judgment, and putting an LLM in a path that
runs unattended at 06:00 buys nothing and adds a way to fail.

Silence is a feature. Printing nothing when there are no new tenders means the
engineers only ever hear from the bot when it has something — a digest that says
"nothing today" every day is one people learn to swipe away, and then they swipe
away the day it mattered.
"""

import subprocess
import sys

REPO = "C:/Users/Adir/Desktop/Coding/Dev/tenders-search-automation"
WORKSPACE = "C:/Users/Adir/Desktop/Coding/Dev/tenders-hermes"
IMAGE = "tenders-agent:1.0"
SOURCE = "state/classified-local.json"
LIMIT = "5"

# The renderer emits this heading when nothing matched. Matching on it is how we
# stay silent without teaching the renderer about delivery.
EMPTY_MARKER = "אין חדש"


def main() -> int:
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{REPO}:/repo:ro",
        "-v", f"{WORKSPACE}:/workspace",
        "-w", "/workspace",
        IMAGE,
        "node", "harness/digest.mjs", "--file", SOURCE, "--limit", LIMIT,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=300)
    except FileNotFoundError:
        print("[digest] docker not found on PATH", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("[digest] timed out after 300s", file=sys.stderr)
        return 1

    if result.returncode != 0:
        # Failures go to stderr so they surface in the job log without being
        # delivered to the client chat as if they were tender content.
        print(
            f"[digest] exit {result.returncode}: {result.stderr.decode('utf-8', 'replace')[:500]}",
            file=sys.stderr,
        )
        return result.returncode

    text = result.stdout.decode("utf-8", "replace").strip()

    if not text or EMPTY_MARKER in text:
        print("[digest] nothing new — staying silent", file=sys.stderr)
        return 0

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
