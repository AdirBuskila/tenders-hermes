#!/usr/bin/env bash
#
# Provision a fresh Ubuntu box to run the tenders agent 24/7.
#
# RUN deploy/verify-ip.sh FIRST. If this host's IP is refused by the portals,
# everything below works perfectly and collects nothing — which is exactly the
# failure already in production. This script refuses to continue without that
# check having passed.
#
#   bash deploy/bootstrap.sh
#
# Idempotent: safe to re-run after fixing a step. Prompts for secrets rather
# than taking them as arguments, so they never land in shell history.
set -euo pipefail

BASE="${BASE:-/opt/tenders}"
PROD_REPO="${PROD_REPO:-}"          # e.g. github.com/owner/tenders-search-automation
IMAGE="tenders-agent:1.0"
HERMES_HOME="$HOME/.hermes"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || warn "Not running as root — sudo may prompt."

# ---------------------------------------------------------------- guard rails
say "Checking the IP verification result"
LATEST_PROBE=$(ls -t "$BASE"/tenders-hermes/state/probe-*.json 2>/dev/null | head -1 || true)
if [ -z "$LATEST_PROBE" ]; then
  die "No probe result found. Run deploy/verify-ip.sh on this host first — it is
    the step that decides whether this box can see the data at all."
fi
REFUSED=$(grep -o '"refused"[[:space:]]*:[[:space:]]*[0-9]*' "$LATEST_PROBE" | grep -o '[0-9]*$' || echo 0)
echo "    $LATEST_PROBE reports refused=$REFUSED (reference baseline: 2)"
if [ "${REFUSED:-0}" -gt 6 ]; then
  die "This host is being blocked ($REFUSED portals refused vs 2 on a good host).
    Do not deploy here. Destroy the box and try another provider."
fi

# ------------------------------------------------------------------- packages
say "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "    already installed"
fi

say "Installing build prerequisites"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

# ---------------------------------------------------------------------- repos
say "Cloning repositories into $BASE"
mkdir -p "$BASE"
cd "$BASE"

if [ ! -d tenders-hermes ]; then
  git clone -q https://github.com/AdirBuskila/tenders-hermes.git
else
  (cd tenders-hermes && git pull -q)
fi

if [ ! -d tenders-search-automation ]; then
  [ -n "$PROD_REPO" ] || die "PROD_REPO is not set. The production repo is private:
    export PROD_REPO=github.com/<owner>/tenders-search-automation"

  # Try an ordinary clone first. If `gh auth login` has run, or a credential
  # helper is configured, this succeeds and no token ever has to be created,
  # pasted or stored. Only fall back to a token when git actually cannot
  # authenticate — a prompt nobody needs is a prompt that gets pasted into the
  # wrong window.
  if git clone -q "https://${PROD_REPO}.git" tenders-search-automation 2>/dev/null; then
    echo "    cloned using existing git credentials"
  else
    echo "    no usable git credentials for a private repo."
    echo "    Easiest fix, in another shell:  gh auth login   (then re-run this script)"
    echo "    Or paste a classic PAT with 'repo' scope now (input hidden, not stored):"
    read -rs GH_TOKEN
    echo
    [ -n "$GH_TOKEN" ] || die "no token supplied and no git credentials available"
    git clone -q "https://${GH_TOKEN}@${PROD_REPO}.git" tenders-search-automation
    unset GH_TOKEN
    # The token would otherwise be written into .git/config by the clone URL.
    git -C tenders-search-automation remote set-url origin "https://${PROD_REPO}.git"
  fi
else
  echo "    production repo already present"
fi

say "Installing production dependencies (Linux binaries)"
# Must happen ON this host: a checkout carrying another platform's node_modules
# ships a native esbuild that cannot execute here.
cd "$BASE/tenders-search-automation" && npm ci --silent

say "Building the sandbox image"
cd "$BASE/tenders-hermes"
docker build -q -t "$IMAGE" docker/ >/dev/null
docker run --rm -v "$PWD:/workspace" -w /workspace "$IMAGE" npm install --no-audit --no-fund --silent

say "Verifying the read-only mount is actually enforced"
if docker run --rm -v "$BASE/tenders-search-automation:/repo:ro" "$IMAGE" \
     touch /repo/__write_test 2>/dev/null; then
  rm -f "$BASE/tenders-search-automation/__write_test"
  die "The production mount is WRITABLE. That guardrail is load-bearing — stop
    and fix the volume flags before going further."
fi
echo "    ✓ /repo rejects writes"

# --------------------------------------------------------------------- hermes
say "Installing Hermes"
if ! command -v hermes >/dev/null 2>&1; then
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
else
  echo "    already installed"
fi

