# Scraper triage — complete sweep, 2026-07-27

**Status:** proposal / findings only. Nothing in `/repo` was modified.
**Supersedes:** `scraper-triage-2026-07-26.md` (partial, 4 sites — and wrong on one point, corrected below).

**Method.** All 34 site configs were dumped from the read-only `/repo` mount
(`harness/dump-configs.ts`) and probed with their *real* URLs and *real*
selectors (`harness/probe-all.mjs`), reproducing the production fetch path
byte-for-byte: same Playwright 1.60.0, same User-Agent, same
`Accept-Language: he-IL`, same `Accept`, same 20s/30s timeouts, same
`domcontentloaded` + `waitForSelector` strategy, static vs dynamic chosen by
each config's own `fetcher` field.

Compared against production run `30250394972` (2026-07-27 08:34 UTC) by joining
two machine-readable inputs (`harness/compare-origins.mjs`) — no hand-typed
numbers.

---

## Headline

**Production collects from 11 of 34 configs. From an Israeli home connection,
32 of 34 work. 21 sites are recoverable by changing where the scraper runs —
with zero code changes.**

| | Production (GitHub Actions) | Probe (home IP, Israel) |
|---|---|---|
| Configs returning rows | **11 / 34** | **32 / 34** |
| Unique publishers productive | 9 / 32 | 30 / 32 |
| Hard-blocked everywhere | — | `nta`, `rail` |

Upper bound on what relocation recovers: **1,722 rows** against the 260 tenders
production currently collects. That number is deliberately labelled an upper
bound — it counts every row the production selectors match, including closed
and archived tenders, so the true gain in *open* tenders is lower. It is not a
promise; it is the size of the thing worth measuring properly.

## The pattern nobody would guess from the logs

Every one of the 13 hard `403`s is a **`static`** fetcher site. Every one of the
7 silent `✓ 0 tenders` is a **`dynamic`** fetcher site. That split is not about
the portals at all — it is about a missing status check, explained below.

## Correction to the 2026-07-26 triage

That document claimed `ayalon` had **selector drift**. **It does not.** The
first pass probed it with a hand-supplied `--row tr`; the config's actual row
selector is `div.tenders__item`. Probed with its real selectors:

| Selector | Matched |
|---|---|
| `div.tenders__item__column:first-child h4` (title) | 625 / 625 |
| `.tenders__item__status` | 625 / 625 |
| `.tenders__item__link` | 625 / 625 |
| `.tenders__item__date` (deadline) | 450 / 625 |

`ayalon` is purely IP-blocked. The lesson is the reason this sweep dumps configs
from source instead of copying selectors by hand: a hand-typed selector produced
a confident, wrong diagnosis that would have sent someone rewriting a working
adapter.

(Only the deadline selector is genuinely partial — 175 rows carry no date
element. Worth a look, but it degrades one field, it does not break the site.)

Its top row today is core client business, currently invisible in production:

> מכרז מס' 52/26 — מכרז ממוכן (מקוון) למתן שירותי "תכנון על" בפרויקט BRT – הקו הוורוד

---

## Root-cause bug: 403s are silently swallowed on dynamic sites

`src/lib/scraper/fetchStatic.ts` gets this right:

```ts
if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
```

`src/lib/scraper/fetchDynamic.ts` does not:

```ts
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch {
  // navigation error — continue with whatever loaded
}
...
return await page.content();
```

`page.goto()` **does not throw on an HTTP 403** — it resolves with a response
object carrying `status() === 403`. The status is never read. So the function
returns a Cloudflare error page, `extractRows` finds nothing, and the run logs:

```
[nta] ✓ 0 tenders
```

A tick mark, for a hard block. **This is the entire explanation for the
static/dynamic split**: both fetchers are blocked equally often, but only one of
them says so.

### Proposed fix — `/repo/src/lib/scraper/fetchDynamic.ts`

```ts
const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

// page.goto resolves (not throws) on 4xx/5xx — an unchecked status turns a hard
// block into a silent zero-row "success". Fail loudly instead: the engine's
// Promise.allSettled already reports a rejected adapter, and markStaleClosed
// correctly skips sites that threw.
if (resp && !resp.ok()) {
  throw new Error(`HTTP ${resp.status()} from ${url}`);
}
```

**Impact:** converts silent zeros into visible `✗` errors, bringing dynamic
sites to parity with static ones. Recovers no tender by itself — it makes
existing breakage *observable*, which is the precondition for everything else.

**Risk:** a site that legitimately serves a non-2xx and still renders content
would begin erroring. None observed across the 34. One supervised run is enough
to confirm.

---

## Recommended sequence

1. **Apply the `fetchDynamic.ts` status check.** Small, safe, makes failures
   self-reporting. Do this first regardless of everything else.
2. **Move collection off GitHub Actions runners.** This is the whole ballgame:
   21 sites, zero code changes. ⚠️ See the caveat below before picking a host.
3. **`nta` and `rail` need a different approach.** Blocked from both origins;
   `rail` serves a full Cloudflare challenge (`Enable JavaScript and cookies to
   continue`). Options in order of preference: look for an official tenders API
   or RSS feed; ask whether Groisman holds a portal account whose session could
   be reused; only then consider residential egress — and that is the client's
   decision, not a technical default.
4. **`ayalon` deadline selector** — 175 of 625 rows carry no date. Low priority,
   cosmetic next to the above.

### ⚠️ Caveat on the VPS plan — unchanged and now more important

Hetzner is a datacenter provider, and its ranges are **widely blocked by
bot-protection vendors** — potentially no better than GitHub Actions. With 21
sites riding on the relocation decision, guessing here is expensive.

**Verify before committing:** rent hourly (~€0.01), run

```
node harness/probe-all.mjs --md --label hetzner --out state/probe-hetzner.json
node harness/compare-origins.mjs --home state/probe-hetzner.json --md
```

and compare against `state/probe-home.json`. If it is worse, the answer is an
Israeli host — or keeping collection on a domestic IP and running only the agent
in the cloud. The tooling to decide this now exists and takes 21 seconds.

---

## Verification performed

- 34/34 configs dumped from source; no selector or URL typed by hand
- Header parity with `fetchStatic.ts` confirmed by reading it (UA,
  Accept-Language, Accept, 20s timeout all identical)
- Full sweep completes in ~21s; results in `state/probe-home.json`
- Comparison table generated by joining the production log with the probe
  output; every figure traceable to a log line
- Low-row sites manually inspected — `bat-yam`(1), `shafir`(1), `hlr`(1),
  `arim`(2), `kal-yehud`(2) etc. return genuine Hebrew tender text
- `rail`'s single matched row is the Cloudflare interstitial, not a tender —
  caught by fixing the classifier to treat HTTP status as authoritative over
  row count
- Nothing under `/repo` was written; the mount is read-only

## Not verified

- Whether a Hetzner (or any specific VPS) IP behaves better or worse than
  GitHub Actions — **this is the open question that decides the deployment**
- How many of the 1,722 recoverable rows are *open* tenders rather than
  closed/archived — needs the real mappers, not the probe
- `cbinyamin` matches a `<style>` block as one of its 2 rows; it does this in
  production too, so it is pre-existing and out of scope here
