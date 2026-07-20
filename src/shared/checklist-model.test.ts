/**
 * Unit tests for the PURE HITL checklist parser (issue 156). A parked issue's
 * Receipt `detail` (or, absent that, the issue file body) carries ordered
 * `- [ ] step` / `- [x] step` lines; this turns them into a checklist model.
 */
import { describe, it, expect } from 'vitest';
import { parseChecklist, checklistSourceText, markVerifiedDoneText } from './checklist-model';

const HITL_BLOCK = `## Ready for manual verification — issue 42 — example

**Verification steps**

- [ ] Start the dev server with \`npm run dev\`.
- [x] Open the Map and select any HITL issue.
- [ ] Confirm the checklist renders in order.

Let me know once you've walked through these.`;

describe('parseChecklist', () => {
  it('extracts ordered items in source order, trimmed', () => {
    const items = parseChecklist(HITL_BLOCK);
    expect(items).toEqual([
      { text: 'Start the dev server with `npm run dev`.', checked: false },
      { text: 'Open the Map and select any HITL issue.', checked: true },
      { text: 'Confirm the checklist renders in order.', checked: false },
    ]);
  });

  it('seeds `- [x]` items as already checked', () => {
    const items = parseChecklist('- [x] done already');
    expect(items).toEqual([{ text: 'done already', checked: true }]);
  });

  it('is case-insensitive on the checked marker', () => {
    expect(parseChecklist('- [X] shouting done')[0].checked).toBe(true);
  });

  it('accepts a `*` bullet marker as well as `-`', () => {
    expect(parseChecklist('* [ ] star bullet')).toEqual([
      { text: 'star bullet', checked: false },
    ]);
  });

  it('yields an empty list for text with no checkbox lines (no crash)', () => {
    expect(parseChecklist('Just a paragraph.\n\nAnother one.')).toEqual([]);
  });

  it('tolerates non-string / empty / whitespace-only input', () => {
    expect(parseChecklist(null)).toEqual([]);
    expect(parseChecklist(undefined)).toEqual([]);
    expect(parseChecklist(42)).toEqual([]);
    expect(parseChecklist('')).toEqual([]);
    expect(parseChecklist('   \n  ')).toEqual([]);
  });

  it('ignores acceptance-criteria-style lines outside a checkbox (plain bullets)', () => {
    expect(parseChecklist('- plain bullet, no checkbox\n- [ ] real item')).toEqual([
      { text: 'real item', checked: false },
    ]);
  });
});

describe('checklistSourceText', () => {
  it('prefers the Receipt detail body when present', () => {
    expect(checklistSourceText('- [ ] receipt step', '- [ ] body step')).toBe(
      '- [ ] receipt step',
    );
  });

  it('falls back to the issue body when the Receipt detail is null', () => {
    expect(checklistSourceText(null, '- [ ] body step')).toBe('- [ ] body step');
  });

  it('falls back to the issue body when the Receipt detail is empty/whitespace', () => {
    expect(checklistSourceText('   ', '- [ ] body step')).toBe('- [ ] body step');
  });

  it('falls back to the issue body when the Receipt detail is non-empty prose with no checkbox lines (issue 189)', () => {
    const proseDetail = `Some prose.

**Try it yourself**

1. Start the dev server.
2. Open the Map.

Let me know once verified.`;
    expect(checklistSourceText(proseDetail, '- [ ] body step')).toBe('- [ ] body step');
  });

  it('yields an empty string when both sources are absent', () => {
    expect(checklistSourceText(null, undefined)).toBe('');
  });
});

const WIP_ISSUE_FILE = `---
status: wip
depends_on: [152]
---

# 156 — example

Some body text.
`;

describe('markVerifiedDoneText', () => {
  it('flips status: wip to status: done', () => {
    const result = markVerifiedDoneText(WIP_ISSUE_FILE, '2026-07-18');
    expect(result).toMatch(/^---\nstatus: done\ndepends_on: \[152\]\n---/);
  });

  it('preserves the body and appends a dated sign-off note', () => {
    const result = markVerifiedDoneText(WIP_ISSUE_FILE, '2026-07-18');
    expect(result).toMatch(/# 156 — example/);
    expect(result).toMatch(/Some body text\./);
    expect(result).toMatch(/Verified and marked done by human sign-off on 2026-07-18\./);
  });

  it('returns null when there is no closed frontmatter fence', () => {
    expect(markVerifiedDoneText('no frontmatter here', '2026-07-18')).toBeNull();
  });

  it('returns null when the status is not wip (already done, or open)', () => {
    const doneAlready = WIP_ISSUE_FILE.replace('status: wip', 'status: done');
    expect(markVerifiedDoneText(doneAlready, '2026-07-18')).toBeNull();
    const openIssue = WIP_ISSUE_FILE.replace('status: wip', 'status: open');
    expect(markVerifiedDoneText(openIssue, '2026-07-18')).toBeNull();
  });
});
