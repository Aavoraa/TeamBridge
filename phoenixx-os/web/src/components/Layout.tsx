import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, ListChecks, CalendarDays, Users2, FileText, Receipt, Wallet,
  BookOpenCheck, BarChart3, Settings, Bell, Menu, X, LogOut, Sun, Moon, Search,
  Building2, ShieldCheck, ChevronDown, CreditCard, Clock, AlertTriangle, Target, CheckCircle2,
  FolderKanban, Megaphone, MessagesSquare, Contact, FileSpreadsheet, History, Send, Landmark, ClipboardList,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { PushBanner, PushToggle, usePushMessages } from './PushControls';
import { api } from '../lib/api';
import { store } from '../lib/storage';
import { Logo } from './Logo';
import { applyStatusBarTheme } from '../lib/native';
import { Avatar, Badge, Button, cx, EmptyState } from './ui';
import { relative } from '../lib/format';
import TodoReminders from './TodoReminders';

/* ------------------------------------------------------------------ theme */
/** Exported so the mobile shell shares it — two copies would let the native
 *  status bar drift out of step with the page. */
export function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = store.get('phoenixx.theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    store.set('phoenixx.theme', dark ? 'dark' : 'light');
    // The native status bar sits outside the WebView, so it has to be told
    // separately or it keeps the old theme's text colour and goes unreadable.
    void applyStatusBarTheme(dark);
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

/* ------------------------------------------------------------ navigation */
type NavItem = {
  to: string; label: string; icon: any;
  /** Hidden unless the caller can view this module. */
  module?: string;
  /** Hidden unless the caller can take this action on `module`. */
  action?: string;
  /** Match the path exactly. Needed wherever one nav path prefixes another. */
  exact?: boolean;
  badge?: 'overdue' | 'approvals' | 'chat' | 'reimb_manager' | 'reimb_finance';
};

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Work',
    items: [
      { to: '/', label: 'My day', icon: LayoutDashboard, exact: true },
      { to: '/action-items', label: 'Action items', icon: ListChecks, module: 'action_items', badge: 'overdue' },
      { to: '/meetings', label: 'Meetings & MOM', icon: CalendarDays, module: 'meetings' },
      { to: '/deadlines', label: 'Deadlines', icon: Clock, module: 'deadlines' },
      { to: '/chat', label: 'Chat', icon: MessagesSquare, module: 'chat', badge: 'chat' },
    ],
  },
  {
    section: 'Clients',
    items: [
      // The register first, the pipeline second: you look up who a client is far
      // more often than you move a deal between stages.
      { to: '/clients', label: 'Clients', icon: Contact, module: 'crm' },
      { to: '/crm', label: 'CRM pipeline', icon: Users2, module: 'crm' },
      { to: '/proposals', label: 'Proposals', icon: FileText, module: 'proposals' },
      { to: '/projects', label: 'Projects & teams', icon: FolderKanban, module: 'projects' },
      { to: '/marketing', label: 'Marketing leads', icon: Megaphone, module: 'crm' },
    ],
  },
  {
    section: 'Money',
    items: [
      { to: '/invoices', label: 'Invoices', icon: Receipt, module: 'invoices' },
      // Exact: /finance/reimbursements/* is a different section entirely.
      { to: '/finance', label: 'Cost & profit', icon: Wallet, module: 'costs', exact: true },
    ],
  },
  {
    // Its own section, not a tab inside Cost & profit: everybody in the
    // workspace files an expense claim, whereas almost nobody reads a P&L.
    section: 'Finance',
    items: [
      { to: '/finance/reimbursements/new', label: 'Reimbursement', icon: Send, module: 'reimbursements', action: 'create' },
      { to: '/finance/reimbursements', label: 'My reimbursements', icon: Receipt, module: 'reimbursements', exact: true },
      { to: '/finance/reimbursements/approvals', label: 'Pending approvals', icon: ShieldCheck, module: 'reimbursements', action: 'approve', badge: 'reimb_manager' },
      { to: '/finance/reimbursements/review', label: 'Finance review', icon: Landmark, module: 'reimbursement_finance', badge: 'reimb_finance' },
      { to: '/finance/reimbursements/history', label: 'Reimbursement history', icon: History, module: 'reimbursements' },
      { to: '/finance/reimbursements/reports', label: 'Expense & reimbursement reports', icon: FileSpreadsheet, module: 'reimbursements', action: 'export' },
    ],
  },
  {
    section: 'People',
    items: [
      { to: '/hr', label: 'HR', icon: Building2, module: 'hr_attendance', badge: 'approvals' },
      { to: '/team', label: 'Team', icon: Users2, module: 'employees' },
    ],
  },
  {
    section: 'Standards',
    items: [
      { to: '/sop', label: 'SOP & KPI', icon: BookOpenCheck, module: 'sop' },
    ],
  },
  {
    section: 'Insight',
    items: [
      { to: '/dashboard', label: 'Traction dashboard', icon: Target, module: 'dashboard' },
      { to: '/reports', label: 'Reports', icon: BarChart3, module: 'reports' },
    ],
  },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings, module: 'settings' },
  { to: '/billing', label: 'Billing & plan', icon: CreditCard, module: 'billing' },
];

