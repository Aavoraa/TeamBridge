import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { api, clearTokens, loadTokens, setTokens, readQueue, flushQueue } from './api';

type User = {
  id: string; name: string; email: string; role: string; designation?: string;
};
type Tenant = { id: string; name: string; currency: string; brand_primary: string; timezone: string };
type Permissions = Record<string, string[]>;

interface AuthValue {
  user: User | null;
  tenant: Tenant | null;
  permissions: Permissions;
  loading: boolean;
  queued: number;
  syncing: boolean;
  signIn: (email: string, password: string, totp?: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (module: string, action: string) => boolean;
  refreshQueueCount: () => Promise<void>;
  sync: () => Promise<{ applied: number; failed: number; conflicts: string[] } | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [permissions, setPermissions] = useState<Permissions>({});
  const [loading, setLoading] = useState(true);
  const [queued, setQueued] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refreshQueueCount = useCallback(async () => {
    setQueued((await readQueue()).length);
  }, []);

  const applySession = (data: any) => {
    setUser(data.user);
    setTenant(data.tenant);
    setPermissions(data.permissions || {});
  };

  useEffect(() => {
    (async () => {
      const { accessToken } = await loadTokens();
      if (accessToken) {
        try {
          const res = await api.get('/auth/me');
          applySession(res.data);
        } catch {
          await clearTokens();
        }
      }
      await refreshQueueCount();
      setLoading(false);
    })();
  }, [refreshQueueCount]);

  const sync = useCallback(async () => {
    if (!user) return null;
    setSyncing(true);
    try {
      const result = await flushQueue();
      await refreshQueueCount();
      return result;
    } finally {
      setSyncing(false);
    }
  }, [user, refreshQueueCount]);

  // Anything captured offline is pushed as soon as a session is live.
  useEffect(() => {
    if (user && queued > 0) sync().catch(() => {});
  }, [user]);

  const value = useMemo<AuthValue>(() => ({
    user,
    tenant,
    permissions,
    loading,
    queued,
    syncing,

    async signIn(email, password, totp) {
      const res = await api.post('/auth/login', { email, password, ...(totp ? { totp } : {}) });
      await setTokens(res.data.access_token, res.data.refresh_token);
      applySession(res.data);
    },

    async signOut() {
      await clearTokens();
      setUser(null);
      setTenant(null);
      setPermissions({});
    },

    can: (module, action) => !!permissions?.[module]?.includes(action),
    refreshQueueCount,
    sync,
  }), [user, tenant, permissions, loading, queued, syncing, refreshQueueCount, sync]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
