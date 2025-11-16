# Phase 4 – UX & Workflow Polish

## Objectives
1. **Investigator-friendly summaries** – Surface actionable context (risk distribution, most critical players, queue health) without scanning the entire list.
2. **Interaction refinements** – Ensure cards, timelines, and badges remain readable across resolutions, support keyboard users, and expose clear legends.
3. **Guided actions** – Provide CTA buttons for exporting data, copying risky players, or opening quick filters in future steps.

## Initial Deliverables
- Summary panel injected above the player table showing total players, risky percentage, and recent activity windows.
- Legend + help affordances for risk colors and timeline markers.
- Refined layout spacing, consistent typography, responsive handling for the HUD and card grid.
- Quick filter chips for severity, recent sightings, and heavy link sharing to focus the list in one click.
- Copy/export controls (clipboard summary) scoped to the currently visible results for fast note-taking.
- Inline action toolbar on each card for queuing follow-ups, copying identifiers, and jumping back into BattleMetrics profiles.
- CSV/case-pack export that respects the active filters and bundles notes/ban metadata for offline handoffs.
- Lightweight per-card notes + tag chips persisted locally for rapid investigator annotation.

## Stretch Ideas
- Shared workspace sync for notes/tags (multi-analyst collaboration).
- Template-driven export (PDF briefs, auto-generated incident tickets).
