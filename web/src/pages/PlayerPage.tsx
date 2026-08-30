import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { RecordTable } from '../components/RecordTable';
import { HistoryTable } from '../components/HistoryTable';

export function PlayerPage() {
  const { id } = useParams();
  const detail = useAsync(() => api.player(id!), [id]);
  const [page, setPage] = useState(1);
  const history = useAsync(() => api.playerHistory(id!, page), [id, page]);

  if (detail.loading) return <p className="muted">Loading…</p>;
  if (detail.error) return <p className="error">{detail.error}</p>;
  if (!detail.data) return null;

  const d = detail.data;

  return (
    <div>
      <h1>{d.player.name}</h1>

      <h2>Events</h2>
      {d.events.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Event</th>
              <th>Games</th>
              <th>Won</th>
            </tr>
          </thead>
          <tbody>
            {d.events.map((e) => (
              <tr key={e.eventId}>
                <td>{e.date ?? '—'}</td>
                <td>
                  <Link to={`/events/${e.eventId}`}>{e.eventName}</Link>
                </td>
                <td>{e.gameCount}</td>
                <td>{e.wins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>上家</h2>
      <RecordTable records={d.losing} />

      <h2>平手</h2>
      <RecordTable records={d.even} />

      <h2>下家</h2>
      <RecordTable records={d.winning} />

      <h2>Game history</h2>
      {history.error && <p className="error">{history.error}</p>}
      {history.data && (
        <>
          <HistoryTable items={history.data.items} />
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ‹ Prev
            </button>
            <span className="muted">
              Page {history.data.page} — {history.data.total} games
            </span>
            <button
              disabled={!history.data.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next ›
            </button>
          </div>
        </>
      )}
    </div>
  );
}
