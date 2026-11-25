import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NavBar } from './NavBar';

export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <main className="center-screen">
        <div className="card compact-card">
          <div className="spinner" aria-hidden="true" />
          <p className="muted">Restoring your session...</p>
        </div>
      </main>
    );
  }

  if (status !== 'authenticated') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return (
    <div className="app-shell">
      <NavBar />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
