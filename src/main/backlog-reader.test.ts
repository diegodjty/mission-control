import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBacklogAt } from './backlog-reader';

const CONFIG = `---
run_timeout: 90
worker_model: opus
escalation_ceiling: fable
hot_files:
  - src/renderer/src/App.tsx
---

## Active PRD

\`PRD-example.md\` — the example batch.
`;

const ISSUE = `---
status: open
depends_on: []
---

# 01 — an issue

## What to build

Body.
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mc-backlog-reader-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readBacklogAt', () => {
  it('honors a workbench-layout CONFIG.md at the project root, one level above issues/', async () => {
    const issuesDir = join(root, 'issues');
    await mkdir(issuesDir, { recursive: true });
    await writeFile(join(root, 'CONFIG.md'), CONFIG, 'utf8');
    await writeFile(join(issuesDir, '01-an-issue.md'), ISSUE, 'utf8');

    const backlog = await readBacklogAt(issuesDir);

    expect(backlog.runTimeoutMinutes).toBe(90);
    expect(backlog.workerModel).toBe('opus');
    expect(backlog.escalationCeiling).toBe('fable');
    expect(backlog.hotFiles).toEqual(['src/renderer/src/App.tsx']);
    expect(backlog.activePrd).toBe('PRD-example.md');
  });

  it('still reads a legacy in-repo CONFIG.md from inside issues/', async () => {
    const issuesDir = join(root, 'issues');
    await mkdir(issuesDir, { recursive: true });
    await writeFile(join(issuesDir, 'CONFIG.md'), CONFIG, 'utf8');
    await writeFile(join(issuesDir, '01-an-issue.md'), ISSUE, 'utf8');
    // A different CONFIG at the parent must NOT be consulted when issues/ has its own.
    await writeFile(
      join(root, 'CONFIG.md'),
      CONFIG.replace('run_timeout: 90', 'run_timeout: 15'),
      'utf8',
    );

    const backlog = await readBacklogAt(issuesDir);

    expect(backlog.runTimeoutMinutes).toBe(90);
    expect(backlog.workerModel).toBe('opus');
    expect(backlog.hotFiles).toEqual(['src/renderer/src/App.tsx']);
  });

  it('falls back to clean defaults, without throwing, when no CONFIG.md exists anywhere', async () => {
    const issuesDir = join(root, 'issues');
    await mkdir(issuesDir, { recursive: true });
    await writeFile(join(issuesDir, '01-an-issue.md'), ISSUE, 'utf8');

    const backlog = await readBacklogAt(issuesDir);

    expect(backlog.runTimeoutMinutes).toBe(30);
    expect(backlog.workerModel).toBe('sonnet');
    expect(backlog.escalationCeiling).toBe('opus');
    expect(backlog.hotFiles).toEqual([]);
    expect(backlog.activePrd).toBeNull();
  });
});
