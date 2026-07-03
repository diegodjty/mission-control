---
status: done
depends_on: [15]
---

# 25 — [HIGH] Solo Runs must not leave main dirty and block merges

## Source

Hardening review (2026-07-03), finding corr-4 (observed live today). MC auto-commits only *isolated* Runs (`shouldCommitWorktree` requires `isolated`). A solo Run works on `main` and, per the afk-issue-runner solo contract, the agent flips the issue to `done` and leaves the files + flip **uncommitted** on `main`. Nothing in MC commits them. The next parallel Merge then fails the clean-tree preflight ("commit or stash them first") with no in-app remedy — this is the exact wall hit in the QA walkthrough.

## What to build

Make "finished" mean "committed" **uniformly**: when a solo Run reaches `done` on `main`, Mission Control auto-commits its work (symmetry with the isolated auto-commit from issue 15) — e.g. `afk: complete issue NN — <slug>` — so `main` stays clean and mergeable. (Chosen approach: commit solo runs, mirroring issue 15. Alternatives considered — merge step stashes/commits residue, or a preflight prompt — are inferior because they leave "finished" ambiguous.) Only commit on the done transition; blocked/stopped solo Runs are left for the user. Keep it idempotent.

## Acceptance criteria

- [ ] A solo Run that reaches `done` results in a commit on `main` (files + done flip); `main` is clean afterward.
- [ ] A subsequent parallel Merge is no longer blocked by leftover solo-run changes.
- [ ] Blocked/stopped solo Runs are not auto-committed.
- [ ] Auto-commit is idempotent (no double-commit). Integration test: solo Run done → main committed+clean → a parallel merge preflight passes.

## Blocked by

- 15
