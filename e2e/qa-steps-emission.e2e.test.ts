/**
 * E2E — Workers emit `## QA Steps` on needs-verification Receipts (issue 197).
 *
 * Issue 196 built the schema, the strict parser (`qa-steps-model.ts`), and the
 * read-only render; this issue is the emission side. The scripted fake Worker
 * (`fake-worker.ts`) gains a `qaSteps` flag: set, a `needs-verification` exit's
 * Receipt carries a well-formed `## QA Steps` block alongside the existing
 * freeform "Ready for manual verification" prose. This suite drains a real
 * HITL sandbox issue through the real Worker driver, reads the Receipt back
 * off disk, and asserts it parses into structured steps via the SAME
 * `parseReceipt` → `resolveQaSteps` chain the Map's detail panel uses — no
 * LLM anywhere.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { sandboxIssue, seedSandbox, type Sandbox } from './sandbox';
import { runFakeWorker } from './fake-worker';
import { parseReceipt } from '../src/shared/receipt-parser';
import { resolveQaSteps } from '../src/shared/qa-steps-model';

let sandbox: Sandbox;

afterEach(async () => {
  await rm(sandbox.scratch, { recursive: true, force: true });
});

describe('Worker-emitted QA Steps on a needs-verification Receipt (issue 197)', () => {
  it('a drained HITL park with qaSteps produces a Receipt that resolves to structured steps', async () => {
    sandbox = await seedSandbox();
    const { repo, issuesDir } = sandbox;
    const issue = sandboxIssue(5); // the seeded HITL issue ("05-manual-check")

    const trace = await runFakeWorker({ repo, issue, exit: 'needs-verification', qaSteps: true });
    expect(trace.receiptPath).not.toBeNull();

    const receiptText = await readFile(trace.receiptPath!, 'utf8');
    expect(receiptText).toContain('## QA Steps');
    // Additive, not a replacement — the legacy freeform prose still renders.
    expect(receiptText).toContain('Ready for manual verification');

    const record = parseReceipt(receiptText);
    expect(record.outcome).toBe('needs-verification');
    expect(record.detail).toContain('## QA Steps');

    const issueBody = await readFile(`${issuesDir}/${issue.slug}.md`, 'utf8');
    const result = resolveQaSteps(record.detail, issueBody);
    expect(result?.kind).toBe('steps');
    if (result?.kind === 'steps') {
      expect(result.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of result.steps) {
        expect(step.action.length).toBeGreaterThan(0);
        expect(step.expected.length).toBeGreaterThan(0);
      }
      expect(result.steps[0].command).toBe('npm run dev');
    }
  });

  it('a needs-verification Receipt without qaSteps stays legacy-only (no block, resolves null)', async () => {
    sandbox = await seedSandbox();
    const { repo, issuesDir } = sandbox;
    const issue = sandboxIssue(5);

    const trace = await runFakeWorker({ repo, issue, exit: 'needs-verification' });
    const receiptText = await readFile(trace.receiptPath!, 'utf8');
    expect(receiptText).not.toContain('## QA Steps');

    const record = parseReceipt(receiptText);
    const issueBody = await readFile(`${issuesDir}/${issue.slug}.md`, 'utf8');
    expect(resolveQaSteps(record.detail, issueBody)).toBeNull();
  });
});
