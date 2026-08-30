import type { MatchupRow } from '../api';

export function MatchupTable({ rows }: { rows: MatchupRow[] }) {
  if (rows.length === 0) return <p className="muted">No matchups.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Rd</th>
          <th>White</th>
          <th>Black</th>
          <th>Winner</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.roundNumber ?? '—'}</td>
            <td>{r.whiteName ?? '—'}</td>
            <td>{r.blackName ?? '—'}</td>
            <td>{r.winnerName ?? '—'}</td>
            <td className="muted">{r.resultType}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
