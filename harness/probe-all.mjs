#!/usr/bin/env node
/**
 * Probe every configured tender site from wherever this runs, and report which
 * ones are actually reachable.
 *
 * The point is comparison, not a single verdict. Production runs on GitHub
 * Actions runners; Israeli government-adjacent portals block datacenter IP
 * ranges by reputation. Running the identical fetch path from a different
 * origin separates "the scraper is broken" from "the scraper is blocked from
 * where it runs" — two problems with opposite fixes. Run this from each
 * candidate host and diff the tables before choosing where to deploy.
 *
 * Usage:
 *   node harness/probe-all.mjs                      # every site in configs.json
 *   node harness/probe-all.mjs --sites nta,rail     # just these
 *   node harness/probe-all.mjs --md                 # markdown table on stderr
 *   node harness/probe-all.mjs --out state/probe-home.json
 *
 *   --configs PATH   default state/configs.json (see dump-configs.ts)
 *   --concurrency N  default 4
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from './lib/supabase.mjs';
import { launchBrowser, loadCheerio, probeSite } from './lib/probe-core.mjs';

const DEFAULT_CONFIGS = 'state/configs.json';
const DEFAULT_CONCURRENCY = 4;

function die(msg) {
  console.error(`probe-all: ${msg}`);
  process.exit(1);
}

/** Run tasks with a bounded worker pool. */
async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        // One portal hanging must not void the other 33 results. Record the
        // failure as data and keep going.
        results[i] = {
          site: items[i].site,
          url: items[i].url,
          classification: 'probe-error',
          error: err?.message ?? String(err),
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Short human verdict — what to actually do about this site. */
function verdict(r) {
  switch (r.classification) {
    case 'ok':
      return `${r.rowCount} rows`;
    case 'bot-block':
      return 'blocked here too';
    case 'network-error':
      return 'unreachable (DNS/TLS)';
    case 'selector-drift':
      return 'serves HTML, selectors match 0';
    case 'empty-shell (likely JS app)':
      return 'empty shell';
    case 'probe-error':
      return `probe error: ${r.error}`;
    default:
      return r.classification;
  }
}

function toMarkdown(reports) {
  const lines = [
    '| Site | HTTP | Rows | Classification | Verdict |',
    '|---|---|---|---|---|',
  ];
  for (const r of reports) {
    lines.push(
      `| \`${r.site}\` | ${r.httpStatus ?? '—'} | ${r.rowCount ?? 0} | ${r.classification} | ${verdict(r)} |`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const configsPath = args.configs === true || !args.configs ? DEFAULT_CONFIGS : args.configs;
  let configs;
  try {
    // Strip a UTF-8 BOM: PowerShell's `>` redirection adds one by default, and
    // JSON.parse rejects it with an error that points at the wrong problem.
    configs = JSON.parse(readFileSync(configsPath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    die(`cannot read ${configsPath} (${err?.message}). Generate it with dump-configs.ts first.`);
  }

  if (args.sites && args.sites !== true) {
    const want = new Set(String(args.sites).split(',').map((s) => s.trim()));
    configs = configs.filter((c) => want.has(c.site));
    const missing = [...want].filter((w) => !configs.some((c) => c.site === w));
    if (missing.length) die(`unknown site(s): ${missing.join(', ')}`);
  }
  if (!configs.length) die('no sites selected');

  const concurrency = Number(args.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY;
  const cheerio = await loadCheerio();
  const browser = await launchBrowser();

  process.stderr.write(`[probe-all] ${configs.length} sites, concurrency ${concurrency}\n`);
  const started = process.hrtime.bigint();

  let reports;
  try {
    reports = await pooled(configs, concurrency, async (c) => {
      const r = await probeSite({ browser, cheerio, ...c });
      process.stderr.write(
        `  ${r.classification === 'ok' ? '✓' : '✗'} ${c.site.padEnd(16)} ${String(r.httpStatus ?? '—').padEnd(5)} rows=${String(r.rowCount).padEnd(5)} ${r.classification}\n`,
      );
      return r;
    });
  } finally {
    await browser.close().catch(() => {});
  }

  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;

  const summary = reports.reduce((acc, r) => {
    acc[r.classification] = (acc[r.classification] ?? 0) + 1;
    return acc;
  }, {});

  const payload = {
    // No timestamp is generated here on purpose — the caller passes --label so
    // two runs from different hosts can be diffed without ambiguity about
    // which is which.
    label: args.label === true || !args.label ? null : args.label,
    siteCount: reports.length,
    elapsedSeconds: Number(elapsed.toFixed(1)),
    summary,
    reports,
  };

  const outPath = args.out === true || !args.out ? null : args.out;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    process.stderr.write(`[probe-all] wrote ${outPath}\n`);
  }

  process.stderr.write(
    `\n[probe-all] ${summary.ok ?? 0}/${reports.length} returning rows in ${elapsed.toFixed(1)}s\n` +
      Object.entries(summary)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`)
        .join('\n') +
      '\n',
  );

  if (args.md) process.stderr.write('\n' + toMarkdown(reports) + '\n');

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => die(`failed: ${err?.stack ?? err}`));
