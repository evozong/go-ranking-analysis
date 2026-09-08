import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { RankMovements } from '../api';

// Bump chart: one line per player tracing finishing position (y, 1 = top) after
// each round (x). The SVG holds only the plot; player names live in an HTML
// column to its right, each row absolutely positioned at the y where that
// player's line ends so the two halves read as one row. Many players => no
// per-series colour (that would mean cycling hues); identity is the vertical
// position plus the name, and hovering either the line or the name lifts that
// player to the accent colour with the round-by-round path spelled out below.

const ROW_H = 22; // vertical px between adjacent positions
const M = { top: 28, right: 16, bottom: 28, left: 36 };
const PLOT_W = 640;
const NAME_W = 240;

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

export function RankMovementChart({ data }: { data: RankMovements }) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (data.rounds === 0 || data.series.length === 0) {
    return <p className="muted">No rounds to chart.</p>;
  }

  const { rounds, series } = data;
  const n = series.length;
  const plotH = Math.max((n - 1) * ROW_H, ROW_H);
  const svgW = M.left + PLOT_W + M.right;
  const height = M.top + plotH + M.bottom;
  const colX = (r: number): number =>
    rounds === 1
      ? M.left + PLOT_W / 2
      : M.left + (PLOT_W * (r - 1)) / (rounds - 1);
  const posY = (p: number): number => M.top + (p - 1) * ROW_H;

  const yTicks: number[] = [];
  for (let p = 1; p <= n; p += p === 1 ? 4 : 5) yTicks.push(p);
  if (yTicks[yTicks.length - 1] !== n) yTicks.push(n);

  const hoveredSeries = series.find((s) => s.eventPlayerId === hovered) ?? null;
  const roundList = Array.from({ length: rounds }, (_, i) => i + 1);
  const on = (id: number) => ({
    onMouseEnter: () => setHovered(id),
    onMouseLeave: () => setHovered(null),
  });

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 'min-content' }}>
          <svg
            width={svgW}
            height={height}
            role="img"
            aria-label="Player standings position after each round"
            style={{ fontFamily: 'inherit', flex: '0 0 auto' }}
          >
            {/* round gridlines + top/bottom labels */}
            {roundList.map((r) => (
              <g key={`col-${r}`}>
                <line
                  x1={colX(r)}
                  x2={colX(r)}
                  y1={M.top - 6}
                  y2={M.top + plotH + 6}
                  stroke="var(--border)"
                />
                <text
                  x={colX(r)}
                  y={M.top - 12}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--muted)"
                >
                  R{r}
                </text>
                <text
                  x={colX(r)}
                  y={M.top + plotH + 18}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--muted)"
                >
                  R{r}
                </text>
              </g>
            ))}

            {/* y-axis position ticks */}
            {yTicks.map((p) => (
              <text
                key={`y-${p}`}
                x={M.left - 10}
                y={posY(p) + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--muted)"
              >
                {p}
              </text>
            ))}

            {/* faint line for every player (hovered one redrawn on top) */}
            {series.map((s) => {
              if (s.eventPlayerId === hovered) return null;
              const pts = s.positions
                .map((p, i) => `${colX(i + 1)},${posY(p)}`)
                .join(' ');
              return (
                <g key={s.eventPlayerId} {...on(s.eventPlayerId)} style={{ cursor: 'pointer' }}>
                  <polyline points={pts} fill="none" stroke="transparent" strokeWidth={12} />
                  <polyline
                    points={pts}
                    fill="none"
                    stroke="var(--muted)"
                    strokeOpacity={hovered == null ? 0.45 : 0.12}
                    strokeWidth={1.5}
                  />
                </g>
              );
            })}

            {hoveredSeries &&
              (() => {
                const s = hoveredSeries;
                const pts = s.positions
                  .map((p, i) => `${colX(i + 1)},${posY(p)}`)
                  .join(' ');
                return (
                  <g {...on(s.eventPlayerId)} style={{ cursor: 'pointer' }}>
                    <polyline points={pts} fill="none" stroke="transparent" strokeWidth={14} />
                    <polyline points={pts} fill="none" stroke="var(--link)" strokeWidth={2.5} />
                    {s.positions.map((p, i) => (
                      <circle key={i} cx={colX(i + 1)} cy={posY(p)} r={3.5} fill="var(--link)" />
                    ))}
                  </g>
                );
              })()}
          </svg>

          {/* names outside the plot, aligned to each line's end point */}
          <ol
            style={{
              position: 'relative',
              width: NAME_W,
              minWidth: NAME_W,
              height,
              margin: 0,
              padding: 0,
              listStyle: 'none',
              flex: '0 0 auto',
            }}
          >
            {series.map((s) => {
              const hot = s.eventPlayerId === hovered;
              return (
                <li
                  key={s.eventPlayerId}
                  {...on(s.eventPlayerId)}
                  style={{
                    position: 'absolute',
                    top: posY(s.finalPosition) - 8,
                    left: 8,
                    right: 0,
                    lineHeight: '16px',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontWeight: hot ? 700 : 400,
                  }}
                >
                  <span style={{ color: 'var(--muted)' }}>{s.finalPosition}.</span>{' '}
                  <Link
                    to={`/players/${s.playerId}`}
                    style={hot ? { color: 'var(--link)' } : undefined}
                  >
                    {s.name}
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <p className="muted" style={{ minHeight: '1.4em' }}>
        {hoveredSeries ? (
          <>
            <strong>{hoveredSeries.name}</strong>
            {hoveredSeries.rank ? ` (${hoveredSeries.rank})` : ''} —{' '}
            {hoveredSeries.positions
              .map((p, i) => `R${i + 1} ${ordinal(p)}`)
              .join(' · ')}
          </>
        ) : (
          'Hover a line or a name to trace one player’s movement. Rows are ordered by final standing.'
        )}
      </p>
    </div>
  );
}
