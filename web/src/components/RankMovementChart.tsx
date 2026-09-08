import { useState } from 'react';
import type { RankMovements } from '../api';

// Bump chart: one line per player tracing finishing position (y, 1 = top) after
// each round (x). Vertical order at the right edge is the final-round standing.
// Many players => no per-series colour (that would mean cycling hues); identity
// is carried by vertical position + the direct label, and hovering a line lifts
// it to the accent colour with its round-by-round path spelled out below.

const ROW_H = 22; // vertical px between adjacent positions
const M = { top: 28, right: 196, bottom: 28, left: 36 };
const PLOT_W = 680;

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
  const width = M.left + PLOT_W + M.right;
  const height = M.top + plotH + M.bottom;
  const colX = (r: number): number =>
    rounds === 1 ? M.left + PLOT_W / 2 : M.left + (PLOT_W * r) / (rounds - 1);
  const posY = (p: number): number => M.top + (p - 1) * ROW_H;

  const yTicks: number[] = [];
  for (let p = 1; p <= n; p += p === 1 ? 4 : 5) yTicks.push(p);
  if (yTicks[yTicks.length - 1] !== n) yTicks.push(n);

  const hoveredSeries = series.find((s) => s.eventPlayerId === hovered) ?? null;

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Player standings position after each round"
          style={{ fontFamily: 'inherit' }}
        >
          {/* round gridlines + top/bottom labels */}
          {Array.from({ length: rounds }, (_, i) => i + 1).map((r) => (
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

          {/* faint line for every player */}
          {series.map((s) => {
            const isHot = s.eventPlayerId === hovered;
            if (isHot) return null; // drawn again on top below
            const pts = s.positions
              .map((p, i) => `${colX(i + 1)},${posY(p)}`)
              .join(' ');
            return (
              <g
                key={s.eventPlayerId}
                onMouseEnter={() => setHovered(s.eventPlayerId)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'pointer' }}
              >
                <polyline
                  points={pts}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                />
                <polyline
                  points={pts}
                  fill="none"
                  stroke="var(--muted)"
                  strokeOpacity={hovered == null ? 0.45 : 0.15}
                  strokeWidth={1.5}
                />
                <text
                  x={M.left + PLOT_W + 8}
                  y={posY(s.finalPosition) + 4}
                  fontSize={11}
                  fill="var(--muted)"
                  opacity={hovered == null ? 1 : 0.35}
                >
                  {s.finalPosition}. {s.name}
                </text>
              </g>
            );
          })}

          {/* hovered player on top, in accent */}
          {hoveredSeries &&
            (() => {
              const s = hoveredSeries;
              const pts = s.positions
                .map((p, i) => `${colX(i + 1)},${posY(p)}`)
                .join(' ');
              return (
                <g
                  onMouseEnter={() => setHovered(s.eventPlayerId)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: 'pointer' }}
                >
                  <polyline
                    points={pts}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                  />
                  <polyline
                    points={pts}
                    fill="none"
                    stroke="var(--link)"
                    strokeWidth={2.5}
                  />
                  {s.positions.map((p, i) => (
                    <circle
                      key={i}
                      cx={colX(i + 1)}
                      cy={posY(p)}
                      r={3.5}
                      fill="var(--link)"
                    />
                  ))}
                  <text
                    x={M.left + PLOT_W + 8}
                    y={posY(s.finalPosition) + 4}
                    fontSize={11}
                    fontWeight={700}
                    fill="var(--link)"
                  >
                    {s.finalPosition}. {s.name}
                  </text>
                </g>
              );
            })()}
        </svg>
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
          'Hover a line to trace one player’s movement. Rows are ordered by final standing.'
        )}
      </p>
    </div>
  );
}
