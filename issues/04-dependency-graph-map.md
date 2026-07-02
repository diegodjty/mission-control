---
status: done
depends_on: [2]
---

# 04 — Dependency graph and blocked reasons on the Map

## Parent

`docs/PRD.md` — Mission Control.

## What to build

Extend the **Map** (and the **Backlog Model**'s output) to show the dependency relationships between issues as a graph, and to explain *why* a blocked issue is blocked (which `depends_on` isn't `done` yet). Surface HITL issues distinctly. This is what turns the flat list from issue 02 into the bird's-eye "where is the whole feature" view.

Can be built in parallel with issue 03 — both hang off 02.

## Acceptance criteria

- [ ] The Map renders the dependency edges between issues (a graph or clear visual equivalent).
- [ ] A blocked issue shows the specific unmet dependency/dependencies, not just "blocked".
- [ ] An issue whose dependencies are all `done` shows as eligible.
- [ ] HITL issues are visually distinct.
- [ ] The eligibility/blocked-reason computation lives in the Backlog Model and is covered by its unit tests.

## Blocked by

- 02
