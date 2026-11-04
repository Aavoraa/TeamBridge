/**
 * Mobile V2 shell.
 *
 * Four tabs, Teams-style, chosen for what someone actually opens the app to do:
 * see what is on them today, talk to the team, check the day's meetings and
 * follow-ups, and mark themselves in or out. Everything else stays on the web
 * app — this complements it rather than reproducing it.
 *
 * Reached at /m. It is the whole app inside the Capacitor shell (App.tsx sends
 * native launches straight here) and is browsable at /m on a desktop, which is
 * how it gets tested without a device.
 */
import { Suspense, lazy } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { CalendarDays, House, MessagesSquare, UserCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cx } from '../components/ui';
import { MobileChrome } from './chrome';
import { Loading } from './ui';
import TodoReminders from '../components/TodoReminders';

const MHome = lazy(() => import('./screens/Home'));
const MChat = lazy(() => import('./screens/Chat'));
const MToday = lazy(() => import('./screens/Today'));
const MHR = lazy(() => import('./screens/HR'));

/**
 * One request behind Home, Today and the HR check-in state. Shared by tab via
 * this query key, so switching tabs costs nothing and a mutation anywhere
 * refreshes all three at once.
 */
export const HOME_KEY = ['m', 'home'];

export function useHomeFeed() {
  return useQuery({
    queryKey: HOME_KEY,
    queryFn: () => api.get('/dashboard/home').then((r) => r.data),
    staleTime: 30_000,
  });
}

const TABS = [
  { to: '/m', end: true, label: 'Home', icon: House },
  { to: '/m/chat', label: 'Chat', icon: MessagesSquare },
  { to: '/m/today', label: 'Today', icon: CalendarDays },
  { to: '/m/hr', label: 'HR', icon: UserCheck },
];

function TabBar({ chatUnread }: { chatUnread: number }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-raised pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary"
    >
      <div className="mx-auto flex max-w-lg">
        {TABS.map(({ to, end, label, icon: Icon }) => (
          <NavLink
            key={to} to={to} end={end}
            className={({ isActive }) => cx(
              'relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 min-h-[58px]',
              'text-[11px] font-medium transition-colors duration-150',
              isActive ? 'text-brand' : 'text-subtle',
            )}
          >
            {({ isActive }) => (
              <>
                <span className="relative">
                  <Icon size={21} strokeWidth={isActive ? 2.4 : 1.9} />
                  {label === 'Chat' && chatUnread > 0 && (
                    <span
                      className="absolute -right-2 -top-1.5 min-w-[17px] rounded-full bg-[var(--negative)] px-1
                                 text-center text-[10px] font-bold leading-[17px] text-white"
                      aria-label={`${chatUnread} unread`}
                    >
                      {chatUnread > 99 ? '99+' : chatUnread}
                    </span>
                  )}
                </span>
                {label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export default function MobileApp() {
  const { data } = useHomeFeed();
  const chatUnread = Number(data?.counters?.chat || 0);

  return (
    <MobileChrome>
    <div className="min-h-screen bg-surface pb-[calc(58px+env(safe-area-inset-bottom))]">
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route index element={<MHome />} />
          <Route path="chat" element={<MChat />} />
          <Route path="chat/:channelId" element={<MChat />} />
          <Route path="today" element={<MToday />} />
          <Route path="hr" element={<MHR />} />
          <Route path="*" element={<Navigate to="/m" replace />} />
        </Routes>
      </Suspense>
      <TabBar chatUnread={chatUnread} />
      <TodoReminders />
    </div>
    </MobileChrome>
  );
}
