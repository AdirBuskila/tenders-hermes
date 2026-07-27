#!/usr/bin/env node
/**
 * Deterministic bulk classifier.
 *
 * This is NOT the agent. It is a dumb, fast, cheap script that the agent
 * curates. The agent owns criteria/relevance.md; this file sends that text to
 * a small model once per tender and records the verdict. Running 300 tenders a
 * night through an agent loop would cost far more and decide nothing extra.
 *
 * Reads tenders as JSON on stdin (the {ok, tenders:[...]} envelope emitted by
 * db.mjs) or via --file. Writes the same envelope back with `tier` and
 * `agent_reason` added to each tender.
 *
 * Usage:
 *   node harness/db.mjs new --since ... | node harness/classify.mjs > out.json
 *   node harness/classify.mjs --file eval/set.json --model claude-haiku-4-5-20251001
 *
 * The criteria file is sent as a cached system prompt, so re-running the same
 * criteria over many tenders is billed at the cache-read rate after the first
 * call rather than re-billing the full prompt every time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseJson } from './lib/supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRITERIA_PATH = resolve(HERE, '..', 'criteria', 'relevance.md');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 6;
const MAX_RETRIES = 3;

function die(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Strip the HTML review contract comment — it is guidance for humans, not the model. */
function loadCriteria(path = CRITERIA_PATH) {
  if (!existsSync(path)) die(`criteria file not found at ${path}`);
  return readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Models occasionally wrap JSON in prose or a fenced block despite instructions.
 * Recovering the object is cheaper than a retry and keeps the failure rate
 * honest — a parse we could have made but didn't would inflate the error count
 * in the eval and make the criteria look worse than they are.
 */
function extractJson(text) {
  const trimmed = (text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) {
    try {
      return JSON.parse(braced[0]);
    } catch {
      /* fall through */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classifyOne(tender, { criteria, model, apiKey }) {
  const userContent =
    `מכרז: "${tender.title}"` +
    (tender.publisher ? `\nמפרסם: ${tender.publisher}` : '') +
    (tender.region ? `\nאזור: ${tender.region}` : '');

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          system: [
            {
              type: 'text',
              text: criteria,
              // The criteria block is identical across every tender in a run;
              // caching it turns N full-prompt bills into 1 write + N reads.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      // 429 and 5xx are transient. 4xx other than 429 will not improve on retry.
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        return { ...tender, tier: null, agent_reason: null, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      }

      const data = await res.json();
      const parsed = extractJson(data?.content?.[0]?.text);
      if (!parsed?.tier) {
        lastError = 'unparseable model output';
        await sleep(300 * attempt);
        continue;
      }

      return {
        ...tender,
        tier: parsed.tier,
        agent_relevant: parsed.tier === 'A' || parsed.tier === 'B',
        agent_reason: parsed.reason ?? null,
        _usage: {
          input: data?.usage?.input_tokens ?? 0,
          cacheWrite: data?.usage?.cache_creation_input_tokens ?? 0,
          cacheRead: data?.usage?.cache_read_input_tokens ?? 0,
          output: data?.usage?.output_tokens ?? 0,
        },
      };
    } catch (err) {
      lastError = err?.message ?? String(err);
      await sleep(500 * attempt);
    }
  }

  // Deliberately NOT defaulting to irrelevant. A tender we failed to classify
  // is unknown, not rejected — silently dropping it is the one failure mode
  // that loses the client money.
  return { ...tender, tier: null, agent_relevant: null, agent_reason: null, error: lastError };
}

/** Bounded-concurrency map. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    die('ANTHROPIC_API_KEY is not set in the container. Add it to ~/.hermes/.env — it is already in terminal.docker_forward_env.');
  }

  const raw = args.file && args.file !== true ? readFileSync(args.file, 'utf8') : readStdin();
  if (!raw.trim()) die('classify: no input. Pipe db.mjs output in, or pass --file <path>.');

  let payload;
  try {
    payload = parseJson(raw, 'classify input');
  } catch (err) {
    die(`classify: ${err.message}`);
  }

  const tenders = Array.isArray(payload) ? payload : payload.tenders;
  if (!Array.isArray(tenders)) die('classify: expected an array, or an object with a `tenders` array.');

  const model = args.model && args.model !== true ? args.model : DEFAULT_MODEL;
  // --criteria exists so the eval can swap in a variant (e.g. the examples-free
  // holdout) without editing the file production reads.
  const criteria = loadCriteria(args.criteria && args.criteria !== true ? args.criteria : CRITERIA_PATH);

  const started = Date.now();
  const classified = await mapLimit(tenders, CONCURRENCY, (t) =>
    classifyOne(t, { criteria, model, apiKey }),
  );

  const errors = classified.filter((t) => t.error).length;

  // Cache accounting. Haiku 4.5 has the highest minimum cacheable prefix of any
  // model — 4096 tokens. A criteria file below that silently does not cache:
  // no error, no warning, just full price on every call. The only way to know
  // is to read cache_read_input_tokens back, so we do, and say so out loud.
  const usage = classified.reduce(
    (acc, t) => {
      const u = t._usage;
      if (!u) return acc;
      acc.input += u.input;
      acc.cacheWrite += u.cacheWrite;
      acc.cacheRead += u.cacheRead;
      acc.output += u.output;
      return acc;
    },
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  );

  // Haiku 4.5 list price: $1.00 / MTok in, $5.00 / MTok out.
  // Cache writes bill at 1.25x input, cache reads at 0.10x input.
  const estUsd =
    (usage.input / 1e6) * 1.0 +
    (usage.cacheWrite / 1e6) * 1.25 +
    (usage.cacheRead / 1e6) * 0.1 +
    (usage.output / 1e6) * 5.0;

  process.stderr.write(
    `[classify] ${classified.length} tenders, ${errors} errors, ${model}, ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
  process.stderr.write(
    `[classify] tokens: ${usage.input} uncached, ${usage.cacheWrite} cache-write, ${usage.cacheRead} cache-read, ${usage.output} out — est $${estUsd.toFixed(4)}\n`,
  );
  if (classified.length > 1 && usage.cacheRead === 0) {
    process.stderr.write(
      '[classify] WARNING: zero cache reads. The criteria file is probably under Haiku 4.5\'s 4096-token minimum, so caching is silently inactive and every call pays full price.\n',
    );
  }

  // Strip per-tender usage from the payload — it is operational telemetry, not
  // classification output, and it would pollute the eval diffs.
  const output = classified.map(({ _usage, ...t }) => t);

  console.log(
    JSON.stringify(
      { ok: true, model, count: classified.length, errors, usage, estimatedUsd: Number(estUsd.toFixed(4)), tenders: output },
      null,
      2,
    ),
  );
}

main().catch((err) => die(`classify failed: ${err?.message ?? err}`));
