import { NavLink, Outlet } from 'react-router-dom';

export function App() {
  return (
    <div className="app">
      <header className="topnav">
        <span className="brand">Go Ranking Analysis</span>
        <nav>
          <NavLink to="/events">Events</NavLink>
          <NavLink to="/players">Players</NavLink>
          <NavLink to="/import">Import</NavLink>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
