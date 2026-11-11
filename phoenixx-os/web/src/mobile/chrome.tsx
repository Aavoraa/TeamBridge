/**
 * The app bar's permanent controls: the side navigation and the profile avatar.
 * The drawer and the profile sheet are mounted once by the shell rather than per
 * screen, so every tab opens the same ones in the same state. Screens reach them
 * through this context instead of each holding their own copy.
 */
import { ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Globe, LogOut, Menu, Settings } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { isNative } from '../lib/storage';
import { Sidebar, useTheme } from '../components/Layout';
import { useStockPhoto, avatarTint, photoUrl } from '../lib/avatar';
import { Sheet } from './sheet';

type Chrome = { openProfile: () => void; openNav: () => void };

const ChromeContext = createContext<Chrome>({ openProfile: () => {}, openNav: () => {} });
export const useChrome = () => useContext(ChromeContext);

export function MobileChrome({ children }: { children: ReactNode }) {
  useTheme(); // light only, status bar included
  const [profile, setProfile] = useState(false);
  const [nav, setNav] = useState(false);

  const closeNav = useCallback(() => setNav(false), []);
  const value = useMemo<Chrome>(() => ({
    openProfile: () => setProfile(true),
    openNav: () => setNav(true),
  }), []);

  return (
    <ChromeContext.Provider value={value}>
      {children}
      <ProfileSheet open={profile} onClose={() => setProfile(false)} />
      <Sidebar drawerOnly open={nav} onClose={closeNav} />
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
        ? <img src={photoUrl(user.avatar_url) || undefined} alt="" className="h-full w-full object-cover" />
        : (
          <span className="block h-full w-full" style={{ background: avatarTint(name) }}>
            <Drawn name={name} />
          </span>
        )}
    </button>
  );
}

/* ------------------------------------------------- the side navigation */

export function MenuButton() {
  const { openNav } = useChrome();
  return (
    <button
      type="button" onClick={openNav} aria-label="Open navigation"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink active:bg-sunken"
    >
      <Menu size={22} />
    </button>
  );
}

/* ------------------------------------------------------------- profile */

function ProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, tenant, subscription, signOut } = useAuth();
  const navigate = useNavigate();
  const name = user?.name || '?';

  const go = (to: string) => { onClose(); navigate(to); };

  return (
    <Sheet open={open} onClose={onClose} title="You">
      <div className="flex items-center gap-3">
        <span
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full"
          style={{ background: avatarTint(name) }}
        >
          {user?.avatar_url
            ? <img src={photoUrl(user.avatar_url) || undefined} alt="" className="h-full w-full object-cover" />
            : <Drawn name={name} />}
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
        <button type="button" onClick={() => go('/profile')}
          className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-3 text-left active:bg-sunken">
          <Settings size={18} className="text-subtle" />
          <span className="flex-1 text-[15px] text-ink">Profile & preferences</span>
          <ChevronRight size={17} className="text-subtle" />
        </button>

        {/* In the installed app "/" is this shell, and everything is under More. */}
        {!isNative && (
          <button type="button" onClick={() => go('/')}
            className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-3 text-left active:bg-sunken">
            <Globe size={18} className="text-subtle" />
            <span className="flex-1 text-[15px] text-ink">Open the full app</span>
            <ChevronRight size={17} className="text-subtle" />
          </button>
        )}
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

/** A stock photo from the pool, or soft initials when there is none. */
function Drawn({ name }: { name?: string | null }) {
  const src = useStockPhoto(name);
  return src
    ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} loading="lazy" />
    : <span className="grid h-full w-full place-items-center text-[13px] font-semibold text-[#44403c]">{(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>;
}
