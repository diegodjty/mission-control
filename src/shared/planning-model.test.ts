import { describe, it, expect } from 'vitest';
import {
  derivePlanningDocs,
  isAdrPlanningChange,
  isAllowedPlanningDoc,
  isRepoPlanningChange,
  isWorkbenchPlanningChange,
  orderPlanningDocs,
  parseInline,
  parsePlanningDoc,
  stageInvocation,
  PLANNING_STAGES,
  type PlanningDoc,
  type PlanningRoots,
} from './planning-model';

const roots: PlanningRoots = {
  workbenchDir: '/wb/proj',
  repoPath: '/code/repo',
};

describe('derivePlanningDocs', () => {
  it('collects workbench PRDs, issues, CONTEXT.md and ADRs with labels and groups', () => {
    const docs = derivePlanningDocs(roots, {
      workbenchFiles: [
        { name: 'PRD.md', mtimeMs: 10 },
        { name: 'CONFIG.md', mtimeMs: 5 },
        { name: 'notes.txt', mtimeMs: 99 }, // not markdown — excluded
      ],
      issueFiles: [{ name: '83-planning-view-v1.md', mtimeMs: 20 }],
      contextMtimeMs: 15,
      adrFiles: [{ name: '0016-mc-guides.md', mtimeMs: 30 }],
    });
    expect(docs.map((d) => d.label)).toEqual([
      'docs/adr/0016-mc-guides.md',
      'issues/83-planning-view-v1.md',
      'CONTEXT.md',
      'PRD.md',
      'CONFIG.md',
    ]);
    expect(docs.map((d) => d.group)).toEqual(['repo', 'issue', 'repo', 'workbench', 'workbench']);
    expect(docs[1].path).toBe('/wb/proj/issues/83-planning-view-v1.md');
    expect(docs[2].path).toBe('/code/repo/CONTEXT.md');
  });

  it('omits CONTEXT.md when the repo has none, and tolerates empty dirs', () => {
    const docs = derivePlanningDocs(roots, {
      workbenchFiles: [],
      issueFiles: [],
      contextMtimeMs: null,
      adrFiles: [],
    });
    expect(docs).toEqual([]);
  });

  it('excludes dotfiles', () => {
    const docs = derivePlanningDocs(roots, {
      workbenchFiles: [{ name: '.hidden.md', mtimeMs: 1 }],
      issueFiles: [{ name: '.afk-parallel.md', mtimeMs: 1 }],
      contextMtimeMs: null,
      adrFiles: [],
    });
    expect(docs).toEqual([]);
  });
});

describe('orderPlanningDocs', () => {
  it('floats the most-recently-changed doc to the top, ties by label', () => {
    const doc = (label: string, mtimeMs: number): PlanningDoc => ({
      path: `/x/${label}`,
      label,
      group: 'workbench',
      mtimeMs,
    });
    const ordered = orderPlanningDocs([doc('b.md', 5), doc('a.md', 5), doc('c.md', 9)]);
    expect(ordered.map((d) => d.label)).toEqual(['c.md', 'a.md', 'b.md']);
  });
});

describe('watch relevance filters', () => {
  it('workbench: top-level md and issues/ are relevant; completions/memory/.git are not', () => {
    expect(isWorkbenchPlanningChange(null)).toBe(true);
    expect(isWorkbenchPlanningChange('PRD.md')).toBe(true);
    expect(isWorkbenchPlanningChange('issues')).toBe(true);
    expect(isWorkbenchPlanningChange('issues/83-planning-view-v1.md')).toBe(true);
    expect(isWorkbenchPlanningChange('completions/83-planning.md')).toBe(false);
    expect(isWorkbenchPlanningChange('memory/journal/2026-07-04.md')).toBe(false);
    expect(isWorkbenchPlanningChange('.git/index')).toBe(false);
    expect(isWorkbenchPlanningChange('notes.txt')).toBe(false);
  });

  it('repo root: only CONTEXT.md and the docs dir itself', () => {
    expect(isRepoPlanningChange(null)).toBe(true);
    expect(isRepoPlanningChange('CONTEXT.md')).toBe(true);
    expect(isRepoPlanningChange('docs')).toBe(true);
    expect(isRepoPlanningChange('src')).toBe(false);
    expect(isRepoPlanningChange('README.md')).toBe(false);
  });

  it('adr dir: markdown files only', () => {
    expect(isAdrPlanningChange(null)).toBe(true);
    expect(isAdrPlanningChange('0016-mc-guides.md')).toBe(true);
    expect(isAdrPlanningChange('scratch.txt')).toBe(false);
  });
});

