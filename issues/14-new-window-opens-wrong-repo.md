---
status: done
depends_on: [9]
---

# 14 — "Open in new Window" ignores the pasted path and grabs the backend cwd

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). Pasting `…/repo-b` and clicking "Open in new Window" opens a window that errors "`…/mission-control` is already open in another Window" — the app's own repo, not the pasted path. Confirmed two root causes:
1. The queued target repo (`pendingOpen`, keyed by the new Window's webContents id in `main/index.ts`) is **deleted on the first `ProjectList` read**, but the bootstrap effect in `App.tsx` fires `listProjects()` more than once (React StrictMode double-mount in dev; plus the registry-changed listener). A racing/duplicate read consumes and discards the pending path before the bootstrap acts on it.
2. When the pending path is lost (or a Window opens with no target), the bootstrap falls through to `openProjectHere('')`, which resolves to `process.cwd()` — the mission-control repo — so the Window silently tries to claim the app's own directory, colliding with the Window that already owns it.

## What to build

Two fixes:

- **Deliver the target repo to a new Window reliably**, so the pasted path can't be lost to a duplicate/racing `listProjects` read. Options (pick the simplest that holds): don't consume `pendingOpen` on a generic list call — only hand it to, and clear it from, the one bootstrap consumption for that Window (idempotent until acted upon); or pass the target via the Window's init (a query param / init arg the renderer reads once) rather than a delete-on-read map. Guard the bootstrap effect so a StrictMode double-invoke can't double-open or drop the target.
- **Stop defaulting to the backend cwd.** A Window with no queued target and no owned repo should open **no Project** and show an empty "open or choose a Project" state — never silently open `process.cwd()`. Opening the app's own repo as a Project should only happen if the user explicitly enters that path.

Net behavior: pasting repo-b → new Window opens **repo-b**; a plain new Window (no path) → empty state, no phantom claim on mission-control; the existing duplicate-repo guard still applies only when the user actually targets an already-owned repo.

## Acceptance criteria

- [ ] Pasting a repo path + "Open in new Window" opens a Window managing **that** repo, not the app's cwd.
- [ ] The pasted path survives a StrictMode double-mount / concurrent `ProjectList` reads (dev-mode `npm run dev` reproduces the original bug — confirm it's gone).
- [ ] A new Window with no target opens no Project and shows an empty "open a Project" state; it does not claim `process.cwd()`.
- [ ] Opening a repo already owned by another Window is still refused with the existing message — but only when that repo is what the user actually targeted.
- [ ] The pending-target delivery / "which repo does this Window open" decision is covered by tests (pure logic unit-tested; the delivery path exercised as far as is feasible headlessly).

## Blocked by

- 9
