/**
 * Notifications - everything the bell holds, as a tab of its own.
 *
 * Newest first, grouped by day, unread marked. A tap marks it read and opens
 * the page it is about (the same link a phone notification carries). A phone
 * notification arriving while this is open refreshes it (lib/phonePush.ts).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Bell, CalendarClock, CheckCheck, ClipboardCheck, MessagesSquare, ShieldCheck, Users2, Wallet,
} from 'lucide-react';
import { api } from '../../lib/api';
import { cx, useToast } from '../../components/ui';
import { HOME_KEY } from '../MobileApp';
import { Empty, ErrorNote, Loading, MButton, Screen } from '../ui';

const PAGE = 40;

/** A glance at what kind of thing it is, from the event that raised it. */
function kindOf(eventKey = '') {
  if (/escalat|stall|overdue|breach|blocked/.test(eventKey)) return { icon: AlertTriangle, tone: 'text-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)]' };
  if (/^chat|mention/.test(eventKey)) return { icon: MessagesSquare, tone: 'text-[var(--info)] bg-[color-mix(in_srgb,var(--info)_12%,transparent)]' };
  if (/meeting/.test(eventKey)) return { icon: CalendarClock, tone: 'text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]' };
  if (/request|approv|leave|validat/.test(eventKey)) return { icon: ShieldCheck, tone: 'text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]' };
  if (/reimburs|invoice|payment/.test(eventKey)) return { icon: Wallet, tone: 'text-[var(--positive)] bg-[color-mix(in_srgb,var(--positive)_12%,transparent)]' };
  if (/join|user|team/.test(eventKey)) return { icon: Users2, tone: 'text-brand bg-brand-soft' };
  if (/action_item|task|todo|deadline/.test(eventKey)) return { icon: ClipboardCheck, tone: 'text-brand bg-brand-soft' };
  return { icon: Bell, tone: 'text-subtle bg-sunken' };
}

const dayKey = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

export default function MNotifications() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['notifications', 'm', unreadOnly, limit],
    queryFn: () => api.get<any>('/notifications', { limit, ...(unreadOnly ? { unread: 'true' } : {}) }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const items: any[] = data?.data || [];
  const unread = Number(data?.meta?.unread || 0);
  const total = Number(data?.meta?.total || items.length);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: HOME_KEY });
  };
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => { toast.success('All caught up.'); refresh(); },
    onError: (e: any) => toast.error(e.message),
  });

  const groups = useMemo(() => {
    const out: { label: string; rows: any[] }[] = [];
    for (const n of items) {
      const last = out[out.length - 1];
      if (last && dayKey(last.rows[0].created_at) === dayKey(n.created_at)) last.rows.push(n);
      else out.push({ label: dayLabel(n.created_at), rows: [n] });
    }
    return out;
  }, [items]);

  const open = (n: any) => {
    if (!n.read_at) markRead.mutate(n.id);
    if (typeof n.link === 'string' && n.link.startsWith('/')) navigate(n.link);
  };

  return (
    <Screen title="Notifications" subtitle={unread ? `${unread} unread` : 'You are all caught up'}>
      <div className="flex items-center gap-2">
        {[{ id: false, label: 'All' }, { id: true, label: `Unread${unread ? ` (${unread})` : ''}` }].map((f) => (
          <button key={String(f.id)} type="button" onClick={() => { setUnreadOnly(f.id); setLimit(PAGE); }}
            className={cx('min-h-[36px] rounded-full px-3.5 text-[13px] font-medium transition-colors',
              unreadOnly === f.id ? 'bg-brand-soft text-brand' : 'bg-sunken text-subtle')}>
            {f.label}
          </button>
        ))}
        <span className="flex-1" />
        {unread > 0 && (
          <button type="button" onClick={() => readAll.mutate()} disabled={readAll.isPending}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-brand active:bg-brand-soft">
            <CheckCheck size={16} /> Read all
          </button>
        )}
      </div>

      {error ? <ErrorNote error={error} retry={refetch} />
        : isLoading ? <Loading />
          : !items.length ? (
            <Empty icon={<Bell size={22} />} title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
              message="New tasks, approvals, meetings and messages show up here." />
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <section key={g.label} className="space-y-2">
                  <h2 className="label-cap px-0.5">{g.label}</h2>
                  <div className="card divide-y divide-line overflow-hidden">
                    {g.rows.map((n) => {
                      const { icon: Icon, tone } = kindOf(n.event_key);
                      return (
                        <button key={n.id} type="button" onClick={() => open(n)}
                          className={cx('flex w-full items-start gap-3 px-3.5 py-3 text-left active:bg-sunken',
                            !n.read_at && 'bg-[color-mix(in_srgb,var(--brand)_4%,transparent)]')}>
                          <span className={cx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full', tone)}>
                            <Icon size={17} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-start gap-2">
                              <span className={cx('min-w-0 flex-1 text-[14.5px] leading-snug text-ink line-clamp-2',
                                !n.read_at ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                              <span className="shrink-0 pt-0.5 text-[11.5px] text-subtle tabular-nums">{timeOf(n.created_at)}</span>
                            </span>
                            {n.body && <span className="mt-0.5 text-[13px] leading-snug text-muted line-clamp-2">{n.body}</span>}
                          </span>
                          {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]" aria-label="Unread" />}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
              {items.length < total && limit < 200 && (
                <MButton full loading={isFetching} onClick={() => setLimit((l) => l + PAGE)}>Show older</MButton>
              )}
            </div>
          )}
    </Screen>
  );
}
