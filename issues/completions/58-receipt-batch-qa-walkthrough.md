---
issue: 58
slug: receipt-batch-qa-walkthrough
outcome: needs-verification
finished: 2026-07-03T23:03:55Z
---
## Ready for manual verification — issue 58: Receipt batch QA walkthrough (HITL)

**What I prepped:** The QA sandbox at `/Users/devteam/Developer/mc-qa-sandbox/repo-a` is reset to its seed state per the procedure in the issue file: worktrees removed and pruned, all `afk/*` branches deleted, `git reset --hard` to the seed root commit (`b8c1eea`), `git clean -fdx` (which removed the leftover `issues/.afk-parallel`, `issues/afk-merge.conf`, `issues/completions/`, and `deliverables/`), and `../.afk-worktrees` deleted. Verified against the seed: **01 done, 05 open with `hitl: true`, 03 open and dep-blocked on 02** (02 open), and 04/06/07 open; `main` is the only branch, working tree clean, single commit. Issue 58 is claimed (`status: wip`) and stays `wip` until you sign off. Toolchain prerequisites verified live (git 2.50.1, Node v22.23.1 via nvm, `claude` CLI 2.1.200 on PATH) — note the boxes in `issues/HUMAN-SETUP.md` were never ticked, but all three are demonstrably installed; the checklist is stale, not blocking.

**Your walkthrough** (checklist from `issues/58-receipt-batch-qa-walkthrough.md` — the headline seam is Worker-writes-Receipt (54) → edge ingests it (56) → HITL notice fires, closing the issue-53 gap):

1. Start Mission Control:
   `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22 && npm run dev`
   Expect: the Electron window opens. Point it at the project `/Users/devteam/Developer/mc-qa-sandbox/repo-a`.
2. **Solo Receipt:** drain repo-a with cap 1. As the first issue finishes, check `/Users/devteam/Developer/mc-qa-sandbox/repo-a/issues/completions/NN-slug.md` exists with `outcome: completed` in its frontmatter, and exactly one Run-log card shows the block's sections.
3. **HITL notice (the issue-53 fix):** let the drain reach the parked HITL issue 05. Expect: the Dispatcher **chat** (not the ambient log, not silence) shows one prominent "waiting for you" notification naming issue 05 with its manual-verification steps, sourced from a Receipt with `outcome: needs-verification`.
4. **Zero ghosts:** across the whole drain, confirm status and the Run log contain no unclassifiable/boot-screen entries.
5. **Parallel mode:** reset the sandbox again first so parallel runs start clean — in `/Users/devteam/Developer/mc-qa-sandbox/repo-a` run: `rm -rf ../.afk-worktrees && git worktree prune && git branch --list 'afk/*' --format='%(refname:short)' | xargs -n1 git branch -D; git reset --hard b8c1eea && git clean -fdx` — then drain with cap 2. Expect: each worktree Run's Receipt surfaces live (card appears while the Run's branch is unmerged); after a clean auto-Merge, the Receipt files are present on `main`.
6. **Missing receipt:** delete a Receipt mid-drain after its issue flipped done (or hand-flip an issue to done with no Receipt). Expect: exactly one "finished without receipt" passive note in the ambient log; no scrape, no junk entry.
7. **Blocked exit:** arrange the backlog so only the dep-blocked issue is eligible (03 depends on 02 — e.g. after the resets above, hand-flip 04/05/06/07 away from open, or use the state a drain leaves) and run it. Expect: the Worker's blocked report lands as a Receipt with `outcome: blocked` and one card.
8. On full pass: record sign-off, flip `issues/58-receipt-batch-qa-walkthrough.md` from `wip` to `done`. That unblocks re-running the parked walkthroughs 40, 51, and 10 under the new capture pipeline.

To stop the dev app: Ctrl+C in the terminal running `npm run dev`.

**Verified (by me):** sandbox reset executed and end-state confirmed by inspection (git log/branch/worktree/status plus frontmatter grep of all seven issue files). Not runtime-verified beyond that — the walkthrough itself is the human verification this issue exists for; I did not launch Mission Control or run any drain.

**Bookkeeping:** no code changes; no tests to add (prep-only HITL issue). Files touched: `issues/58-receipt-batch-qa-walkthrough.md` (status → wip), this Receipt, plus the sandbox reset in `/Users/devteam/Developer/mc-qa-sandbox/repo-a` (outside this repo).

**Doc drift:** none in the PRD/issue. Minor: `issues/HUMAN-SETUP.md` checkboxes are all unticked despite the toolchain being installed and used by 57 done issues — worth ticking or noting, and it may mislead future runs into skipping HITL issues.
