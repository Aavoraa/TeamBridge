import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  House, SquareCheckBig, Users2, FileText, Receipt, Wallet, BookOpenCheck, BarChart3, Settings, Bell, Menu, X, LogOut,
  Sun, Moon, Search, ShieldCheck, ChevronDown, CreditCard, Clock, AlertTriangle, Target, CheckCircle2, FolderKanban,
  Megaphone, MessagesSquare, Contact, FileSpreadsheet, History, Send, Landmark, ClipboardList, Sparkles, AudioLines,
  Video, CalendarPlus, LogIn, CalendarClock, CalendarDays, ListChecks, Building2, UserRound, ArrowRight, MessageSquare,
  SquareUser, Presentation, LayoutDashboard,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { PushBanner, PushToggle, usePushMessages } from './PushControls';
import { api } from '../lib/api';
import { isNative, store } from '../lib/storage';
import { Wordmark } from './Logo';
import { applyStatusBarTheme } from '../lib/native';
import { Avatar, Badge, Button, cx, EmptyState } from './ui';
import VoiceTaskButton from './VoiceTaskButton';
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
type BadgeKind = 'overdue' | 'approvals' | 'chat' | 'reimb_manager' | 'reimb_finance';
type NavItem = {
  to: string; label: string; icon?: any;
  /** Hidden unless the caller can view this module. */
  module?: string;
  /** Hidden unless the caller can take this action on `module`. */
  action?: string;
  /** Match the path exactly. Needed wherever one nav path prefixes another. */
  exact?: boolean;
  badge?: BadgeKind;
  superAdmin?: boolean;
};
/** A top-level entry: a page of its own, or a section that opens to show its pages. */
type NavGroup = { label: string; icon: any } & ({ item: NavItem; children?: never } | { item?: never; children: NavItem[] });

/**
 * The design's ten sections. Every page of the app sits under one of them, so
 * the sidebar stays short while nothing becomes harder to reach. A section the
 * user can see only one page of is drawn as a plain link to that page.
 */
const NAV: NavGroup[] = [
  { label: 'Dashboard', icon: House, item: { to: '/', label: 'Dashboard', exact: true } },
  { label: 'Calendar', icon: CalendarDays, item: { to: '/calendar', label: 'Office calendar' } },
  { label: 'Projects', icon: FolderKanban, item: { to: '/projects', label: 'Projects', module: 'projects' } },
  {
    label: 'Tasks', icon: SquareCheckBig, children: [
      { to: '/action-items', label: 'Action items', icon: ListChecks, module: 'action_items', badge: 'overdue' },
      { to: '/deadlines', label: 'Deadlines', icon: Clock, module: 'deadlines' },
    ],
  },
  {
    label: 'CRM', icon: SquareUser, children: [
      // The register first, the pipeline second: you look up who a client is far
      // more often than you move a deal between stages.
      { to: '/clients', label: 'Clients', icon: Contact, module: 'crm' },
      { to: '/crm', label: 'Pipeline', icon: Users2, module: 'crm' },
      { to: '/proposals', label: 'Proposals', icon: FileText, module: 'proposals' },
      { to: '/marketing', label: 'Marketing leads', icon: Megaphone, module: 'crm' },
    ],
  },
  {
    label: 'Finance', icon: Wallet, children: [
      { to: '/invoices', label: 'Invoices', icon: Receipt, module: 'invoices' },
      // Exact: /finance/reimbursements/* is a different area entirely.
      { to: '/finance', label: 'Cost & profit', icon: Wallet, module: 'costs', exact: true },
      { to: '/finance/reimbursements/new', label: 'New reimbursement', icon: Send, module: 'reimbursements', action: 'create' },
      { to: '/finance/reimbursements', label: 'My reimbursements', icon: Receipt, module: 'reimbursements', exact: true },
      { to: '/finance/reimbursements/approvals', label: 'Pending approvals', icon: ShieldCheck, module: 'reimbursements', action: 'approve', badge: 'reimb_manager' },
      { to: '/finance/reimbursements/review', label: 'Finance review', icon: Landmark, module: 'reimbursement_finance', badge: 'reimb_finance' },
      { to: '/finance/reimbursements/history', label: 'Reimbursement history', icon: History, module: 'reimbursements' },
      { to: '/finance/reimbursements/reports', label: 'Expense reports', icon: FileSpreadsheet, module: 'reimbursements', action: 'export' },
    ],
  },
  {
    label: 'HR', icon: Users2, children: [
      { to: '/hr', label: 'HR & attendance', icon: Building2, module: 'hr_attendance', badge: 'approvals' },
      { to: '/team', label: 'Team', icon: Users2, module: 'employees' },
    ],
  },
  {
    // Live internal meetings and what comes out of them, plus the client MOM log.
    label: 'Meetings', icon: Presentation, children: [
      { to: '/ai-meetings', label: 'Meetings dashboard', icon: Video, module: 'meetings', exact: true },
      { to: '/ai-meetings/schedule', label: 'Schedule meeting', icon: CalendarPlus, module: 'meetings', action: 'create' },
      { to: '/ai-meetings/join', label: 'Join meeting', icon: LogIn, module: 'meetings' },
      { to: '/ai-meetings/upcoming', label: 'Upcoming', icon: CalendarClock, module: 'meetings' },
      { to: '/ai-meetings/history', label: 'History', icon: History, module: 'meetings' },
      { to: '/meetings', label: 'Meetings & MOM', icon: CalendarDays, module: 'meetings' },
      { to: '/meeting-intel', label: 'AI Meeting Intelligence', icon: AudioLines, module: 'meeting_intelligence', exact: true },
      { to: '/meeting-intel?tab=pending', label: 'Task approvals', icon: ListChecks, module: 'meeting_intelligence', action: 'approve' },
    ],
  },
  { label: 'Chat', icon: MessageSquare, item: { to: '/chat', label: 'Chat', module: 'chat', badge: 'chat' } },
  {
    label: 'Reports', icon: BarChart3, children: [
      { to: '/reports', label: 'Reports', icon: BarChart3, module: 'reports' },
      { to: '/dashboard', label: 'Traction dashboard', icon: Target, module: 'dashboard' },
      { to: '/sop', label: 'SOP & KPI library', icon: BookOpenCheck, module: 'sop' },
    ],
  },
  {
    label: 'Settings', icon: Settings, children: [
      { to: '/settings', label: 'Workspace settings', icon: Settings, module: 'settings' },
      { to: '/billing', label: 'Billing & plan', icon: CreditCard, module: 'billing' },
      { to: '/profile', label: 'My profile', icon: UserRound },
      { to: '/admin', label: 'Platform console', icon: ShieldCheck, superAdmin: true },
    ],
  },
];

