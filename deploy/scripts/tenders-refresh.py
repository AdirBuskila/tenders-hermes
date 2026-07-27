#!/usr/bin/env python3
"""Refresh the tender snapshot before the morning digest.

Scheduled at 05:30 so the 06:00 digest reads data collected minutes earlier
rather than whenever someone last ran it by hand. A digest built on a stale
snapshot is the failure this pipeline exists to prevent — it looks identical to
a working one.

Prints nothing on success. A daily "refresh ok" message trains people to ignore
the bot, and then they ignore the failure too. Errors are printed, and with
--no-agent delivery that means they arrive in the chat, which is exactly when a
human should hear from it.
"""

import subprocess
import sys

REPO = "C:/Users/Adir/Desktop/Coding/Dev/tenders-search-automation"
WORKSPACE = "C:/Users/Adir/Desktop/Coding/Dev/tenders-hermes"
IMAGE = "tenders-agent:1.0"

# Scrape + classify across 34 portals. Measured at ~140s; the ceiling is set
# well above that so a slow portal does not truncate the run, but not so high
# that a hung run is still holding the slot at digest time.
TIMEOUT_SECONDS = 900


def main() -> int:
    cmd = [
        "docker", "run", "--rm",
        "-e", "ANTHROPIC_API_KEY",
        "-e", "REPO_PATH=/repo",
        "-v", f"{REPO}:/repo:ro",
        "-v", f"{WORKSPACE}:/workspace",
        "-w", "/workspace",
        IMAGE,
        "bash", "harness/refresh.sh",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_SECONDS)
    except FileNotFoundError:
        print("⚠️ tenders refresh: docker not found on PATH")
        return 1
    except subprocess.TimeoutExpired:
        print(f"⚠️ tenders refresh: timed out after {TIMEOUT_SECONDS}s — snapshot NOT updated")
        return 1

    stderr = result.stderr.decode("utf-8", "replace")

    if result.returncode != 0:
        # Surfaced to the chat deliberately: the digest that follows in 30
        # minutes will be built on an old snapshot, and someone needs to know
        # that before they trust it.
        tail = "\n".join(stderr.strip().splitlines()[-6:])
        print(f"⚠️ tenders refresh failed (exit {result.returncode}) — the 06:00 digest will use stale data\n\n{tail}")
        return result.returncode

    # Success is silent by design.
    print(stderr.strip().splitlines()[-1] if stderr.strip() else "", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
