---
status: done
depends_on: [3]
---

# 09 — Multiple Projects, multiple Windows

## Parent

`docs/PRD.md` — Mission Control.

## What to build

Turn the single-Project app into the multi-Project backend of ADR-0004. Introduces the **Project Registry** — a pure module holding the set of **Projects** (repo path + pipeline stage + Runs) and the legal stage transitions, and enforcing that no two Windows manage the same repo at once. Each Project opens in its own **Window** backed by the one main-process backend; you can switch the active Project within a Window. No second backend, no port collisions.

## Acceptance criteria

- [ ] You can register multiple Projects (repo paths) and open each in its own Window.
- [ ] Two Windows (e.g. two different Projects) run at once against a single backend — no second process/port.
- [ ] Attempting to open/manage the same repo in two Windows is prevented with a clear message.
- [ ] You can switch the active Project within a Window.
- [ ] Project Registry is a pure module, unit-tested: legal/illegal stage transitions, and rejection of a duplicate repo claim.

## Blocked by

- 03
