---
status: open
depends_on: [2]
---

# 05 — Live Map updates from disk

## Parent

`docs/PRD.md` — Mission Control.

## What to build

The **Map** reflects changes to the underlying `issues/` files without a manual refresh — so when a Run flips an issue to `wip` or `done`, or you edit an issue by hand, the Map updates on its own. Resolves the open build-time probe of file-watching the `issues/` directory vs. polling; pick one, and record the choice briefly (a short note in the issue's completion block or a lightweight ADR if it turns out to be a real trade-off).

## Acceptance criteria

- [ ] Editing an issue file's status on disk updates the Map within a couple of seconds, no manual refresh.
- [ ] Adding or removing an issue file updates the Map.
- [ ] The mechanism doesn't peg the CPU or leak watchers when Windows open/close.
- [ ] The chosen mechanism (watch vs. poll) is recorded.

## Blocked by

- 02
