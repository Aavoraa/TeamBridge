import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle, ArrowRight, BarChart3, Bell, CalendarCheck, CheckCircle2, Clock, IndianRupee, Layers, ListChecks,
  MoreHorizontal, PencilLine, Receipt, Users2, Check, Video, ClipboardList,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, relative } from '../lib/format';
import { Badge, Card, Delta, Skeleton, cx } from './ui';

/**
 * The top of the Dashboard, laid out as the TeamBridge design: Overview
 * Analytics, a trend chart, the sales funnel, recent activity and the
 * upcoming schedule. Every number is real - each block appears only for
 * people allowed to see what it is made from, and a person without business
 * figures sees their own work in the same frame instead.
 */
type Range = '1M' | '3M' | '6M' | '1Y';

export default function DashboardOverview({ home }: { home: any }) {
  const { can } = useAuth();
  const business = can('invoices', 'view') || can('crm', 'view') || can('proposals', 'view');
  const [range, setRange] = useState<Range>('1M');
  const q = useQuery({
    queryKey: ['dashboard', 'overview-analytics', range],
    queryFn: () => api.get<any>('/dashboard/overview-analytics', { range }).then((r) => r.data),
    enabled: business,
    placeholderData: (prev) => prev,
  });
  const a = q.data;
  const showFunnel = business && (q.isLoading || a?.funnel);
  const showChart = business && (q.isLoading || a?.series);

  return (
    <div className="space-y-6">
      <div className={cx('grid grid-cols-1 gap-6', showFunnel && 'xl:grid-cols-[minmax(0,1fr)_340px]')}>
        <div className="min-w-0 space-y-6">
          {business ? <AnalyticsCard a={a} loading={q.isLoading} /> : <PersonalCard c={home?.counters || {}} />}
          {showChart && <TrendCard a={a} range={range} setRange={setRange} loading={q.isLoading} fetching={q.isFetching} />}
        </div>
        {showFunnel && <FunnelCard f={a?.funnel} loading={q.isLoading} />}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)]">
        <RecentActivity />
        <UpcomingSchedule home={home} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ figures */
