import { describe, it, expect } from 'vitest';
import { parseInline, parseRichDoc } from './rich-viewer-model';

describe('parseRichDoc', () => {
  it('parses issue-file frontmatter (status/deps) and body blocks', () => {
    const doc = parseRichDoc(
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
    const doc = parseRichDoc('first line\nsecond line\n\nnext para\n');
    expect(doc.frontmatter).toEqual([]);
    expect(doc.blocks).toEqual([
      { kind: 'para', text: 'first line second line' },
      { kind: 'para', text: 'next para' },
    ]);
  });

  it('appends indented continuation lines to the open list item', () => {
    const doc = parseRichDoc('- item one\n  continues here\n- item two\n');
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
    const doc = parseRichDoc('```\nunclosed');
    expect(doc.blocks).toEqual([{ kind: 'code', text: 'unclosed' }]);
  });

  it('parses a ```mermaid fence as a mermaid block, not code', () => {
    const doc = parseRichDoc(['```mermaid', 'flowchart TD', 'A --> B', '```'].join('\n'));
    expect(doc.blocks).toEqual([{ kind: 'mermaid', text: 'flowchart TD\nA --> B' }]);
  });

  it('is case-insensitive on the mermaid fence tag', () => {
    const doc = parseRichDoc(['```Mermaid', 'graph TD; A-->B;', '```'].join('\n'));
    expect(doc.blocks).toEqual([{ kind: 'mermaid', text: 'graph TD; A-->B;' }]);
  });

  it('mixes prose, a mermaid diagram, and a plain code fence in one document', () => {
    const doc = parseRichDoc(
      ['# Title', '', 'Some prose.', '', '```mermaid', 'graph TD', 'A-->B', '```', '', '```', 'plain', '```'].join(
        '\n',
      ),
    );
    expect(doc.blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'mermaid', 'code']);
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
