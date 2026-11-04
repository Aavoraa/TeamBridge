import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokens, ApiError } from './api';
import { API_BASE } from './config';
import { configureLocale } from './format';
import { syncPush, forgetPushForThisBrowser } from './push';

export type Role = 'super_admin' | 'owner' | 'manager' | 'employee' | 'finance' | 'hr' | 'client';

export interface SessionUser {
  id: string; name: string; email: string; role: Role;
  designation?: string; avatar_url?: string; phone?: string;
  manager_id?: string; service_line_id?: string; client_id?: string;
  twofa_enabled: boolean;
  notification_prefs: Record<string, any>;
}

export interface Tenant {
  id: string; name: string; slug: string; timezone: string; currency: string;
  number_format: string; brand_primary: string; brand_accent: string; logo_url?: string;
  invoice_prefix: string; invoice_scheme: string; fy_start_month: number;
  state_code?: string; gstin?: string; city?: string; address?: string;
  phone?: string; email?: string; settings: Record<string, any>;
}

export interface Subscription {
  status: string; plan_code: string; plan_name: string; billing_cycle: string;
  trial_ends_at?: string; current_period_end?: string;
  features: Record<string, boolean>; limits: Record<string, number | null>;
  band_max_users: number;
}

type Permissions = Record<string, string[]>;

interface Session {
  user: SessionUser;
  tenant: Tenant | null;
  subscription: Subscription | null;
  permissions: Permissions;
}

interface AuthValue extends Partial<Session> {
  loading: boolean;
  signIn: (email: string, password: string, totp?: string) => Promise<void>;
  signUp: (payload: Record<string, any>) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
  can: (module: string, action: string) => boolean;
  hasFeature: (flag: string) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const applySession = (data: Session) => {
    setSession(data);
    // A browser that already allows pop-ups now delivers them to this person.
    syncPush();
    if (data.tenant) {
      configureLocale(data.tenant);
      // The tenant's own brand colour drives the UI accent (tenant branding).
      document.documentElement.style.setProperty('--brand', data.tenant.brand_primary);
      document.title = `Phoenixx OS · ${data.tenant.name}`;
    }
  };

  const loadMe = async () => {
    if (!tokens.access) { setLoading(false); return; }
    try {
      const { data } = await api.get<Session>('/auth/me');
      applySession(data);
    } catch {
      tokens.clear();
      setSession(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMe(); }, []);

  // Tokens live in localStorage, which every tab shares, but each tab holds its
  // own idea of who is signed in. Signing in as someone else in another tab
  // swaps the token underneath this one, which would then show one person's
  // name over another person's data. A silent token refresh for the same
  // person also lands here, so only a different person (or a sign-out) acts.
  const signedInId = session?.user?.id;
  useEffect(() => {
    const onStorage = async (e: StorageEvent) => {
      if (e.key !== 'phoenixx.access' || !signedInId) return;
      if (!e.newValue) { setSession(null); return; }
      try {
        const { data } = await api.get<Session>('/auth/me');
        if (data?.user?.id !== signedInId) window.location.reload();
      } catch { /* the api client handles a dead session itself */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [signedInId]);

  // The API client raises this when a refresh token is rejected.
  useEffect(() => {
    const onSignedOut = () => setSession(null);
    window.addEventListener('phoenixx:signed-out', onSignedOut);
    return () => window.removeEventListener('phoenixx:signed-out', onSignedOut);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    ...session,
    loading,

    async signIn(email, password, totp) {
      const { data } = await api.post<Session & { access_token: string; refresh_token: string }>(
        '/auth/login', { email, password, ...(totp ? { totp } : {}) },
      );
      tokens.set(data.access_token, data.refresh_token);
      applySession(data);
    },

    async signUp(payload) {
      const { data } = await api.post<Session & { access_token: string; refresh_token: string }>(
        '/auth/signup', payload,
      );
      tokens.set(data.access_token, data.refresh_token);
      applySession(data);
    },

    signOut() {
      forgetPushForThisBrowser(tokens.access);
      const refreshToken = tokens.refresh;
      tokens.clear();
      setSession(null);
      if (refreshToken) {
        fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        }).catch(() => {});
      }
    },

    async refresh() { await loadMe(); },

    can(module, action) {
      if (!session) return false;
      if (session.user.role === 'super_admin') return true;
      return !!session.permissions?.[module]?.includes(action);
    },

    hasFeature(flag) {
      return !!session?.subscription?.features?.[flag];
    },
  }), [session, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export { ApiError };
