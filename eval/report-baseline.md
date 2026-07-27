# Relevance evaluation

- **Model:** `claude-haiku-4-5-20251001`
- **Labelled set:** 29 tenders (14 relevant, 15 not)
- **Scored:** 29

| Metric | Value | Why it matters here |
|---|---|---|
| **Recall** | **100.0%** | The metric that governs. A miss is a tender the firm never got to bid on. |
| Precision | 100.0% | A false positive costs ten seconds of reading. Cheap by comparison. |
| F1 | 100.0% | Balance of the two. |
| Accuracy | 100.0% | Reported for completeness; misleading on an unbalanced set. |

## Confusion matrix

| | predicted relevant | predicted not |
|---|---|---|
| **actually relevant** | 14 | 0 |
| **actually not** | 0 | 15 |

## Every disagreement

None — every labelled tender was classified as the client labelled it.

