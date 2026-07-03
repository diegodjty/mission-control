---
status: open
depends_on: [8]
---

# 23 — [HIGH] Merge must report and clean up what afk-merge.sh actually merged

## Source

Hardening review (2026-07-03), findings corr-2 + corr-9 + corr-10 (the 17-worker's flag, confirmed). `mergeRuns` treats exit 0 as "all requested slugs merged" — it pushes every input slug into `merged` and never parses the script's result. But `afk-merge.sh` exits 0 while *skipping* branches that are missing ("no branch — skipping") or already-in-main. So a stale-scan Merge reports "Merged 1 branch into main" when zero merged, and cleanup (keyed on requested slugs, not merged ones) then misreports "left worktree in place." Conflict detection is a brittle substring regex (`/conflict/i`) that mislabels preflight `die`s.

## What to build

Parse `afk-merge.sh`'s structured output (it emits `SUMMARY`/`MERGED_LABELS`-style rows) so `mergeRuns` reports and cleans up based on **what actually merged**: skipped/missing/already-merged slugs must not be counted as merged, and cleanup (worktree remove + branch delete) runs only for genuinely-merged slugs. Replace the substring conflict check with the script's structured conflict signal so a preflight failure (dirty tree / wrong branch) is reported as its real cause, not a generic "could not run" or a false "conflict".

## Acceptance criteria

- [ ] A requested slug whose branch does not exist is NOT reported in `merged`, and the message reflects the true count.
- [ ] An already-in-main / skipped branch is reported accurately (not as a fresh merge).
- [ ] Cleanup acts only on actually-merged slugs.
- [ ] Conflict vs. preflight-failure vs. clean is classified from the script's structured output, not a substring match; the failure message names the real cause.
- [ ] Tests: a merge request including a non-existent slug asserts it's excluded from `merged`; a preflight-dirty case asserts an accurate cause message (not "conflict").

## Blocked by

- 8
