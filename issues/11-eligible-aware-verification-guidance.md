---
status: done
depends_on: []
---

# 11 — Verification guidance should point at currently-eligible issues, not stale numbers

## Source

Found while draining the Mission Control backlog (this session, 2026-07-02). A completed issue's "Try it yourself" block told the user to "click Run on issue 04/05" — but the same drain then marked 04 and 05 `done`, so by the time the user read it, no Run button existed on those rows and the instructions were dead. Standalone finding, not part of the PRD.

## What to build

Make Mission Control's own guidance about "what can I run to see this working" reference the **live, currently-eligible** set rather than issue numbers captured at some earlier moment. Concretely, when the app presents a Run's outcome / verification affordance (e.g. a completion summary panel, an empty-state on the Map, or Run help text), it should derive "here are the issues you can Run right now" from the same eligibility source of truth the Map already uses (`run-eligibility` / `issue-graph`), and show that live — so a status change elsewhere in the batch never leaves the user chasing a stale number.

If there are **no** eligible issues (everything done/wip/blocked — the exact state that triggered this finding), say so explicitly and explain why (e.g. "no eligible issues — 06/09 are blocked on 03 which is wip"), rather than showing a Run affordance that points nowhere.

Scope note: the parallel remedy on the workflow side — teaching the afk-issue-runner completion block not to hardcode sibling issue numbers as test targets — is a separate skill-file tweak, out of scope for this app issue. This issue is only the Mission-Control-side behavior.

## Acceptance criteria

- [ ] Any in-app guidance about which issues can be Run is derived live from the current backlog's eligibility, not from a value fixed at render time earlier.
- [ ] When the backlog has no eligible issues, the app states that and names what's blocking (or that everything is done/wip), instead of pointing at a Run action that isn't there.
- [ ] The eligibility determination reuses the existing pure `run-eligibility`/`issue-graph` modules (one source of truth), and any new decision logic is unit-tested.
- [ ] Existing Map/Run behavior is unchanged for the eligible case.

## Blocked by

None - can start immediately. (Standalone; in-batch PRD issues take precedence when both are eligible.)