say "Writing secrets to $HERMES_HOME/.env"
mkdir -p "$HERMES_HOME"
if [ -f "$HERMES_HOME/.env" ] && grep -q TELEGRAM_BOT_TOKEN "$HERMES_HOME/.env"; then
  echo "    .env already populated — leaving it alone"
else
  echo "    values are hidden as you type; nothing is echoed or logged"
  read -rsp "    ANTHROPIC_API_KEY: "      ANTHROPIC_API_KEY; echo
  read -rsp "    SUPABASE_URL:      "      SUPABASE_URL; echo
  read -rsp "    SUPABASE_ANON_KEY: "      SUPABASE_ANON_KEY; echo
  read -rsp "    TELEGRAM_BOT_TOKEN: "     TELEGRAM_BOT_TOKEN; echo
  read -rp  "    TELEGRAM_CHAT_ID:  "      TELEGRAM_CHAT_ID
  cat > "$HERMES_HOME/.env" <<ENVEOF
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
TELEGRAM_ALLOWED_USERS=$TELEGRAM_CHAT_ID
ENVEOF
  chmod 600 "$HERMES_HOME/.env"
  unset ANTHROPIC_API_KEY SUPABASE_ANON_KEY TELEGRAM_BOT_TOKEN
  echo "    ✓ written, mode 600"
fi

say "Applying Hermes configuration"
python3 - "$BASE" <<'PYEOF'
import sys, pathlib, re
base = sys.argv[1]
cfg = pathlib.Path.home() / ".hermes" / "config.yaml"
if not cfg.exists():
    print("    config.yaml not found yet — run `hermes` once, then re-run this script")
    sys.exit(0)

text = cfg.read_text(encoding="utf-8")
block = f"""terminal:
  backend: docker
  cwd: /workspace
  timeout: 300
  docker_image: tenders-agent:1.0
  docker_mount_cwd_to_workspace: false
  docker_volumes:
    - {base}/tenders-search-automation:/repo:ro
    - {base}/tenders-hermes:/workspace
  docker_forward_env:
    - SUPABASE_URL
    - SUPABASE_ANON_KEY
    - ANTHROPIC_API_KEY
    - TELEGRAM_BOT_TOKEN
    - TELEGRAM_CHAT_ID
  docker_network: true
skills:
  external_dirs:
    - {base}/tenders-hermes/skills
  guard_agent_created: true
  write_approval: true
session_reset:
  mode: idle
  idle_minutes: 180
platform_toolsets:
  telegram:
    - terminal
    - file
    - web
    - skills
    - todo
    - memory
    - cronjob
    - clarify
"""
# Replace each top-level key we own; append if absent.
for key in ("terminal", "skills", "session_reset", "platform_toolsets"):
    text = re.sub(rf"^{key}:.*?(?=^\S|\Z)", "", text, flags=re.S | re.M)
cfg.write_text(text.rstrip() + "\n" + block, encoding="utf-8")
print("    ✓ terminal / skills / session_reset / platform_toolsets set")
PYEOF

say "Pointing the cron scripts at this host"
mkdir -p "$HERMES_HOME/scripts"
for f in tenders-refresh tenders-digest; do
  src="$BASE/tenders-hermes/deploy/scripts/$f.py"
  [ -f "$src" ] || continue
  sed -e "s|^REPO = .*|REPO = \"$BASE/tenders-search-automation\"|" \
      -e "s|^WORKSPACE = .*|WORKSPACE = \"$BASE/tenders-hermes\"|" \
      "$src" > "$HERMES_HOME/scripts/$f.py"
  echo "    ✓ $f.py"
done

cat <<'NEXT'

==> Remaining steps — these need you, not a script

  1. Connect a model (OAuth needs a browser):
       hermes auth add anthropic --type oauth --no-browser
       hermes model
     Or copy ~/.hermes/auth.json from a machine where you already did this.

  2. Disable the toolset a headless box has no use for:
       hermes tools disable computer_use

  3. Prove the pipeline works here before trusting a schedule:
       cd /opt/tenders/tenders-hermes
       docker run --rm -e ANTHROPIC_API_KEY -e REPO_PATH=/repo \
         -v /opt/tenders/tenders-search-automation:/repo:ro \
         -v $PWD:/workspace -w /workspace tenders-agent:1.0 bash harness/refresh.sh

  4. Schedule, then force a run rather than waiting for morning:
       hermes cron create "30 5 * * *" --name tenders-refresh --script tenders-refresh.py --no-agent --deliver telegram
       hermes cron create "0 6 * * *"  --name tenders-daily-digest --script tenders-digest.py --no-agent --deliver telegram
       hermes cron list
       hermes cron run <job-id> && hermes cron tick

  5. Keep it alive across reboots:
       hermes gateway install
       hermes gateway status

NEXT
