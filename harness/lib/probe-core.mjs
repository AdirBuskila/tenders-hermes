/**
 * Shared diagnosis logic for the tender scrapers.
 *
 * Both the single-site probe and the batch runner import this. Keeping one copy
 * is not tidiness: the classifier below already shipped one false "bot-block"
 * verdict against a page with 934 valid rows, and a duplicated copy is how a
 * fix like that survives in one file and not the other.
 *
 * Everything here reproduces the production fetch path in `fetchDynamic.ts`
 * exactly — same Playwright version (resolved from the read-only /repo mount),
 * same user agent, same Accept-Language, same wait strategy. That parity is the
 * whole point: a portal that 403s a plain curl often serves a headless Chromium
 * with Hebrew Accept-Language just fine, and mistaking one for the other sends
 * you rewriting selectors that were never broken.
 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const ACCEPT_LANGUAGE = 'he-IL,he;q=0.9,en;q=0.8';

// Byte-identical to fetchStatic.ts. Header parity is not pedantry here: the
// whole claim is "same request, different origin, different outcome", and any
// header we send differently is a confound a reviewer would rightly attack.
export const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const STATIC_TIMEOUT = 20000;

// Production timeouts, deliberately unchanged. Shortening them here would make
// slow-but-working sites look broken and quietly invalidate the comparison.
const NAV_TIMEOUT = 30000;
const ROW_TIMEOUT = 20000;

/** Prefer the repo's own copies so versions match production exactly. */
async function fromRepo(repoPath, bare) {
  return import(repoPath).catch(() => import(bare));
}

export async function loadCheerio() {
  return fromRepo('/repo/node_modules/cheerio/dist/esm/index.js', 'cheerio');
}

export async function launchBrowser() {
  const { chromium } = await fromRepo('/repo/node_modules/playwright/index.mjs', 'playwright');
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

export async function fetchStaticHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': ACCEPT_LANGUAGE, Accept: ACCEPT },
      signal: AbortSignal.timeout(STATIC_TIMEOUT),
    });
    // Unlike production, read the body even on a non-2xx: fetchStatic throws
    // before reading it, which is correct for a scraper and useless for a
    // diagnosis — the block page is the evidence.
    return { status: res.status, html: await res.text() };
  } catch (err) {
    // A DNS or TLS failure never reaches HTTP at all. The production log shows
    // these as "TypeError: fetch failed", which reads like a bug in the
    // scraper; it is almost always the host being unreachable or TLS-broken.
    return { status: null, html: '', navError: err?.message ?? String(err) };
  }
}

/**
 * Render one page in an existing browser. Takes a browser rather than launching
 * its own so a batch run pays the Chromium startup cost once instead of 30
 * times; each site still gets a fresh context, so cookies never leak between
 * sites and one portal's session cannot mask another's block.
 */
