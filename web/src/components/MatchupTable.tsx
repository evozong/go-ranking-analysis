import { Link } from 'react-router-dom';
import type { MatchupRow } from '../api';

function resultLabel(r: MatchupRow): string {
  const winnerColor =
    r.winnerName == null
      ? null
      : r.winnerName === r.whiteName
        ? 'White'
        : r.winnerName === r.blackName
          ? 'Black'
          : null;

  switch (r.resultType) {
    case 'game':
      return winnerColor ? `${winnerColor} wins` : '—';
    case 'forfeit':
      return winnerColor ? `${winnerColor} wins (forfeit)` : 'Forfeit';
    case 'draw':
      return 'Draw';
    case 'both_win':
      return 'Both win';
    case 'both_lose':
      return 'Both lose';
    case 'bye':
      return 'Bye';
    case 'no_result':
      return 'No result';
    default:
      return r.resultType;
  }
}

function playerCell(
  name: string | null,
  playerId: number | null,
  isWinner: boolean,
) {
  if (name == null) return <>—</>;
  const inner =
    playerId != null ? <Link to={`/players/${playerId}`}>{name}</Link> : name;
  return isWinner ? <strong>{inner}</strong> : inner;
}

export function MatchupTable({ rows }: { rows: MatchupRow[] }) {
  if (rows.length === 0) return <p className="muted">No matchups.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Rd</th>
          <th>Black</th>
          <th>White</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.roundNumber ?? '—'}</td>
            <td>
              {playerCell(
                r.blackName,
                r.blackPlayerId,
                r.winnerName != null && r.blackName === r.winnerName,
              )}
            </td>
            <td>
              {playerCell(
                r.whiteName,
                r.whitePlayerId,
                r.winnerName != null && r.whiteName === r.winnerName,
              )}
            </td>
            <td className="muted">{resultLabel(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
