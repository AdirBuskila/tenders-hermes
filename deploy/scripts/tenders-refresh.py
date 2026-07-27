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

import os
import subprocess
import sys
from pathlib import Path

REPO = "C:/Users/Adir/Desktop/Coding/Dev/tenders-search-automation"
WORKSPACE = "C:/Users/Adir/Desktop/Coding/Dev/tenders-hermes"
IMAGE = "tenders-agent:1.0"

# Scrape + classify across 34 portals. Measured at ~140s; the ceiling is set
# well above that so a slow portal does not truncate the run, but not so high
# that a hung run is still holding the slot at digest time.
TIMEOUT_SECONDS = 900


def load_env() -> dict:
    """Load Hermes' .env and merge it over the inherited environment.

    Hermes does NOT export .env into --no-agent cron scripts. Verified the hard
    way: the first scheduled run scraped all 34 portals, then failed at the
    classifier with "ANTHROPIC_API_KEY not set". The digest job succeeded in the
    same setup because it needs no secrets, so nothing about it warned us.

    Parsed rather than sourced through a shell: these values are secrets and a
    token containing shell metacharacters would otherwise be interpreted.
    """
    env = dict(os.environ)
    env_path = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / ".env"

    if not env_path.exists():
        return env

    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # Do not let .env clobber something explicitly set in the environment.
        if key and key not in env:
            env[key] = value.strip().strip('"').strip("'")

    return env


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

    env = load_env()
    if not env.get("ANTHROPIC_API_KEY"):
        # Fail before spending 50s scraping, and say exactly what is missing.
        print("⚠️ tenders refresh: ANTHROPIC_API_KEY missing from environment and ~/.hermes/.env — snapshot NOT updated")
        return 1

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_SECONDS, env=env)
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
