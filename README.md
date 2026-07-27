# tenders-hermes

An agent deployment over a live Israeli tender-monitoring pipeline — and the
audit that found the pipeline had been quietly broken for weeks.

The production system scrapes 34 Israeli infrastructure tender portals nightly
via GitHub Actions and writes to Supabase. Real engineers use it daily. This
repository does not replace it. It puts an agent alongside it where judgment is
needed, leaves the deterministic parts alone, and physically cannot modify
production.

---

## What it found

The workflow reported success every morning. Underneath:

| | Production (GitHub Actions) | Same code, different IP |
|---|---|---|
| Sites returning tenders | **11 / 34** | **32 / 34** |

**192 open tenders were invisible to the client, recoverable with zero code
changes.** The scrapers were never broken — they were blocked from where they
run. Israeli agency portals block datacenter IP ranges by reputation.

The failures were invisible because of one unchecked return value:

```ts
// fetchStatic.ts — correct
if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

// fetchDynamic.ts — the bug
await page.goto(url, { waitUntil: 'domcontentloaded' });   // resolves on 403
return await page.content();                               // returns the block page
```

`page.goto()` does not throw on a 403. So a Cloudflare block returned 27 KB of
error page, zero rows extracted, and the run logged `✓ 0 tenders`. A tick mark,
for a hard block. That single omission is why 13 sites failed loudly and 7
failed silently — the same block, two reporting behaviours.

Findings are written to `staged/` as proposals. Nothing here patches production.

## What it does

**Relevance.** On 271 open tenders, the agent's criteria flag 45 as relevant
where the live keyword rules flag 16 — and reject 5 the keyword rules accept.
Every rejection is a keyword hit on ניהול/בקרה in a disqualified domain
(security-system supply, maintenance control, acoustics, energy management,
architectural design). A keyword filter structurally cannot make that call.

**Digest.** A Hebrew RTL summary grouped by publisher, soonest deadline first,
delivered to Telegram at 06:00 daily. Silent when there is nothing new — a bot
that says "nothing today" every day is one people stop reading.

**Diagnosis.** A skill that diagnoses a dead scraper and writes a proposal a
human reviews.

## Principle

> The agent goes where judgment is required. Deterministic code stays where
> determinism is correct.

34 hand-tuned selector configs over Hebrew government portals are fast, free and
reproducible. Replacing them with an LLM would be slower, costlier and
non-deterministic. What needs judgment is *is this tender relevant*, *why did
this collector stop working*, and *is this new portal worth adding*.

The same split runs through the whole design: the agent curates
`criteria/relevance.md`; a cheap deterministic script applies it to hundreds of
tenders a night. Nightly classification through an agent loop would cost more
and decide nothing extra.

## Guardrails

Structural, not prompt-based. The agent is not *told* to leave production alone;
it is unable to.

| Control | Mechanism |
|---|---|
| Cannot modify production | `/repo` mounted `:ro`. Verified: `touch /repo/x` → `Read-only file system` |
| Cannot write to the database | Only the anon key is forwarded; the `service_role` key never enters the container |
| Cannot reach the desktop | `computer_use` disabled; Telegram limited to an explicit toolset |
| Cannot be used by strangers | `TELEGRAM_ALLOWED_USERS` allowlist; Hermes fails closed |
| Cannot silently add skills | `write_approval` + `guard_agent_created` |

## Layout

```
criteria/relevance.md      the classifier's rules. Hebrew prose, client-editable
harness/
  lib/source.mjs           resolves Supabase vs local snapshot, always reports which
  lib/supabase.mjs         read-only access (anon key, GET only)
  lib/probe-core.mjs       shared fetch/analyse/classify for diagnosis
  db.mjs                   list / new / sites / health / sample / get
  probe-all.mjs            sweep every site from any origin
  compare-origins.mjs      join a production run against a probe run
  scrape-local.ts          run the real production adapters, no database
  classify.mjs             bulk classification, cached criteria prompt
  digest.mjs               Hebrew RTL digest
  notify.mjs               Telegram delivery, line-safe chunking
  refresh.sh               scrape → classify → snapshot
eval/
  build-set.mjs            labelled set from the client's own examples
  make-holdout.mjs         strips examples so the eval measures something
  score.mjs                precision/recall/F1; recall governs
skills/tenders/            four skills, read-only to the agent
staged/                    agent proposals awaiting human review
```

## Evaluation

Recall governs. A false positive costs an engineer ten seconds of reading; a
false negative is a tender the firm never got to bid on.

| Run | Recall | Precision |
|---|---|---|
| Full criteria | 100% | 100% |
| **Examples stripped (holdout)** | **100%** | **100%** |

The first number is worthless and is shown only to explain the second. The
criteria file embeds paraphrases of the client's 29 labelled examples, and the
eval set *is* those 29 — the classifier was graded on its own answer key.
`eval/make-holdout.mjs` strips them so the score reflects the stated rules alone.

Even the holdout is not out-of-sample: the rules were derived from these
examples. A real generalisation number needs tenders nobody has seen. That
measurement is pending, and this README will say so until it isn't.

## Running it

See [DEPLOY.md](DEPLOY.md). Step 0 is verifying that the host's IP can actually
reach the portals — 21 seconds, and it decides whether the deployment is worth
paying for.

```bash
docker build -t tenders-agent:1.0 docker/
docker run --rm -v $PWD:/workspace -w /workspace tenders-agent:1.0 npm install
docker run --rm -v <repo>:/repo:ro -v $PWD:/workspace -w /workspace \
  -e REPO_PATH=/repo tenders-agent:1.0 bash harness/refresh.sh
```

## Notes

- Secrets live in the Hermes `.env` and are forwarded by name. Nothing
  credential-bearing is in this repository.
- `state/` is gitignored. A probe run from one laptop says nothing about what
  another host would see, and a committed one invites being read as a fact.
- Built with [Hermes Agent](https://github.com/NousResearch/hermes-agent).
