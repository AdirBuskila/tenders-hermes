#!/usr/bin/env bash
#
# Refresh the tender snapshot: scrape the live portals, classify, write.
#
# Runs entirely inside the container, so the same command works on this laptop
# and on a VPS. This is what keeps the agent's answers current — without it the
# snapshot is a photograph of one afternoon, and an agent confidently quoting a
# week-old snapshot is worse than one that says it has no data.
#
# Writes to a temp file and moves it into place at the end: a run that dies
# halfway through must not leave a half-written snapshot that every later query
# silently reads as complete.
#
# Usage (from /workspace inside the container):
#   ./harness/refresh.sh            # scrape + classify
#   ./harness/refresh.sh --no-llm   # scrape only, skip the paid classifier
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_PATH="${REPO_PATH:-/repo}"
OUT="state/classified-local.json"
RAW="state/tenders-local.json"
TMP="state/.refresh.$$.json"

# shellcheck disable=SC2064
trap "rm -f '$TMP'" EXIT

echo "[refresh] scraping live portals via the production adapters" >&2
REPO_PATH="$REPO_PATH" node_modules/.bin/tsx harness/scrape-local.ts --open-only --out "$RAW"

if [ "${1:-}" = "--no-llm" ]; then
  echo "[refresh] --no-llm: skipping classification, snapshot is $RAW" >&2
  exit 0
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[refresh] ANTHROPIC_API_KEY not set — cannot classify." >&2
  echo "[refresh] The unclassified snapshot is at $RAW; $OUT was left unchanged." >&2
  exit 1
fi

echo "[refresh] classifying against criteria/relevance.md" >&2
node harness/classify.mjs --file "$RAW" > "$TMP"

# Only replace a good snapshot once the new one is known to be complete.
mv "$TMP" "$OUT"
echo "[refresh] wrote $OUT" >&2
