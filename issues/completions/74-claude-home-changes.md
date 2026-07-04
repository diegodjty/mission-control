---
issue: 74
slug: claude-home-changes
outcome: needs-verification
finished: 2026-07-04T15:38:57Z
---
## Ready for manual verification — issue 74 (claude-home-changes, HITL)

**What was prepped:** all four human-gated `~/.claude` changes now sit as ready-to-apply files in `~/Workbench/tools/pending-setup/` (committed to the Workbench repo, commit `2764927`). Nothing under `~/.claude` was touched — that's yours to apply. The four artifacts:

1. **`01-afk-issue-runner-SKILL.md`** — the full proposed afk-issue-runner skill: today's file plus one appended "Workbench resolution (ADR-0015)" section covering the resolution order (explicit prompt paths → `~/Workbench/registry.md` by cwd → legacy in-repo fallback), the issue `repo:` field (unknown key = section-6 blocker), Receipt paths moving to `~/Workbench/<project>/completions/`, and CORE.md injection using issue 73's exact label, ~1.5k-token/~6,000-char cap, and truncation marker from `src/shared/workbench-memory.ts`.
   **Additive-only: verified.** `01-afk-issue-runner-additive.diff` against the snapshot `01-afk-issue-runner-SKILL.md.orig` is a single append hunk (`180a181,223`), 43 lines added, 0 removed, 0 changed.
2. **`02-memory-curator-SKILL.md`** — the new `memory-curator` skill: weekly pass per project (promote recurring journal facts, prune stale, dedupe), CORE cap enforcement, contradiction + secret-shaped-content flags with autonomous redaction in topics/journal, **propose-only on CORE.md** (`memory/CORE.proposed.md` for your sign-off), Receipt-style report to `~/Workbench/tools/curator-reports/`, one boring commit per pass, never pushes.
3. **`03-global-claude-md-snippet.md`** — the block to append to `~/.claude/CLAUDE.md`: on session start, resolve cwd via the registry (`status: active` entries only) and read that project's CORE.md as labeled background context; read-only, silent when unmapped.
4. **`04-curator-weekly-schedule.md`** — the exact crontab registration (Mondays 09:00, local `claude -p` run with `acceptEdits` scoped to `~/Workbench` cwd and git-commit-only allowed tools) plus a one-off smoke test. Local cron because the curator needs this machine's disk; free/self-hosted per your standing preference.

**Steps to verify and apply (detailed expected outputs in APPLY.md):**

1. `cat ~/Workbench/tools/pending-setup/APPLY.md` — read it once through.
2. Follow APPLY.md steps 1–4: drift-check the live skill against the snapshot (`diff` prints nothing), review the additive diff, `cp` the new SKILL.md in, verify with `diff` (nothing).
3. Follow steps 5–7: `mkdir -p ~/.claude/skills/memory-curator` and `cp` the curator SKILL.md in.
4. Follow steps 8–10: review the CLAUDE.md snippet, append it, `tail -4 ~/.claude/CLAUDE.md` shows it.
5. Follow steps 11–13: run the curator smoke test once (expect a report in `~/Workbench/tools/curator-reports/` and a `curator: weekly memory pass` commit), then install the cron line and confirm with `crontab -l`.
6. Step 14: flip `issues/74-claude-home-changes.md` from `wip` to `done` and tick the issue-74 box in `issues/HUMAN-SETUP.md`.

**Verified by the Worker:** artifact prep only — the additive-only diff check above, the snapshot's checksum matching the live skill at prep time, and internal consistency of label/cap/marker strings with `src/shared/workbench-memory.ts` (`CORE_MEMORY_LABEL`, `CORE_MEMORY_TOKEN_CAP` = 1500, char cap 6000, truncation marker). Not runtime-verified: applying to `~/.claude` and the cron/smoke run are exactly the human-gated steps this HITL issue reserves for you.

**Bookkeeping:** issue 74 left `status: wip` (you flip it after applying). Files written: the seven under `~/Workbench/tools/pending-setup/` (APPLY.md, proposed SKILL.md + snapshot + diff, curator SKILL.md, CLAUDE.md snippet, schedule doc), committed to `~/Workbench` on `main`. In the code repo, only this Receipt and the issue's wip flip; no code changes, no tests to run.

**Doc drift:** none against ADR-0015/issue 74. One note, not drift: the new skill section and CLAUDE.md line are inert for mission-control until issue 76 flips the registry entry to `status: active` — today everything still resolves through the legacy in-repo fallback, which is the intended sequencing.
