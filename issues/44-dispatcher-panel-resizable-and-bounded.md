---
status: done
depends_on: [35, 36]
---

# 44 — Dispatcher panel: make it resizable, and stop the activity strip from shrinking the chat

## Source

Issue-40 verification (2026-07-03): the Dispatcher works, but the panel is hard to read and use. Two confirmed layout defects in `src/renderer/src/DispatcherPanel.tsx` / `index.css`:
1. **Fixed width, not resizable.** `.dispatcher { flex: 0 0 360px }` — the panel is a hardcoded 360px with no way to widen it, so the chat is cramped and hard to read.
2. **The activity/approval strip progressively shrinks the chat.** `.dispatcher__activities` is `max-height: 45%; overflow-y: auto` — so each new autonomous note / proposal grows the strip toward **45% of the panel height**, squeezing the chat terminal smaller and smaller every time one appears, until it finally caps at nearly half the panel. Ceding ~45% to the action log leaves the chat unreadable during an active drain.

## What to build

- **Resizable width:** replace the fixed 360px with a user-adjustable width — a draggable divider between the Dispatcher panel and the Map (with a sensible min/max), and persist the chosen width (per Project or app-wide). The chat terminal must reflow to the new width (reuse the Pane's existing ResizeObserver-driven fit).
- **Bounded activity strip that doesn't eat the chat:** the chat must stay the dominant, stable region — a new activity must NOT shrink it each time. Cap the activity strip to a small bounded height (a few rows) that scrolls, so accumulating notes/proposals scroll within their own area instead of growing to ~half the panel. Keep **pending proposals** (the approve/reject actions) prominent/visible; resolved items (approved/rejected/autonomous notes) can scroll off or collapse. Consider a count/"N awaiting approval" affordance so pending actions aren't missed when the list scrolls.
- **Readability:** ensure the chat text is legible at the resized width (terminal reflow on resize); the panel should feel like a comfortable chat, not a shrinking slot.

## Acceptance criteria

- [ ] The Dispatcher panel width can be adjusted by dragging, within a sensible min/max, and the width persists across opens; the chat reflows to the new width.
- [ ] Adding a new activity/proposal does NOT shrink the chat terminal each time; the activity strip is bounded to a small height and scrolls.
- [ ] Pending approve/reject proposals remain visible/reachable even as the activity list grows (not lost below a fold with no indicator).
- [ ] The chat is legible during an active drain (comfortable width, proper terminal reflow).
- [ ] Any pure layout/derivation logic (e.g. splitting pending vs resolved for display, clamping width) is unit-tested; the on-screen behavior verifies via type-check + build + the batch QA walkthrough.

## Blocked by

- 35
- 36
