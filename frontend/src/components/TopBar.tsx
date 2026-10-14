import { useAuth } from '../auth/AuthContext';
import type { ConnectionState } from '../lib/socket';
import { BrandMark, DocsIcon, LogoutIcon } from './ui';

const CONN_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Reconnecting…',
};

export function TopBar({ connection, subtitle }: { connection: ConnectionState; subtitle: string }) {
  const { user, logout } = useAuth();
  const initials = user?.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        Dispatch Control
        <small>{subtitle}</small>
      </div>
      <div className="spacer" />
      <span className={`conn ${connection}`} title="Socket.IO connection">
        <i />
        {CONN_LABEL[connection]}
      </span>
      <a className="btn btn-ghost btn-sm hide-sm" href="/docs" target="_blank" rel="noreferrer">
        <DocsIcon size={14} /> API docs
      </a>
      <div className="who">
        <span className="avatar" aria-hidden>
          {initials}
        </span>
        <span className="meta">
          <b>{user?.name}</b>
          <small>{user?.role}</small>
        </span>
        <button className="btn btn-ghost btn-sm" onClick={logout} aria-label="Sign out">
          <LogoutIcon size={14} />
        </button>
      </div>
    </header>
  );
}
