import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ImportSummary } from '../api';

export function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dupeEventId, setDupeEventId] = useState<number | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setSummary(null);
    setError(null);
    setDupeEventId(null);
    try {
      setSummary(await api.importFile(file));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.status === 409 && typeof err.body?.eventId === 'number') {
          setDupeEventId(err.body.eventId);
        }
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Import a tournament</h1>
      <p className="muted">Upload one OpenGotha tournament file (.xml).</p>
      <form onSubmit={submit}>
        <input
          type="file"
          accept=".xml,text/xml,application/xml"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={!file || busy}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </form>

      {error && (
        <p className="error">
          {error}
          {dupeEventId != null && (
            <>
              {' '}
              <Link to={`/events/${dupeEventId}`}>View the existing event</Link>.
            </>
          )}
        </p>
      )}

      {summary && (
        <div className="ok">
          <p>
            Imported <strong>{summary.name}</strong>
            {summary.date ? ` (${summary.date})` : ''} —{' '}
            <Link to={`/events/${summary.eventId}`}>open event</Link>
          </p>
          <ul>
            <li>{summary.eventPlayers} event players</li>
            <li>
              {summary.playersMatched} matched to existing players, {summary.playersCreated}{' '}
              newly created
            </li>
            <li>
              {summary.gamesInserted} games inserted ({summary.nonGames} non-games)
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
