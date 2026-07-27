#!/usr/bin/env node
/**
 * Join a production scrape run against a local probe run and report the delta.
 *
 * This is the artifact that decides where the scraper should live. Production
 * runs on GitHub Actions; the probe runs wherever you invoke it. If a site
 * returns rows here and nothing there, the scraper is not broken — it is
 * blocked from where it runs, and no amount of selector work will fix it.
 *
 * Deliberately joins two machine-readable inputs instead of a hand-written
 * table: every number below is traceable to a log line or a probe result, and
 * transcribing 34 rows by hand is how a diagnosis picks up errors it then
 * defends.
 *
 * Usage:
 *   node harness/compare-origins.mjs \
 *     --prod state/prod-run.log --home state/probe-home.json --md
 *
 * --prod expects lines as emitted by the scrape script, e.g.
 *   [iroads] ✓ 0 tenders
 *   [ayalon] ✗ Error: HTTP 403 from https://...
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from './lib/supabase.mjs';

function die(msg) {
  console.error(`compare-origins: ${msg}`);
  process.exit(1);
}

const OK_LINE = /^\[([a-z0-9-]+)\]\s+✓\s+(\d+)\s+tenders/;
const ERR_LINE = /^\[([a-z0-9-]+)\]\s+✗\s+(.*)$/;

/**
 * Parse the production log. Sites may repeat (mr-gov is three configs sharing
 * one label), so results accumulate into a list per site rather than
 * overwriting — silently keeping only the last would misreport two of three.
 */
function parseProdLog(text) {
  const bySite = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const ok = line.match(OK_LINE);
    if (ok) {
      const [, site, count] = ok;
      push(bySite, site, { status: 'ok', tenders: Number(count) });
      continue;
    }
    const err = line.match(ERR_LINE);
    if (err) {
      const [, site, message] = err;
      push(bySite, site, { status: 'error', tenders: 0, message: message.trim() });
    }
  }
  return bySite;
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/** Collapse repeated site labels into one aggregate row. */
function aggregate(entries) {
  const tenders = entries.reduce((n, e) => n + e.tenders, 0);
  const errors = entries.filter((e) => e.status === 'error');
  return {
    runs: entries.length,
    tenders,
    errored: errors.length,
    message: errors[0]?.message ?? null,
    // "Produces nothing" is the condition that matters, and it covers both a
    // hard error and the far more dangerous ✓ 0 tenders.
    productive: tenders > 0,
  };
}

function prodVerdict(agg) {
  if (!agg) return 'not in run';
  if (agg.errored) return `✗ ${(agg.message ?? '').slice(0, 40)}`;
  return agg.tenders > 0 ? `✓ ${agg.tenders}` : '✓ 0 (silent)';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prodPath = args.prod === true || !args.prod ? 'state/prod-run.log' : args.prod;
  const homePath = args.home === true || !args.home ? 'state/probe-home.json' : args.home;

  let prodText, home;
  try {
    prodText = readFileSync(prodPath, 'utf8');
  } catch (err) {
    die(`cannot read ${prodPath} (${err?.message})`);
  }
  try {
    home = JSON.parse(readFileSync(homePath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    die(`cannot read ${homePath} (${err?.message})`);
  }

  const prod = parseProdLog(prodText);

  // Probe reports carry one entry per config, so repeated labels aggregate the
  // same way the production log does — otherwise mr-gov's three configs would
  // compare three probe rows against one production row.
  const homeBySite = new Map();
  for (const r of home.reports) push(homeBySite, r.site, r);

  const rows = [];
  for (const [site, reports] of homeBySite) {
    const agg = prod.has(site) ? aggregate(prod.get(site)) : null;
    const homeRows = reports.reduce((n, r) => n + (r.rowCount ?? 0), 0);
    const homeOk = reports.some((r) => r.classification === 'ok');
    rows.push({
      site,
      prod: agg,
      prodProductive: Boolean(agg?.productive),
      homeRows,
      homeOk,
      homeClass: reports.map((r) => r.classification).join(','),
      recoverable: homeOk && !agg?.productive,
    });
  }

  rows.sort((a, b) => Number(b.recoverable) - Number(a.recoverable) || b.homeRows - a.homeRows);

  const recoverable = rows.filter((r) => r.recoverable);
  const blockedBoth = rows.filter((r) => !r.homeOk && !r.prodProductive);
  const workingBoth = rows.filter((r) => r.homeOk && r.prodProductive);

  const recoverableRows = recoverable.reduce((n, r) => n + r.homeRows, 0);
  const prodTenders = rows.reduce((n, r) => n + (r.prod?.tenders ?? 0), 0);

  const summary = {
    sites: rows.length,
    productionProductive: rows.filter((r) => r.prodProductive).length,
    homeProductive: rows.filter((r) => r.homeOk).length,
    recoverableByRelocation: recoverable.length,
    blockedFromBothOrigins: blockedBoth.map((r) => r.site),
    productionTenderCount: prodTenders,
    // Rows, not tenders: the production number counts mapped tenders after
    // status filtering, while this counts every row the selectors match —
    // including closed and archived ones. It is an upper bound on what
    // relocation recovers, not a promise, and must be labelled as such.
    recoverableRowsUpperBound: recoverableRows,
  };

  if (args.md) {
    const md = [
      '| Site | Production | From probe origin | Recoverable |',
      '|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| \`${r.site}\` | ${prodVerdict(r.prod)} | ${r.homeOk ? `${r.homeRows} rows` : r.homeClass} | ${r.recoverable ? '**yes**' : r.homeOk ? '—' : 'no'} |`,
      ),
    ].join('\n');
    process.stderr.write(md + '\n\n');
  }

  process.stderr.write(
    `production productive: ${summary.productionProductive}/${summary.sites}\n` +
      `probe origin productive: ${summary.homeProductive}/${summary.sites}\n` +
      `recoverable by relocation: ${summary.recoverableByRelocation} sites, ` +
      `up to ${summary.recoverableRowsUpperBound} rows (upper bound — includes closed tenders)\n` +
      `blocked from both origins: ${summary.blockedFromBothOrigins.join(', ') || 'none'}\n` +
      `working in both: ${workingBoth.length}\n`,
  );

  console.log(JSON.stringify({ summary, rows }, null, 2));
}

main();
