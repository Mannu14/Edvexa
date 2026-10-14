import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onUnauthorized, tokenStore } from '../lib/api';
import type { User } from '../lib/types';

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => tokenStore.get());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(token));

  const logout = useCallback(() => {
    tokenStore.set(null);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => onUnauthorized(logout), [logout]);

  useEffect(() => {
    if (!token || user) return;
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(logout)
      .finally(() => setLoading(false));
  }, [token, user, logout]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    tokenStore.set(r.token);
    setToken(r.token);
    setUser(r.user);
  }, []);

  const value = useMemo(() => ({ user, token, loading, login, logout }), [user, token, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
