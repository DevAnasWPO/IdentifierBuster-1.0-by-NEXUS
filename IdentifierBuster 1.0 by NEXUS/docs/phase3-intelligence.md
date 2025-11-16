# Phase 3 – Intelligence & Insights

## Goals
- Surface an at-a-glance risk score per player using the data already fetched (BattleMetrics bans, Steam bans, name/identifier overlap, activity recency).
- Provide contextual timelines (first/last seen, ban timestamps) so investigators can understand patterns quickly.
- Prioritize background work (prefetching) toward the riskiest or most-likely-needed players while staying within queue limits.

## Deliverables
1. **Risk Scoring Engine**
   - Deterministic scoring (0–100) derived from: SB count + recency, Steam bans, associates count, name similarity, days since last seen.
   - Map to textual severity labels (Clean, Watch, Risky, Critical).
   - Expose via UI badges + tooltip breakdown and include in data export path if added later.
2. **Activity Timeline Visualization**
   - For each player row, render a mini timeline sparkline summarizing first seen → last seen with ban markers.
   - Provide hover tooltip listing notable events (Newest ban, Most recent session).
   - Reuse existing date helpers in `setup.js` for data prep.
3. **Intelligent Prefetch Heuristics**
   - Extend `prefetch.js` to rank candidates by risk score (fall back to identifier proximity) before enqueuing.
   - Allow HUD or logs to show prefetch priority decisions for debugging.

## Implementation Notes
- Risk score calculation can live in a new `modules/scoring.js` shared by setup + HUD.
- Timeline rendering can be pure DOM/CSS (flex-based) to avoid bundling chart libs.
- Prefetch ranking pulls from the same scoring utility; pass metadata through `bundleCache` entries to avoid recomputation.
