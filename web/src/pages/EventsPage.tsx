import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../useAsync';

export function EventsPage() {
  const { data, loading, error } = useAsync(() => api.events(), []);

  return (
    <div>
      <h1>Events</h1>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Name</th>
              <th>Games</th>
              <th>Players</th>
            </tr>
          </thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id}>
                <td>{e.date ?? '—'}</td>
                <td>
                  <Link to={`/events/${e.id}`}>{e.name}</Link>
                </td>
                <td>{e.gameCount}</td>
                <td>{e.playerCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