/** Is this page the one open? A link with a query (?tab=pending) matches only with that query. */
function matches(item: NavItem, pathname: string, search: string) {
  const [path, query] = item.to.split('?');
  if (query) return pathname === path && new URLSearchParams(search).toString().includes(query);
  if (item.exact) return pathname === path;
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Within a section, the one item to mark: a query match beats a plain one, a longer path beats a shorter. */
function activeOf(items: NavItem[], pathname: string, search: string) {
  const hits = items.filter((i) => matches(i, pathname, search));
  return hits.sort((a, b) => Number(b.to.includes('?')) - Number(a.to.includes('?')) || b.to.length - a.to.length)[0] || null;
}

/* =================================================================== SHELL */
export default function Layout() {
  const { signOut } = useAuth();
  const { dark, toggle } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  usePushMessages();

  return (
    <div className="min-h-full flex bg-surface">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* ------------------------------------------------------------- main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar onMenu={() => setSidebarOpen(true)} dark={dark} toggleTheme={toggle} signOut={signOut} />
        <main className="flex-1 min-w-0 px-4 pt-3 pb-10 sm:px-8 max-w-[1600px] w-full mx-auto">
          <PushBanner />
          <Outlet />
        </main>
        <TodoReminders />
      </div>
    </div>
  );
}

/**
 * The side navigation. A permanent column on a wide screen and a slide-in drawer
 * on a narrow one; the phone shell (/m) passes `drawerOnly` so it stays a drawer
 * at every width, since that shell has no room reserved for a column.
 */
export function Sidebar({ open: drawerOpen, onClose, drawerOnly }: {
  open: boolean; onClose: () => void; drawerOnly?: boolean;
}) {
  const { user, subscription, can, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Going somewhere closes the drawer (it stays open if the path did not change).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { closeRef.current(); }, [location.pathname, location.search]);

  // Android's back button closes the drawer before it leaves the page (lib/native.ts).
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onBack = (e: Event) => { e.preventDefault(); closeRef.current(); };
    window.addEventListener('phoenixx:back', onBack);
    return () => window.removeEventListener('phoenixx:back', onBack);
  }, [drawerOpen]);

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

  const badgeFor = (kind?: BadgeKind) => {
    if (kind === 'overdue') return counters.overdue || 0;
    if (kind === 'approvals') return approvalCount;
    if (kind === 'chat') return counters.chat || 0;
    if (kind === 'reimb_manager') return claimQueues?.manager_pending || 0;
    if (kind === 'reimb_finance') return (claimQueues?.finance_pending || 0) + (claimQueues?.awaiting_payment || 0);
    return 0;
  };

  const isSuperAdmin = user?.role === 'super_admin';
  // The same permission the API enforces decides whether an entry is drawn.
  // Hiding it is a courtesy; the server refuses the call either way.
  const visible = (item: NavItem) => (item.superAdmin ? isSuperAdmin : !item.module || can(item.module, item.action || 'view'));

  // Which sections are open: the one holding the current page always is.
  const [open, setOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(store.get('tb.nav.open') || '{}'); } catch { return {}; } });
  useEffect(() => { store.set('tb.nav.open', JSON.stringify(open)); }, [open]);

  const plan = String(subscription?.plan_name || '');
  const showUpgrade = can('billing', 'view') && (subscription?.status === 'trial' || !/pro|enterprise|business|scale|premium/i.test(plan));

  // In the app "/" is the phone Home, so the entries for it differ: Home and the
  // dashboard are separate pages, and Chat opens the phone's own chat. No upgrade
  // pitch in the drawer either: there is little height to spare on a phone.
  const phoneShell = !!drawerOnly || isNative;
  const entries: NavGroup[] = phoneShell
    ? [
      { label: 'Home', icon: House, item: { to: '/m', label: 'Home', exact: true } },
      { label: 'Dashboard', icon: LayoutDashboard, item: { to: '/overview', label: 'Dashboard' } },
      ...NAV.filter((g) => g.label !== 'Dashboard').map((g) => (g.label === 'Chat' && g.item
        ? { ...g, item: { ...g.item, to: '/m/chat' } } : g)),
    ]
    : NAV;

  return (
    <>
      {drawerOpen && (
        <div className={cx('fixed inset-0 z-30 bg-slate-950/40', !drawerOnly && 'lg:hidden')} onClick={onClose} aria-hidden />
      )}

      <aside className={cx(
        'fixed inset-y-0 left-0 z-40 w-[264px] shrink-0 border-r border-line bg-raised',
        'flex flex-col transition-transform duration-200 no-print',
        !drawerOnly && 'lg:translate-x-0 lg:sticky lg:top-0 lg:h-screen',
        drawerOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="flex items-center justify-between px-7 h-[84px] shrink-0">
          <Link to={phoneShell ? '/m' : '/'} aria-label="TeamBridge home" onClick={onClose}><Wordmark size={34} /></Link>
          <button className={cx('text-subtle hover:text-ink cursor-pointer', !drawerOnly && 'lg:hidden')} onClick={onClose} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-4 pb-4" aria-label="Main">
          <ul className="space-y-1">
            {entries.map((group) => {
              if (group.item) {
                if (!visible(group.item)) return null;
                const active = matches(group.item, location.pathname, location.search);
                return (
                  <li key={group.label}>
                    <NavRow to={group.item.to} icon={group.icon} label={group.label} active={active} count={badgeFor(group.item.badge)}
                      urgent={group.item.badge === 'overdue'} />
                  </li>
                );
              }
              const items = group.children.filter(visible);
              if (!items.length) return null;
              const current = activeOf(items, location.pathname, location.search);
              // One page in the section: the section is that page.
              if (items.length === 1) {
                return (
                  <li key={group.label}>
                    <NavRow to={items[0].to} icon={group.icon} label={group.label} active={!!current}
                      count={badgeFor(items[0].badge)} urgent={items[0].badge === 'overdue'} />
                  </li>
                );
              }
              const isOpen = open[group.label] ?? !!current;
              const total = items.reduce((a, i) => a + badgeFor(i.badge), 0);
              return (
                <li key={group.label}>
                  <button type="button" onClick={() => setOpen((o) => ({ ...o, [group.label]: !isOpen }))} aria-expanded={isOpen}
                    className={cx(
                      'flex w-full items-center gap-3.5 rounded-xl px-4 py-2.5 text-[15px] transition-colors duration-150 cursor-pointer',
                      current && !isOpen ? 'bg-brand-soft text-[var(--brand)] font-medium' : current ? 'text-[var(--brand)] font-medium' : 'text-muted hover:bg-sunken hover:text-ink',
                    )}>
                    <group.icon size={20} strokeWidth={1.8} className="shrink-0" />
                    <span className="flex-1 truncate text-left">{group.label}</span>
                    {!isOpen && total > 0 && <Count n={total} urgent={items.some((i) => i.badge === 'overdue' && badgeFor('overdue') > 0)} />}
                    <ChevronDown size={16} className={cx('shrink-0 text-subtle transition-transform duration-200', isOpen && 'rotate-180')} />
                  </button>
                  {isOpen && (
                    <ul className="mt-0.5 mb-1.5 ml-[26px] space-y-0.5 border-l border-line pl-3">
                      {items.map((i) => {
                        const on = current === i;
                        const n = badgeFor(i.badge);
                        return (
                          <li key={i.to}>
                            <Link to={i.to} aria-current={on ? 'page' : undefined}
                              className={cx('flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] transition-colors duration-150',
                                on ? 'bg-brand-soft text-[var(--brand)] font-medium' : 'text-subtle hover:bg-sunken hover:text-ink')}>
                              <span className="flex-1 truncate">{i.label}</span>
                              {n > 0 && <Count n={n} urgent={i.badge === 'overdue'} />}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        {showUpgrade && !phoneShell && (
          <div className="mx-4 mb-4 rounded-2xl bg-sunken px-4 py-5 text-center">
            <Sparkles size={24} className="mx-auto text-[var(--brand-vivid)]" fill="currentColor" strokeWidth={1.2} />
            <p className="mt-2.5 text-[16px] font-semibold tracking-[-0.01em] text-ink">
              {subscription?.status === 'trial' ? 'Trial in progress' : 'Upgrade to Pro'}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-subtle">
              {subscription?.status === 'trial' && subscription?.trial_ends_at
                ? `Ends ${relative(subscription.trial_ends_at)}. Choose a plan to keep everything running.`
                : 'Unlock advanced features for your whole team.'}
            </p>
            <Button variant="accent" className="mt-3.5 w-full justify-center" onClick={() => navigate('/billing')}>
              {subscription?.status === 'trial' ? 'Choose a plan' : 'Upgrade Now'} <ArrowRight size={15} />
            </Button>
          </div>
        )}

        <UserCard signOut={signOut} />
      </aside>
    </>
  );
}

function Count({ n, urgent }: { n: number; urgent?: boolean }) {
  return (
    <span className={cx('rounded-full px-1.5 text-[11px] font-semibold tabular leading-[18px] min-w-[18px] text-center',
      urgent ? 'bg-[var(--negative)] text-white' : 'bg-brand-soft text-[var(--brand)]')}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

function NavRow({ to, icon: Icon, label, active, count, urgent }: {
  to: string; icon: any; label: string; active: boolean; count: number; urgent?: boolean;
}) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined}
      className={cx('flex items-center gap-3.5 rounded-xl px-4 py-2.5 text-[15px] transition-colors duration-150',
        active ? 'bg-brand-soft text-[var(--brand)] font-medium' : 'text-muted hover:bg-sunken hover:text-ink')}>
      <Icon size={20} strokeWidth={active ? 2.1 : 1.8} className="shrink-0" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.14 : 0} />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && <Count n={count} urgent={urgent} />}
    </Link>
  );
}

/** The person signed in, at the foot of the sidebar - opens their menu. */
function UserCard({ signOut }: { signOut: () => void }) {
  const { user, tenant, can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  return (
    <div className="relative border-t border-line px-4 py-3.5" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
        className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-sunken transition-colors cursor-pointer">
        <Avatar name={user?.name} url={user?.avatar_url} size={36} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[14.5px] font-medium text-ink">{user?.name}</span>
          <span className="block truncate text-[12.5px] text-subtle capitalize">{user?.role?.replace('_', ' ')}</span>
        </span>
        <ChevronDown size={16} className={cx('shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-4 right-4 mb-2 card p-1.5 shadow-[var(--shadow-lg)] animate-in z-30">
          <div className="px-3 py-2 border-b border-line mb-1">
            <p className="text-[13px] text-subtle truncate">{user?.email}</p>
            {tenant && <p className="text-[12px] text-subtle truncate mt-0.5">{tenant.name}</p>}
          </div>
          <MenuButton onClick={() => { setOpen(false); navigate('/profile'); }}>Profile & notifications</MenuButton>
          {can('settings', 'view') && <MenuButton onClick={() => { setOpen(false); navigate('/settings'); }}>Workspace settings</MenuButton>}
          <MenuButton danger onClick={signOut}><LogOut size={14} /> Sign out</MenuButton>
        </div>
      )}
    </div>
  );
}

function MenuButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors cursor-pointer',
        danger ? 'text-[var(--negative)] hover:bg-negative-soft' : 'text-muted hover:bg-sunken hover:text-ink')}>
      {children}
    </button>
  );
}

/* ================================================================= TOPBAR */
function TopBar({ onMenu, dark, toggleTheme, signOut }: {
  onMenu: () => void; dark: boolean; toggleTheme: () => void; signOut: () => void;
}) {
  const { user, tenant, can } = useAuth();
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
    <header className="sticky top-0 z-20 flex h-[84px] items-center gap-3 bg-surface/90 backdrop-blur px-4 sm:px-8 no-print">
      <button onClick={onMenu} aria-label="Open navigation"
        className="lg:hidden text-muted hover:text-ink transition-colors cursor-pointer p-2 -ml-2 rounded-lg">
        <Menu size={22} />
      </button>

      <GlobalSearch />

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
        <VoiceTaskButton />

        <NotificationBell open={bellOpen} setOpen={setBellOpen} />

        <button onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}
          className="grid h-10 w-10 place-items-center rounded-full text-ink hover:bg-sunken transition-colors duration-150 cursor-pointer">
          {dark ? <Moon size={21} strokeWidth={1.8} /> : <Sun size={22} strokeWidth={1.8} />}
        </button>

        <div className="relative" ref={menuRef}>
          <button onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen} aria-haspopup="menu" aria-label="Your account"
            className="flex items-center gap-1.5 rounded-full p-1 pr-1.5 hover:bg-sunken transition-colors duration-150 cursor-pointer">
            <Avatar name={user?.name} url={user?.avatar_url} size={36} />
            <ChevronDown size={16} className="text-ink hidden sm:block" />
          </button>

          {menuOpen && (
            <div role="menu"
              className="absolute right-0 mt-2 w-64 card p-1.5 shadow-[var(--shadow-lg)] animate-in z-30">
              <div className="px-3 py-2.5 border-b border-line mb-1">
                <p className="text-[14px] font-medium text-ink truncate">{user?.name}</p>
                <p className="text-[12.5px] text-subtle truncate">{user?.email}</p>
                {tenant && <p className="text-[12px] text-subtle mt-1 truncate">{tenant.name}</p>}
              </div>
              <MenuButton onClick={() => { setMenuOpen(false); navigate('/profile'); }}>Profile & notifications</MenuButton>
              {can('settings', 'view') && <MenuButton onClick={() => { setMenuOpen(false); navigate('/settings'); }}>Workspace settings</MenuButton>}
              <MenuButton danger onClick={signOut}><LogOut size={14} /> Sign out</MenuButton>
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
    <div className="relative flex-1 max-w-[590px]" ref={boxRef}>
      <Search size={19} strokeWidth={1.8} className="absolute left-5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search anything... (⌘ + K)"
        aria-label="Search clients and tasks"
        className="h-12 w-full rounded-full border border-transparent bg-[color-mix(in_srgb,var(--surface-sunken)_85%,var(--border))] pl-12 pr-5 text-[14.5px] text-ink
                   placeholder:text-subtle transition-[background-color,border-color,box-shadow] duration-150 focus:outline-none focus:bg-raised focus:border-line-strong focus:shadow-[var(--shadow-md)]"
      />

      {open && q.trim().length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-2 card p-1.5 shadow-[var(--shadow-lg)] max-h-[70vh] overflow-y-auto animate-in z-30">
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
        className="relative grid h-10 w-10 place-items-center rounded-full text-ink hover:bg-sunken transition-colors duration-150 cursor-pointer">
        <Bell size={22} strokeWidth={1.8} />
        {/* The design's red dot; the number is in the label for screen readers and in the panel. */}
        {unread > 0 && <span className="absolute top-2 right-2.5 h-2.5 w-2.5 rounded-full bg-[var(--negative)] ring-2 ring-[var(--surface)]" aria-hidden />}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(24rem,calc(100vw-2rem))] card shadow-[var(--shadow-lg)] animate-in z-30 overflow-hidden">
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
