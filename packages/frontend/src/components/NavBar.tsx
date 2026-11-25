import { NavLink } from 'react-router-dom';
import { useProfile } from '../api/queries';
import { useAuth } from '../auth/AuthContext';
import { BikeIcon, FlagIcon, GroupsIcon, LogoutIcon, SettingsIcon } from './Icons';
import styles from './NavBar.module.css';

export function NavBar() {
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();

  const displayLabel = profile?.displayName ?? user?.name ?? user?.email ?? 'Racer';
  const bikeColor = profile?.bikeColor ?? 'var(--color-primary)';

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.navLink} ${styles.active}` : styles.navLink;

  return (
    <header className={styles.navbar}>
      <div className={styles.navbarInner}>
        <div className={styles.navbarLeft}>
          <NavLink to="/race" className={styles.brand} aria-label="Activity Racer Home">
            <span
              className={styles.brandBadge}
              style={{ backgroundColor: bikeColor }}
              aria-hidden="true"
            >
              <BikeIcon size={16} />
            </span>
            <span className={styles.brandText}>Activity Racer</span>
          </NavLink>

          <nav className={styles.navLinks} aria-label="Main navigation">
            <NavLink to="/race" className={navLinkClass}>
              <FlagIcon size={16} />
              <span>Race</span>
            </NavLink>
            <NavLink to="/groups" className={navLinkClass}>
              <GroupsIcon size={16} />
              <span>Groups</span>
            </NavLink>
          </nav>
        </div>

        <div className={styles.navbarRight}>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              isActive ? `${styles.userSettingsLink} ${styles.active}` : styles.userSettingsLink
            }
            aria-label={`Settings (${displayLabel})`}
            title={`Settings — ${user?.email ?? displayLabel}`}
          >
            <SettingsIcon size={16} />
            <span className={styles.userSettingsName}>{displayLabel}</span>
          </NavLink>
          <button
            type="button"
            className={`btn btn-secondary btn-sm ${styles.navSignoutBtn}`}
            onClick={() => void signOut()}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogoutIcon size={16} />
            <span className={styles.navSignoutLabel}>Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
