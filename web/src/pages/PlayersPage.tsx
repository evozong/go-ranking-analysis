import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../useAsync';

export function PlayersPage() {
  const { data, loading, error } = useAsync(() => api.players(), []);
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all;
  }, [data, filter]);

  return (
    <div>
      <h1>Players</h1>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="filter-row">
            <input
              type="text"
              placeholder="Filter by name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="muted"> {rows.length} of {data.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Games</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/players/${p.id}`}>{p.name}</Link>
                  </td>
                  <td>{p.gameCount}</td>
                  <td>{p.eventCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
