import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RichViewer } from './RichViewer';
import { BarChart, StackedBarChart, LineChart } from './Charts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

// mermaid is lazy-loaded via a dynamic `import('mermaid')` inside MermaidBlock
// (issue 179) — mock the module so tests exercise OUR wiring (lazy-load,
// fallback-on-error) without depending on mermaid's real layout engine, which
// jsdom can't run.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

describe('RichViewer — demo/test surface (issue 179)', () => {
  it('renders one document mixing prose, a list, and a mermaid diagram end-to-end', async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg data-testid="mock-mermaid-svg"><rect /></svg>',
      diagramType: 'flowchart',
    } as never);

    const doc = [
      '# Sample rich doc',
      '',
      'Some **prose** with `inline code`.',
      '',
      '- [x] mixes markdown',
      '- [ ] mixes mermaid',
      '',
      '```mermaid',
      'flowchart TD',
      'A --> B',
      '```',
    ].join('\n');

    render(<RichViewer text={doc} />);

    expect(screen.getByText('Sample rich doc')).toBeTruthy();
    expect(screen.getByText('inline code').tagName).toBe('CODE');
    expect(screen.getByText('mixes mermaid')).toBeTruthy();

    await waitFor(() => expect(screen.getByTestId('mock-mermaid-svg')).toBeTruthy());
    expect(mermaid.initialize).toHaveBeenCalled();
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringContaining('richviewer-mermaid'), 'flowchart TD\nA --> B');
  });

  it('falls back to the raw fenced text when the mermaid diagram is malformed', async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error on line 1'));

    const doc = ['```mermaid', 'not a real diagram !!', '```'].join('\n');
    const { container } = render(<RichViewer text={doc} />);

    await waitFor(() => expect(container.querySelector('.richviewer__mermaid-fallback')).toBeTruthy());
    expect(container.querySelector('.richviewer__mermaid-fallback')?.textContent).toBe('not a real diagram !!');
    // Never a crash — the rest of the render tree is intact.
    expect(container.querySelector('.richviewer__mermaid')).toBeNull();
  });

  it('renders frontmatter chips ahead of the parsed blocks', () => {
    const doc = ['---', 'status: open', '---', '', '# Title'].join('\n');
    const { container } = render(<RichViewer text={doc} />);
    expect(container.querySelector('.richviewer__fm-key')?.textContent).toBe('status');
    expect(container.querySelector('.richviewer__fm-value')?.textContent).toBe('open');
  });
});

describe('chart primitives (issue 179) — hand-rolled SVG, no chart lib', () => {
  it('BarChart renders one bar per datum as SVG', () => {
    const { container } = render(
      <BarChart data={[{ label: 'a', value: 3 }, { label: 'b', value: 7 }]} />,
    );
    const svg = container.querySelector('svg.richchart');
    expect(svg).toBeTruthy();
    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });

  it('StackedBarChart renders one row of stacked segments as SVG', () => {
    const { container } = render(
      <StackedBarChart
        data={[
          {
            label: 'row 1',
            segments: [
              { label: 'done', value: 4 },
              { label: 'open', value: 2 },
            ],
          },
        ]}
      />,
    );
    expect(container.querySelector('svg.richchart')).toBeTruthy();
    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });

  it('LineChart renders a path + point per series as SVG', () => {
    const { container } = render(
      <LineChart
        series={[
          {
            label: 'trend',
            points: [
              { x: 0, y: 1 },
              { x: 1, y: 4 },
              { x: 2, y: 2 },
            ],
          },
        ]}
      />,
    );
    expect(container.querySelector('svg.richchart')).toBeTruthy();
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
  });

  it('composes with RichViewer in one pane — a document beside a sample chart', () => {
    const { container } = render(
      <div>
        <RichViewer text={'# Report\n\nSummary prose.'} />
        <BarChart data={[{ label: 'issues closed', value: 12 }]} />
      </div>,
    );
    expect(screen.getByText('Report')).toBeTruthy();
    expect(container.querySelector('svg.richchart')).toBeTruthy();
  });
});
