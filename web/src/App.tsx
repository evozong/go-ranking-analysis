import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import { ProfileMenu } from './components/ProfileMenu';

export function App() {
  const { status } = useAuth();

  return (
    <div className="app">
      <header className="topnav">
        <span className="brand">Go Ranking Analysis</span>
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
