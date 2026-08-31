import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';

export function LandingPage() {
  const { status, user, login } = useAuth();
  const [params] = useSearchParams();
  const authError = params.get('auth_error') === '1';

  return (
    <div className="landing">
      <h1>Go Ranking Analysis</h1>
      <p className="muted">
        Ingests OpenGotha tournament results — or a parsed standings-table CSV —
        and lets you explore the head-to-head history of any player. Access is
        invite-only.
      </p>

      {authError && (
        <p className="error">Sign-in didn’t complete. Please try again.</p>
      )}

      {status === 'loading' && <p className="muted">Loading…</p>}

      {status === 'anon' && (
        <p>
          <button onClick={login}>Sign in with Google</button>
        </p>
      )}

      {status === 'unauthorised' && (
        <p className="error">
          You’re signed in as <strong>{user?.email}</strong>, but that address isn’t
          on the invite list. Ask the owner to add you.
        </p>
      )}

      {status === 'ok' && (
        <p className="muted">
          You’re signed in — use the navigation above to get started.
        </p>
      )}
    </div>
  );
}
