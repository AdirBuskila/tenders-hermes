/**
 * Where tenders come from.
 *
 * There are two sources and the agent must never have to care which is live:
 *
 *   1. The production Supabase table — the real thing, read-only, anon key.
 *   2. A local snapshot produced by scrape-local.mjs/classify.mjs.
 *
 * WHY A FALLBACK EXISTS. The production table is readable only by a credential
 * this deployment deliberately does not hold: the anon role has no RLS read
 * policy, so PostgREST answers `200` with an empty array. An agent asked "show
 * me the נתיבי איילון tenders" then truthfully answers "the database is empty",
 * which is correct, useless, and — worse — invites it to guess at causes
 * ("the pipeline must not have run"). That exact exchange happened.
 *
 * The fallback is never silent. Every payload carries a `source` block naming
 * the origin and the reason, so the agent can say "from a local snapshot taken
 * at X" instead of implying it read production. A silent fallback would be a
 * worse bug than the empty table.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELECT_FIELDS,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  fail,
  query,
  readJsonFile,
} from './supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** Checked in order; the first that exists wins. */
const SNAPSHOT_CANDIDATES = [
  'state/classified-local.json',
  'state/tenders-local.json',
];

const MAX_ROWS = 10000;

/**
 * Normalise a tender to one shape regardless of origin.
 *
 * Supabase uses snake_case and a single `relevant` boolean written by the live
 * keyword rules; the snapshot uses camelCase and carries both the agent's
 * verdict and production's. Downstream code should never branch on which.
 */
function normalise(t) {
  const agent = t.agent_relevant;
  const production = t.production_relevant ?? t.relevant;

  return {
    site: t.site ?? null,
    tenderId: t.tenderId ?? t.tender_id ?? null,
    title: t.title ?? '',
    publisher: t.publisher ?? null,
    region: t.region ?? null,
    deadline: t.deadline ?? null,
    status: t.status ?? null,
    url: t.url ?? null,

    // The agent's verdict wins when present, but production's is kept
    // alongside rather than overwritten — the difference between them is the
    // entire point of shadow mode.
    relevant: agent ?? production ?? null,
    tier: t.tier ?? null,
    reason: t.agent_reason ?? t.relevanceReason ?? t.relevance_reason ?? t.production_reason ?? null,
    agentRelevant: agent ?? null,
    productionRelevant: production ?? null,

    firstSeenAt: t.first_seen_at ?? null,
    lastSeenAt: t.last_seen_at ?? null,
  };
}

function findSnapshot() {
  const explicit = process.env.TENDERS_SNAPSHOT;
  if (explicit) {
    const p = resolve(ROOT, explicit);
    return existsSync(p) ? p : null;
  }
  for (const candidate of SNAPSHOT_CANDIDATES) {
    const p = resolve(ROOT, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

function loadSnapshot(path, reason) {
  const payload = readJsonFile(path);
  const rows = Array.isArray(payload) ? payload : (payload.tenders ?? []);
  return {
    source: {
      kind: 'snapshot',
      path: path.replace(ROOT, '').replace(/^[\\/]/, ''),
      takenAt: statSync(path).mtime.toISOString(),
      reason,
      note: 'Local snapshot of the live portals, not the production database.',
    },
    tenders: rows.map(normalise),
  };
}

/**
 * Load every tender from the best available source.
 *
 * Filtering happens in memory afterwards rather than in PostgREST. At this
 * scale (hundreds to low thousands of rows) the cost is nothing, and it means
 * the snapshot and the database support exactly the same query surface — a
 * filter that works against one cannot silently not work against the other.
 */
export async function loadTenders({ preferSnapshot = false, dedupe: shouldDedupe = true } = {}) {
  const result = await resolveSource({ preferSnapshot });
  if (!shouldDedupe) return result;

  const { tenders, collapsed } = dedupe(result.tenders);
  return {
    ...result,
    source: { ...result.source, deduped: collapsed, rawCount: result.tenders.length },
    tenders,
  };
}

async function resolveSource({ preferSnapshot }) {
  const snapshotPath = findSnapshot();

  if (preferSnapshot || process.env.TENDERS_SNAPSHOT) {
    if (!snapshotPath) {
      fail(`TENDERS_SNAPSHOT is set but no snapshot found. Looked for ${process.env.TENDERS_SNAPSHOT}`);
    }
    return loadSnapshot(snapshotPath, 'explicitly requested');
  }

  const hasCredentials = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  if (hasCredentials) {
    const rows = await query(
      `tenders?select=${SELECT_FIELDS}&order=first_seen_at.desc&limit=${MAX_ROWS}`,
    );
    if (rows.length > 0) {
      return {
        source: { kind: 'supabase', url: SUPABASE_URL, rows: rows.length, reason: 'live production table' },
        tenders: rows.map(normalise),
      };
    }

    // 200-with-zero-rows. Do not let this be read as "there are no tenders".
    const diagnosis =
      'Supabase returned HTTP 200 with zero rows. A missing grant would return 401, ' +
      'so this is row-level security enabled with no read policy for the anon role — ' +
      'the rows exist but are not visible to this credential. Ask the project owner ' +
      'for a SELECT policy on `tenders`.';

    if (snapshotPath) {
      return loadSnapshot(snapshotPath, `${diagnosis} Falling back to the local snapshot.`);
    }
    fail(`${diagnosis} No local snapshot available either — run harness/scrape-local.ts first.`);
  }

  if (snapshotPath) {
    return loadSnapshot(snapshotPath, 'no Supabase credentials configured');
  }

  fail(
    'No tender source available. Either set SUPABASE_URL / SUPABASE_ANON_KEY, or produce a ' +
      'snapshot with harness/scrape-local.ts.',
  );
}

/**
 * Collapse the same tender listed on more than one portal.
 *
 * `dekel` is a shared bidding platform that re-lists tenders belonging to
 * נתיבי איילון, מוריה and JET, so the same tender arrives twice under different
 * site keys. Production's uniqueness key is (site, tender_id), which cannot see
 * this — the sites genuinely differ. Measured on 2026-07-27: 11 duplicated
 * rows, 3 of them relevant, i.e. three tenders that would have appeared twice
 * in one digest. Engineers stop trusting a feed that repeats itself.
 *
 * Nothing is hidden: the surviving row records the other portals in `alsoOn`.
 */
export function dedupe(tenders) {
  const key = (t) =>
    String(t.title ?? '')
      .replace(/["'׳״]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  // Prefer the most complete record, and prefer a real deadline above all —
  // a duplicate that kept the undated copy would drop the urgency marker and
  // silently demote an expiring tender to the bottom of the digest.
  const score = (t) =>
    (t.deadline ? 4 : 0) +
    (t.url ? 2 : 0) +
    (t.tenderId ? 1 : 0) +
    (t.region ? 1 : 0);

  const groups = new Map();
  for (const t of tenders) {
    const k = key(t);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  const out = [];
  let collapsed = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // Sort by score, then by site for a stable choice across runs.
    const sorted = [...group].sort(
      (a, b) => score(b) - score(a) || String(a.site).localeCompare(String(b.site)),
    );
    const [winner, ...rest] = sorted;
    collapsed += rest.length;
    out.push({
      ...winner,
      alsoOn: [...new Set(rest.map((t) => t.site))].filter((s) => s && s !== winner.site),
    });
  }

  return { tenders: out, collapsed };
}

/** Case- and whitespace-insensitive substring match, safe on null. */
export function matches(haystack, needle) {
  if (!needle) return true;
  return String(haystack ?? '')
    .toLowerCase()
    .includes(String(needle).toLowerCase().trim());
}
