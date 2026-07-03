# The Dispatcher has hybrid authority: autonomous on reversible mechanics, human-approved on scope

Mission Control's **Dispatcher** — the conversational orchestrator that spawns worker Panes, ingests each Run's Completion block, and synthesizes across Runs — acts **autonomously only on safe, reversible, mechanical actions** (commit a clean checkpoint between issues, synthesize/relay progress, start the next queued Run within the cap) and **proposes for one-click human approval every scope-changing judgment call** (logging a new issue, a Merge, aborting a drain, changing course).

## Considered Options

- **Pure advisor** — synthesizes and recommends; every action is a human click. Rejected: drowns the user in clicks for reversible mechanics (e.g. inter-issue commits) that need no oversight.
- **Autonomous driver** — decides and acts on everything, surfacing after the fact. Rejected: discards the human oversight the user has valued throughout (and contradicts ADR-0002's human-triggered Merge, ADR-0001's interactive posture).
- **Hybrid** (chosen) — the autonomy line is drawn at reversibility/scope.

## Consequences

- The division is exactly how the dispatcher role worked in the session that inspired this feature: commit + relay freely, but ask before scope decisions (log these issues? do the hardening pass? which wave?). That made the long drain both fast and safe.
- "Reversible mechanics" (auto) vs "scope-changing" (approve) is the classification the implementation must encode; a Merge is explicitly approve-side (consistent with ADR-0002).
- The Dispatcher is a distinct authority layer from the deterministic **Run Coordinator** (which owns cap/queue/startable scheduling) — the Dispatcher delegates scheduling to it rather than reimplementing it (see ADR-0008 once resolved).
- Depends on Completion-block capture (the Dispatcher's input); it never consumes raw Pane output.
