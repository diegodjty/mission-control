---
status: open
depends_on: [2]
---

# 03 — Run one issue in a Pane and watch it reach done

## Parent

`docs/PRD.md` — Mission Control.

## What to build

The execution tracer bullet. From the **Map**, start a **Run** on an eligible issue: the main process spawns a **fresh** interactive `claude` session running `/afk-issue-runner` for that issue, in a new **Pane** you can watch and type into. Permission prompts and "blocked, need you" moments appear live in the Pane (inherited from interactive Claude Code). You can stop the Run (kill the session). When the issue's status flips to `done` on disk, the Map reflects it and the Run is marked finished.

Solo mode only here: the Run works directly on `main`, no worktree (concurrency and isolation come in 06–08). One fresh session per issue is the whole point — it matches the `/clear`-per-issue habit.

## Acceptance criteria

- [ ] An eligible issue on the Map has a "Run" action; starting it opens a fresh Pane running `/afk-issue-runner` scoped to that issue.
- [ ] The Pane is fully interactive — typing reaches the session, prompts render, you can answer.
- [ ] Stopping the Run terminates the underlying session cleanly.
- [ ] When the issue reaches `done`, the Map updates and the Run shows finished; if the session stops blocked, the Run shows blocked with its reason.
- [ ] The Run works on `main` with no worktree created.

## Blocked by

- 02
