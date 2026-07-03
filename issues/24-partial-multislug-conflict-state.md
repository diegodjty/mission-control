---
status: done
depends_on: [8, 23]
---

# 24 — [HIGH] Handle partial multi-slug merge / mid-conflict state

## Source

Hardening review (2026-07-03), finding corr-3. `afk-merge.sh` merges slugs sequentially, committing each clean `--no-ff` to `main` before the next; the first non-chokepoint conflict `exit 1`s immediately, leaving `main` **mid-merge with a conflicted index** and earlier slugs already merged. `mergeRuns` then returns `merged:[]`, `conflicted:true`, "Nothing was cleaned up" — wrong (earlier slugs ARE on main), and clicking Merge again hits the dirty-tree preflight (`die`), so the retry is blocked until the user manually resolves+commits in git. A non-git user is stranded, and a new drain would run on a conflicted `main`.

## What to build

Report the partial-merge truth (which slugs merged before the conflict, which one conflicted, that `main` is mid-merge) and give an in-app path forward rather than a dead end: surface the conflicting files, and either provide an abort/reset of the in-progress merge (restoring a clean `main`) or clear guidance + a retry that doesn't just re-trip the preflight. Ensure a subsequent drain cannot start on a `main` left mid-merge.

## Acceptance criteria

- [ ] After a partial merge (slug A clean, slug B conflicts), the report states A merged, B conflicted, and that `main` is mid-merge — not "nothing merged / nothing cleaned up".
- [ ] The user has an in-app way to either resolve-and-continue or abort the in-progress merge back to a clean `main` (no manual git required for the common case).
- [ ] A new drain/Run refuses to start while `main` has an in-progress/conflicted merge, with a clear message.
- [ ] Integration test drives the partial-conflict path and asserts the reported state matches `main`'s actual state.

## Blocked by

- 8
- 23