export async function fetchRenderedHtml(browser, url, rowSelector) {
  const context = await browser.newContext({
    userAgent: UA,
    extraHTTPHeaders: { 'Accept-Language': ACCEPT_LANGUAGE },
  });
  try {
    const page = await context.newPage();

    let status = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      // Read the status even though production does not — that omission is the
      // bug this harness exists to document.
      status = resp?.status() ?? null;
    } catch (err) {
      return { status, html: '', navError: err?.message ?? String(err) };
    }

    let rowsAppeared = true;
    try {
      await page.waitForSelector(rowSelector, { timeout: ROW_TIMEOUT });
    } catch {
      rowsAppeared = false;
    }

    return { status, html: await page.content(), rowsAppeared };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Name the failure class before anyone proposes a fix — the remedy for a bot
 * block and the remedy for selector drift are opposites, and guessing wrong
 * costs days.
 */
export function classify({ status, html, rowCount, navError }) {
  if (navError) return 'network-error';

  // HTTP status first: it is authoritative in a way nothing below is. A 403 is
  // a refusal even when rows matched — a Cloudflare interstitial is still a
  // table, and rail.co.il's block page matches the configured `tr` exactly once.
  // Trusting rows over a 403 reported that block as a healthy site.
  if (status === 403 || status === 429) return 'bot-block';
  if (status && status >= 400) return `http-${status}`;

  // Below here the signals are heuristic, and matched rows beat all of them: a
  // large tender page can easily contain the word "captcha" in a consent banner
  // or an inline script, and an earlier version of this function reported a
  // 200-OK page with 934 valid rows as a bot block on exactly that basis. A
  // false "blocked" verdict is expensive — it sends you shopping for a proxy
  // instead of noticing the scraper works fine from here.
  if (rowCount > 0) return 'ok';

  if (!html) return 'empty-response';

  const lower = html.toLowerCase();
  if (/captcha|are you a robot|cf-browser-verification|just a moment|enable javascript and cookies/.test(lower)) {
    return 'bot-block';
  }
  if (html.length < 5000) return 'empty-shell (likely JS app)';
  return 'selector-drift';
}

/**
 * Classify *reachability* only — is this IP being served, or refused?
 *
 * Deliberately ignores row counts. The full classifier needs the real selectors
 * to tell "blocked" from "the page changed", but the host-selection question
 * comes earlier and is narrower: can this machine talk to the portal at all?
 * Judging that on rows matched by a generic `tr` reports healthy 200-serving
 * sites as broken, which would send someone away from a perfectly good host.
 */
export function classifyReachability({ status, html, navError }) {
  if (navError) return 'unreachable';
  if (status === 403 || status === 429) return 'refused';
  if (status && status >= 400) return `http-${status}`;
  if (!status) return 'no-response';

  const length = html?.length ?? 0;

  // Size gate BEFORE the keyword check, and this is the second time this bug
  // has been written here. Challenge interstitials are small — Cloudflare's is
  // ~27 KB. Real tender pages run 140–350 KB and routinely contain the word
  // "captcha" in a consent banner or an inline script, so an unguarded keyword
  // match labelled 17 of 34 *working* portals as challenged. A false "blocked"
  // verdict is the expensive direction: it argues against a host that is
  // actually fine.
  const CHALLENGE_MAX_BYTES = 60000;

  if (length < 2000) return 'thin-response';

  if (length < CHALLENGE_MAX_BYTES) {
    const lower = html.toLowerCase();
    if (/captcha|are you a robot|cf-browser-verification|just a moment|enable javascript and cookies/.test(lower)) {
      return 'challenged';
    }
  }

  return 'reachable';
}

/** Count rows and check each configured selector against them. */
export function analyzeHtml(cheerio, html, row, selectors = {}, sampleCount = 3) {
  const $ = cheerio.load(html || '');

  // Mirror the engine: a bare `tr` selector must drop header rows with no <td>,
  // or every table page reports rows it cannot actually extract.
  let rows = $(row);
  if (row === 'tr') rows = rows.filter((_i, el) => $(el).find('td').length > 0);

  const selectorHits = {};
  for (const [name, sel] of Object.entries(selectors)) {
    if (typeof sel !== 'string' || !sel) continue;
    let matched = 0;
    rows.each((_i, el) => {
      if ($(el).find(sel).length > 0) matched++;
    });
    selectorHits[name] = { selector: sel, matchedInRows: matched, ofRows: rows.length };
  }

  const samples = [];
  rows.slice(0, sampleCount).each((_i, el) => {
    samples.push($(el).text().replace(/\s+/g, ' ').trim().slice(0, 200));
  });

  return { rowCount: rows.length, selectorHits, samples };
}

/**
 * Probe one site end to end and return a report object.
 *
 * `keepHtml` attaches the raw body under `html`. Off by default because a batch
 * run would otherwise hold ~1 MB per site in memory and dump it into any JSON
 * the caller prints — but it is what lets you actually read the block page, and
 * reading it is how the Cloudflare interstitial on rail.co.il got identified.
 */
export async function probeSite({ browser, cheerio, site, url, row = 'tr', selectors = {}, fetcher = 'dynamic', sampleCount = 3, keepHtml = false }) {
  const useStatic = fetcher === 'static' || !browser;

  const fetched = useStatic
    ? await fetchStaticHtml(url)
    : await fetchRenderedHtml(browser, url, row);

  const { html = '', status = null, navError, rowsAppeared } = fetched;
  const { rowCount, selectorHits, samples } = analyzeHtml(cheerio, html, row, selectors, sampleCount);

  return {
    site,
    url,
    mode: useStatic ? 'static' : 'dynamic',
    httpStatus: status,
    navError: navError ?? null,
    rowsAppearedBeforeTimeout: rowsAppeared ?? null,
    htmlLength: html.length,
    rowSelector: row,
    rowCount,
    selectorHits,
    samples,
    classification: classify({ status, html, rowCount, navError }),
    reachability: classifyReachability({ status, html, navError }),
    ...(keepHtml ? { html } : {}),
  };
}
