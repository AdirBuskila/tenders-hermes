#!/usr/bin/env node
/**
 * Read-only data access CLI for the tenders agent.
 *
 * Every command prints a single JSON object carrying a `source` block, so the
 * agent always knows whether it read the production table or a local snapshot
 * and can say so. See harness/lib/source.mjs for why both exist, and
 * harness/lib/supabase.mjs for the security posture.
 *
 * Usage:
 *   node harness/db.mjs list [--site nta] [--publisher "נתיבי איילון"]
 *                            [--search "רכבת קלה"] [--relevant-only]
 *                            [--tier A] [--open-only] [--limit 50]
 *   node harness/db.mjs new --since 2026-07-25T00:00:00Z [--relevant-only]
 *   node harness/db.mjs health
 *   node harness/db.mjs sites
 *   node harness/db.mjs sample --limit 200
 *   node harness/db.mjs get --site nta --id 3/26
 */

import { emit, fail, parseArgs } from './lib/supabase.mjs';
import { loadTenders, matches } from './lib/source.mjs';

const bool = (v) => v === true || v === 'true';

/**
 * Filter the loaded set.
 *
 * `--publisher` and `--search` are substring matches because the caller is an
 * agent relaying a human's words: someone asks for "נתיבי איילון" and the
 * stored publisher may be "נתיבי איילון בע\"מ". An exact match would return
 * nothing and the agent would report, truthfully and unhelpfully, that there
 * are none — the failure this whole command exists to prevent.
 */
function applyFilters(tenders, args) {
  let out = tenders;

  if (args.site && args.site !== true) out = out.filter((t) => matches(t.site, args.site));
  if (args.publisher && args.publisher !== true) {
    out = out.filter((t) => matches(t.publisher, args.publisher) || matches(t.site, args.publisher));
  }
  if (args.search && args.search !== true) out = out.filter((t) => matches(t.title, args.search));
  if (args.tier && args.tier !== true) {
    out = out.filter((t) => String(t.tier ?? '').toUpperCase() === String(args.tier).toUpperCase());
  }
  if (bool(args['relevant-only'])) out = out.filter((t) => t.relevant === true);
  if (bool(args['open-only'])) out = out.filter((t) => t.status === 'open');

  // Soonest deadline first; undated sink to the bottom rather than sorting as
  // epoch-zero and burying the urgent ones.
  out = [...out].sort((a, b) => {
    const da = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
    const db = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
    return da - db;
  });

  return out;
}

async function cmdList(args) {
  const { source, tenders } = await loadTenders();
  const filtered = applyFilters(tenders, args);
  const limit = Number(args.limit ?? 50);

  emit({
    source,
    matched: filtered.length,
    // Reported separately from `matched` so a truncated answer can never be
    // mistaken for a complete one.
    returned: Math.min(filtered.length, limit),
    truncated: filtered.length > limit,
    tenders: filtered.slice(0, limit),
  });
}

async function cmdNew(args) {
  if (!args.since || args.since === true) fail('new: --since <iso8601> is required');
  if (Number.isNaN(Date.parse(args.since))) fail(`new: invalid --since value: ${args.since}`);

  const { source, tenders } = await loadTenders();
  const cutoff = Date.parse(args.since);

  // A snapshot has no first_seen_at — it is a point-in-time capture, not a
  // change feed. Say that rather than returning everything as if it were new.
  const dated = tenders.filter((t) => t.firstSeenAt);
  const recent = dated.filter((t) => Date.parse(t.firstSeenAt) >= cutoff);

  const filtered = applyFilters(source.kind === 'snapshot' ? tenders : recent, args);

  emit({
    source,
    since: args.since,
    sinceApplied: source.kind !== 'snapshot',
    note:
      source.kind === 'snapshot'
        ? 'Snapshot has no first_seen_at history, so --since was NOT applied. These are all current tenders, not only new ones.'
        : undefined,
    count: filtered.length,
    tenders: filtered.slice(0, Number(args.limit ?? 200)),
  });
}

