---
status: wip
depends_on: [69]
hitl: true
---

# 74 — ~/.claude changes: skill upgrade, curator install, global CLAUDE.md line, weekly schedule (HITL)

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

Everything human-gated under `~/.claude`, prepped by the Worker as **exact ready-to-apply artifacts** (the permission system rightly blocks autonomous agents from editing their own operating manuals — issue 54 precedent), parked for the user to apply in one sitting:

1. **afk-issue-runner upgrade (additive-only diff):** workbench resolution per ADR-0015's order (explicit prompt paths → `~/Workbench/registry.md` lookup by cwd → legacy in-repo fallback), the issue `repo:` field (work in that repo; unknown key = section-6 blocker), Receipt path resolution to the workbench completions root, and reading `memory/CORE.md` as context when resolving via registry.
2. **Curator skill (new):** a `memory-curator` skill implementing ADR-0015's rules — weekly pass over each project's memory/: promote recurring journal facts, prune stale ones, dedupe, enforce the CORE token cap, flag contradictions and secret-shaped content; **autonomous on topics/journal, proposes CORE.md diffs for sign-off**; writes its own Receipt-style report into the workbench.
3. **Global `~/.claude/CLAUDE.md` line:** on session start, resolve cwd via the registry and read that project's CORE.md (the zero-repo-trace warm start).
4. **Schedule:** the exact command/config to register the curator weekly.

Worker writes all four as files under `~/Workbench/tools/pending-setup/` with a numbered APPLY.md, verifies the skill diff is additive-only against a snapshot, and parks.

## Acceptance criteria

- [ ] The four artifacts exist, are internally consistent with ADR-0015 and issues 69–73's conventions, and APPLY.md gives exact numbered steps with expected outputs.
- [ ] Skill diff verified additive-only; the full proposed SKILL.md also provided for direct copy.
- [ ] Human applied them: skill updated, curator installed + scheduled, CLAUDE.md line added — then this issue flips done.

## Human prerequisites

- Apply the prepped `~/.claude` changes per APPLY.md (approve the skill edit interactively).
- Register the weekly curator schedule.

## Blocked by

- 69
