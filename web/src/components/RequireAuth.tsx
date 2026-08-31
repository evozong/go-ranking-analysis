import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

// Gate for every non-public route. `loading` shows nothing; `ok` renders the
// matched route; anything else bounces to the public landing page.
export function RequireAuth() {
  const { status } = useAuth();
  if (status === 'loading') {
    return <p className="muted">Loading…</p>;
  }
  if (status === 'ok') {
    return <Outlet />;
  }
  return <Navigate to="/" replace />;
}