/** One row per site: how much it holds and how fresh it is. */
async function cmdSites() {
  const { source, tenders } = await loadTenders();

  const bySite = new Map();
  for (const t of tenders) {
    const cur = bySite.get(t.site) ?? {
      site: t.site,
      publisher: t.publisher,
      total: 0,
      open: 0,
      relevant: 0,
    };
    cur.total++;
    if (t.status === 'open') cur.open++;
    if (t.relevant === true) cur.relevant++;
    bySite.set(t.site, cur);
  }

  emit({
    source,
    siteCount: bySite.size,
    sites: [...bySite.values()].sort((a, b) => b.total - a.total),
  });
}

/**
 * Per-site freshness.
 *
 * A site whose newest last_seen_at lags well behind the rest of the table is
 * almost always a broken selector rather than a quiet week — Israeli tender
 * portals redesign without notice. Deliberately computed relative to the
 * freshest site rather than wall-clock, so the whole pipeline being down for a
 * day does not flag every site as individually broken.
 */
async function cmdHealth() {
  const { source, tenders } = await loadTenders();

  if (source.kind === 'snapshot') {
    // Staleness is meaningless in a snapshot: every row was captured in the
    // same run, so they are all equally fresh by construction. Reporting
    // "0 stale sites" here would be a false all-clear.
    return emit({
      source,
      applicable: false,
      note:
        'Freshness cannot be assessed from a snapshot — every row was captured in one run. ' +
        'Use harness/probe-all.mjs to check which sites are actually reachable, and ' +
        'harness/compare-origins.mjs to compare against the production run.',
      siteCount: new Set(tenders.map((t) => t.site)).size,
      tenderCount: tenders.length,
    });
  }

  const bySite = new Map();
  for (const t of tenders) {
    const cur = bySite.get(t.site) ?? { site: t.site, total: 0, open: 0, newestSeen: null };
    cur.total++;
    if (t.status === 'open') cur.open++;
    if (!cur.newestSeen || (t.lastSeenAt ?? '') > cur.newestSeen) cur.newestSeen = t.lastSeenAt;
    bySite.set(t.site, cur);
  }

  const sites = [...bySite.values()].sort((a, b) =>
    (a.newestSeen ?? '').localeCompare(b.newestSeen ?? ''),
  );
  const freshest = sites.reduce((max, s) => (s.newestSeen && s.newestSeen > max ? s.newestSeen : max), '');
  const staleThresholdHours = 48;
  const cutoff = freshest
    ? new Date(Date.parse(freshest) - staleThresholdHours * 3600_000).toISOString()
    : null;

  for (const s of sites) s.stale = cutoff ? !s.newestSeen || s.newestSeen < cutoff : false;

  emit({
    source,
    pipelineLastSeen: freshest || null,
    staleThresholdHours,
    staleSites: sites.filter((s) => s.stale).map((s) => s.site),
    sites,
  });
}

/**
 * Deterministic stride sample for building the evaluation set. Same ordering
 * always yields the same sample, so eval runs stay comparable across days.
 */
async function cmdSample(args) {
  const { source, tenders } = await loadTenders();
  const limit = Number(args.limit ?? 200);
  const stride = Math.max(1, Math.floor(tenders.length / limit));
  const sampled = [];
  for (let i = 0; i < tenders.length && sampled.length < limit; i += stride) {
    sampled.push(tenders[i]);
  }
  emit({ source, requested: limit, pool: tenders.length, count: sampled.length, tenders: sampled });
}

async function cmdGet(args) {
  if (!args.site || !args.id) fail('get: --site <site> --id <tender_id> are both required');
  const { source, tenders } = await loadTenders();
  const found = tenders.filter(
    (t) => matches(t.site, args.site) && String(t.tenderId ?? '') === String(args.id),
  );
  emit({ source, count: found.length, tenders: found });
}

const [, , cmd, ...rest] = process.argv;
const commands = {
  list: cmdList,
  new: cmdNew,
  sites: cmdSites,
  health: cmdHealth,
  sample: cmdSample,
  get: cmdGet,
};

if (!cmd || !commands[cmd]) {
  fail(`Unknown command "${cmd ?? ''}". Expected one of: ${Object.keys(commands).join(', ')}`);
}

commands[cmd](parseArgs(rest)).catch((err) => fail(`${cmd} failed: ${err?.message ?? err}`));
