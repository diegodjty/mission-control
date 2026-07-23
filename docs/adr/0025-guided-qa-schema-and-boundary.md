# Guided QA: the `## QA Steps` schema, strict parser, and a display-only boundary

**Status:** accepted (2026-07-23). Realizes the foundation slice of roadmap item 5 ("Guided QA mode"). Grill session 2026-07-23. Builds on issue 156 (interactive HITL checklist — the roadmap-5 MVP this batch supersedes for issues that opt in) and issue 195 (HITL issues are drained never — a walkthrough's steps can therefore only ever live in its own body, never only in a Receipt). Batch: issues 196 (this ADR + schema/parser/render), 197 (Workers emit the block), 198 (durable per-pass QA Receipts + verdicts), 199 (session-end done-flip / failure filing), 200 (e2e), 201 (batch walkthrough).

Issue 156 gave a parked HITL issue a tickable checklist parsed out of loose `- [ ]` markdown lines. It works, but the steps it ticks are unstructured prose — no distinction between "what to do" and "what you should see", and no way to hand the human a ready-to-paste command. Turning the *existing* batch-QA-walkthrough markdown a drain already emits into something an app can render richly needs a real, deterministic schema instead of grep-for-checkbox-lines.

## Decision

- **A new `## QA Steps` markdown block**, additive alongside (never replacing) the 156 checklist syntax. A document carries at most one; each step is a flush-left bullet (`-`/`*`) or ordinal (`1.`) list item with two required labelled fields and one optional one, in any order but conventionally:

  ```markdown
  ## QA Steps

  - Action: Start the dev server with `npm run dev`.
    Expected: The Map window opens with the backlog loaded.
    Command: npm run dev

  - Action: Select any HITL issue in the list.
    Expected: The detail panel expands below the row.
  ```

  **Action** (what the human does) and **Expected** (what they should see) are required; **Command** (something to run first) is optional. A field's value ends at the next labelled field or at a blank line — so trailing prose after the list (a sign-off line, the next markdown section) is never swallowed into the last step.

- **Strict, pure parser (`src/shared/qa-steps-model.ts`), in the mold of `completion-parser.ts` and `checklist-model.ts`.** Three outcomes, never a throw: no `## QA Steps` heading → `null` (the legacy path takes over); a heading with at least one well-formed step → `{ kind: 'steps', steps }`; a heading whose body has no recognisable step, or where any step is missing Action or Expected → `{ kind: 'error', message }`. A malformed block is a **surfaced parse error**, not a partial list of just the steps that happened to parse — half-parsing a walkthrough is worse than telling the human it's broken.

- **Source precedence mirrors the 156 checklist (`resolveQaSteps`, same shape as `checklistSourceText`):** the Receipt's `detail` body wins when it carries a block, else the issue file's own body. This is load-bearing, not a fallback nicety — per issue 195, a HITL issue is never drained, so a batch-walkthrough issue's only chance to carry a QA Steps block is its own body. Requiring the Receipt is not an option.

- **Coexist by mode — the 156 contract holds exactly.** `resolveQaSteps` returning `null` means the document has no opinion on Guided QA at all, and the detail panel falls through to the unmodified 156 `ChecklistSection` (same ticks, same ephemeral tick-store). A `'steps'` or `'error'` result takes over the same HITL-only render slot instead. Guided QA is purely additive: an issue/Receipt that never adopts the new block behaves exactly as it did before this batch.

- **Display + copy only — no run affordance, anywhere.** The detail panel renders each step's action, expected outcome, and (if present) its command as a read-only line with a **copy-to-clipboard** button. MC does not execute QA commands on the human's behalf, ever, in this batch or the ones that follow it (198–201) — Guided QA verifies what a Worker already did, it does not become a second execution surface. Surrounding receipt prose (prep notes, context) is left alone as read-only text; the structured render only replaces the checklist slot, not the whole Receipt.

- **No verdict/pass-fail yet.** This slice is read-only rendering of the schema. Recording pass/fail per step and filing a failure back as an issue is issue 198 (durable per-pass QA Receipts) and issue 199 (session-end actions); this ADR fixes the schema and boundary those build on.

## Considered Options

- **Extend the 156 checklist's checkbox syntax** with inline `| expected | command` columns. Rejected: markdown tables/pipes inside a checkbox line are fragile to hand-author and don't tolerate wrapped prose; a dedicated heading + labelled-field block is far more forgiving and mirrors the completion block's own labelled-section convention.
- **Silently degrade a malformed block to whatever parsed before the break.** Rejected — same reasoning as `completion-parser.ts`'s outcome contract: a half-parsed walkthrough silently missing its last three steps is more dangerous than a visible parse error.
- **Let Guided QA execute the `Command` field via a "Run" button.** Rejected outright, now and for the rest of the batch: MC's execution surface is Runs/Workers; a manual QA pass clicking "run" blurs that boundary and reintroduces exactly the kind of ungoverned execution the Worker/Receipt pipeline exists to avoid. Copy-to-clipboard gets 95% of the convenience with none of the risk.

## Consequences

- **Gained:** a deterministic, testable schema (`qa-steps-model.ts`, unit-tested for well-formed/malformed/absent/precedence) that issues 197–201 build the rest of Guided QA on top of, without inventing their own parsing.
- **Given up / documented limitation:** two coexisting checklist-ish syntaxes in HITL documents (156's `- [ ]` and this batch's `## QA Steps`) until every HITL-heavy issue type migrates — accepted as the deliberate cost of "purely additive."
- **Docs:** this ADR is the schema's reference; CONTEXT.md should gain a "Guided QA" / "QA Steps block" term once issue 198's durable Receipt shape is settled (deferred to that issue so the term is defined once, not twice).
