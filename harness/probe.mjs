#!/usr/bin/env node
/**
 * Live-page probe for diagnosing one broken tender scraper.
 *
 * Fetches a portal exactly the way the production engine does and reports what
 * the configured selectors actually match. The fetch, analysis and failure
 * classification live in lib/probe-core.mjs, shared with probe-all.mjs.
 *
 * Usage:
 *   node harness/probe.mjs --url "https://..." --row "tr" \
 *     --sel "title=td:first-child > a" --sel "link=td.goTd a.go"
 *
 *   --static      use plain fetch instead of Playwright
 *   --dump N      print the first N chars of rendered HTML to stderr
 *   --sample N    show text from the first N matched rows
 */

import { parseArgs } from './lib/supabase.mjs';
import { launchBrowser, loadCheerio, probeSite } from './lib/probe-core.mjs';

function die(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

/** Collect repeated --sel name=selector pairs (parseArgs keeps only the last). */
function collectSelectors(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--sel') continue;
    const raw = argv[i + 1];
    if (!raw) continue;
    const eq = raw.indexOf('=');
    if (eq < 1) continue;
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const selectors = collectSelectors(argv);

  const url = args.url;
  const row = args.row ?? 'tr';
  if (!url || url === true) die('probe: --url is required');

  const cheerio = await loadCheerio();
  const browser = args.static ? null : await launchBrowser();

  try {
    const { html, ...report } = await probeSite({
      browser,
      cheerio,
      site: args.site ?? null,
      url,
      row,
      selectors,
      fetcher: args.static ? 'static' : 'dynamic',
      sampleCount: Number(args.sample ?? 3),
      keepHtml: Boolean(args.dump),
    });

    // The body goes to stderr, never into the JSON: stdout stays machine-
    // readable so `probe.mjs ... | jq` keeps working with --dump on.
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));

    if (args.dump) {
      const n = Number(args.dump) || 3000;
      process.stderr.write(`\n===== htmlLength=${report.htmlLength}, first ${n} chars =====\n`);
      process.stderr.write((html ?? '').slice(0, n) + '\n');
    }
  } finally {
    await browser?.close().catch(() => {});
  }
}

main().catch((err) => die(`probe failed: ${err?.message ?? err}`));
