#!/usr/bin/env node
/**
 * Deliver a rendered digest to Telegram.
 *
 * Kept separate from digest.mjs so that rendering and sending fail
 * independently: a broken send must never be able to advance the digest
 * watermark, or the engineers silently lose a day of tenders. Compose them
 * explicitly instead —
 *
 *   node harness/digest.mjs --file state/classified-local.json | node harness/notify.mjs
 *
 * Reads the message on stdin (or --file), splits it to fit Telegram's limit,
 * and reports what it sent.
 *
 *   --dry-run     print what would be sent, contact nothing
 *   --chat CHATID override TELEGRAM_CHAT_ID
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from './lib/supabase.mjs';

// Telegram's hard cap is 4096 characters. The margin absorbs the part-counter
// suffix appended to multi-part messages.
const LIMIT = 3900;

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

/**
 * Split on line boundaries, never mid-line.
 *
 * A digest line is a tender title, a deadline or a Markdown link; cutting one
 * in half produces an unparseable link and Telegram rejects the whole message
 * with a 400 that says nothing useful about which line broke.
 */
function chunk(text, limit = LIMIT) {
  const lines = text.split('\n');
  const parts = [];
  let current = '';

  for (const line of lines) {
    // A single line longer than the limit cannot be placed by this strategy.
    // Hard-split it rather than silently dropping it.
    if (line.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function send(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      // The digest links to the tender pages; previews would bury the list.
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${res.status}: ${data.description ?? 'unknown error'}`);
  }
  return data.result.message_id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const text = (args.file && args.file !== true ? readFileSync(args.file, 'utf8') : readFileSync(0, 'utf8'))
    .replace(/^﻿/, '')
    .trim();
  if (!text) fail('notify: empty message. Pipe digest.mjs output in, or pass --file.');

  const parts = chunk(text);
  const labelled =
    parts.length === 1 ? parts : parts.map((p, i) => `${p}\n\n_(${i + 1}/${parts.length})_`);

  if (args['dry-run']) {
    process.stderr.write(`[notify] DRY RUN — ${text.length} chars in ${parts.length} message(s)\n`);
    labelled.forEach((p, i) => process.stderr.write(`\n----- part ${i + 1} (${p.length} chars) -----\n${p}\n`));
    console.log(JSON.stringify({ ok: true, dryRun: true, parts: parts.length, chars: text.length }, null, 2));
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = args.chat && args.chat !== true ? args.chat : process.env.TELEGRAM_CHAT_ID;
  if (!token) fail('notify: TELEGRAM_BOT_TOKEN is not set in the container.');
  if (!chatId) fail('notify: TELEGRAM_CHAT_ID is not set (or pass --chat).');

  const sent = [];
  for (const part of labelled) {
    // Sequential, not parallel: Telegram delivers in arrival order, and a
    // digest whose parts arrive shuffled is worse than no digest.
    sent.push(await send(token, chatId, part));
  }

  process.stderr.write(`[notify] sent ${sent.length} message(s), ${text.length} chars\n`);
  console.log(JSON.stringify({ ok: true, messageIds: sent, parts: sent.length, chars: text.length }, null, 2));
}

main().catch((err) => fail(`notify failed: ${err?.message ?? err}`));
