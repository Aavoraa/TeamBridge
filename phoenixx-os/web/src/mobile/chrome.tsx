/**
 * The app bar's two permanent controls, Teams-style: the profile avatar on the
 * left and the overflow menu on the right.
 *
 * Both sheets are mounted once by the shell rather than per screen, so tapping
 * the avatar on Home and on HR opens the same sheet in the same state. Screens
 * reach them through this context instead of each holding their own copy.
 */
import { ReactNode, createContext, useContext, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3, BookOpenCheck, Building2, CalendarDays, ChevronRight, Clock, CreditCard, FileText,
  FolderKanban, Globe, ListChecks, LogOut, Moon, Receipt, Settings, ShieldCheck, Sun, Target,
  Users2, Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTheme } from '../components/Layout';
import { avatarColor, initials } from '../lib/format';
import { Sheet } from './sheet';

type Chrome = { openProfile: () => void; openMore: () => void };

const ChromeContext = createContext<Chrome>({ openProfile: () => {}, openMore: () => {} });
export const useChrome = () => useContext(ChromeContext);

/**
 * Everything the web app has that is worth reaching from a phone, in the same
 * grouping the desktop sidebar uses so the two do not have to be learned twice.
 * `module` is checked against the caller's permissions — an employee never sees
 * an invoices row they would only be refused at.
 */
const MORE: { section: string; items: { to: string; label: string; icon: any; module?: string }[] }[] = [
  {
    section: 'Work',
    items: [
      { to: '/action-items', label: 'All action items', icon: ListChecks, module: 'action_items' },
      { to: '/meetings', label: 'Meetings & MOM', icon: CalendarDays, module: 'meetings' },
      { to: '/deadlines', label: 'Deadlines', icon: Clock, module: 'deadlines' },
    ],
  },
  {
    section: 'Clients',
    items: [
      { to: '/crm', label: 'CRM pipeline', icon: Users2, module: 'crm' },
      { to: '/proposals', label: 'Proposals', icon: FileText, module: 'proposals' },
      { to: '/projects', label: 'Projects & teams', icon: FolderKanban, module: 'crm' },
    ],
  },
  {
    section: 'Money',
    items: [
      { to: '/invoices', label: 'Invoices', icon: Receipt, module: 'invoices' },
      { to: '/finance', label: 'Cost & profit', icon: Wallet, module: 'costs' },
    ],
  },
  {
    section: 'People',
    items: [
      { to: '/hr', label: 'HR records', icon: Building2, module: 'hr_attendance' },
      { to: '/team', label: 'Team directory', icon: Users2, module: 'employees' },
    ],
  },
  {
    section: 'Standards & insight',
    items: [
      { to: '/sop', label: 'SOP & KPI', icon: BookOpenCheck, module: 'sop' },
      { to: '/dashboard', label: 'Traction dashboard', icon: Target, module: 'dashboard' },
      { to: '/reports', label: 'Reports', icon: BarChart3, module: 'reports' },
    ],
  },
  {
    section: 'Workspace',
    items: [
      { to: '/settings', label: 'Settings', icon: Settings, module: 'settings' },
      { to: '/billing', label: 'Billing & plan', icon: CreditCard, module: 'billing' },
      { to: '/admin', label: 'Platform console', icon: ShieldCheck, module: 'platform' },
    ],
  },
];

