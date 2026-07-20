# Mission Control renders the work: Receipts, cost, and docs live in-app, not in Obsidian

**Status:** accepted (2026-07-20). Reverses the standing "Obsidian/artifacts are the lens" posture (ADR-0015's Workbench entry; the ad-hoc claude.ai artifacts used for diagrams). Builds on ADR-0013 (Receipts), issue 143 (Run telemetry), the afk-issue-runner "How it works" completion-block clause, and `docs/ARCHITECTURE.md`.

Until now MC ran the work but you left MC to *understand* it: Receipts (and their mermaid "How it works" diagrams) were read in Obsidian, telemetry was a text `## Totals` block in a journal, architecture diagrams rendered on GitHub/Obsidian, and one-off explainers were external claude.ai artifacts. For a visual-first operator that means the review-and-learn half of the job lives outside the tool built to be the single home. This decision brings it in.

## Decision

MC becomes the surface for **reviewing and understanding** the work, not just running it. One shared renderer, surfaced in three new nav-rail tabs; Obsidian/artifacts demote from "the lens" to optional external browsers.

- **Rendering mechanism.** Extend MC's existing hand-rolled markdown renderer (the one Planning view and the curator-report view, issue 151, already share) with two capabilities:
  - **Mermaid diagrams** — bundle `mermaid.js` in the renderer, **lazy-loaded** only when a diagram is on screen; a ```mermaid fence renders to inline SVG. This is the one new dependency, and it earns its place because diagrams are specifically what the operator learns from. **No webview** — MC's one-app, no-embedded-browser discipline holds.
  - **Charts** — **hand-rolled SVG**, no charting library (consistent with MC's hand-rolled UI; bars / stacked-token breakdown / trend line are simple SVG per the dataviz mark specs). Theme-aware, zero dependency.
- **Surfaces (new nav-rail tabs), all on the shared renderer:**
  - **Receipts** — browse finished Runs; each renders its completion prose **plus its "How it works" mermaid diagram** live. **Replaces the inline Run-log strip** (one review surface, not two).
  - **Cost** — the `/cost` telemetry dashboard made native: per-drain totals, per-issue cost bars, token breakdown (input/output/cache — so "re-read a big file" is visible), and a trend line. Reads Run telemetry (issue 143, fixed by issue 177).
  - **Docs** — renders the code repo's `ARCHITECTURE.md` (and CONTEXT.md / ADRs) with diagrams live — orientation in-app.
- **Debrief stays a Pane.** `/debrief` is conversational (a Claude session), which a terminal Pane already hosts; it points the operator at the rendered Receipts / Docs / Cost tabs for the visuals. No bespoke debrief surface unless a split-screen later earns itself.
- **Obsidian & artifacts are demoted, not removed.** The Workbench is still plain files; Obsidian still opens them; ad-hoc artifacts are still fine for throwaway/shareable one-offs. They are simply no longer *the* place the daily job happens.

## Considered Options

- **Keep Obsidian/artifacts as the lens** (status quo). Rejected: it splits a visual-first operator's workflow across three apps for the half of the job (review/learn) that most needs to be where the work is.
- **A sandboxed webview rendering artifact-style HTML.** Rejected: MC has deliberately never embedded a browser context; it's a new security surface and a foreign rendering model. The hand-rolled-renderer + mermaid path reuses what exists.
- **A charting library (Recharts/visx/uPlot).** Rejected for now: the charts needed (bars, stacked, trend) are simple SVG, and MC's hand-rolled discipline + theme tokens make a lib more cost than benefit. Revisit only if chart needs outgrow hand-rolled SVG.
- **Fold Receipts into the Run-log card** (the first proposal). Rejected by the operator: a dedicated tab is preferred and avoids two overlapping review surfaces.
- **A dedicated split-screen Debrief view.** Deferred: a Pane already lives in MC and the visuals render in the new tabs; build the split only if it proves needed.

## Consequences

- **Gained:** the whole job — run, review, understand, cost — lives in one app; diagrams and cost render where the work is; the shared renderer is a reusable primitive future tools' content (ecosystem-hub style, per the Attention design) can render through too.
- **Given up / cost:** one real dependency (`mermaid.js`, lazy-loaded) and new render surface area on an app that is already the heaviest maintenance item (the `App.tsx`/AppShell hotspot). Mitigated by the shared renderer (built once) and by issue 171's overlap scheduling now guarding the nav-rail hotspot.
- **Docs:** CONTEXT.md's Workbench "Obsidian… a lens, never a dependency" line is amended (MC is now the primary lens; Obsidian optional), and a **Review surfaces** glossary entry is added.
- **Sequencing:** the shared renderer is the tracer; the three tabs build on it. The Cost tab is only meaningful once a drain runs on the issue-177-fixed build (all prior telemetry is null).
