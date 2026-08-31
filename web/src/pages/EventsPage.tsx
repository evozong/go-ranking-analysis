import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../useAsync';

export function EventsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useAsync(() => api.events(), [refreshKey]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onDelete(id: number, name: string) {
    if (
      !window.confirm(
        `Delete "${name}" — all of its games and players? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(id);
    setDeleteError(null);
    try {
      await api.deleteEvent(id);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <h1>Events</h1>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {deleteError && <p className="error">{deleteError}</p>}
      {data && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Name</th>
              <th>Games</th>
              <th>Players</th>
              <th />
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
                <td>
                  {e.deletable && (
                    <button
                      type="button"
                      onClick={() => onDelete(e.id, e.name)}
                      disabled={deletingId != null}
                    >
                      {deletingId === e.id ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
