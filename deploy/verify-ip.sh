#!/usr/bin/env bash
#
# Step 0 of any deployment: can this machine's IP actually reach the portals?
#
# Run this on an HOURLY-BILLED box BEFORE committing to a provider. It takes a
# few minutes and costs about one cent, and it answers the only question that
# decides whether the host is worth paying for.
#
# WHY THIS EXISTS. 21 of 34 portals currently return nothing in production for
# exactly one reason: the IP they are scraped from. Israeli agency portals block
# datacenter ranges by reputation, and CI runners live in those ranges. Hetzner,
# DigitalOcean, Vultr and Linode are datacenter ranges too — a VPS may be no
# better than what you already have, and can be worse. Guessing here means
# paying monthly for a host that cannot see the data.
#
# Deliberately standalone: it needs only Docker and this public repository. No
# private repo, no credentials, no selectors. A block shows up in the HTTP
# status and the page body, which requires no knowledge of the page structure.
#
#   curl -fsSL <raw-url>/deploy/verify-ip.sh | bash
# or
#   git clone https://github.com/AdirBuskila/tenders-hermes && cd tenders-hermes
#   bash deploy/verify-ip.sh
set -euo pipefail

IMAGE="tenders-agent:1.0"
LABEL="${1:-$(hostname)}"

cd "$(dirname "$0")/.."

echo "==> Verifying portal reachability from this host"
echo "    label: $LABEL"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. On Ubuntu:" >&2
  echo "  curl -fsSL https://get.docker.com | sh" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> Building $IMAGE (a few minutes; the Playwright base image is ~3.5 GB)"
  docker build -t "$IMAGE" docker/
fi

if [ ! -d node_modules ]; then
  echo "==> Installing harness dependencies"
  docker run --rm -v "$PWD:/workspace" -w /workspace "$IMAGE" npm install --no-audit --no-fund
fi

echo "==> Probing 34 portals (reachability only)"
docker run --rm -v "$PWD:/workspace" -w /workspace "$IMAGE" \
  node harness/probe-all.mjs \
    --configs deploy/portals.json \
    --ip-check \
    --label "$LABEL" \
    --out "state/probe-$LABEL.json" \
  >/dev/null

echo
cat <<'INTERPRET'
==> How to read this

Compare the **refused** count against the reference baseline, measured from an
Israeli home connection on 2026-07-27:

    reference:  29 reachable · 3 challenged · 2 refused   <- nta and rail only

  refused ≈ 2       This host is accepted. Proceed with the deployment.
  refused ≫ 2       This host is being blocked by reputation. Do not rent it
                    monthly — try another provider, ideally an Israeli one.

`refused` (HTTP 403/429) is the number that matters. `challenged` is a soft
signal with known false positives on small pages, and `reachable` is measured
with a generic row selector so it understates what a real scrape would collect.

If every datacenter provider is refused, the answer is architectural rather
than commercial: keep collection on a domestic IP and run only the agent in the
cloud. They are already separate programs, so that split costs nothing.
INTERPRET
