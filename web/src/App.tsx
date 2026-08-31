import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import { ProfileMenu } from './components/ProfileMenu';

export function App() {
  const { status } = useAuth();

  return (
    <div className="app">
      <header className="topnav">
        <Link to="/" className="brand">
          Go Ranking Analysis
        </Link>
        {status === 'ok' && (
          <nav>
            <NavLink to="/events">Events</NavLink>
            <NavLink to="/players">Players</NavLink>
            <NavLink to="/import">Import</NavLink>
          </nav>
        )}
        <ProfileMenu />
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
