import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ImportSummary } from '../api';

// Accepts space / underscore / hyphen as separators, e.g.
//   "20250419_go_academy_intermediate_r5_standings_table.csv"
//   "20250419 Go Academy Intermediate standings.csv"
//   -> date 2025-04-19, name "Go Academy Intermediate"
// The trailing " r<n>" round tag and " standings…" suffix are stripped if present.
const FILENAME_RE =
  /^(\d{4})(\d{2})(\d{2})[ _-]+(.+?)(?:[ _-]+r\d+)?(?:[ _-]+standings.*)?\.csv$/i;

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function prefillFromFilename(filename: string): { name: string; date: string } {
  const m = FILENAME_RE.exec(filename);
  if (!m) return { name: '', date: '' };
  const [, y, mo, d, rawName] = m;
  return {
    name: titleCase(rawName.replace(/[ _-]+/g, ' ').trim()),
    date: `${y}-${mo}-${d}`,
  };
}

interface Feedback {
  summary: ImportSummary | null;
  error: string | null;
  dupeEventId: number | null;
}

const NO_FEEDBACK: Feedback = { summary: null, error: null, dupeEventId: null };

function toFeedback(err: unknown): Feedback {
  if (err instanceof ApiError) {
    return {
      summary: null,
      error: err.message,
      dupeEventId:
        err.status === 409 && typeof err.body?.eventId === 'number'
          ? err.body.eventId
          : null,
    };
  }
  return { summary: null, error: (err as Error).message, dupeEventId: null };
}

function FeedbackPanel({ feedback }: { feedback: Feedback }) {
  const { summary, error, dupeEventId } = feedback;
  return (
    <>
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
              {summary.playersMatched} matched to existing players,{' '}
              {summary.playersCreated} newly created
            </li>
            <li>
              {summary.gamesInserted} games inserted ({summary.nonGames} non-games)
            </li>
          </ul>
        </div>
      )}
    </>
  );
}

function StandingsCsvSection() {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);

  function onFile(f: File | null) {
    setFile(f);
    setFeedback(NO_FEEDBACK);
    if (f) {
      const { name: n, date: d } = prefillFromFilename(f.name);
      setName(n);
      setDate(d);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    setFeedback(NO_FEEDBACK);
    try {
      const result = await api.importStandings(file, name.trim(), date);
      // Hand the generated OpenGotha XML back to the user as a download.
      const url = URL.createObjectURL(
        new Blob([result.xml], { type: 'application/xml' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setFeedback({ summary: result, error: null, dupeEventId: null });
    } catch (err) {
      setFeedback(toFeedback(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Import from Standings CSV</h2>
      <p className="muted">
        Upload a parsed standings-table CSV
        (<code>Num,Pl,Name,Female,Rk,NbW,R1…Rn,NBW,SOS,SOSOS</code>). It is
        converted to an OpenGotha <code>.xml</code> (downloaded automatically) and
        imported. Name and date pre-fill from the filename and stay editable.
      </p>
      <form onSubmit={submit}>
        <p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
        </p>
        <p>
          <label>
            Tournament name{' '}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Go Academy Intermediate"
            />
          </label>
        </p>
        <p>
          <label>
            Date{' '}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </p>
        <button type="submit" disabled={!file || !name.trim() || busy}>
          {busy ? 'Importing…' : 'Convert & import'}
        </button>
      </form>
      <FeedbackPanel feedback={feedback} />
    </section>
  );
}

function OpenGothaXmlSection() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setFeedback(NO_FEEDBACK);
    try {
      const summary = await api.importFile(file);
      setFeedback({ summary, error: null, dupeEventId: null });
    } catch (err) {
      setFeedback(toFeedback(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Import from OpenGotha XML</h2>
      <p className="muted">Upload one OpenGotha tournament file (.xml).</p>
      <form onSubmit={submit}>
        <input
          type="file"
          accept=".xml,text/xml,application/xml"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setFeedback(NO_FEEDBACK);
          }}
        />
        <button type="submit" disabled={!file || busy}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </form>
      <FeedbackPanel feedback={feedback} />
    </section>
  );
}

export function ImportPage() {
  return (
    <div>
      <h1>Import a tournament</h1>
      <StandingsCsvSection />
      <OpenGothaXmlSection />
    </div>
  );
}
