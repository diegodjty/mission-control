/**
 * E2E worker model tiering (issue 154) — drives the REAL tiering + escalation
 * decisions against REAL infrastructure, the same philosophy as the drain
 * harness (issue 63): a temp git repo seeded like the QA sandbox, real
 * worktrees, the real headless command builder, the real backlog reader, and
 * scripted (no-LLM) fake Workers with configurable exits. No LLM anywhere.
 *
 * It proves the two behaviors the cost incident's fix hinges on:
 *   1. Escalation — a Worker declared `haiku` that FAILS is re-run one tier up
 *      (`sonnet`) from a FRESH worktree (the failed attempt's work discarded),
 *      and that attempt completes. The per-attempt tier ledger records which
 *      tier each attempt used (haiku → sonnet), the data the drain journal /
 *      telemetry surfaces (feeds issue 143). Each attempt's REAL headless
 *      command carries `--model <id>` for its resolved tier.
 *   2. Cheap default — an issue with no `model:` override drains on the CONFIG
 *      default (`sonnet`) and completes on the first attempt with no escalation,
 *      spawning `--model claude-sonnet-5` instead of inheriting the expensive
 *      interactive default that caused the incident.
 *
 * Kept in its own file (not appended to drain-harness.e2e.test.ts) so it stays a
 * focused, self-contained feature proof.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBacklog } from '../src/main/backlog-reader';
import {
  createWorktree,
  readIsolatedIssueStatus,
  worktreePathFor,
} from '../src/main/git-worktree-adapter';
import type { ShellCommand } from '../src/main/resolve-shell';
import { resolveHeadlessRunCommand } from '../src/main/resolve-run-command';
import { branchFor } from '../src/shared/isolation-policy';
import { deriveRunStatus, type RunStatus } from '../src/shared/run-state';
import { parseReceipt } from '../src/shared/receipt-parser';
import {
  effortForTier,
  modelIdForTier,
  nextEscalation,
  resolveWorkerEffort,
  resolveWorkerModel,
  type DrainAttempt,
  type WorkerModelTier,
} from '../src/shared/worker-model';
import { seedSandbox, sandboxIssue, git, type Sandbox, type SandboxIssue } from './sandbox';
import { runFakeWorker } from './fake-worker';

let sandbox: Sandbox;
let repo: string;

beforeEach(async () => {
  sandbox = await seedSandbox();
  repo = sandbox.repo;
});

afterEach(async () => {
  await rm(sandbox.scratch, { recursive: true, force: true });
});

/** Rewrite a seeded issue's file with an optional `model:` frontmatter line and
 *  commit it — the on-disk shape the real backlog reader parses `model` from. */
async function setIssueModel(id: number, model: WorkerModelTier | null): Promise<void> {
  const issue = sandboxIssue(id);
  const modelLine = model ? `model: ${model}\n` : '';
  const content =
    `---\nstatus: open\ndepends_on: [${issue.dependsOn.join(', ')}]\n` +
    `${issue.hitl ? 'hitl: true\n' : ''}${modelLine}---\n\n` +
    `# ${issue.id} — ${issue.title}\n\nScripted tiering issue for the e2e.\n`;
  await writeFile(join(sandbox.issuesDir, `${issue.slug}.md`), content);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', `e2e: set issue ${id} model=${model ?? 'none'}`);
}

/**
 * Run one scripted attempt for `issue` at `tier` in a FRESH worktree, discarding
 * any prior attempt's worktree + branch first (the "each retry from a fresh
 * worktree" contract). Returns the attempt's terminal Run status (observed the
 * way MC does — branch tip + Receipt) and the REAL headless command it spawned.
 */
async function runAttempt(
  issue: SandboxIssue,
  tier: WorkerModelTier,
  exit: 'completed' | 'blocked',
): Promise<{ status: RunStatus; command: ShellCommand }> {
  const { slug } = issue;
  const wtPath = worktreePathFor(repo, slug);
  // Discard the previous attempt's partial work: remove its worktree + branch.
  if (existsSync(wtPath)) {
    await git(repo, 'worktree', 'remove', wtPath, '--force');
    await git(repo, 'branch', '-D', branchFor(slug)).catch(() => undefined);
  }
  await createWorktree(repo, slug, branchFor(slug));

  // The REAL command this attempt would spawn — carrying --model for the tier
  // AND --effort for the tier-derived level (issue 155). The sandbox CONFIG sets
  // no worker_effort, so effort derives from the (possibly escalated) tier: a
  // retry on a bigger model is also more deliberate.
  const command = resolveHeadlessRunCommand(
    {},
    { id: issue.id, fileName: `${slug}.md`, title: issue.title, cwd: wtPath },
    { model: tier, effort: resolveWorkerEffort({ tier }) },
  );

  await runFakeWorker({ repo, worktree: wtPath, issue, exit });

  // Observe the terminal state from the branch tip and the declared Receipt,
  // exactly as the coordinator derives a worktree Run's status.
  const obs = await readIsolatedIssueStatus(repo, slug);
  const receiptText = await readFile(
    join(wtPath, 'issues', 'completions', `${slug}.md`),
    'utf8',
  );
  const status = deriveRunStatus({
    sessionAlive: false,
    stoppedByUser: false,
    issueStatus: obs.status,
    receiptOutcome: parseReceipt(receiptText).outcome,
  });
  return { status, command };
}