/* =================================================================== SHELL */
export default function Layout() {
  const { user, tenant, subscription, can, signOut } = useAuth();
  const { dark, toggle } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  usePushMessages();

  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const { data: home } = useQuery({
    queryKey: ['home-counters'],
    queryFn: () => api.get('/dashboard/home').then((r) => r.data),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // Claim queues are their own call: the roles that can see them are a
  // different set from the ones the home counters serve.
  const { data: claimQueues } = useQuery({
    queryKey: ['reimbursements', 'queues'],
    queryFn: () => api.get('/finance/reimbursements/queues').then((r) => r.data),
    enabled: can('reimbursements', 'view'),
    refetchInterval: 180_000,
    staleTime: 120_000,
  });

  const counters = home?.counters || {};
  const approvals = home?.pending_approvals || {};
  const approvalCount = (approvals.leave || 0) + (approvals.regularizations || 0);

  const badgeFor = (kind?: string) => {
    if (kind === 'overdue') return counters.overdue || 0;
    if (kind === 'approvals') return approvalCount;
    if (kind === 'chat') return counters.chat || 0;
    if (kind === 'reimb_manager') return claimQueues?.manager_pending || 0;
    if (kind === 'reimb_finance') return (claimQueues?.finance_pending || 0) + (claimQueues?.awaiting_payment || 0);
    return 0;
  };

  // The same permission the API enforces decides whether an entry is drawn.
  // Hiding it is a courtesy; the server refuses the call either way.
  const visible = (item: NavItem) => !item.module || can(item.module, item.action || 'view');

  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <div className="min-h-full flex bg-surface">
      {/* ---------------------------------------------------------- sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />
      )}

      <aside className={cx(
        'fixed inset-y-0 left-0 z-40 w-[248px] shrink-0 border-r border-line bg-raised',
        'flex flex-col transition-transform duration-200 lg:translate-x-0 lg:static no-print',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line shrink-0">
          {/* The workspace's own identity, not the product's — an agency that
              uploaded a logo sees it here, otherwise their initial in their
              brand colour. Only with no tenant at all does Phoenixx OS's own
              mark stand in. */}
          {tenant?.logo_url ? (
            <img src={tenant.logo_url} alt=""
              className="h-8 w-8 shrink-0 rounded-lg object-cover" />
          ) : tenant?.name ? (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-white"
              style={{ background: tenant.brand_primary || '#E15926' }}>
              {tenant.name[0]}
            </span>
          ) : (
            <Logo size={32} className="shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-ink truncate leading-tight">{tenant?.name || 'Phoenixx OS'}</p>
            <p className="text-[11px] text-subtle truncate leading-tight">
              {subscription?.plan_name} {subscription?.status === 'trial' && '· trial'}
            </p>
          </div>
          <button className="lg:hidden text-subtle hover:text-ink cursor-pointer" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-4">
          {NAV.map((group) => {
            const items = group.items.filter(visible);
            if (!items.length) return null;
            return (
              <div key={group.section}>
                <p className="label-cap px-2.5 mb-1">{group.section}</p>
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const count = badgeFor(item.badge);
                    return (
                      <li key={item.to}>
                        <NavLink
                          to={item.to} end={!!item.exact}
                          className={({ isActive }) => cx(
                            'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium',
                            'transition-colors duration-150 cursor-pointer',
                            isActive
                              ? 'bg-brand-soft text-[var(--brand)]'
                              : 'text-muted hover:bg-sunken hover:text-ink',
                          )}
                        >
                          <item.icon size={16} className="shrink-0" />
                          <span className="truncate flex-1">{item.label}</span>
                          {count > 0 && (
                            <span className={cx('rounded-full px-1.5 text-[10.5px] font-semibold tabular leading-[17px]',
                              item.badge === 'overdue' ? 'bg-[var(--negative)] text-white' : 'bg-[var(--accent-bg)] text-slate-900')}>
                              {count > 99 ? '99+' : count}
                            </span>
                          )}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {(ADMIN_NAV.some(visible) || isSuperAdmin) && (
            <div>
              <p className="label-cap px-2.5 mb-1">Admin</p>
              <ul className="space-y-0.5">
                {ADMIN_NAV.filter(visible).map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to}
                      className={({ isActive }) => cx(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium transition-colors duration-150 cursor-pointer',
                        isActive ? 'bg-brand-soft text-[var(--brand)]' : 'text-muted hover:bg-sunken hover:text-ink',
                      )}>
                      <item.icon size={16} className="shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  </li>
                ))}
                {isSuperAdmin && (
                  <li>
                    <NavLink to="/admin"
                      className={({ isActive }) => cx(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium transition-colors duration-150 cursor-pointer',
                        isActive ? 'bg-brand-soft text-[var(--brand)]' : 'text-muted hover:bg-sunken hover:text-ink',
                      )}>
                      <ShieldCheck size={16} className="shrink-0" />
                      <span className="truncate">Platform console</span>
                    </NavLink>
                  </li>
                )}
              </ul>
            </div>
          )}
        </nav>

        {subscription?.status === 'trial' && (
          <div className="mx-2.5 mb-2.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-accent-soft p-3">
            <p className="text-[12.5px] font-semibold text-[var(--accent)]">Trial in progress</p>
            <p className="text-[12px] text-muted mt-0.5 leading-snug">
              Ends {relative(subscription.trial_ends_at)}. No card on file yet.
            </p>
            <Button variant="accent" size="sm" className="mt-2 w-full justify-center"
              onClick={() => navigate('/billing')}>Choose a plan</Button>
          </div>
        )}
      </aside>

      {/* ------------------------------------------------------------- main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar onMenu={() => setSidebarOpen(true)} dark={dark} toggleTheme={toggle} signOut={signOut} />
        <main className="flex-1 min-w-0 px-4 py-5 sm:px-6 lg:px-7 max-w-[1600px] w-full mx-auto">
          <PushBanner />
          <Outlet />
        </main>
        <TodoReminders />
        <footer className="border-t border-line px-4 sm:px-6 py-3 text-[12px] text-subtle flex flex-wrap gap-x-4 gap-y-1 justify-between no-print">
          <span>Phoenixx OS · {tenant?.name}</span>
          <span>All times {tenant?.timezone?.replace('_', ' ')} · amounts in {tenant?.currency}</span>
        </footer>
      </div>
    </div>
  );
}

/* ================================================================= TOPBAR */
function TopBar({ onMenu, dark, toggleTheme, signOut }: {
  onMenu: () => void; dark: boolean; toggleTheme: () => void; signOut: () => void;
}) {
  const { user, tenant } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-raised/95 backdrop-blur px-4 sm:px-6 no-print">
      <button onClick={onMenu} aria-label="Open navigation"
        className="lg:hidden text-muted hover:text-ink transition-colors cursor-pointer p-1.5 -ml-1.5 rounded">
        <Menu size={20} />
      </button>

      <GlobalSearch />

      <div className="ml-auto flex items-center gap-1">
        <button onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-sunken hover:text-ink transition-colors duration-150 cursor-pointer">
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        <NotificationBell open={bellOpen} setOpen={setBellOpen} />

        <div className="relative" ref={menuRef}>
          <button onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen} aria-haspopup="menu"
            className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sunken transition-colors duration-150 cursor-pointer">
            <Avatar name={user?.name} url={user?.avatar_url} size={28} />
            <span className="hidden sm:block text-left leading-tight">
              <span className="block text-[13px] font-medium text-ink max-w-[120px] truncate">{user?.name}</span>
              <span className="block text-[11px] text-subtle capitalize">{user?.role?.replace('_', ' ')}</span>
            </span>
            <ChevronDown size={14} className="text-subtle hidden sm:block" />
          </button>

          {menuOpen && (
            <div role="menu"
              className="absolute right-0 mt-1.5 w-60 card p-1.5 shadow-[var(--shadow-lg)] animate-in z-30">
              <div className="px-2.5 py-2 border-b border-line mb-1">
                <p className="text-[13px] font-medium text-ink truncate">{user?.name}</p>
                <p className="text-[12px] text-subtle truncate">{user?.email}</p>
                {tenant && <p className="text-[11px] text-subtle mt-1">{tenant.name}</p>}
              </div>
              <button onClick={() => { setMenuOpen(false); navigate('/profile'); }} role="menuitem"
                className="w-full text-left px-2.5 py-2 rounded text-[13px] text-muted hover:bg-sunken hover:text-ink transition-colors cursor-pointer">
                Profile & notifications
              </button>
              <button onClick={() => { setMenuOpen(false); navigate('/settings'); }} role="menuitem"
                className="w-full text-left px-2.5 py-2 rounded text-[13px] text-muted hover:bg-sunken hover:text-ink transition-colors cursor-pointer">
                Workspace settings
              </button>
              <button onClick={signOut} role="menuitem"
                className="w-full text-left px-2.5 py-2 rounded text-[13px] text-[var(--negative)] hover:bg-negative-soft transition-colors cursor-pointer flex items-center gap-2 mt-1">
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------- global search */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['search', q],
    queryFn: async () => {
      const [clients, items] = await Promise.all([
        api.get('/crm/clients', { search: q, limit: 5 }).then((r) => r.data).catch(() => []),
        api.get('/action-items', { search: q, limit: 5 }).then((r) => r.data).catch(() => []),
      ]);
      return { clients, items };
    },
    enabled: q.trim().length >= 2,
    staleTime: 20_000,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        boxRef.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const go = (path: string) => { setOpen(false); setQ(''); navigate(path); };

  return (
    <div className="relative flex-1 max-w-md" ref={boxRef}>
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search clients and action items…"
        aria-label="Search"
        className="h-9 w-full rounded-md border border-line bg-sunken pl-8 pr-14 text-sm text-ink
                   placeholder:text-subtle transition-colors duration-150 focus:bg-raised focus:border-line-strong"
      />
      <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:block text-[10.5px] text-subtle
                      border border-line rounded px-1.5 py-0.5 pointer-events-none mono">⌘K</kbd>

      {open && q.trim().length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-1.5 card p-1.5 shadow-[var(--shadow-lg)] max-h-[70vh] overflow-y-auto animate-in z-30">
          {!data?.clients?.length && !data?.items?.length ? (
            <p className="px-3 py-4 text-[13px] text-subtle text-center">No matches for “{q}”</p>
          ) : (
            <>
              {!!data?.clients?.length && (
                <div className="mb-1">
                  <p className="label-cap px-2.5 py-1.5">Clients</p>
                  {data.clients.map((c: any) => (
                    <button key={c.id} onClick={() => go(`/crm/${c.id}`)}
                      className="w-full text-left px-2.5 py-2 rounded hover:bg-sunken transition-colors cursor-pointer flex items-center gap-2">
                      <Users2 size={14} className="text-subtle shrink-0" />
                      <span className="text-[13px] text-ink truncate flex-1">{c.name}</span>
                      <Badge tone={c.status === 'active' ? 'positive' : 'info'}>{c.status}</Badge>
                    </button>
                  ))}
                </div>
              )}
              {!!data?.items?.length && (
                <div>
                  <p className="label-cap px-2.5 py-1.5">Action items</p>
                  {data.items.map((a: any) => (
                    <button key={a.id} onClick={() => go(`/action-items?open=${a.id}`)}
                      className="w-full text-left px-2.5 py-2 rounded hover:bg-sunken transition-colors cursor-pointer flex items-center gap-2">
                      <ListChecks size={14} className="text-subtle shrink-0" />
                      <span className="text-[13px] text-ink truncate flex-1">{a.title}</span>
                      <Badge tone={a.status === 'done' ? 'positive' : 'neutral'}>{a.status.replace('_', ' ')}</Badge>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- bell */
function NotificationBell({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['notifications', 'bell'],
    queryFn: () => api.get('/notifications', { limit: 12 }),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [setOpen]);

  const unread = data?.meta?.unread || 0;
  const items = data?.data || [];

  const markAll = async () => {
    await api.post('/notifications/read-all');
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  const openItem = async (n: any) => {
    if (!n.read_at) await api.post(`/notifications/${n.id}/read`).catch(() => {});
    qc.invalidateQueries({ queryKey: ['notifications'] });
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const iconFor = (key: string) => {
    if (key.includes('overdue') || key.includes('escalation')) return <AlertTriangle size={14} className="text-[var(--negative)]" />;
    if (key.includes('paid') || key.includes('accepted')) return <CheckCircle2 size={14} className="text-[var(--positive)]" />;
    if (key.includes('invoice')) return <Receipt size={14} className="text-[var(--brand)]" />;
    if (key === 'todo.approved') return <CheckCircle2 size={14} className="text-[var(--positive)]" />;
    if (key.startsWith('todo.')) return <ClipboardList size={14} className="text-[var(--brand)]" />;
    return <Bell size={14} className="text-subtle" />;
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-sunken hover:text-ink transition-colors duration-150 cursor-pointer">
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute top-1 right-1 grid min-w-[16px] h-4 place-items-center rounded-full
                           bg-[var(--negative)] px-1 text-[10px] font-semibold text-white tabular">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-[min(23rem,calc(100vw-2rem))] card shadow-[var(--shadow-lg)] animate-in z-30 overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-line">
            <p className="text-[13.5px] font-semibold text-ink">Notifications</p>
            {unread > 0 && (
              <button onClick={markAll} className="text-[12px] text-[var(--brand)] hover:underline cursor-pointer">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[26rem] overflow-y-auto">
            {items.length === 0 ? (
              <EmptyState compact icon={<Bell size={18} />} title="Nothing new" message="Alerts about due work, escalations and payments land here." />
            ) : items.map((n: any) => (
              <button key={n.id} onClick={() => openItem(n)}
                className={cx('w-full text-left px-3.5 py-2.5 border-b border-line last:border-0 row-hover cursor-pointer flex gap-2.5',
                  !n.read_at && 'bg-brand-soft/40')}>
                <span className="mt-0.5 shrink-0">{iconFor(n.event_key)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink leading-snug">{n.title}</span>
                  {n.body && <span className="block text-[12px] text-subtle leading-snug mt-0.5 line-clamp-2">{n.body}</span>}
                  <span className="block text-[11px] text-subtle mt-1">{relative(n.created_at)}</span>
                </span>
                {!n.read_at && <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--brand)] shrink-0" aria-hidden />}
              </button>
            ))}
          </div>
          <PushToggle />
          <div className="border-t border-line px-3.5 py-2">
            <Link to="/notifications" onClick={() => setOpen(false)}
              className="text-[12.5px] text-[var(--brand)] hover:underline">
              View delivery log and preferences
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
