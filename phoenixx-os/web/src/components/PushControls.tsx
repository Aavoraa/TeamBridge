import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, X } from 'lucide-react';
import { api } from '../lib/api';
import { store } from '../lib/storage';
import { pushState, enablePush, disablePush, pushSupported, PUSH_CHANGED } from '../lib/push';
import { Button, useToast } from './ui';

/**
 * Chrome pop-ups for every notification. The banner invites each person once;
 * the bell menu holds the on/off switch and a test button for later.
 */

const DISMISS_KEY = 'phoenixx.pushPromptDismissed';

export function usePushState() {
  const qc = useQueryClient();
  useEffect(() => {
    const refresh = () => qc.invalidateQueries({ queryKey: ['push-state'] });
    window.addEventListener(PUSH_CHANGED, refresh);
    return () => window.removeEventListener(PUSH_CHANGED, refresh);
  }, [qc]);
  return useQuery({ queryKey: ['push-state'], queryFn: pushState, enabled: pushSupported(), staleTime: 60_000 });
}

function usePushToggle() {
  const qc = useQueryClient();
  const toast = useToast();
  const on = useMutation({
    mutationFn: enablePush,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['push-state'] }); toast.success('Chrome pop-ups are on for this browser.'); },
    onError: (e: any) => { qc.invalidateQueries({ queryKey: ['push-state'] }); toast.error(e.message); },
  });
  const off = useMutation({
    mutationFn: disablePush,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['push-state'] }); toast.success('Chrome pop-ups are off for this browser.'); },
  });
  const test = useMutation({
    mutationFn: () => api.post('/notifications/push/test'),
    onSuccess: () => toast.success('Test sent. It should pop up in a moment.'),
    onError: (e: any) => toast.error(e.message),
  });
  return { on, off, test };
}

/** Pop-up clicks and arrivals, relayed by the service worker to an open tab. */
export function usePushMessages() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    if (!pushSupported()) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'phoenixx:notification') qc.invalidateQueries({ queryKey: ['notifications'] });
      if (e.data?.type === 'phoenixx:navigate' && e.data.url) {
        const u = new URL(e.data.url);
        navigate(`${u.pathname}${u.search}`);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate, qc]);
}

/** A one-time invitation under the top bar, until it is accepted or dismissed. */
export function PushBanner() {
  const { data } = usePushState();
  const { on } = usePushToggle();
  const [dismissed, setDismissed] = useState(() => {
    try { return store.get(DISMISS_KEY) === '1'; } catch { return false; }
  });
  if (!data?.supported || !data.configured || data.permission !== 'default' || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { store.set(DISMISS_KEY, '1'); } catch { /* private mode: it just shows again next time */ }
  };
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--brand)]/30 bg-brand-soft/50 px-4 py-3">
      <BellRing size={18} className="text-[var(--brand)] shrink-0" />
      <p className="min-w-0 flex-1 text-[13.5px] text-muted">
        <span className="text-ink font-medium">Get a Chrome pop-up for every notification</span>
        {' '}— Advance Planner reminders, approvals, comments and more, even when Phoenixx OS is closed.
      </p>
      <Button size="sm" variant="primary" loading={on.isPending} onClick={() => on.mutate()}>Turn on pop-ups</Button>
      <button onClick={dismiss} aria-label="Not now" className="text-subtle hover:text-ink cursor-pointer"><X size={16} /></button>
    </div>
  );
}

/** The switch inside the bell menu. */
export function PushToggle() {
  const { data } = usePushState();
  const { on, off, test } = usePushToggle();
  if (!data?.supported || !data.configured) return null;

  if (data.permission === 'denied') {
    return (
      <p className="px-3.5 py-2 border-t border-line text-[12px] text-subtle">
        Chrome pop-ups are blocked for this site. Click the icon left of the address bar → Notifications → Allow.
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-t border-line text-[12.5px]">
      <span className="flex items-center gap-1.5 text-muted">
        <BellRing size={13} /> Chrome pop-ups {data.subscribed ? <span className="text-[var(--positive)] font-medium">on</span> : 'off'}
      </span>
      {data.subscribed ? (
        <span className="flex gap-3">
          <button onClick={() => test.mutate()} disabled={test.isPending} className="text-[var(--brand)] hover:underline cursor-pointer">Send a test</button>
          <button onClick={() => off.mutate()} disabled={off.isPending} className="text-subtle hover:text-ink cursor-pointer">Turn off</button>
        </span>
      ) : (
        <button onClick={() => on.mutate()} disabled={on.isPending} className="text-[var(--brand)] font-medium hover:underline cursor-pointer">Turn on</button>
      )}
    </div>
  );
}
