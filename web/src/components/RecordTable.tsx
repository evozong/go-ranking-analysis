import { Link } from 'react-router-dom';
import type { OpponentRecord } from '../api';

export function RecordTable({ records }: { records: OpponentRecord[] }) {
  if (records.length === 0) return <p className="muted">None.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Opponent</th>
          <th>W</th>
          <th>L</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.opponentId}>
            <td>
              <Link to={`/players/${r.opponentId}`}>{r.opponentName}</Link>
            </td>
            <td>{r.wins}</td>
            <td>{r.losses}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
