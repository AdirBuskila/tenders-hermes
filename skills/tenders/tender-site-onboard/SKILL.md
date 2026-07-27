---
name: tender-site-onboard
description: Add a new tender portal by inspecting its DOM
version: 1.0.0
metadata:
  hermes:
    tags: [tenders, scraping, onboarding, config]
    category: tenders
    requires_toolsets: [terminal, file, web]
---

# Onboard a new tender portal

## When to use

Someone gives you a URL and wants tenders from it collected — typically
"תוסיף את האתר הזה" with a link. `MVP.md` names chakar.co.il and hlr.co.il as
outstanding examples.

This is the skill that changes who can extend the system. Adding a site is
currently a developer task; done well, this makes it a five-minute conversation
with whoever noticed the missing portal.

## Procedure

1. **Read two existing configs first** — one static, one dynamic — so the
   proposal matches house style rather than inventing its own:

   ```bash
   cat /repo/src/lib/scraper/configs/jet.ts      # static
   cat /repo/src/lib/scraper/configs/nta.ts      # dynamic
   cat /repo/src/lib/scraper/types.ts            # the SiteConfig contract
   ```

2. **Fetch the listing page** and decide the fetcher:
   - Tender rows present in the raw HTML → `fetcher: 'static'`
   - Raw HTML is an empty app shell → `fetcher: 'dynamic'`

3. **Find the repeating row container**, then the child selectors for title,
   link, deadline, and tender id where present. Count the matches. A selector
   that matches exactly one element is usually wrong — it caught a heading.

4. **Check the link shape.** Relative hrefs are resolved against `cfg.url` by
   the engine, so a relative selector is fine. Confirm the anchor you picked
   points at a tender detail page and not a PDF index or a category filter.

5. **Check the date format.** Hebrew portals use dd/mm/yyyy, dd.mm.yy and
   written months inconsistently. Read
   `/repo/src/lib/scraper/parseHebrewDate.ts` and confirm the existing parser
   handles what this site emits. If it does not, say so — do not silently emit
   unparseable dates, which become "ללא תאריך" and lose the deadline urgency
   flag in the digest.

6. **Write the proposal** to `/workspace/staged/newsite-<key>-<YYYY-MM-DD>.md`
   containing:

   - The site key you propose, matching existing naming (lowercase, hyphenated)
   - A complete `SiteConfig` as a fenced TypeScript block, ready to drop into
     `/repo/src/lib/scraper/configs/<key>.ts`
   - The one-line addition needed in `configs/index.ts`
   - Sample output: 3–5 tenders your selectors actually extracted, with titles
     and URLs, so a reviewer can sanity-check without running anything
   - How many rows matched in total
   - Whether the site also has a separate RFI page (`MVP.md` §3.2 lists several
     portals that keep RFIs at a second URL — a site is not fully onboarded
     until that is checked)

7. **Report** the proposal path and the sample tenders. Never write to `/repo`.

## Pitfalls

- **Do not propose a config you have not run.** Selectors that look right in
  DevTools frequently match nothing under cheerio, which does not execute JS.
- **Watch for pagination.** Many portals show 10 per page. If the listing is
  paginated, say so — the current engine fetches one page and a silent
  truncation looks like a working adapter.
- **Check for a duplicate.** Some municipal portals are already covered
  indirectly through `muni-bids.ts`. Adding a second config for the same source
  produces duplicate tenders under two site keys.

## Verification

- Your selectors extracted ≥ 3 plausible tenders, and you listed them.
- Titles are tender titles, not nav or footer text.
- Links resolve to absolute URLs that load.
- Deadlines parse, or you flagged that they do not.
- The proposal is under `/workspace/staged/`, and `/repo` is untouched.
