import { describe, expect, it } from 'vitest';
import {
  assembleInputContract,
  renderCompletionEvent,
  toCompletionEvent,
  type RunResult,
} from './dispatcher-input-contract';
import type { Backlog } from './backlog-model';
import { parseCompletionBlock } from './completion-parser';

// A sentinel only ever present in a Run's RAW Pane scroll — ANSI noise, a shell
// prompt, and a phrase that appears nowhere in its structured Completion block.
// If any of these leak into the contract, the exclusion rule is broken.
const RAW_PANE_SENTINEL =
  '\x1b[32mdevteam@host\x1b[0m:~/repo$ npm test\r\nRAW_PANE_ONLY_MARKER internal scratch noise';

const COMPLETION_TEXT = `## Completed issue 03 — run-issue-in-pane

**What changed**
The Map can now start a Run on an eligible issue.

**Try it yourself**
Open the app and click Run.

**Verified**
Loaded the page; the Pane spawned.

**Bookkeeping**
Touched Pane.tsx.

**Doc drift**
none`;

function backlog(): Backlog {
  return {
    activePrd: 'docs/PRD.md',
    workerModel: 'sonnet',
    escalationCeiling: 'opus',
    workerEffort: null,
    runTimeoutMinutes: 30,
    issues: [
      {
        id: 3,
        slug: 'run-issue-in-pane',
        fileName: '03-run-issue-in-pane.md',
        title: '03 — run one issue in a Pane',
        status: 'done',
        dependsOn: [],
        parent: 'docs/PRD.md',
        source: null,
        hitl: false,
        repoKey: null,
        model: null,
        effort: null,
        inBatch: true,
        standalone: false,
        // A body full of scroll-like noise — the assembler must not carry it.
        body: 'RAW_PANE_ONLY_MARKER should never reach the seed either',
      },
    ],
  };
}

function resultWithRawScroll(): RunResult {
  return {
    id: 'sess-1',
    record: parseCompletionBlock(COMPLETION_TEXT),
    rawPaneOutput: RAW_PANE_SENTINEL,
  };
}

describe('dispatcher input-contract assembler', () => {
  it('NEVER includes raw Pane output in the assembled contract', () => {
    const contract = assembleInputContract({
      backlog: backlog(),
      results: [resultWithRawScroll()],
    });
    const serialized = JSON.stringify(contract);
    // The whole point: the raw scroll marker is nowhere in the contract.
    expect(serialized).not.toContain('RAW_PANE_ONLY_MARKER');
    expect(serialized).not.toContain('npm test');
    // ...but the structured summary IS present.
    expect(serialized).toContain('The Map can now start a Run');
    expect(contract.stream).toHaveLength(1);
    expect(contract.stream[0].kind).toBe('completion-block');
    expect(contract.stream[0].whatChanged).toContain('start a Run');
  });

  it('excludes issue bodies from the seed (only id/status/title)', () => {
    const contract = assembleInputContract({ backlog: backlog(), results: [] });
    const serialized = JSON.stringify(contract.seed);
    expect(serialized).not.toContain('should never reach the seed');
    expect(contract.seed.issues).toEqual([
      { id: 3, status: 'done', title: '03 — run one issue in a Pane' },
    ]);
    expect(contract.seed.activePrd).toBe('docs/PRD.md');
  });

  it('carries the PRD/CONTEXT seed text when supplied', () => {
    const contract = assembleInputContract({
      backlog: backlog(),
      prd: '# The PRD body',
      context: '# CONTEXT body',
      results: [],
    });
    expect(contract.seed.prd).toBe('# The PRD body');
    expect(contract.seed.context).toBe('# CONTEXT body');
  });

  it('tolerates a null backlog (empty, well-formed seed)', () => {
    const contract = assembleInputContract({ backlog: null, results: [] });
    expect(contract.seed.issues).toEqual([]);
    expect(contract.seed.activePrd).toBeNull();
    expect(contract.stream).toEqual([]);
  });

  it('renders a stream event as plain text without any raw Pane scroll', () => {
    const event = toCompletionEvent(resultWithRawScroll());
    const text = renderCompletionEvent(event);
    expect(text).not.toContain('RAW_PANE_ONLY_MARKER');
    expect(text).not.toContain('npm test');
    expect(text).toContain('issue 03');
    expect(text).toContain('What changed');
    expect(text).toContain('completed');
  });
});
