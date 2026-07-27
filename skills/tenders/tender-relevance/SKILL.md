---
name: tender-relevance
description: Classify tenders and evolve the relevance criteria
version: 1.0.0
metadata:
  hermes:
    tags: [tenders, classification, evaluation, feedback]
    category: tenders
    requires_toolsets: [terminal, file]
---

# Tender relevance

## When to use

- Running a shadow classification over production tenders.
- An engineer gives feedback: "this one wasn't relevant", "you missed this one",
  "לא רלוונטי", "פספסת מכרז".
- Evaluating a criteria change before it goes live.

## The contract

`/workspace/criteria/relevance.md` **is** the classifier. `harness/classify.mjs`
sends that file verbatim as the system prompt. You change behaviour by editing
prose, not code, and the change takes effect on the next run with no deploy.

You may propose edits to that file. You may not decide alone that they are
correct — every edit is a git diff a human reviews, and every edit must be
justified by evidence and measured against the labelled set.

## Procedure — classifying

```bash
node /workspace/harness/db.mjs new --since <iso> --limit 200 \
  | node /workspace/harness/classify.mjs > /workspace/state/classified-<date>.json
```

Read the stderr summary. If `errors` is more than ~5% of the count, stop and
report — a systematic API failure will look like a criteria problem otherwise.

**Check the `source` block first.** `db.mjs` reads either the production table
or a local snapshot and always says which. Two consequences:

- On a snapshot, `--since` is **not applied** (a snapshot has no
  `first_seen_at` history) and the response says so in `note`. You will get all
  current tenders, not only new ones. Do not report them as "new".
- An empty result from the production table means RLS is hiding rows from the
  anon credential, **not** that no tenders exist. That has been diagnosed
  already; do not re-investigate it or speculate about the pipeline.

To answer questions about existing tenders rather than classify a batch, use
`db.mjs list` (see the tender-digest skill). Never hand-write a database query.

Note that unclassifiable tenders come back with `tier: null`, **not**
`irrelevant`. Never treat them as rejected. An unknown tender is a tender
nobody has looked at yet.

## Procedure — acting on feedback

This is the loop that makes the system improve. Do it carefully; it is also the
loop that can silently make things worse.

1. **Get the specific tender.** Do not act on a vague complaint. Ask for the
   title if you do not have it.

   ```bash
   node /workspace/harness/db.mjs get --site <site> --id <tender_id>
   ```

2. **Decide which rule was wrong.** Read `/workspace/criteria/relevance.md` and
   name the specific clause that produced the error. One of:

   - A tier-A/B phrase is missing → the criteria never had a way to catch it
   - An exclusion is missing → a whole domain the client does not work in
   - An exclusion is too broad → it is killing tenders it should not
   - A spelling variant is unlisted (תיאום/תאום, ייעוץ/יעוץ) → cheap, safe fix
   - Nothing is wrong with the criteria; the model misread → do **not** edit

   That last case is real and important. If the criteria already say the right
   thing, editing them to restate it is how a criteria file rots into noise.

3. **Establish the baseline before you change anything.**

   ```bash
   node /workspace/eval/build-set.mjs --repo /repo --out /workspace/eval/labelled.json
   node /workspace/harness/classify.mjs --file /workspace/eval/labelled.json > /workspace/eval/before.json
   node /workspace/eval/score.mjs --truth /workspace/eval/labelled.json --pred /workspace/eval/before.json --md
   ```

4. **Make the smallest edit that fixes the case.** One clause. Add the new
   example to the "דוגמאות מתויגות" table so it is permanently protected.

5. **Re-run the eval and compare.**

   ```bash
   node /workspace/harness/classify.mjs --file /workspace/eval/labelled.json > /workspace/eval/after.json
   node /workspace/eval/score.mjs --truth /workspace/eval/labelled.json --pred /workspace/eval/after.json --md
   ```

   **If recall dropped, revert.** Not "investigate" — revert, then investigate.
   Recall governs: a false positive costs an engineer ten seconds, a false
   negative costs a bid.

6. **Append a CHANGELOG row** in the criteria file: what changed, what evidence
   prompted it, and the before → after numbers. A change with no evidence and
   no delta does not get committed.

7. **Report** the diff, the metric change, and the changelog entry. Say plainly
   if the numbers got worse.

## Pitfalls

- **One complaint is not a pattern.** Adding an exclusion because of a single
  odd tender can wipe out a category. Check the labelled examples first.
- **Never edit the labelled examples to make a run pass.** Those came from the
  client. They are the test, not the answer key to be adjusted.
- **Do not tune precision at recall's expense** without saying so explicitly and
  getting agreement. It is the tempting trade and it is usually the wrong one.
- **Do not edit `/repo/src/lib/relevance.ts`.** It is read-only and it is the
  live production keyword filter. This project runs beside it, not through it.

## Verification

- Eval ran before and after; both reports exist under `/workspace/eval/`.
- Recall did not decrease.
- The CHANGELOG has a new row citing real evidence.
- `git diff` in `/workspace` shows only the intended criteria change.
