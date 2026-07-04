---
status: open
depends_on: [71]
---

# 72 — Runs on the Workbench: repo-targeted Workers, Receipts in the Workbench, per-repo isolation, auto-commit

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

For a workbench Project: a Run's Worker is spawned with **cwd = the issue's target repo** (`repo:` field, else `default_repo`), with the prompt carrying the explicit workbench paths (issues root, absolute Receipt path) per the ADR's discovery order. Receipts are read from `~/Workbench/<project>/completions/` — one watch root, no per-worktree Receipt roots, and the stray-adoption path (issue 62) is bypassed for workbench Projects (legacy Projects keep today's behavior). Isolation/parallel mode keys on concurrency **per repo**: two concurrent issues targeting different repos need no mutual worktrees; two in the same repo isolate exactly as today. Merge stays per repo. MC **auto-commits the Workbench** after each Run event (claim observed, park, done + Receipt) with `<project>: issue NN <event>` messages — idempotent, quiet, never pushes.

## Acceptance criteria

- [ ] A drain over a two-repo fixture project runs each issue in its declared repo; a cross-repo `depends_on` chain executes in order.
- [ ] Receipts land in the workbench completions root and drive cards/narrative/lifecycle exactly as in-repo Receipts did; no worktree Receipt watching for workbench Projects.
- [ ] Concurrent issues in different repos run without worktrees; same-repo concurrency isolates as today.
- [ ] Workbench auto-commit fires once per Run event, idempotent on re-observation; code repos never receive workflow commits.
- [ ] Legacy-layout Projects behave byte-identically to today (existing e2e stays green); full suite + type-check pass.

## Blocked by

- 71
