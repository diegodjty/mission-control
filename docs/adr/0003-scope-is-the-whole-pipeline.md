# Mission Control's scope is the whole pipeline, not just execution

Mission Control is the single home for the entire `grill → to-prd → to-issues → afk` workflow, not just backlog execution. It has two purpose-built views: an **Execution view** (Map + parallel Panes + Merge) and a **Planning view** for the grilling/PRD/issue-generation stages. Execution is the first slice to build; the Planning view is a later slice.

## Considered Options

- **Execution-only** (recommended during grilling) — assume a populated `issues/` backlog exists; planning stays in a normal terminal. Rejected by the user: they want to run the *whole* process from one place ("i just want to work off of this mission control").
- **Whole pipeline** (chosen) — Mission Control also hosts the planning stages.

## Consequences

- Planning is a *conversation with live document output*, not a tiled terminal, so it gets its own view rather than reusing the Pane layout. Leading direction: a split screen with the interview on one side and `CONTEXT.md` / PRD / ADRs rendering live on the other (the shape of a `grill-with-docs` session itself). Detailed design deferred.
- Because Panes are generic Claude Code sessions, scoping v1 to the Execution view costs nothing later — a Planning view can be added as its own slice without rework.
- Introduces a notion of pipeline *stage* per project (planning → backlog → execution → merge/QA), which interacts with the still-open single-project-vs-portfolio question.
