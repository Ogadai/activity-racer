import { NavLink } from 'react-router-dom';
import { useProfile } from '../api/queries';
import { useAuth } from '../auth/AuthContext';

export function NavBar() {
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();

  const displayLabel = profile?.displayName ?? user?.name ?? user?.email ?? 'Racer';
  const bikeColor = profile?.bikeColor ?? '#2563eb';

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <div className="navbar-left">
          <NavLink to="/race" className="brand">
            <span className="brand-dot" style={{ backgroundColor: bikeColor }} aria-hidden="true" />
            <span>Activity Racer</span>
          </NavLink>

          <nav className="nav-links" aria-label="Main navigation">
            <NavLink
              to="/race"
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              Race
            </NavLink>
            <NavLink
              to="/groups"
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              Groups
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              Settings
            </NavLink>
          </nav>
        </div>

        <div className="navbar-right">
          <span className="user-pill" title={user?.email ?? displayLabel}>
            <span className="color-dot" style={{ backgroundColor: bikeColor }} aria-hidden="true" />
            <span className="user-pill-name">{displayLabel}</span>
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void signOut()}>
            Sign Out
          </button>
        </div>
      </div>
    </header>
  );
}
