import { Link } from 'react-router-dom';
import type { StandingsTable as StandingsTableData } from '../api';

function outcomeClass(points: number): string {
  if (points >= 1) return 'outcome-win';
  if (points === 0) return 'outcome-loss';
  return 'outcome-draw';
}

export function StandingsTable({ table }: { table: StandingsTableData }) {
  if (table.rows.length === 0) return <p className="muted">No standings.</p>;
  const roundNumbers = Array.from({ length: table.rounds }, (_, i) => i + 1);

  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Name</th>
          <th>Rank</th>
          <th>Score</th>
          <th>SOS</th>
          <th>SOSOS</th>
          {roundNumbers.map((rd) => (
            <th key={rd}>R{rd}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => (
          <tr key={row.eventPlayerId}>
            <td>{i + 1}</td>
            <td>
              <Link to={`/players/${row.playerId}`}>{row.name}</Link>
            </td>
            <td>{row.rank ?? '—'}</td>
            <td>{row.score}</td>
            <td>{row.sos}</td>
            <td>{row.sosos}</td>
            {row.rounds.map((cell, ri) =>
              cell ? (
                <td key={ri} className={outcomeClass(cell.points)} title={cell.label}>
                  {cell.opponentName ?? cell.label}
                </td>
              ) : (
                <td key={ri} className="muted">
                  —
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
