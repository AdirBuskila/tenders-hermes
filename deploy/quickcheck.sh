#!/usr/bin/env bash
#
# One-liner IP check for a candidate host. Installs what it needs, clones this
# repository, and runs the reachability probe.
#
#   curl -fsSL https://raw.githubusercontent.com/AdirBuskila/tenders-hermes/main/deploy/quickcheck.sh | bash
#
# Exists because the multi-line version is a paste hazard: a half-pasted block
# leaves a box in a state nobody can reason about, and diagnosing that wastes
# more time than the check itself takes. One short line is hard to get wrong.
#
# Everything it does is idempotent — safe to re-run.
set -euo pipefail

REPO_URL="https://github.com/AdirBuskila/tenders-hermes.git"
BASE="${BASE:-/opt/tenders}"
LABEL="${1:-$(hostname)}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Installing prerequisites"
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq git
else
  echo "    git present"
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "    docker present"
fi

say "Fetching the harness"
mkdir -p "$BASE"
cd "$BASE"
if [ -d tenders-hermes ]; then
  cd tenders-hermes && git pull -q && cd ..
else
  git clone -q "$REPO_URL"
fi

say "Running the reachability probe (this builds a ~3.5 GB image on first run)"
exec bash "$BASE/tenders-hermes/deploy/verify-ip.sh" "$LABEL"
