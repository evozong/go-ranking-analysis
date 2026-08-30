import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type EventPlayerRow } from '../api';
import { useAsync } from '../useAsync';
import { MatchupTable } from '../components/MatchupTable';

export function EventPage() {
  const { id } = useParams();
  const [refreshKey, setRefreshKey] = useState(0);

  const event = useAsync(() => api.event(id!), [id]);
  const players = useAsync(() => api.eventPlayers(id!), [id, refreshKey]);
  const matchups = useAsync(() => api.matchups({ event: id! }), [id, refreshKey]);
  const allPlayers = useAsync(() => api.players(), [refreshKey]);

  function afterRemap() {
    setRefreshKey((k) => k + 1);
  }

  if (event.loading) return <p className="muted">Loading…</p>;
  if (event.error) return <p className="error">{event.error}</p>;
  if (!event.data) return null;

  return (
    <div>
      <h1>{event.data.name}</h1>
      <p className="muted">
        {event.data.date ?? 'no date'} · {event.data.gameCount} games ·{' '}
        {event.data.playerCount} players
      </p>

      <h2>Players</h2>
      {players.error && <p className="error">{players.error}</p>}
      {players.data && (
        <table>
          <thead>
            <tr>
              <th>Raw name</th>
              <th>Rank</th>
              <th>Matched player</th>
              <th>Remap</th>
            </tr>
          </thead>
          <tbody>
            {players.data.map((row) => (
              <PlayerRow
                key={row.eventPlayerId}
                row={row}
                options={allPlayers.data ?? []}
                onRemapped={afterRemap}
              />
            ))}
          </tbody>
        </table>
      )}

      <h2>Matchups</h2>
      {matchups.error && <p className="error">{matchups.error}</p>}
      {matchups.data && <MatchupTable rows={matchups.data} />}
    </div>
  );
}

function PlayerRow({
  row,
  options,
  onRemapped,
}: {
  row: EventPlayerRow;
  options: { id: number; name: string }[];
  onRemapped: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'existing' | 'new'>('idle');
  const [target, setTarget] = useState<number | ''>('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'existing' && target !== '') {
        await api.remapEventPlayer(row.eventPlayerId, { playerId: Number(target) });
      } else if (mode === 'new' && newName.trim()) {
        await api.remapEventPlayer(row.eventPlayerId, { newName: newName.trim() });
      } else {
        setBusy(false);
        return;
      }
      setMode('idle');
      setTarget('');
      setNewName('');
      onRemapped();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{row.rawName}</td>
      <td>{row.rank ?? '—'}</td>
      <td>
        {row.canonicalPlayerId != null ? (
          <Link to={`/players/${row.canonicalPlayerId}`}>{row.canonicalName}</Link>
        ) : (
          <span className="muted">unmatched</span>
        )}
      </td>
      <td>
        {mode === 'idle' && (
          <span className="remap">
            <button onClick={() => setMode('existing')}>Remap…</button>
          </span>
        )}
        {mode === 'existing' && (
          <span className="remap">
            <select
              value={target}
              onChange={(e) =>
                setTarget(e.target.value === '' ? '' : Number(e.target.value))
              }
            >
              <option value="">Choose player…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button disabled={busy || target === ''} onClick={apply}>
              Apply
            </button>
            <button onClick={() => setMode('new')}>＋ new</button>
            <button onClick={() => setMode('idle')}>Cancel</button>
          </span>
        )}
        {mode === 'new' && (
          <span className="remap">
            <input
              type="text"
              placeholder="New player name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button disabled={busy || !newName.trim()} onClick={apply}>
              Create &amp; link
            </button>
            <button onClick={() => setMode('existing')}>‹ back</button>
            <button onClick={() => setMode('idle')}>Cancel</button>
          </span>
        )}
        {error && <span className="error"> {error}</span>}
      </td>
    </tr>
  );
}
