import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';

// Top-right header control, rendered on every page. `anon` -> a "Sign in"
// button; signed-in -> an avatar that opens a small name/email + "Sign out"
// dropdown. Plain React state, no menu library.
export function ProfileMenu() {
  const { status, user, login, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (status === 'loading') return null;

  if (status === 'anon') {
    return (
      <button className="profile-signin" onClick={login}>
        Sign in
      </button>
    );
  }

  const label = (user?.name || user?.email || '?').trim();
  const initial = label.charAt(0).toUpperCase() || '?';

  return (
    <div className="profile" ref={ref}>
      <button
        className="profile-avatar"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        {user?.picture && !imgFailed ? (
          <img
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="profile-initial">{initial}</span>
        )}
      </button>
      {open && (
        <div className="profile-dropdown" role="menu">
          <div className="profile-id">
            {user?.name && <div className="profile-name">{user.name}</div>}
            <div className="muted">{user?.email}</div>
          </div>
          <button
            className="profile-signout"
            role="menuitem"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
