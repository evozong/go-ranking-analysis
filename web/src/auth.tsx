import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
}

// loading  — /api/auth/me in flight
// anon     — not signed in
// unauthorised — signed in with Google but not on the allowlist
// ok       — signed in and allowlisted (full app)
export type AuthStatus = 'loading' | 'anon' | 'unauthorised' | 'ok';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const body = (await res.json()) as {
        authenticated: boolean;
        authorised: boolean;
        email?: string;
        name?: string;
        picture?: string;
      };
      if (!body.authenticated) {
        setStatus('anon');
        setUser(null);
      } else {
        setUser({ email: body.email!, name: body.name, picture: body.picture });
        setStatus(body.authorised ? 'ok' : 'unauthorised');
      }
    } catch {
      setStatus('anon');
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // api.ts dispatches this when any request comes back 401 (session expired).
  useEffect(() => {
    const onExpired = () => {
      setStatus('anon');
      setUser(null);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(() => {
    window.location.href = '/api/auth/login';
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      setStatus('anon');
      setUser(null);
      window.location.assign('/');
    }
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>');
  return ctx;
}
