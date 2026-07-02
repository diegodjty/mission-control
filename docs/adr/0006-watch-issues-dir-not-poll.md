# Live Map updates: watch the `issues/` directory, don't poll it

The **Map** must reflect changes to a Project's `issues/*.md` files without a manual refresh — a Run flipping an issue to `wip`/`done`, or a human hand-editing a file, or an issue being added/removed. Issue 02 left this as an open build-time probe: **file-watch vs. polling**. We choose **file-watching** (`fs.watch` on the `issues/` directory, in the main process).

## Considered Options

- **Poll** — the renderer (or main) re-reads the whole backlog on a fixed timer (the Run slice shipped a stopgap 2s poll that ran only while a Run was live). Simple and portable, but it forces a latency-vs-CPU trade-off: a short interval wastes work re-reading unchanged files forever; a long interval makes the Map feel stale. It also only updated during a Run, so hand-edits outside a Run never showed.
- **Watch** (chosen) — the main process registers an OS file watcher (`fs.watch`, backed by FSEvents/inotify) on `<project>/issues/`, debounces the event burst, re-reads the backlog through the pure Backlog Model, and pushes it to the renderer only when the Map-visible state actually changed.

## Decision

Watch. `fs.watch` is event-driven, so there is no idle CPU cost and no polling-interval latency knob to tune — updates land in well under a second, and only when something actually changed on disk.

To make watching robust we lean on two pure, unit-tested decisions (`src/shared/backlog-watch.ts`):

- `isRelevantChange(filename)` filters `fs.watch`'s noisy event stream down to `.md` writes (issue files *and* `CONFIG.md`, since the active PRD drives in-batch classification), erring toward reloading when the platform reports no filename.
- `backlogChanged(prev, next)` compares the re-read snapshot against the last one and suppresses the renderer push when nothing the Map renders differs — so a metadata-only touch or a no-op save doesn't cause a redundant re-render.

The watcher (`src/main/backlog-watcher.ts`) is keyed per renderer WebContents. Registering a key replaces (and closes) any prior watcher for it, and the key is closed on WebContents `destroyed` and on app quit — so watchers never outlive the Window that needed them.

## Consequences

- **Gained:** sub-second, CPU-cheap live updates for Run-driven flips *and* out-of-band hand-edits and file add/remove; the general mechanism supersedes the Run slice's targeted 2s poll (now removed) — there is exactly one update path, and the Run's status rides on it.
- **Given up:** `fs.watch` has known cross-platform quirks (event coalescing, unreliable `filename`, occasional missed events under rapid churn). We mitigate the first two with the debounce + "reload the whole backlog on any relevant event" strategy; the last is acceptable for a local single-user tool editing a handful of small files. If a missed-event case ever bites, a low-frequency safety re-read on an interval can be layered on without changing the contract.
- **Constraint:** watching lives in the main process (renderers have no fs access), pushed to the renderer over the existing IPC contract (`backlog:watch` / `backlog:changed`). Multiple Windows (issue 09) already fit: each WebContents keys its own watcher.
