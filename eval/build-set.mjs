#!/usr/bin/env node
/**
 * Builds the labelled evaluation set from the client's own hand-written files.
 *
 * `good tenders.txt` and `bed tenders.txt` in the production repo are ground
 * truth: an engineer at Groisman wrote them, including the reason for each
 * verdict. They are the closest thing to a client acceptance test this project
 * has, so they are parsed from source rather than retyped — a retyped copy
 * silently drifts from what the client actually said.
 *
 * Usage:
 *   node eval/build-set.mjs --repo /repo --out eval/labelled.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../harness/lib/supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Marks the reason line in both files ("good"/"bed" — the client's spelling). */
const REASON_RE = /^this\s+is\s+tender\s+is\s+(good|bed)\s+because\s+of:\s*(.*)$/i;
const SEPARATOR_RE = /^-{3,}$/;

/**
 * Records are: one or more title lines, then a reason line, then a separator.
 * Titles wrap across lines in the source files, so anything accumulated before
 * the reason marker is joined back into a single title.
 */
function parseLabelled(text, expectedLabel) {
  const out = [];
  let titleLines = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || SEPARATOR_RE.test(line)) {
      titleLines = [];
      continue;
    }

    // File header ("bed tenders") — not a tender.
    if (/^(bed|good)\s+tenders$/i.test(line)) continue;

    const m = line.match(REASON_RE);
    if (m) {
      const title = titleLines.join(' ').replace(/\s+/g, ' ').trim();
      if (title) {
        out.push({
          title,
          expected_relevant: m[1].toLowerCase() === 'good',
          client_reason: m[2].trim(),
        });
      }
      titleLines = [];
      continue;
    }

    titleLines.push(line);
  }

  const mismatched = out.filter((r) => r.expected_relevant !== (expectedLabel === 'good'));
  if (mismatched.length) {
    console.warn(
      `[build-set] ${mismatched.length} record(s) in the ${expectedLabel} file carry the opposite label — check the source file.`,
    );
  }

  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo && args.repo !== true ? args.repo : '/repo';
  const out = args.out && args.out !== true ? args.out : resolve(HERE, 'labelled.json');

  const good = parseLabelled(readFileSync(join(repo, 'good tenders.txt'), 'utf8'), 'good');
  const bad = parseLabelled(readFileSync(join(repo, 'bed tenders.txt'), 'utf8'), 'bed');

  const tenders = [...good, ...bad].map((t, i) => ({ id: `L${String(i + 1).padStart(3, '0')}`, ...t }));

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        ok: true,
        source: 'client-labelled (good tenders.txt / bed tenders.txt)',
        positives: good.length,
        negatives: bad.length,
        count: tenders.length,
        tenders,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.error(
    `[build-set] ${tenders.length} labelled tenders (${good.length} relevant, ${bad.length} not) -> ${out}`,
  );
}

main();
