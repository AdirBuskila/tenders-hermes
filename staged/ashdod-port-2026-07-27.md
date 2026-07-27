# Diagnosis: ashdod-port — 2026-07-27

## Site key
`ashdod-port`

## Config path
`/repo/src/lib/scraper/configs/ashdod-port.ts`

## Failure class
**Origin block (IP reputation)**

## Evidence

### Production run (state/prod-run.log)
```
[ashdod-port] ✓ 0 tenders
```
The adapter completed without error (HTTP 200), but extracted zero rows.

### Live page from non-datacenter origin
URL: https://www.ashdodport.co.il/about/opportunities/tenders

The page renders a full table with active tenders. The existing selector
`table tr` matches **8 elements** (1 header row + 7 data rows). The `map`
function correctly filters the header (< 5 `<td>` elements), yielding
**7 valid tenders**, including:

| Tender ID | Title (truncated) | Status |
|---|---|---|
| 3264/TZ/26 | Tender for the Design, Fabrication, Supply… (DJLC) | פתוח להגשה |
| 26/מנ/3261 | אספקת דלק לרכבים באמצעות התקני תדלוק… | פתוח להגשה |
| בנ- 2996/2026 | שירותי חברה מנהלת לתכנון, ניהול ופיקוח… | פתוח להגשה |
| 26/בט/3277 | מתן שירותי תחקור התאמה בטחונית… | פתוח להגשה |
| 26/צד/3262 | שרותי תחזוקה לרשת חשמל מתח גבוה… | פתוח להגשה |
| 25/צד/3243 | שירותי תכנון וליווי פרויקט הקמת תחמ"ש… | פתוח להגשה |
| 3211/IN/25 | Digital Public Tender… Pilot Programs… | פתוח להגשה |

### Differential: shared infrastructure is not the cause
`iaa` uses the same `fetcher: 'dynamic'` and returned **180 tenders** in the
identical production run. Playwright and the headless browser work. The
infrastructure is healthy for every other dynamic site that isn't IP-blocked.

### Conclusion
The site returns HTTP 200 to datacenter IPs (GitHub Actions runners) but serves
an empty or JS-challenged page instead of the real tender table. The selectors
and map function are correct — the scraper has no code fault.

## Proposed fix
**No code change.** The config, selectors, and map function are all correct.

The fix is operational: relocate collection for this site to a runner with a
non-datacenter (residential or ISP-grade) IP address. Before committing to a
new host, verify it with:

```bash
node harness/probe-all.mjs --sites ashdod-port --md
```

If probe-all.mjs is not available in the repo, a manual verification from the
candidate host is:

```bash
# From the new host, run the scraper for this site only and confirm > 0 rows
npx tsx src/cli.ts scrape --site ashdod-port
```

## What could not be verified
- The exact response body that production receives (no access to the CI
  runner's network). The zero-row-with-200 pattern strongly indicates a
  soft block (empty shell or JS challenge served to datacenter IPs) rather
  than a hard 403.
- Whether the site uses a WAF vendor (Cloudflare, Imperva, etc.) — the
  page loaded cleanly from a residential IP with no visible challenge.
