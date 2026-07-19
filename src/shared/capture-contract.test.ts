import { describe, expect, it } from 'vitest';
import { renderCompletionEvent, toCompletionEvent, type RunResult } from './capture-contract';
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

function resultWithRawScroll(): RunResult {
  return {
    id: 'sess-1',
    record: parseCompletionBlock(COMPLETION_TEXT),
    rawPaneOutput: RAW_PANE_SENTINEL,
  };
}

describe('capture contract', () => {
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
