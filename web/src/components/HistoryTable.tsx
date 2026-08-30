import { Link } from 'react-router-dom';
import type { HistoryItem } from '../api';

const OUTCOME_LABEL: Record<HistoryItem['outcome'], string> = {
  win: 'Win',
  loss: 'Loss',
  draw: 'Draw',
  nongame: '—',
};

export function HistoryTable({ items }: { items: HistoryItem[] }) {
  if (items.length === 0) return <p className="muted">No games recorded.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Event</th>
          <th>Rd</th>
          <th>Opponent</th>
          <th>Outcome</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i}>
            <td>{it.date ?? '—'}</td>
            <td>
              <Link to={`/events/${it.eventId}`}>{it.eventName}</Link>
            </td>
            <td>{it.roundNumber ?? '—'}</td>
            <td>
              {it.opponentId != null ? (
                <Link to={`/players/${it.opponentId}`}>{it.opponentName}</Link>
              ) : (
                (it.opponentName ?? '—')
              )}
            </td>
            <td className={`outcome-${it.outcome}`}>{OUTCOME_LABEL[it.outcome]}</td>
            <td className="muted">{it.resultType}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
