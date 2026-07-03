---
status: open
depends_on: [8]
---

# 27 — [MED] Support non-`main` default branches

## Source

Hardening review (2026-07-03), findings corr-8 / state-H2. The default branch name `main` is hardcoded: `isMergedIntoMain` runs `git merge-base --is-ancestor afk/<slug> main` (errors → returns false for every branch on a `master`/`trunk` repo, so branches never look merged, the Merge button never clears, rows stay `finished (unmerged)` forever), `run-merge.ts` messaging assumes "into main", and `afk-merge.sh` preflight `die`s "is on 'master', not main". The whole merge path is unusable on a non-`main` repo.

## What to build

Detect the repo's actual default/current branch (e.g. `git symbolic-ref --short HEAD` or the remote head) instead of hardcoding `main`, and thread it through `isMergedIntoMain`, the merge messaging, and — importantly — `afk-merge.sh` (the skill script at `~/.claude/skills/afk-issue-runner/afk-merge.sh`), which also hardcodes `main`. If the skill script can't be changed in scope, at minimum detect the mismatch and surface a clear, actionable message rather than a silent permanent-`finished-unmerged` state.

## Acceptance criteria

- [ ] On a `master`/`trunk` repo, a finished branch is correctly detected as merged after merging, and the Merge button/row states clear.
- [ ] Merge works (or fails with a clear, accurate message) on a non-`main` default branch.
- [ ] `isMergedIntoMain` and merge messaging use the detected branch, not a hardcoded `main`.
- [ ] Note in the completion block whether `afk-merge.sh` needed changing and whether that change was made.
- [ ] Test includes a non-`main` scratch repo.

## Blocked by

- 8