function Figure({ icon, hue, label, value, delta, deltaSuffix = '%', sub, to }: {
  icon: React.ReactNode; hue: string; label: string; value: React.ReactNode;
  delta?: number | null; deltaSuffix?: string; sub?: React.ReactNode; to?: string;
}) {
  const body = (
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in srgb, ${hue} 13%, transparent)`, color: hue }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="whitespace-nowrap text-[14px] text-subtle">{label}</p>
        <p className="mt-1 whitespace-nowrap text-[27px] leading-8 font-semibold tracking-[-0.03em] text-ink tabular">{value}</p>
        {delta != null ? <Delta value={delta} suffix={deltaSuffix} className="mt-2 whitespace-nowrap text-[12.5px]" />
          : sub ? <p className="mt-2 text-[12.5px] leading-snug text-subtle">{sub}</p> : null}
      </div>
    </div>
  );
  return to ? <Link to={to} className="block rounded-xl -m-2 p-2 hover:bg-sunken/60 transition-colors">{body}</Link> : body;
}

const GREEN = 'var(--brand-vivid)';
const ORANGE = '#f59e0b';
const BLUE = '#2563eb';

function AnalyticsCard({ a, loading }: { a: any; loading: boolean }) {
  const cur = a?.currency;
  const figures = !a ? [] : [
    a.revenue && <Figure key="rev" icon={<BarChart3 size={20} strokeWidth={2.2} />} hue={GREEN} label="Total revenue"
      value={money(a.revenue.value, { compact: true, cur })} delta={a.revenue.change} to="/finance"
      sub="no payments last month to compare" />,
    a.conversion && <Figure key="conv" icon={<Users2 size={20} strokeWidth={2.2} />} hue={GREEN} label="Conversion rate"
      value={a.conversion.value == null ? '—' : `${a.conversion.value}%`} delta={a.conversion.change} deltaSuffix=" pts" to="/proposals"
      sub="no proposals sent in 30 days" />,
    a.leads && <Figure key="leads" icon={<Check size={20} strokeWidth={2.6} />} hue={ORANGE} label="Active leads"
      value={a.leads.value.toLocaleString('en-IN')} delta={a.leads.change} to="/crm"
      sub={`${a.leads.new_this_period} new in 30 days`} />,
    a.pipeline && <Figure key="pipe" icon={<Layers size={20} strokeWidth={2.2} />} hue={BLUE} label="Pipeline value"
      value={money(a.pipeline.value, { compact: true, cur })} to="/crm" sub={`${a.pipeline.deals} open deal${a.pipeline.deals === 1 ? '' : 's'}`} />,
  ].filter(Boolean);
  return (
    <Card className="px-6 pt-5 pb-6">
      <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Overview Analytics</h2>
      {loading ? <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div> : (
        <div className={cx('mt-5 grid grid-cols-1 gap-y-6 sm:grid-cols-2', figures.length >= 4 ? 'lg:grid-cols-4' : figures.length === 3 ? 'lg:grid-cols-3' : '')}>
          {figures.map((f, i) => (
            <div key={i} className={cx('min-w-0 lg:px-4 2xl:px-6', i > 0 && 'lg:border-l lg:border-line', i === 0 && 'lg:pl-0')}>{f}</div>
          ))}
        </div>
      )}
      <p className="mt-5 text-[12px] text-subtle">Last 30 days compared with the 30 days before.</p>
    </Card>
  );
}

/** For people without business figures: their own work, in the same frame. */
function PersonalCard({ c }: { c: any }) {
  return (
    <Card className="px-6 pt-5 pb-6">
      <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Your work today</h2>
      <div className="mt-5 grid grid-cols-1 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {[
          <Figure key="o" icon={<AlertTriangle size={19} strokeWidth={2.2} />} hue={c.overdue ? 'var(--negative)' : GREEN} label="Overdue"
            value={c.overdue ?? 0} sub={c.overdue ? 'needs attention now' : 'nothing overdue'} to="/action-items?overdue=true" />,
          <Figure key="d" icon={<Clock size={19} strokeWidth={2.2} />} hue={GREEN} label="Due today" value={c.due_today ?? 0} sub="tasks" to="/action-items" />,
          <Figure key="p" icon={<ListChecks size={19} strokeWidth={2.2} />} hue={ORANGE} label="In progress" value={c.in_progress ?? 0} sub="tasks" to="/action-items?status=in_progress" />,
          <Figure key="u" icon={<PencilLine size={19} strokeWidth={2.2} />} hue={BLUE} label="Needs update" value={c.needs_update ?? 0}
            sub={c.needs_update ? 'not written up today' : 'all written up'} to="/action-items?tab=updates" />,
        ].map((f, i) => <div key={i} className={cx('min-w-0 lg:px-4 2xl:px-6', i > 0 && 'lg:border-l lg:border-line', i === 0 && 'lg:pl-0')}>{f}</div>)}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- trend */
const RANGE_LABEL: Record<Range, string> = { '1M': 'last 30 days', '3M': 'last 3 months', '6M': 'last 6 months', '1Y': 'last 12 months' };

function TrendCard({ a, range, setRange, loading, fetching }: {
  a: any; range: Range; setRange: (r: Range) => void; loading: boolean; fetching: boolean;
}) {
  const s = a?.series;
  const fmtTick = (iso: string) => {
    const d = new Date(iso);
    return s?.unit === 'month' ? d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })
      : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const data = (s?.points || []).map((p: any) => ({ ...p, label: fmtTick(p.start) }));
  return (
    <Card className="px-6 pt-5 pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-8 w-8 place-items-center text-[var(--info)]"><BarChart3 size={22} strokeWidth={2.2} /></span>
        <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Revenue</h2>
        <div className="ml-auto flex items-center gap-1" role="tablist" aria-label="Period">
          {(['1M', '3M', '6M', '1Y'] as Range[]).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => setRange(r)}
              className={cx('rounded-full px-4 py-1.5 text-[14px] font-medium transition-colors cursor-pointer',
                range === r ? 'bg-brand-soft text-[var(--brand)]' : 'text-muted hover:bg-sunken hover:text-ink')}>
              {r}
            </button>
          ))}
          <Link to="/finance" aria-label="Open cost and profit" title="Open cost & profit"
            className="ml-1 grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-sunken hover:text-ink"><MoreHorizontal size={20} /></Link>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2.5">
        <span className="text-[26px] font-semibold tracking-[-0.03em] text-ink tabular">{s ? money(s.total, { compact: true, cur: a.currency }) : '—'}</span>
        {s?.change != null && (
          <span className={cx('inline-flex items-center gap-0.5 rounded-full px-2.5 py-0.5 text-[13px] font-medium',
            s.change >= 0 ? 'bg-positive-soft text-[var(--positive)]' : 'bg-negative-soft text-[var(--negative)]')}>
            {s.change >= 0 ? '↑' : '↓'} {Math.abs(s.change)}%
          </span>
        )}
        <span className="text-[13px] text-subtle">collected, {RANGE_LABEL[range]}</span>
      </div>
      <div className={cx('mt-3 h-[260px] transition-opacity', fetching && !loading && 'opacity-60')}>
        {loading ? <Skeleton className="h-full" /> : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="tb-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ORANGE} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={ORANGE} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" vertical horizontal />
              <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} dy={8} />
              <YAxis tickLine={false} axisLine={false} width={56}
                tickFormatter={(v) => money(v, { compact: true, cur: a?.currency }).replace(/\.0(?=\D*$)/, '')} />
              <Tooltip
                formatter={(v: any, name: any) => [money(Number(v), { cur: a?.currency }), name === 'current' ? 'This period' : 'Period before']}
                labelFormatter={(l) => l}
                contentStyle={{ fontSize: 13 }}
              />
              <Line type="monotone" dataKey="previous" stroke="var(--border-strong)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="current" stroke={ORANGE} strokeWidth={2.5} fill="url(#tb-area)"
                dot={false} activeDot={{ r: 5, fill: ORANGE, stroke: 'var(--surface-raised)', strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-1 flex items-center gap-4 text-[12.5px] text-subtle">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full" style={{ background: ORANGE }} /> This period</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-[var(--border-strong)]" /> The period before</span>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------- funnel */
const FUNNEL_HUES = ['#4fb077', '#7aa7f5', '#f6ad55', '#8fd3a8', '#9dbcf7'];

function FunnelCard({ f, loading }: { f: any; loading: boolean }) {
  const top = f?.steps?.[0]?.value || 0;
  return (
    <Card className="flex flex-col px-6 pt-5 pb-6">
      <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Sales Funnel</h2>
      <p className="mt-1 text-[14px] text-subtle">Conversion at each stage</p>
      {loading ? <Skeleton className="mt-6 h-64" /> : !top ? (
        <p className="mt-6 text-[13.5px] text-subtle">No leads in the last 12 months.</p>
      ) : (
        <>
          <ul className="mt-6 space-y-5">
            {f.steps.map((s: any, i: number) => {
              const pct = Math.round((s.value / top) * 100);
              return (
                <li key={s.key}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[15px] text-ink">{s.label}</span>
                    <span className="tabular text-[15px] text-ink">{s.value.toLocaleString('en-IN')}
                      <span className="ml-2 text-[13px] text-subtle">({pct}%)</span></span>
                  </div>
                  <div className="mt-2 h-2.5 rounded-full bg-sunken overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={s.label}>
                    <div className="h-full rounded-full" style={{ width: `${Math.max(pct, s.value ? 4 : 0)}%`, background: FUNNEL_HUES[i % FUNNEL_HUES.length] }} />
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto pt-8">
            <div className="flex items-center justify-between border-t border-line pt-5">
              <span className="text-[15px] text-subtle">Conversion rate</span>
              <span className="text-[24px] font-semibold tracking-[-0.02em] text-[var(--positive)] tabular">{f.conversion == null ? '—' : `${f.conversion}%`}</span>
            </div>
            <p className="mt-1 text-[12px] text-subtle">Leads from the last 12 months, by the furthest step they reached.</p>
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ activity */
function activityIcon(key: string) {
  if (/paid|payment|invoice/.test(key)) return { icon: <IndianRupee size={17} strokeWidth={2.4} />, hue: GREEN };
  if (/meeting/.test(key)) return { icon: <CalendarCheck size={17} strokeWidth={2.2} />, hue: '#8b5cf6' };
  if (/overdue|escalation|reject/.test(key)) return { icon: <AlertTriangle size={17} strokeWidth={2.2} />, hue: 'var(--negative)' };
  if (/proposal|accepted/.test(key)) return { icon: <Receipt size={17} strokeWidth={2.2} />, hue: ORANGE };
  if (/todo|action_item|task/.test(key)) return { icon: <ClipboardList size={17} strokeWidth={2.2} />, hue: BLUE };
  return { icon: <Bell size={17} strokeWidth={2.2} />, hue: ORANGE };
}

function RecentActivity() {
  const q = useQuery({
    queryKey: ['notifications', 'dashboard'],
    queryFn: () => api.get<any>('/notifications', { limit: 5 }),
  });
  const items: any[] = (q.data as any)?.data || [];
  return (
    <Card className="px-6 pt-5 pb-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Recent Activity</h2>
        <Link to="/notifications" className="inline-flex items-center gap-1.5 text-[14.5px] text-[var(--info)] hover:underline">View All <ArrowRight size={15} /></Link>
      </div>
      {q.isLoading ? <Skeleton className="mt-5 h-40" /> : !items.length ? (
        <p className="py-8 text-[13.5px] text-subtle">Nothing yet. Assignments, approvals and payments show up here.</p>
      ) : (
        <ul className="mt-4">
          {items.map((n) => {
            const { icon, hue } = activityIcon(n.event_key || '');
            return (
              <li key={n.id}>
                <Link to={n.link || '/notifications'} className="-mx-3 flex items-center gap-3.5 rounded-xl px-3 py-3 hover:bg-sunken/70 transition-colors">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in srgb, ${hue} 13%, transparent)`, color: hue }}>{icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ink">{n.title}</span>
                    {n.body && <span className="block truncate text-[13.5px] text-subtle">{n.body}</span>}
                  </span>
                  <span className="shrink-0 text-[13px] text-subtle">{relative(n.created_at)}</span>
                  <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', n.read_at ? 'bg-[var(--border-strong)]' : 'bg-[var(--brand-vivid)]')}
                    title={n.read_at ? 'Read' : 'New'} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ schedule */
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();

function UpcomingSchedule({ home }: { home: any }) {
  const { can } = useAuth();
  const meetings = useQuery({
    queryKey: ['ai-meetings', 'dashboard'],
    queryFn: () => api.get<any>('/ai-meetings/dashboard').then((r) => r.data),
    enabled: can('meetings', 'view'),
  });
  const live = meetings.data?.live || [];
  const upcoming = meetings.data?.upcoming || [];
  type Entry = { id: string; at: string; end?: string; title: string; sub: string; tag: string; tone: 'brand' | 'info' | 'negative'; to: string };
  const entries: Entry[] = [
    ...live.map((m: any) => ({
      id: `l${m.id}`, at: m.scheduled_at, end: new Date(Date.parse(m.scheduled_at) + m.duration_minutes * 60_000).toISOString(),
      title: m.title, sub: m.project_name || m.client_name || m.department || 'Internal', tag: 'Live now', tone: 'negative' as const, to: `/ai-meetings/m/${m.id}`,
    })),
    ...upcoming.map((m: any) => ({
      id: `u${m.id}`, at: m.scheduled_at, end: new Date(Date.parse(m.scheduled_at) + m.duration_minutes * 60_000).toISOString(),
      title: m.title, sub: m.project_name || m.client_name || m.department || 'Internal', tag: 'Meeting', tone: 'brand' as const, to: `/ai-meetings/m/${m.id}`,
    })),
    ...(home?.meetings || []).map((m: any) => ({
      id: `c${m.id}`, at: m.scheduled_at, end: m.duration_minutes ? new Date(Date.parse(m.scheduled_at) + m.duration_minutes * 60_000).toISOString() : undefined,
      title: m.title, sub: m.client_name || m.location || 'Client meeting', tag: 'Meeting', tone: 'brand' as const, to: '/meetings',
    })),
    ...(home?.today_items || []).filter((t: any) => t.due_at && Date.parse(t.due_at) > Date.now()).map((t: any) => ({
      id: `t${t.id}`, at: t.due_at, title: t.title, sub: t.client_name || t.category_name || 'Task due',
      tag: t.validation_status === 'pending' ? 'Review' : 'Task', tone: 'info' as const, to: `/action-items?open=${t.id}`,
    })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).slice(0, 4);

  return (
    <Card className="px-6 pt-5 pb-4">
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg text-[var(--info)]"><CalendarCheck size={22} strokeWidth={2} /></span>
        <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Upcoming Schedule</h2>
        {can('meetings', 'view') && (
          <Link to="/calendar" className="ml-auto inline-flex items-center gap-1.5 text-[14.5px] text-[var(--info)] hover:underline">View Calendar <ArrowRight size={15} /></Link>
        )}
      </div>
      {meetings.isLoading ? <Skeleton className="mt-5 h-40" /> : !entries.length ? (
        <p className="py-8 text-[13.5px] text-subtle">Nothing coming up this week.</p>
      ) : (
        <ol className="relative mt-5 ml-1.5 border-l-2 border-[color-mix(in_srgb,var(--info)_22%,transparent)]">
          {entries.map((e) => {
            const sameDay = new Date(e.at).toDateString() === new Date().toDateString();
            return (
              <li key={e.id} className="relative pb-4 pl-7 last:pb-1">
                <span className="absolute -left-[7px] top-1.5 h-3 w-3 rounded-full bg-[var(--info)] ring-4 ring-[var(--surface-raised)]" aria-hidden />
                <Link to={e.to} className="-mx-2 flex items-start gap-3 rounded-xl px-2 py-1 hover:bg-sunken/70 transition-colors">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] text-subtle tabular">
                      {!sameDay && `${new Date(e.at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · `}
                      {hhmm(e.at)}{e.end ? ` – ${hhmm(e.end)}` : ''}
                    </span>
                    <span className="block truncate text-[15.5px] font-medium text-ink">{e.title}</span>
                    <span className="block truncate text-[13.5px] text-subtle">{e.sub}</span>
                  </span>
                  <Badge tone={e.tone} className="mt-1 px-3.5 py-1 text-[13px]">
                    {e.tag === 'Live now' ? <Video size={12} /> : e.tag === 'Review' ? <CheckCircle2 size={12} /> : null}{e.tag}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
