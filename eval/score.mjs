#!/usr/bin/env node
/**
 * Scores a classifier run against the labelled set.
 *
 * Reports precision, recall and F1, but the number that actually governs this
 * product is RECALL. A false positive costs an engineer ten seconds of reading;
 * a false negative means a tender the firm could have bid on was never seen at
 * all. The report says so out loud so nobody optimises the wrong metric.
 *
 * Usage:
 *   node eval/score.mjs --truth eval/labelled.json --pred eval/run-YYYYMMDD.json
 *   node eval/score.mjs --truth eval/labelled.json --pred out.json --md > report.md
 */

import { parseArgs, readJsonFile } from '../harness/lib/supabase.mjs';

function die(msg) {
  console.error(`[score] ${msg}`);
  process.exit(1);
}

const load = (p) => {
  try {
    return readJsonFile(p);
  } catch (err) {
    die(`could not read ${p}: ${err.message}`);
  }
};

/** Titles vary by whitespace and punctuation between sources; normalise before matching. */
const norm = (s) =>
  (s ?? '')
    .replace(/[‎‏]/g, '')
    .replace(/["'׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.truth || !args.pred) die('usage: --truth <labelled.json> --pred <classified.json>');

  const truth = load(args.truth);
  const pred = load(args.pred);

  const predByTitle = new Map();
  for (const t of pred.tenders ?? []) predByTitle.set(norm(t.title), t);

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let unscored = 0;
  const errors = [];

  for (const t of truth.tenders ?? []) {
    const p = predByTitle.get(norm(t.title));

    // A tender the classifier could not label is counted separately, never
    // silently folded into "irrelevant" — that would flatter recall.
    if (!p || p.agent_relevant === null || p.agent_relevant === undefined) {
      unscored++;
      errors.push({ kind: 'unscored', title: t.title, expected: t.expected_relevant, got: null, reason: p?.error ?? 'no prediction' });
      continue;
    }

    const expected = t.expected_relevant;
    const got = Boolean(p.agent_relevant);

    if (expected && got) tp++;
    else if (!expected && got) {
      fp++;
      errors.push({ kind: 'false_positive', title: t.title, clientReason: t.client_reason, agentReason: p.agent_reason, tier: p.tier });
    } else if (!expected && !got) tn++;
    else {
      fn++;
      errors.push({ kind: 'false_negative', title: t.title, clientReason: t.client_reason, agentReason: p.agent_reason, tier: p.tier });
    }
  }

  const scored = tp + fp + tn + fn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = scored > 0 ? (tp + tn) / scored : 0;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  const summary = {
    model: pred.model ?? 'unknown',
    total: truth.tenders?.length ?? 0,
    scored,
    unscored,
    confusion: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
    precision,
    recall,
    f1,
    accuracy,
  };

  if (!args.md) {
    console.log(JSON.stringify({ ok: true, ...summary, errors }, null, 2));
    return;
  }

  const lines = [
    '# Relevance evaluation',
    '',
    `- **Model:** \`${summary.model}\``,
    `- **Labelled set:** ${summary.total} tenders (${truth.positives ?? '?'} relevant, ${truth.negatives ?? '?'} not)`,
    `- **Scored:** ${scored}${unscored ? ` (${unscored} unscored — classifier returned no verdict)` : ''}`,
    '',
    '| Metric | Value | Why it matters here |',
    '|---|---|---|',
    `| **Recall** | **${pct(recall)}** | The metric that governs. A miss is a tender the firm never got to bid on. |`,
    `| Precision | ${pct(precision)} | A false positive costs ten seconds of reading. Cheap by comparison. |`,
    `| F1 | ${pct(f1)} | Balance of the two. |`,
    `| Accuracy | ${pct(accuracy)} | Reported for completeness; misleading on an unbalanced set. |`,
    '',
    '## Confusion matrix',
    '',
    '| | predicted relevant | predicted not |',
    '|---|---|---|',
    `| **actually relevant** | ${tp} | ${fn} |`,
    `| **actually not** | ${fp} | ${tn} |`,
    '',
  ];

  if (errors.length) {
    lines.push('## Every disagreement', '');
    for (const e of errors) {
      const label =
        e.kind === 'false_negative'
          ? 'MISSED (false negative)'
          : e.kind === 'false_positive'
            ? 'WRONGLY INCLUDED (false positive)'
            : 'UNSCORED';
      lines.push(`### ${label}`);
      lines.push(`> ${e.title}`);
      lines.push('');
      if (e.clientReason) lines.push(`- **Client's reason:** ${e.clientReason}`);
      if (e.agentReason) lines.push(`- **Classifier said:** ${e.agentReason}${e.tier ? ` _(tier ${e.tier})_` : ''}`);
      if (e.reason) lines.push(`- **Failure:** ${e.reason}`);
      lines.push('');
    }
  } else {
    lines.push('## Every disagreement', '', 'None — every labelled tender was classified as the client labelled it.', '');
  }

  console.log(lines.join('\n'));
}

main();
