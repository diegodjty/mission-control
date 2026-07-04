---
status: open
depends_on: []
---

# 70 — Pure workbench model: registry, project CONFIG, `repo:` field, resolution decision

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

A pure `workbench-model` module (house PURE contract: no I/O, never throws) with unit tests: parse `registry.md` (repo path → project entries, active/inactive), parse a project `CONFIG.md`'s frontmatter/body for the `repos:` map + `default_repo` + test commands, parse an issue's optional `repo:` frontmatter, and the **resolution decision**: given {explicit prompt paths?, registry content?, cwd, legacy in-repo `issues/` present?} → {workbench project (issues root, completions root, memory root, target repo path for an issue) | legacy layout | unresolved}. Resolution order per ADR-0015: explicit paths → registry lookup → legacy fallback. An issue naming an unknown `repo:` key resolves to an explicit error value (never a guessed path). Tilde expansion handled at the edge, not in the pure layer.

## Acceptance criteria

- [ ] Registry/CONFIG/issue-frontmatter parsing covered by unit tests incl. malformed input (never throws; explicit error values).
- [ ] Resolution decision table tested: all three orders, inactive registry entries skipped, unknown `repo:` key → error, single-repo projects need no `repo:` field.
- [ ] No filesystem or Electron imports; full suite + type-check pass.

## Blocked by

None - can start immediately.
