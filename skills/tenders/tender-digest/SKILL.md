---
name: tender-digest
description: Deliver the daily Hebrew digest of new relevant tenders
version: 1.0.0
metadata:
  hermes:
    tags: [tenders, digest, hebrew, daily]
    category: tenders
    requires_toolsets: [terminal, file]
---

# Tender digest

## When to use

- A cron job fires the daily digest.
- Someone asks "what's new?", "מה חדש?", or asks for tenders since a given date.
- Someone asks to preview the digest without sending it.
- Someone asks for tenders **from a particular publisher or matching a phrase**
  — see "Answering ad-hoc questions" below, and use `db.mjs list`, not a
  hand-written query.

## Where the data comes from

`db.mjs` resolves its own source and reports it in every payload's `source`
block. It may be the production Supabase table **or** a local snapshot.

**Always read `source.kind` and tell the user which one you used.** A digest
built from a snapshot is real data scraped from the live portals, but it is not
the production table, and presenting it as though it were is a lie of omission.

> [!important] If a query returns nothing, check `source` before concluding anything
> The production table currently returns `HTTP 200` with zero rows to this
> credential: RLS is enabled with no read policy for the anon role. The rows
> exist and are simply invisible here. **This is not "the pipeline never ran"
> and not "the database was reset"** — do not offer those explanations, they
> have already been investigated and ruled out. `db.mjs` handles this and falls
> back to a snapshot automatically; the reason is in `source.reason`.

## Never answer a data question from memory

**Run the query every time, even if you ran it earlier in this conversation.**

Answers like "as we established, the database is empty" are how a stale finding
outlives its cause. The tooling changes underneath a long-lived session: a
snapshot appears, a credential is fixed, a fallback is added. An earlier
conclusion is evidence about the past, never about now — and repeating it with
added confidence ("as we checked twice") is worse than being wrong once,
because it sounds verified.

This has already happened in production use: the agent reported an empty
database three times in one conversation, twice after a working fallback had
been added, because it was quoting itself instead of re-running `db.mjs`.

If a query genuinely returns nothing, report the `source` block and the counts
you *just* observed — not what you remember observing.

## Answering ad-hoc questions

Use `db.mjs list`. It filters in memory and supports substring matching, so a
human's phrasing works without translation:

```bash
node /workspace/harness/db.mjs list --publisher "נתיבי איילון" --relevant-only
node /workspace/harness/db.mjs list --site iaa --tier A --limit 20
node /workspace/harness/db.mjs list --search "רכבת קלה" --open-only
node /workspace/harness/db.mjs sites          # what exists, and how much
```

`--publisher` matches the site key too, and is a substring match on purpose:
publishers are stored inconsistently (`נתיבי איילון` vs
`מפרסם הקול קורא: נתיבי איילון בע"מ`), and an exact match returns nothing while
appearing to work.

**Do not hand-write PostgREST queries or `node -e` one-liners against the
database.** If `list` cannot express the question, say so and propose the flag
that would — an improvised query bypasses the source resolution above and will
report an empty database when a snapshot was sitting right there.

Check `truncated` in the response. If it is `true`, say how many matched versus
how many you are showing.

## Procedure

1. **Check pipeline health first.** A digest built on stale data is worse than
   no digest, because it reads as "nothing new today" when the truth is
   "nothing was collected today".

   ```bash
   node /workspace/harness/db.mjs health
   ```

   Read `pipelineLastSeen`. If it is more than 36 hours old, do **not** send a
   normal digest. Report that the pipeline appears stalled, name the value you
   saw, and stop. Silence about a broken pipeline is the failure mode that
   costs the client money.

   If `staleSites` is non-empty, note them — but continue. A few dead sites is
   the current normal state, not a reason to withhold today's tenders. Mention
   them in one line at the end of the digest.

2. **Build the digest.**

   ```bash
   node /workspace/harness/digest.mjs --since-last --commit
   ```

   `--since-last` reads the watermark in `/workspace/state/last-digest.json`;
   `--commit` advances it. Use `--commit` only when you are actually delivering.
   For a preview, drop it — otherwise the tenders are consumed and the real
   digest tomorrow will look empty.

   For an explicit window, use `--since 2026-07-20T00:00:00Z` instead.

3. **Deliver.** The script's stdout is already formatted Hebrew Markdown.
   Output it as your final message, unchanged.

   Do not summarise it, do not reorder it, do not add an English preamble. The
   formatting is deterministic on purpose so the reader can scan it identically
   every morning. Cron routes your final message to the delivery target on its
   own — you do not call a messaging tool.

4. **If zero new tenders**, still deliver the script's "אין חדש" output. A daily
   message that says "nothing today" is a signal the system is alive. Silence
   is indistinguishable from a crash.

## Pitfalls

- **Never advance the watermark on a failed run.** If `digest.mjs` errors, do
  not re-run it with `--commit` to "get past it" — fix the cause. A skipped
  window means those tenders are never shown to anyone.
- **Do not classify here.** This skill reads the `relevant` column that already
  exists. Re-deciding relevance mid-digest makes the output non-reproducible.
- **Do not translate tender titles.** They are legal titles of Hebrew tenders
  and engineers search for them verbatim.

## Verification

Before sending, confirm:

- `pipelineLastSeen` is within 36 hours.
- The digest's tender count matches the `deliveredCount` written to
  `/workspace/state/last-digest.json`.
- Every bullet has a working URL.
