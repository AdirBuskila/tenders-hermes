# Deploying to a VPS

The whole pipeline runs inside one container image, so deployment is mostly
"install Docker, clone two repos, set five environment variables". The one step
that is genuinely not optional is the first one.

---

## Step 0 — Verify the IP before you pay for it

**Do not prepay for a VPS. Rent it hourly, run one command, then decide.**

21 of 34 tender sites currently fail in production for exactly one reason: the
IP they are scraped from. GitHub Actions runners sit in datacenter ranges that
Israeli agency portals block by reputation. **Hetzner, DigitalOcean, Vultr and
Linode are also datacenter ranges.** A VPS may be no better than what you have,
and it can be worse.

On the candidate host:

```bash
git clone <this repo> tenders-hermes
git clone <production repo> tenders-search-automation
cd tenders-hermes
docker build -t tenders-agent:1.0 docker/
docker run --rm -v $PWD/../tenders-search-automation:/repo:ro -v $PWD:/workspace \
  -w /workspace tenders-agent:1.0 npm install
docker run --rm -v $PWD/../tenders-search-automation:/repo:ro -v $PWD:/workspace \
  -w /workspace tenders-agent:1.0 \
  node harness/probe-all.mjs --md --label vps --out state/probe-vps.json
```

Takes about 21 seconds. Compare against a known-good run:

```bash
node harness/compare-origins.mjs --home state/probe-vps.json --md
```

| Result | What to do |
|---|---|
| ~32/34 sites return rows | Good. Proceed. |
| Materially fewer than from an Israeli home connection | **Stop.** Different host, or an Israeli provider. |
| Same as GitHub Actions (~11/34) | Pointless. You would be paying to keep the bug. |

If every datacenter provider is blocked, the answer is architectural: keep
**collection** on a domestic IP and run only the **agent** in the cloud. They
are already separate programs (`scrape-local.ts` and everything else), so this
split costs nothing to adopt.

> This is the single highest-value 20 seconds in the project. Skipping it risks
> paying monthly for a host that cannot see the data.

---

## Step 1 — Host requirements

- Docker Engine
- ~8 GB disk (the Playwright image is ~3.5 GB)
- 2 GB RAM is enough; the container is capped at 5 GB but uses far less
- Outbound HTTPS. No inbound ports — Telegram is polled, not webhooked, so the
  box needs no public listener at all.

## Step 2 — Layout

Two checkouts side by side. The production repo is mounted **read-only**; that
is a load-bearing guardrail, not a convention.

```
/opt/tenders/
  tenders-search-automation/   → mounted at /repo  (read-only)
  tenders-hermes/              → mounted at /workspace
```

```bash
cd /opt/tenders/tenders-search-automation && npm ci
cd /opt/tenders/tenders-hermes && docker build -t tenders-agent:1.0 docker/
docker run --rm -v $PWD:/workspace -w /workspace tenders-agent:1.0 npm install
```

`npm ci` in the production repo matters: it installs Linux binaries. The whole
reason `scrape-local.ts` needs its own tsx is that a Windows checkout carries a
win32 esbuild that cannot run under Linux.

## Step 3 — Configuration

Install Hermes, then set `terminal:` in its `config.yaml` to Linux paths:

```yaml
terminal:
  backend: docker
  cwd: /workspace
  docker_image: tenders-agent:1.0
  docker_mount_cwd_to_workspace: false
  docker_volumes:
    - /opt/tenders/tenders-search-automation:/repo:ro
    - /opt/tenders/tenders-hermes:/workspace
  docker_forward_env: [SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
  docker_network: true

skills:
  external_dirs: [/opt/tenders/tenders-hermes/skills]
  guard_agent_created: true
  write_approval: true

platform_toolsets:
  telegram: [terminal, file, web, skills, todo, memory, cronjob, clarify]

session_reset:
  mode: idle
  idle_minutes: 180
```

Secrets go in `~/.hermes/.env` — never in the repo, never in a notes file:

```
ANTHROPIC_API_KEY=...
SUPABASE_URL=...
SUPABASE_ANON_KEY=...          # anon only. Never the service_role key.
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_ALLOWED_USERS=...     # REQUIRED — see below
```

> [!danger] `TELEGRAM_ALLOWED_USERS` is not optional
> Hermes fails closed, so an unset allowlist rejects everyone and the bot simply
> looks broken. The dangerous mistake is the opposite one: setting
> `TELEGRAM_ALLOW_ALL_USERS=true` to "fix" it. Your bot's username is public and
> discoverable, and that flag hands any stranger an agent with shell access to a
> container mounting your client's repository.

Then disable the toolset the agent has no business holding on a headless box:

```bash
hermes tools disable computer_use
```

## Step 4 — Model access

```bash
hermes auth add anthropic --type oauth   # subscription, for the agent
hermes model                             # pick anthropic + a Claude model
```

OAuth needs a browser. On a headless VPS use `--no-browser` and complete the
flow on your laptop, or run `hermes auth add` locally and copy `~/.hermes/auth.json`.

**Two credentials, on purpose.** The agent runs on the OAuth subscription; the
bulk classifier calls `api.anthropic.com` with `ANTHROPIC_API_KEY` and is billed
per token. An unattended nightly job is a service, not interactive use — running
271 classifications through the subscription would hit interactive rate limits
and the 06:00 digest would fail silently.

## Step 5 — Schedules

```bash
hermes cron create "30 5 * * *" --name tenders-refresh --script tenders-refresh.py --no-agent --deliver telegram
hermes cron create "0 6 * * *"  --name tenders-daily-digest --script tenders-digest.py --no-agent --deliver telegram
```

Edit the `REPO` and `WORKSPACE` constants at the top of both scripts to the
Linux paths. Then **prove they work** rather than waiting for the morning:

```bash
hermes cron run <job-id> && hermes cron tick
```

## Step 6 — Keep it running

```bash
hermes gateway install    # systemd unit, survives reboot
hermes gateway status
```

---

## Verify the deployment

Each of these has caught a real problem:

```bash
# Read-only mount is actually enforced
docker run --rm -v /opt/tenders/tenders-search-automation:/repo:ro tenders-agent:1.0 \
  touch /repo/SHOULD_FAIL          # must fail

# The pipeline produces data
docker run --rm ... bash harness/refresh.sh

# The agent can answer a real question
hermes chat -q "How many open tenders are there from נתיבי איילון?"

# Delivery works end to end
docker run --rm ... sh -c "node harness/digest.mjs --file state/classified-local.json --limit 3 | node harness/notify.mjs"
```

## Running costs

| Item | Cost |
|---|---|
| VPS (e.g. Hetzner CX32) | ~€6.80/month |
| Classifier (~271 tenders/night, cached) | ~$8–10/month |
| Hermes agent inference | covered by the Claude subscription |

Caching is what keeps the classifier cheap. Watch for the
`zero cache reads` warning — if the criteria file drops below Haiku 4.5's
4096-token minimum cacheable prefix, caching silently stops and the bill roughly
triples with no error.
