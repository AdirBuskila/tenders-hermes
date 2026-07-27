/**
 * The single point of contact with the production Supabase table.
 *
 * Everything here is a GET, and the only credential it will accept is the anon
 * key. If you ever find yourself wanting to add a write here, that is the
 * signal to stop and re-read the shadow-mode decision in the vault: the agent
 * proves itself against production data before it is trusted to change any.
 */

import { readFileSync } from 'node:fs';

export const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const SELECT_FIELDS = [
  'site',
  'tender_id',
  'title',
  'publisher',
  'region',
  'deadline',
  'status',
  'url',
  'relevant',
  'relevance_reason',
  'first_seen_at',
  'last_seen_at',
].join(',');

/**
 * Exit with a machine-readable error. Cron runs are read by an agent, not a
 * human — a JSON error it can parse beats a stack trace it has to interpret.
 */
export function fail(message, code = 1) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

export function emit(payload) {
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
}

/**
 * Parse JSON that may carry a UTF-8 BOM.
 *
 * Every one of these tools gets driven from PowerShell on this machine, and
 * PowerShell's `>` redirection writes a BOM by default. JSON.parse rejects it
 * with "Unexpected token '﻿'", which reads like corrupt data and sends you
 * looking in the wrong place — it cost two debugging rounds already. Strip it
 * once, here, rather than in each caller.
 */
export function parseJson(text, label = 'input') {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

/** Read and parse a JSON file, tolerating a BOM. */
export function readJsonFile(path) {
  return parseJson(readFileSync(path, 'utf8'), path);
}

/** Minimal `--flag` / `--flag value` parser. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function assertCredentials() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    fail(
      'Missing SUPABASE_URL / SUPABASE_ANON_KEY. Check terminal.docker_forward_env in the Hermes config.',
    );
  }
}

/** Run a PostgREST query and return parsed rows. */
export async function query(path) {
  assertCredentials();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    fail(`Supabase ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Tenders first seen at or after `since`.
 *
 * Keys off first_seen_at, which the DB sets once on INSERT and never updates.
 * A re-scrape that only refreshes last_seen_at therefore cannot resurface a
 * tender the engineers have already been shown — which is the entire point of
 * "what's new since I last checked".
 */
export async function fetchNewSince(since, { relevantOnly = false, limit = 200 } = {}) {
  if (!since || Number.isNaN(Date.parse(since))) {
    fail(`Not a valid ISO date: ${since}`);
  }
  const filters = [
    `select=${SELECT_FIELDS}`,
    `first_seen_at=gte.${encodeURIComponent(since)}`,
    'status=eq.open',
    'order=first_seen_at.desc',
    `limit=${limit}`,
  ];
  if (relevantOnly) filters.push('relevant=is.true');
  return query(`tenders?${filters.join('&')}`);
}
