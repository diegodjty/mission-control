import { describe, expect, it } from 'vitest';
import {
  describeReleasedClaims,
  orphanedClaims,
  reopenWipToOpen,
  type TrackedClaim,
} from './drain-interruption';
import type { RunStatus } from './run-state';
import type { IssueStatus } from './backlog-model';

/** A TrackedClaim with the two facts under test, sensible defaults for the rest. */
function claim(
  issueId: number,
  runStatus: RunStatus,
  issueStatus: IssueStatus | null,
): TrackedClaim {
  return { issueId, fileName: `${String(issueId).padStart(2, '0')}-slug.md`, runStatus, issueStatus };
}

describe('orphanedClaims', () => {
  it('releases a Run still running on a still-wip issue (the orphan case)', () => {
    expect(orphanedClaims([claim(12, 'running', 'wip')])).toEqual([
      { issueId: 12, fileName: '12-slug.md' },
    ]);
  });

  it('leaves a finished Run alone (its issue is done, not wip)', () => {
    expect(orphanedClaims([claim(12, 'finished', 'done')])).toEqual([]);
  });

  it('leaves a parked HITL Run alone (wip on purpose — the human verifies)', () => {
    // A parked Run's issue is deliberately left `wip` for manual verification;
    // reopening it would erase the park the Worker intentionally created.
    expect(orphanedClaims([claim(12, 'parked', 'wip')])).toEqual([]);
  });

  it('leaves a blocked Run alone (a genuine blocker to surface, not reclaim)', () => {
    expect(orphanedClaims([claim(12, 'blocked', 'wip')])).toEqual([]);
  });

  it('leaves a user-stopped Run alone', () => {
    expect(orphanedClaims([claim(12, 'stopped', 'wip')])).toEqual([]);
  });

  it('does not release a running Run whose issue is not (yet) wip', () => {
    // A Run that just started but whose claim flip has not been observed on disk
    // yet is not orphaning a `wip` — nothing to reopen.
    expect(orphanedClaims([claim(12, 'running', 'open')])).toEqual([]);
    expect(orphanedClaims([claim(12, 'running', null)])).toEqual([]);
  });

  it('picks out only the orphaned claims from a mixed set', () => {
    expect(
      orphanedClaims([
        claim(10, 'finished', 'done'),
        claim(11, 'running', 'wip'),
        claim(12, 'parked', 'wip'),
        claim(13, 'running', 'wip'),
        claim(14, 'running', 'open'),
      ]),
    ).toEqual([
      { issueId: 11, fileName: '11-slug.md' },
      { issueId: 13, fileName: '13-slug.md' },
    ]);
  });

  it('is empty for no claims and never throws on junk input', () => {
    expect(orphanedClaims([])).toEqual([]);
    // @ts-expect-error — house PURE contract: junk degrades, never throws.
    expect(orphanedClaims(null)).toEqual([]);
    // @ts-expect-error
    expect(orphanedClaims([undefined])).toEqual([]);
  });
});

describe('reopenWipToOpen', () => {
  const body = '\n\n# 12 — a title\n\n## What to build\n\nDo the thing. status: wip appears in prose.\n';

  it('flips a frontmatter status: wip back to open, body untouched', () => {
    const text = `---\nstatus: wip\ndepends_on: [3, 4]\n---${body}`;
    expect(reopenWipToOpen(text)).toBe(`---\nstatus: open\ndepends_on: [3, 4]\n---${body}`);
  });

  it('returns null when the issue is not wip (never clobbers done → open)', () => {
    expect(reopenWipToOpen(`---\nstatus: done\ndepends_on: []\n---${body}`)).toBeNull();
    expect(reopenWipToOpen(`---\nstatus: open\ndepends_on: []\n---${body}`)).toBeNull();
  });

  it('only touches the FRONTMATTER status line, never a status: mention in the body', () => {
    const text = `---\nstatus: wip\n---\n\nNote: status: wip in the body stays.\n`;
    expect(reopenWipToOpen(text)).toBe(`---\nstatus: open\n---\n\nNote: status: wip in the body stays.\n`);
  });

  it('preserves trailing whitespace on the status line', () => {
    expect(reopenWipToOpen('---\nstatus: wip  \n---\n\nx\n')).toBe(
      '---\nstatus: open  \n---\n\nx\n',
    );
  });

  it('tolerates status: below other frontmatter keys', () => {
    const text = `---\ndepends_on: []\nhitl: false\nstatus: wip\n---\n\nbody\n`;
    expect(reopenWipToOpen(text)).toBe(`---\ndepends_on: []\nhitl: false\nstatus: open\n---\n\nbody\n`);
  });

  it('returns null when there is no leading frontmatter block', () => {
    expect(reopenWipToOpen('# just a title\nstatus: wip\n')).toBeNull();
    expect(reopenWipToOpen('')).toBeNull();
  });

  it('never throws on non-string input', () => {
    // @ts-expect-error — house PURE contract.
    expect(reopenWipToOpen(null)).toBeNull();
    // @ts-expect-error
    expect(reopenWipToOpen(42)).toBeNull();
  });
});

describe('describeReleasedClaims', () => {
  it('names one reopened issue, singular', () => {
    expect(describeReleasedClaims([{ issueId: 12, fileName: '12-slug.md' }])).toBe(
      'Leaving this project stopped the drain — released 1 in-flight issue back to open (12) so no claim is left stranded.',
    );
  });

  it('names several reopened issues sorted and zero-padded, plural', () => {
    expect(
      describeReleasedClaims([
        { issueId: 13, fileName: '13-slug.md' },
        { issueId: 5, fileName: '05-slug.md' },
      ]),
    ).toBe(
      'Leaving this project stopped the drain — released 2 in-flight issues back to open (05, 13) so no claim is left stranded.',
    );
  });

  it('is empty when nothing was released', () => {
    expect(describeReleasedClaims([])).toBe('');
  });
});