describe('isAllowedPlanningDoc', () => {
  it('allows exactly the watched locations', () => {
    expect(isAllowedPlanningDoc(roots, '/wb/proj/PRD.md')).toBe(true);
    expect(isAllowedPlanningDoc(roots, '/wb/proj/issues/83-planning-view-v1.md')).toBe(true);
    expect(isAllowedPlanningDoc(roots, '/code/repo/CONTEXT.md')).toBe(true);
    expect(isAllowedPlanningDoc(roots, '/code/repo/docs/adr/0016-mc-guides.md')).toBe(true);
  });

  it('refuses everything else — other dirs, traversal, non-markdown', () => {
    expect(isAllowedPlanningDoc(roots, '/wb/proj/completions/83-planning.md')).toBe(false);
    expect(isAllowedPlanningDoc(roots, '/wb/proj/memory/CORE.md')).toBe(false);
    expect(isAllowedPlanningDoc(roots, '/wb/proj/issues/../memory/CORE.md')).toBe(false);
    expect(isAllowedPlanningDoc(roots, '/code/repo/README.md')).toBe(false);
    expect(isAllowedPlanningDoc(roots, '/code/repo/docs/adr/deeper/x.md')).toBe(false);
    expect(isAllowedPlanningDoc(roots, '/etc/passwd')).toBe(false);
    expect(isAllowedPlanningDoc(roots, '/wb/proj/CONFIG.md.bak')).toBe(false);
  });
});

describe('stage invocations', () => {
  it('maps the three stage buttons to their skill invocations, in pipeline order', () => {
    expect(PLANNING_STAGES.map((s) => s.stage)).toEqual(['grill', 'prd', 'issues']);
    expect(stageInvocation('grill')).toBe('/grill-with-docs');
    expect(stageInvocation('prd')).toBe('/to-prd');
    expect(stageInvocation('issues')).toBe('/to-issues');
  });
});

describe('parsePlanningDoc', () => {
  it('parses issue-file frontmatter (status/deps) and body blocks', () => {
    const doc = parsePlanningDoc(
      [
        '---',
        'status: open',
        'depends_on: [81]',
        '---',
        '',
        '# 83 — Planning view v1',
        '',
        'Left, a normal warm Pane; right, a **live** preview using `fs.watch`.',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] Big feature opens the split view',
        '- [x] Stage buttons submit the right invocation',
        '- plain item',
        '',
        '> a quote line',
        '',
        '---',
        '',
        '```ts',
        'const x = 1;',
        '',
        'const y = 2;',
        '```',
        '',
        '1. first',
        '2. second',
      ].join('\n'),
    );

    expect(doc.frontmatter).toEqual([
      { key: 'status', value: 'open' },
      { key: 'depends_on', value: '[81]' },
    ]);
    expect(doc.blocks).toEqual([
      { kind: 'heading', level: 1, text: '83 — Planning view v1' },
      {
        kind: 'para',
        text: 'Left, a normal warm Pane; right, a **live** preview using `fs.watch`.',
      },
      { kind: 'heading', level: 2, text: 'Acceptance criteria' },
      {
        kind: 'list',
        ordered: false,
        items: [
          { text: 'Big feature opens the split view', checked: false },
          { text: 'Stage buttons submit the right invocation', checked: true },
          { text: 'plain item', checked: null },
        ],
      },
      { kind: 'quote', text: 'a quote line' },
      { kind: 'rule' },
      { kind: 'code', text: 'const x = 1;\n\nconst y = 2;' },
      {
        kind: 'list',
        ordered: true,
        items: [
          { text: 'first', checked: null },
          { text: 'second', checked: null },
        ],
      },
    ]);
  });

  it('handles a doc with no frontmatter and joins wrapped paragraph lines', () => {
    const doc = parsePlanningDoc('first line\nsecond line\n\nnext para\n');
    expect(doc.frontmatter).toEqual([]);
    expect(doc.blocks).toEqual([
      { kind: 'para', text: 'first line second line' },
      { kind: 'para', text: 'next para' },
    ]);
  });

  it('appends indented continuation lines to the open list item', () => {
    const doc = parsePlanningDoc('- item one\n  continues here\n- item two\n');
    expect(doc.blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          { text: 'item one continues here', checked: null },
          { text: 'item two', checked: null },
        ],
      },
    ]);
  });

  it('never throws on an unclosed code fence', () => {
    const doc = parsePlanningDoc('```\nunclosed');
    expect(doc.blocks).toEqual([{ kind: 'code', text: 'unclosed' }]);
  });
});

describe('parseInline', () => {
  it('splits code spans and bold runs out of plain text', () => {
    expect(parseInline('run `npm test` and **verify** it')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' and ' },
      { kind: 'bold', text: 'verify' },
      { kind: 'text', text: ' it' },
    ]);
  });

  it('returns plain text untouched', () => {
    expect(parseInline('nothing special')).toEqual([{ kind: 'text', text: 'nothing special' }]);
  });
});
