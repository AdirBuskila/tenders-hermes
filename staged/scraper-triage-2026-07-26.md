# Scraper triage — 2026-07-26

> **SUPERSEDED by `scraper-triage-2026-07-27.md`.** That sweep covers all 34
> sites instead of 4, and **corrects one finding below**: `ayalon` does *not*
> have selector drift. This document probed it with a hand-supplied `--row tr`;
> its real row selector is `div.tenders__item`, which matches 625/625. Kept for
> history — the wrong turn is part of the record.

**Status:** proposal / findings only. Nothing in `/repo` was modified.
**Method:** `harness/probe.mjs`, run from the container on Adir's home
connection (Israel), reproducing the production fetch path exactly — same
Playwright 1.60.0, same user agent, same `Accept-Language: he-IL`, same
`domcontentloaded` + `waitForSelector` strategy as `fetchDynamic.ts`.

---

## Headline

**Four of the failing sites do not share a cause, and two of them are not
broken at all — they only fail from GitHub Actions.**

| Site | From GitHub Actions | From here (home IP) | Real cause |
|---|---|---|---|
| `iroads` — נתיבי ישראל | `✓ 0 tenders` | **HTTP 200, 934 rows** ✅ | **IP-based blocking** |
| `ayalon` — נתיבי איילון | `✗ HTTP 403` | HTTP 200, 0 rows | **IP blocking + selector drift** |
| `nta` — נת"ע | `✓ 0 tenders` | HTTP 403 | Bot block, both origins |
| `rail` — רכבת ישראל | `✓ 0 tenders` | HTTP 403 (Cloudflare) | Bot block, both origins |

The evidence for `rail` is unambiguous — the page it serves is a Cloudflare
interstitial:

> `האימות הסתיים בהצלחה. ממתין לתגובה של rail.co.il` …
> `Enable JavaScript and cookies to continue`

And `iroads` returns genuine tenders from here, currently invisible in production:

> מכרז פומבי מס' 56/26 להתקשרות עם סוכן ביטוח… — הגשה 08/09/2026
> מכרז פומבי מס' 66/26 נת"צ בן גוריון אשקלון מקטע מערבי מקטעים 3+4 — הגשה 16/08/2026

## What this changes

The working assumption was selector drift — portals redesigned, CSS classes
moved. **That is not the main story.** The dominant failure is *where the
scraper runs*: GitHub Actions runners use datacenter IP ranges that Israeli
government-adjacent portals block by reputation. Same code, same selectors,
different IP, different outcome.

This is good news and bad news. Good: `iroads` needs **no code change at all** —
934 tenders are one deployment move away. Bad: it can't be fixed by editing
selectors, so the existing plan wouldn't have found it.

---

## Root-cause bug: 403s are silently swallowed

`src/lib/scraper/fetchDynamic.ts` catches navigation failures and continues:

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
happily returns 27 KB of Cloudflare error page, `extractRows` finds no rows, and
the run logs:

```
[nta] ✓ 0 tenders
```

A tick mark, for a hard block. This single unchecked return value is why 8 sites
fail *silently* rather than loudly, and why nobody noticed for weeks.

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

**Impact:** converts silent zeros into visible `✗` errors. Does not recover any
tender by itself — it makes the existing breakage *observable*, which is the
precondition for everything else. Lowest-risk, highest-value change here.

**Risk:** sites that legitimately serve a non-2xx and still render content would
start erroring. None observed among the 34, but worth one supervised run.

---

## Recommended sequence

1. **Apply the `fetchDynamic.ts` status check.** Small, safe, makes the other
   16 failures self-reporting. Do this first regardless of everything else.
2. **Move the scrape off GitHub Actions runners.** Recovers `iroads` (934 rows)
   with zero code change, and is the precondition for fixing `ayalon`.
   ⚠️ See the caveat below — this needs verification before committing to a host.
3. **Re-probe `ayalon` from the new origin**, then fix its selectors. The `tr`
   selector matches nothing against 1.1 MB of served HTML, so it genuinely
   drifted — but there is no point tuning selectors against a 403.
4. **`nta` and `rail` need a different approach entirely.** Blocked from both
   origins; `rail` is behind a full Cloudflare challenge. Options, in order of
   preference: check for an official tenders API or RSS feed; ask the client
   whether Groisman has a portal account whose session could be reused; only
   then consider a residential-egress proxy — and that is a decision for the
   client, not a technical default.

### ⚠️ Caveat on the VPS plan

Hetzner is a datacenter provider, and Hetzner ranges are **widely blocked by
bot-protection vendors** — potentially worse than GitHub Actions. Moving there
may not recover `iroads` and could regress currently-working sites.

**Verify before committing:** spin up the box hourly-billed (~€0.01), run
`harness/probe.mjs` against `iroads`, `ayalon`, `nta` and `rail` from it, and
compare against this table. If the results are worse than GitHub Actions, the
right answer is an Israeli host, or keeping collection on a machine with a
domestic IP and running only the agent in the cloud.

This is cheap to test and expensive to assume.

---

## Verification performed

- Reproduced the production fetch path exactly (same version, UA, headers, waits)
- `iroads`: 934 rows matched `li.item.tender-item`; sampled titles are real
  tenders with parseable Hebrew deadlines
- `rail`: served HTML is a Cloudflare interstitial, quoted above
- `nta`: HTTP 403, 27 KB error page, zero rows
- `ayalon`: HTTP 200, 1.1 MB served, `tr` matches zero — drift confirmed
- Nothing under `/repo` was written; mount is read-only

## Not verified

- Whether a Hetzner IP behaves better or worse than a GitHub Actions IP
- Whether the remaining 12 failing sites share the IP-blocking cause
- Whether `ayalon`'s content is table-based at all under its new markup
