import { NavLink } from 'react-router-dom';
import { useProfile } from '../api/queries';
import { useAuth } from '../auth/AuthContext';
import { BikeIcon, FlagIcon, GroupsIcon, LogoutIcon, SettingsIcon } from './Icons';

export function NavBar() {
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();

  const displayLabel = profile?.displayName ?? user?.name ?? user?.email ?? 'Racer';
  const bikeColor = profile?.bikeColor ?? 'var(--color-primary)';

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <div className="navbar-left">
          <NavLink to="/race" className="brand" aria-label="Activity Racer Home">
            <span className="brand-badge" style={{ backgroundColor: bikeColor }} aria-hidden="true">
              <BikeIcon size={16} />
            </span>
            <span className="brand-text">Activity Racer</span>
          </NavLink>

          <nav className="nav-links" aria-label="Main navigation">
            <NavLink
              to="/race"
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <FlagIcon size={16} />
              <span>Race</span>
            </NavLink>
            <NavLink
              to="/groups"
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <GroupsIcon size={16} />
              <span>Groups</span>
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <SettingsIcon size={16} />
              <span>Settings</span>
            </NavLink>
          </nav>
        </div>

        <div className="navbar-right">
          <span className="user-pill" title={user?.email ?? displayLabel}>
            <span className="color-dot" style={{ backgroundColor: bikeColor }} aria-hidden="true" />
            <span className="user-pill-name">{displayLabel}</span>
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm nav-signout-btn"
            onClick={() => void signOut()}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogoutIcon size={16} />
            <span className="nav-signout-label">Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
