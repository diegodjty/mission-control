---
status: done
depends_on: [72, 73]
---

# 75 — E2E workbench fixtures: cross-repo drain, resolution, memory — legacy retained

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

Extend the drain harness with a **workbench-shaped fixture**: a temp workbench (registry, project CONFIG with a two-repo `repos:` map, memory skeleton) plus two temp code repos. Scenarios, machine-before-human: (a) a mixed drain where issues declare different `repo:` targets and a cross-repo `depends_on` chain executes in order, each fake Worker's cwd asserted; (b) Receipts land in the workbench completions root and drive one card/narrative message each; (c) CORE.md content appears in spawned Worker prompts; a finished drain writes one journal entry; (d) the workbench auto-commit trail exists (one commit per Run event); (e) an issue naming an unknown `repo:` key blocks that Run without stalling siblings; (f) **legacy fixture unchanged and still green** (all existing scenarios, incl. stray-adoption for legacy layout). Misbehavior modes (linger, no-receipt, die-mid-exit) run against the workbench fixture too.

## Acceptance criteria

- [ ] Scenarios a–f pass in `npm run test:e2e`, each named; misbehavior modes exercised on the workbench fixture.
- [ ] Reverting issue 72's repo-targeting makes scenario (a) fail (the suite guards the feature).
- [ ] Legacy scenarios all still pass; any live-shell-only residue declared `manual-only` — zero silent gaps.
- [ ] Full suite + type-check + e2e pass.

## Blocked by

- 72, 73
