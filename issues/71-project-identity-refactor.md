---
status: done
depends_on: [70]
---

# 71 — Project = Workbench entry: the identity refactor (registry, IPC, watchers)

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

Break the `ProjectView.repoPath` identity: a Project is now a workbench entry (issue 70's resolved shape) that references one or more repos. Registry, IPC contract, ownership model, open/switch flows, and the backlog watcher key on the workbench project (its issues root) instead of a single repo path. A **legacy project** (opened by repo path, in-repo `issues/`) keeps working through the same resolved shape (the resolution decision returns legacy roots) — one code path downstream, two resolutions upstream. The Map reads the project's issues root wherever it is. Opening a project by picking either its workbench dir or any of its repos resolves to the same Project (registry lookup).

## Acceptance criteria

- [ ] Opening the QA sandbox by repo path works unchanged (legacy resolution).
- [ ] A workbench-shaped fixture project opens by workbench dir or by member-repo path and lands on the identical Project (same ownership key).
- [ ] Backlog watch, on-demand status, and the Map read the resolved issues root for both layouts.
- [ ] Ownership guard keys updated so two Windows can't own the same Project under different aliases (repo path vs workbench dir).
- [ ] Unit tests on the new identity/ownership keys; full suite + type-check pass.

## Blocked by

- 70
