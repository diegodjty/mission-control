import './Charts.css';

/**
 * Hand-rolled SVG chart primitives (issue 179, ADR-0023) — no charting
 * library. Three marks, each fed data directly by the caller (charts don't
 * come from markdown text, unlike the rest of the rich viewer): horizontal
 * bar, stacked bar, and line/trend. Colour comes from the same Atlas tokens
 * every other view uses, so both themes render correctly by construction.
 */
const SERIES_COLORS = [
  'var(--teal)',
  'var(--green)',
  'var(--amber)',
  'var(--violet)',
  'var(--blue)',
  'var(--red)',
];

export interface BarChartDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarChartDatum[];
  width?: number;
  /** Row height drives the chart's total height (`data.length * rowHeight`). */
  rowHeight?: number;
  /** Formats the trailing value label — defaults to plain `String`. */
  formatValue?: (value: number) => string;
}

/** Horizontal bar: one row per datum, bar length proportional to the row's
 *  value against the max value in the set. */
export function BarChart({ data, width = 320, rowHeight = 24, formatValue = String }: BarChartProps): JSX.Element {
  const height = data.length * rowHeight + 8;
  const max = Math.max(1, ...data.map((d) => d.value));
  const labelWidth = 90;
  const trackWidth = Math.max(1, width - labelWidth - 46);

  return (
    <svg className="richchart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bar chart">
      {data.map((d, i) => {
        const y = i * rowHeight;
        const barWidth = (d.value / max) * trackWidth;
        return (
          <g key={d.label} transform={`translate(0, ${y})`}>
            <text x={0} y={rowHeight / 2} dominantBaseline="middle" className="richchart__label">
              {d.label}
            </text>
            <rect
              x={labelWidth}
              y={rowHeight / 2 - 7}
              width={Math.max(1, barWidth)}
              height={14}
              rx={3}
              style={{ fill: SERIES_COLORS[0] }}
            />
            <text
              x={labelWidth + Math.max(1, barWidth) + 6}
              y={rowHeight / 2}
              dominantBaseline="middle"
              className="richchart__value"
            >
              {formatValue(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export interface StackedBarSegment {
  label: string;
  value: number;
}

export interface StackedBarDatum {
  label: string;
  segments: StackedBarSegment[];
}

export interface StackedBarChartProps {
  data: StackedBarDatum[];
  width?: number;
  rowHeight?: number;
}

/** Stacked bar: one row per datum, each row's segments laid end to end,
 *  scaled against the largest row TOTAL in the set. */
export function StackedBarChart({ data, width = 320, rowHeight = 24 }: StackedBarChartProps): JSX.Element {
  const height = data.length * rowHeight + 8;
  const labelWidth = 90;
  const trackWidth = Math.max(1, width - labelWidth - 12);
  const max = Math.max(1, ...data.map((d) => d.segments.reduce((sum, s) => sum + s.value, 0)));

  return (
    <svg className="richchart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Stacked bar chart">
      {data.map((d, i) => {
        const y = i * rowHeight;
        let x = labelWidth;
        return (
          <g key={d.label} transform={`translate(0, ${y})`}>
            <text x={0} y={rowHeight / 2} dominantBaseline="middle" className="richchart__label">
              {d.label}
            </text>
            {d.segments.map((seg, si) => {
              const segWidth = (seg.value / max) * trackWidth;
              const segX = x;
              x += segWidth;
              return (
                <rect
                  key={seg.label}
                  x={segX}
                  y={rowHeight / 2 - 7}
                  width={Math.max(0, segWidth)}
                  height={14}
                  style={{ fill: SERIES_COLORS[si % SERIES_COLORS.length] }}
                >
                  <title>{`${seg.label}: ${seg.value}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export interface LinePoint {
  x: number;
  y: number;
}

export interface LineSeries {
  label: string;
  points: LinePoint[];
}

export interface LineChartProps {
  series: LineSeries[];
  width?: number;
  height?: number;
}

/** Line/trend: one or more series plotted on shared linear x/y axes scaled
 *  to fit every series' points. */
export function LineChart({ series, width = 320, height = 160 }: LineChartProps): JSX.Element {
  const padding = 24;
  const allPoints = series.flatMap((s) => s.points);
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : 1;
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(1, ...ys);

  const scaleX = (x: number): number =>
    padding + (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * (width - padding * 2));
  const scaleY = (y: number): number =>
    height - padding - (maxY === minY ? 0 : ((y - minY) / (maxY - minY)) * (height - padding * 2));

  return (
    <svg className="richchart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Line chart">
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        className="richchart__axis"
      />
      <line x1={padding} y1={padding} x2={padding} y2={height - padding} className="richchart__axis" />
      {series.map((s, si) => {
        const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.x)} ${scaleY(p.y)}`).join(' ');
        return (
          <g key={s.label}>
            <path d={d} fill="none" style={{ stroke: SERIES_COLORS[si % SERIES_COLORS.length] }} strokeWidth={2} />
            {s.points.map((p, i) => (
              <circle
                key={i}
                cx={scaleX(p.x)}
                cy={scaleY(p.y)}
                r={2.5}
                style={{ fill: SERIES_COLORS[si % SERIES_COLORS.length] }}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}
