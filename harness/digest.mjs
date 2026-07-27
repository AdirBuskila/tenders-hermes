#!/usr/bin/env node
/**
 * Builds the Hebrew "what's new since you last checked" digest.
 *
 * This is deterministic formatting, not judgment — deliberately so. The agent
 * decides *what matters*; this script decides *how it reads*. Keeping the
 * rendering out of the model means the digest looks identical every morning,
 * which is what makes it scannable in three seconds on a phone.
 *
 * Usage:
 *   node harness/digest.mjs --since-last [--commit] [--relevant-only]
 *   node harness/digest.mjs --since 2026-07-20T00:00:00Z
 *
 * --commit advances the watermark in state/last-digest.json. Without it the run
 * is a dry run, so the agent can preview a digest without consuming it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, fetchNewSince, parseArgs, readJsonFile } from './lib/supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(HERE, '..', 'state', 'last-digest.json');

/** Default lookback the very first time this ever runs. */
const COLD_START_HOURS = 24;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Hebrew display name per site key, falling back to the raw key. */
const SITE_LABELS = {
  nta: 'נת"ע',
  iroads: 'נתיבי ישראל (כחול-לבן)',
  ayalon: 'נתיבי איילון',
  rail: 'רכבת ישראל',
  transisrael: 'כביש חוצה ישראל',
  mekorot: 'מקורות',
  jet: 'ג\'ט — הרכבת הקלה בירושלים',
  arim: 'ערים',
  moriah: 'מוריה',
  iaa: 'רשות שדות התעופה',
  calcalit: 'כלכלית רמת גן',
  'hod-hasharon': 'הוד השרון',
  'bnei-brak': 'בני ברק',
  'ramat-gan': 'רמת גן',
  'rosh-haayin': 'ראש העין',
  'kal-yehud': 'קרית אונו / יהוד',
  kgat: 'קריית גת',
  dekel: 'דקל',
  ptcom: 'פתח תקווה',
  'mr-gov': 'מנהל הרכש הממשלתי',
  'ashdod-port': 'נמל אשדוד',
  cbinyamin: 'מטה בנימין',
  'muni-bids': 'מכרזים עירוניים',
};

const siteLabel = (site) => SITE_LABELS[site] ?? site;

/** dd/mm/yyyy — how an Israeli engineer expects to read a deadline. */
function formatDeadline(iso) {
  if (!iso) return 'ללא תאריך';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'ללא תאריך';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Days until deadline, or null when there is no usable date. */
function daysLeft(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / 86_400_000);
}

/**
 * Deadline urgency marker. Anything inside a week gets a flag, because the
 * failure mode that actually costs the client money is seeing a relevant tender
 * two days before it closes.
 */
const REASON_CHARS = 110;

/** Trim to a whole word and mark the cut, so nothing reads as a complete thought it isn't. */
function trim(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function urgency(days) {
  if (days === null) return '';
  if (days < 0) return ' ⛔️ עבר המועד';
  if (days <= 3) return ` 🔴 נותרו ${days} ימים`;
  if (days <= 7) return ` 🟠 נותרו ${days} ימים`;
  return '';
}

function render(tenders, { since, now }) {
  if (tenders.length === 0) {
    return [
      '*מכרזים — אין חדש*',
      '',
      `לא נמצאו מכרזים רלוונטיים חדשים מאז ${formatDeadline(since)}.`,
    ].join('\n');
  }

  // Group by site so the reader scans by publisher, which is how they think.
  const groups = new Map();
  for (const t of tenders) {
    if (!groups.has(t.site)) groups.set(t.site, []);
    groups.get(t.site).push(t);
  }

  // Soonest deadline first within each site; undated tenders sink to the bottom.
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const da = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
      const db = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
      return da - db;
    });
  }

  const lines = [
    `*מכרזים חדשים — ${tenders.length}*`,
    `מאז ${formatDeadline(since)}`,
    '',
  ];

  const sortedSites = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [site, list] of sortedSites) {
    lines.push(`*${siteLabel(site)}* (${list.length})`);
    for (const t of list) {
      const d = daysLeft(t.deadline, now);
      lines.push(`• [${t.title}](${t.url})`);
      lines.push(`  הגשה: ${formatDeadline(t.deadline)}${urgency(d)}`);
      // agent_reason comes from the classifier, relevance_reason from the live
      // keyword rules. Either may be present depending on the source.
      const why = t.agent_reason ?? t.relevance_reason;
      // Truncated because the reason is a glance-check, not the argument: the
      // engineer opens the tender to decide. Untrimmed model reasoning ran to
      // 300+ chars each and pushed a 12-tender digest past Telegram's 4096-char
      // message limit on its own.
      if (why) lines.push(`  _${trim(why, REASON_CHARS)}_`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const state = readState();
  const fromFile = args.file && args.file !== true;

  let since;
  if (args.since && args.since !== true) {
    since = args.since;
  } else if (args['since-last']) {
    since =
      state?.lastRunAt ?? new Date(Date.now() - COLD_START_HOURS * 3600_000).toISOString();
  } else if (fromFile) {
    // A file is a snapshot, not a stream: there is no watermark to honour, so
    // "since" is presentational only.
    since = new Date(Date.now() - COLD_START_HOURS * 3600_000).toISOString();
  } else {
    fail('digest: pass --since-last, --since <iso8601>, or --file <path>');
  }

  if (Number.isNaN(Date.parse(since))) fail(`digest: invalid --since value: ${since}`);

  let tenders;
  if (fromFile) {
    // Reads a classifier or scrape envelope so a digest can be produced without
    // database access — the production table is readable only by a credential
    // this agent is deliberately not given.
    const payload = readJsonFile(args.file);
    tenders = Array.isArray(payload) ? payload : (payload.tenders ?? []);
    if (args['relevant-only'] !== false) {
      tenders = tenders.filter((t) => t.agent_relevant ?? t.relevant ?? t.production_relevant);
    }
    tenders = tenders.slice(0, Number(args.limit ?? 200));
  } else {
    tenders = await fetchNewSince(since, {
      relevantOnly: args['relevant-only'] !== false,
      limit: Number(args.limit ?? 200),
    });
  }

  const now = Date.now();
  process.stdout.write(render(tenders, { since, now }) + '\n');

  if (args.commit) {
    writeState({
      lastRunAt: new Date(now).toISOString(),
      previousRunAt: state?.lastRunAt ?? null,
      deliveredCount: tenders.length,
      // Kept so a re-run can be diffed against what was actually sent, which is
      // what makes "the agent sent a duplicate" a debuggable claim.
      deliveredKeys: tenders.map((t) => `${t.site}::${t.tender_id}`),
    });
    process.stderr.write(
      `[digest] watermark advanced to ${new Date(now).toISOString()} (${tenders.length} delivered)\n`,
    );
  } else {
    process.stderr.write('[digest] dry run — watermark NOT advanced (pass --commit to advance)\n');
  }
}

main().catch((err) => fail(`digest failed: ${err?.message ?? err}`));
