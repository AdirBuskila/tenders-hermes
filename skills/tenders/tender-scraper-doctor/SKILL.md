---
name: tender-scraper-doctor
description: Diagnose a tender site returning zero rows
version: 1.0.0
metadata:
  hermes:
    tags: [tenders, scraping, diagnosis, selectors]
    category: tenders
    requires_toolsets: [terminal, file, web]
---

# Tender scraper doctor

## When to use

- `db.mjs health` reports a site in `staleSites`.
- A scrape run logs `[site] ✓ 0 tenders` — **fulfilled but empty**, which is the
  dangerous case. The adapter did not throw, so nothing alerts, and the site's
  entire inventory quietly disappears from the product.
- A scrape run logs `[site] ✗ Error: HTTP 403` or similar.

## Why this matters more than it looks

Israeli agency portals redesign without notice. A changed CSS class turns a
working adapter into a silent zero. The production run on 2026-07-26 had 16 of
34 configs failing this way, including נת"ע and רכבת ישראל — the two agencies
that publish most of the light-rail project-management tenders this client
actually bids on. A relevance filter cannot find what was never scraped.

## Procedure

1. **Identify the failure class.** Read the site's config:

   ```bash
   cat /repo/src/lib/scraper/configs/<site>.ts
   ```

   Note `url`, `fetcher` (`static` | `dynamic`), and `selectors.row`.

2. **Fetch the page as the scraper would.**

   - `fetcher: static` → `curl -sL --compressed -A "<the repo's UA>" "<url>" | head -c 4000`
   - `fetcher: dynamic` → the page needs JS; use the `web` toolset to retrieve
     rendered content, or run Playwright from `/repo` (read-only is fine —
     Playwright only reads the config).

3. **Rule out an origin block before anything else.** This is the single most
   common cause in this project and the easiest to misdiagnose, because from
   your machine the site looks perfectly healthy.

   ```bash
   node harness/probe-all.mjs --sites <site> --md
   node harness/compare-origins.mjs --prod state/prod-run.log --md
   ```

   If the site returns rows for you but nothing in production, **the scraper is
   not broken — it is refused from where it runs.** Israeli agency portals block
   datacenter IP ranges (GitHub Actions runners) by reputation. On 2026-07-27,
   21 of 34 sites were in exactly this state: healthy from an Israeli home
   connection, dead from CI, with no code fault at all.

4. **Before blaming shared infrastructure, run the differential.** If you are
   about to conclude "Playwright is broken in production", "the container is
   missing a dependency", or anything else about machinery *shared by every
   site*, you must first check whether any other site using that same machinery
   succeeds in the same run:

   ```bash
   grep -E '^\[(site1|site2)\]' state/prod-run.log
   ```

   A single passing site with the same `fetcher` disproves the hypothesis
   outright. **This check is mandatory, and skipping it has already produced one
   confident wrong diagnosis**: an agent concluded that production lacked a
   headless browser, when `iaa` — also `fetcher: 'dynamic'` — was returning 180
   tenders in the very same run. A shared-infrastructure explanation must
   explain why the infrastructure works for everyone else, and usually it can't.

5. **Classify what you found:**

   | Symptom | Class | Fix |
   |---|---|---|
   | Works from your origin, zero/403 in production | **Origin block (IP reputation)** | No code change. Relocate collection to a non-datacenter IP. Verify the new host with `probe-all.mjs` *before* committing to it. |
   | HTTP 403 / captcha / Cloudflare **from every origin** | **Bot block** | Not a selector problem. Do not touch selectors. Look for an official API/RSS, or a client-held portal account. |
   | HTTP 200, page has tender rows, `selectors.row` matches nothing | **Selector drift** | Propose a new selector. This is the case you can actually fix. |
   | HTTP 200, page genuinely lists no tenders | **Legitimately empty** | Not a bug. Record it so it stops being re-investigated. |
   | Page is now a JS app, static fetch returns a shell, config says `static` | **Fetcher mismatch** | Propose `fetcher: 'dynamic'`. Only valid if the config actually says `static` — check before proposing it. |
   | URL redirects elsewhere | **Moved** | Propose the new URL. |

4. **For selector drift only**, find the row container that holds the repeating
   tender entries, plus the child selectors for title, link and deadline.
   Verify your candidate selector actually matches more than one element and
   that the extracted text looks like tender titles — not nav links.

5. **Write a proposal. Never a patch.**

   ```bash
   mkdir -p /workspace/staged
   # write /workspace/staged/<site>-<YYYY-MM-DD>.md
   ```

   The proposal must contain:

   - Site key and current config path under `/repo`
   - Failure class from the table above
   - Evidence: the HTTP status, and the snippet of HTML that shows the change
   - The exact `SiteConfig` diff you propose, as a fenced TypeScript block
   - How many rows your proposed selector matched on the live page
   - Anything you could not verify

   `/repo` is mounted read-only. You cannot edit production and must not try.
   A human reviews the proposal and applies it.

6. **Report** the failure class and the proposal path. If several sites are
   broken, do them one at a time and rank by how much the client cares:
   נת"ע, רכבת ישראל, נתיבי איילון and תרנס-ישראל outrank a small municipality.

## Pitfalls

- **Do not conclude "it works here, so production's runtime is broken."** The
  far likelier explanation is that production is blocked from where it runs.
  Check the differential in step 4 before writing a word about infrastructure.
- **Do not propose `fetcher: 'dynamic'` for a site whose config already says
  `dynamic`.** Read the config field before naming the class — a diagnosis that
  proposes the setting already in force is self-refuting.
- **Do not "fix" a 403 by changing selectors.** The selectors are fine; the
  request was refused. Changing them destroys working config and hides the
  real cause.
- **Do not propose a selector you have not counted matches for.** `.card` may
  match 40 nav items and produce 40 junk tenders, which is worse than zero —
  junk enters the digest and the engineers stop trusting it.
- **Zero rows is not always breakage.** Some portals genuinely empty out
  between publication cycles. Check whether the page shows an explicit
  "אין מכרזים" state before declaring a bug.

## Verification

- Your proposed selector matched ≥ 1 row on the live page, and you say how many.
- The extracted titles look like tender titles, not navigation text.
- The proposal file exists under `/workspace/staged/` and names the failure class.
- You did not write anything under `/repo`.