describe('worker model tiering e2e — real worktrees, real command builder', () => {
  it('a haiku Worker that fails escalates to sonnet from a fresh worktree and completes', async () => {
    // The issue declares `model: haiku` (a hand-set starting tier). The real
    // backlog reader parses it; the CONFIG default stays sonnet.
    await setIssueModel(2, 'haiku');
    const backlog = await readBacklog(repo);
    const issue = backlog.issues.find((i) => i.id === 2)!;
    expect(issue.model).toBe('haiku');
    expect(backlog.workerModel).toBe('sonnet');
    expect(backlog.escalationCeiling).toBe('opus');

    const sbIssue = sandboxIssue(2);
    const ledger: DrainAttempt[] = [];

    // --- Attempt 1: the resolved tier is the hand-set haiku; the Worker fails.
    const tier1 = resolveWorkerModel({
      configDefault: backlog.workerModel,
      issueModel: issue.model,
    });
    expect(tier1).toBe('haiku');
    const a1 = await runAttempt(sbIssue, tier1, 'blocked');
    expect(a1.command.args).toContain('--model');
    expect(a1.command.args[a1.command.args.indexOf('--model') + 1]).toBe(modelIdForTier('haiku'));
    // Effort derives from the haiku tier → low (issue 155).
    expect(a1.command.args[a1.command.args.indexOf('--effort') + 1]).toBe(effortForTier('haiku'));
    expect(a1.command.args[a1.command.args.indexOf('--effort') + 1]).toBe('low');
    expect(a1.status).toBe('blocked');
    ledger.push({ tier: tier1, status: a1.status });

    // --- The escalation decision: one tier up from a fresh worktree.
    const decision = nextEscalation({ attempts: ledger, ceiling: backlog.escalationCeiling });
    expect(decision.escalate).toBe(true);
    expect(decision.nextTier).toBe('sonnet');

    // --- Attempt 2: fresh worktree at the escalated tier; the Worker completes.
    const a2 = await runAttempt(sbIssue, decision.nextTier!, 'completed');
    expect(a2.command.args[a2.command.args.indexOf('--model') + 1]).toBe(modelIdForTier('sonnet'));
    expect(a2.command.args[a2.command.args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    // Escalation RE-DERIVES effort for the new tier: haiku(low) → sonnet(medium)
    // — the retry is both a bigger model and more deliberate reasoning.
    expect(a2.command.args[a2.command.args.indexOf('--effort') + 1]).toBe('medium');
    expect(a2.status).toBe('finished');
    ledger.push({ tier: decision.nextTier!, status: a2.status });

    // The success stops escalation — no third, more expensive attempt.
    expect(nextEscalation({ attempts: ledger, ceiling: backlog.escalationCeiling }).escalate).toBe(
      false,
    );

    // The per-attempt tier ledger — which tier each attempt used (feeds issue
    // 143's telemetry/journal): haiku failed, sonnet completed.
    expect(ledger).toEqual([
      { tier: 'haiku', status: 'blocked' },
      { tier: 'sonnet', status: 'finished' },
    ]);

    // The completing attempt's worktree really did finish the issue (done, on
    // its fresh branch) — the escalated Run's work landed, the failed one's was
    // discarded with its worktree.
    const finalObs = await readIsolatedIssueStatus(repo, sbIssue.slug);
    expect(finalObs.status).toBe('done');
  });

  it('an issue with no override drains on the cheap CONFIG default (sonnet) and never escalates', async () => {
    // No `model:` line: the drain-worker tier is the CONFIG worker_model default.
    const backlog = await readBacklog(repo);
    const issue = backlog.issues.find((i) => i.id === 4)!;
    expect(issue.model).toBeNull();

    const tier = resolveWorkerModel({ configDefault: backlog.workerModel, issueModel: issue.model });
    expect(tier).toBe('sonnet');

    const a1 = await runAttempt(sandboxIssue(4), tier, 'completed');
    // The core cost fix: a drain Worker spawns WITH an explicit cheap --model,
    // never the expensive interactive default the incident inherited.
    expect(a1.command.args).toContain('--model');
    expect(a1.command.args[a1.command.args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    // …and an explicit --effort derived from the sonnet tier → medium (issue 155).
    expect(a1.command.args).toContain('--effort');
    expect(a1.command.args[a1.command.args.indexOf('--effort') + 1]).toBe('medium');
    expect(a1.status).toBe('finished');

    // A first-attempt success means no escalation ladder is ever climbed.
    expect(nextEscalation({ attempts: [{ tier, status: a1.status }] }).escalate).toBe(false);
  });
});