export function MobileChrome({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState(false);
  const [more, setMore] = useState(false);

  const value = useMemo<Chrome>(() => ({
    openProfile: () => setProfile(true),
    openMore: () => setMore(true),
  }), []);

  return (
    <ChromeContext.Provider value={value}>
      {children}
      <ProfileSheet open={profile} onClose={() => setProfile(false)} />
      <MoreSheet open={more} onClose={() => setMore(false)} />
    </ChromeContext.Provider>
  );
}

/* ------------------------------------------------------------ the avatar */

export function ProfileButton() {
  const { user } = useAuth();
  const { openProfile } = useChrome();
  const name = user?.name || '?';

  return (
    <button
      type="button" onClick={openProfile} aria-label="Your profile and settings"
      className="h-10 w-10 shrink-0 overflow-hidden rounded-full active:scale-95 transition-transform duration-100"
    >
      {user?.avatar_url
        ? <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
        : (
          <span
            className="flex h-full w-full items-center justify-center text-[13px] font-semibold text-white"
            style={{ background: avatarColor(name) }}
          >
            {initials(name)}
          </span>
        )}
    </button>
  );
}

/* -------------------------------------------------------- the ⋮ control */

export function MenuButton() {
  const { openMore } = useChrome();
  return (
    <button
      type="button" onClick={openMore} aria-label="More"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink active:bg-sunken"
    >
      {/* Three dots drawn rather than imported so they match Teams' spacing. */}
      <span className="flex flex-col items-center gap-[3px]">
        <span className="block h-[3.5px] w-[3.5px] rounded-full bg-current" />
        <span className="block h-[3.5px] w-[3.5px] rounded-full bg-current" />
        <span className="block h-[3.5px] w-[3.5px] rounded-full bg-current" />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- profile */

function ProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, tenant, subscription, signOut } = useAuth();
  const { dark, toggle } = useTheme();
  const nav = useNavigate();
  const name = user?.name || '?';

  const go = (to: string) => { onClose(); nav(to); };

  return (
    <Sheet open={open} onClose={onClose} title="You">
      <div className="flex items-center gap-3">
        <span
          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full
                     text-[18px] font-semibold text-white"
          style={{ background: avatarColor(name) }}
        >
          {user?.avatar_url
            ? <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
            : initials(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[16px] font-semibold text-ink">{name}</p>
          <p className="truncate text-[13px] text-subtle">{user?.email}</p>
          <p className="mt-0.5 text-[12px] capitalize text-subtle">
            {user?.designation || user?.role}
            {tenant?.name ? ` · ${tenant.name}` : ''}
          </p>
        </div>
      </div>

      <div className="card divide-y divide-[var(--border)] overflow-hidden">
        <button type="button" onClick={toggle}
          className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-3 text-left active:bg-sunken">
          {dark ? <Sun size={18} className="text-subtle" /> : <Moon size={18} className="text-subtle" />}
          <span className="flex-1 text-[15px] text-ink">{dark ? 'Light mode' : 'Dark mode'}</span>
        </button>

        <button type="button" onClick={() => go('/profile')}
          className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-3 text-left active:bg-sunken">
          <Settings size={18} className="text-subtle" />
          <span className="flex-1 text-[15px] text-ink">Profile & preferences</span>
          <ChevronRight size={17} className="text-subtle" />
        </button>

        <button type="button" onClick={() => go('/')}
          className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-3 text-left active:bg-sunken">
          <Globe size={18} className="text-subtle" />
          <span className="flex-1 text-[15px] text-ink">Open the full app</span>
          <ChevronRight size={17} className="text-subtle" />
        </button>
      </div>

      {subscription?.plan_name && (
        <p className="px-1 text-[12px] text-subtle">
          {tenant?.name} is on the {subscription.plan_name} plan.
        </p>
      )}

      <button
        type="button"
        onClick={() => { onClose(); signOut?.(); }}
        className="flex w-full min-h-[52px] items-center justify-center gap-2 rounded-lg border
                   border-[var(--negative)] text-[15px] font-semibold text-[var(--negative)] active:bg-negative-soft"
      >
        <LogOut size={18} />
        Sign out
      </button>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- more */

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();

  const sections = MORE
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.module || can?.(i.module, 'view')) }))
    .filter((s) => s.items.length > 0);

  const go = (to: string) => { onClose(); nav(to); };

  return (
    <Sheet open={open} onClose={onClose} title="More">
      <p className="text-[12.5px] leading-relaxed text-subtle">
        The four tabs cover the day-to-day. Everything else from the web app opens here in its full
        view — use the back button to come back.
      </p>

      {sections.map((s) => (
        <div key={s.section} className="space-y-2">
          <p className="label-cap px-0.5">{s.section}</p>
          <div className="card divide-y divide-[var(--border)] overflow-hidden">
            {s.items.map(({ to, label, icon: Icon }) => (
              <button
                key={to} type="button" onClick={() => go(to)}
                className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-3 text-left active:bg-sunken"
              >
                <Icon size={18} className="shrink-0 text-subtle" />
                <span className="flex-1 truncate text-[15px] text-ink">{label}</span>
                <ChevronRight size={17} className="shrink-0 text-subtle" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </Sheet>
  );
}
