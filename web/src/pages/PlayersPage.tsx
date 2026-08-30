import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PlayerListItem } from '../api';
import { useAsync } from '../useAsync';

interface HintInfo {
  reasons: Set<'egf' | 'name'>;
  others: Set<number>;
}

export function PlayersPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useAsync(() => api.players(), [refreshKey]);
  const hints = useAsync(() => api.playerDuplicateHints(), [refreshKey]);

  const [filter, setFilter] = useState('');
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [keeperPick, setKeeperPick] = useState<number | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const hintMap = useMemo(() => {
    const m = new Map<number, HintInfo>();
    for (const h of hints.data ?? []) {
      for (const id of h.playerIds) {
        let info = m.get(id);
        if (!info) {
          info = { reasons: new Set(), others: new Set() };
          m.set(id, info);
        }
        info.reasons.add(h.reason);
        for (const other of h.playerIds) if (other !== id) info.others.add(other);
      }
    }
    return m;
  }, [hints.data]);

  const nameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of data ?? []) m.set(p.id, p.name);
    return m;
  }, [data]);

  const rows = useMemo(() => {
    let all = data ?? [];
    const q = filter.trim().toLowerCase();
    if (q) all = all.filter((p) => p.name.toLowerCase().includes(q));
    if (onlyDuplicates) all = all.filter((p) => hintMap.has(p.id));
    return all;
  }, [data, filter, onlyDuplicates, hintMap]);

  // Effective keeper: the explicit pick if it's still selected, else the first selected.
  const selectedIds = [...selected];
  const keeper =
    keeperPick !== null && selected.has(keeperPick)
      ? keeperPick
      : selectedIds[0] ?? null;

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function cancelMerge() {
    setSelected(new Set());
    setKeeperPick(null);
    setMergeError(null);
  }

  async function doMerge() {
    if (keeper === null) return;
    const mergeIds = [...selected].filter((id) => id !== keeper);
    if (mergeIds.length === 0) return;
    setMerging(true);
    setMergeError(null);
    try {
      await api.mergePlayers(keeper, mergeIds);
      cancelMerge();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setMergeError((err as Error).message);
    } finally {
      setMerging(false);
    }
  }

  const selectedList: PlayerListItem[] = useMemo(
    () => (data ?? []).filter((p) => selected.has(p.id)),
    [data, selected],
  );

  return (
    <div>
      <h1>Players</h1>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {hints.error && <p className="error">{hints.error}</p>}
      {data && (
        <>
          <div className="filter-row">
            <input
              type="text"
              placeholder="Filter by name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <label className="muted" style={{ marginLeft: '0.75rem' }}>
              <input
                type="checkbox"
                checked={onlyDuplicates}
                onChange={(e) => setOnlyDuplicates(e.target.checked)}
              />{' '}
              Only possible duplicates
            </label>
            <span className="muted"> {rows.length} of {data.length}</span>
          </div>

          {selected.size >= 2 && (
            <div className="merge-bar">
              <span>Keeper:</span>
              {selectedList.map((p) => (
                <label key={p.id}>
                  <input
                    type="radio"
                    name="keeper"
                    checked={keeper === p.id}
                    onChange={() => setKeeperPick(p.id)}
                  />{' '}
                  {p.name}
                </label>
              ))}
              <button
                disabled={merging || keeper === null}
                onClick={doMerge}
              >
                Merge {selected.size} players
              </button>
              <button onClick={cancelMerge}>Cancel</button>
              {mergeError && <span className="error"> {mergeError}</span>}
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Possible duplicate</th>
                <th>Games</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const hint = hintMap.get(p.id);
                return (
                  <tr key={p.id} className={hint ? 'dup-row' : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                    </td>
                    <td>
                      <Link to={`/players/${p.id}`}>{p.name}</Link>
                    </td>
                    <td>
                      {hint && (
                        <span
                          className="hint"
                          title={
                            'Matches: ' +
                            [...hint.others]
                              .map((id) => nameById.get(id) ?? `#${id}`)
                              .join(', ')
                          }
                        >
                          {hint.reasons.has('egf') ? 'same EGF pin' : 'similar name'}
                        </span>
                      )}
                    </td>
                    <td>{p.gameCount}</td>
                    <td>{p.eventCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
