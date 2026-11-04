import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  Users2, Wallet, Building2, Receipt, TrendingUp, AlertTriangle, Lightbulb,
  RefreshCw, ChevronRight, Target, ArrowUpRight, Check,
} from 'lucide-react';
import { api } from '../lib/api';
import { money, num, percent, monthLabel, date } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, Drawer, EmptyState, ErrorState, Meter,
  PageHeader, Select, Skeleton, Stat, Table, TD, TH, THead, TR, useToast, cx, StatusBadge,
} from '../components/ui';

/**
 * Module H — the Overview Traction Dashboard.
 * Five pillars, lagging indicators, auto-surfaced improvement flags, and a
 * drill-down from every widget to the records underneath it (H4).
 */

const SERIES = ['#1e40af', '#3b82f6', '#f59e0b', '#0f766e', '#7c3aed', '#be185d'];

export default function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [compare, setCompare] = useState<'mom' | 'qoq'>('mom');
  const [drill, setDrill] = useState<{ key: string; title: string } | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'overview', month, compare],
    queryFn: () => api.get('/dashboard/overview', { month, compare }).then((r) => r.data),
  });

  const refresh = useMutation({
    mutationFn: () => api.post('/dashboard/improvement-flags/refresh'),
    onSuccess: () => {
      toast.success('Improvement flags recomputed.');
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <DashboardSkeleton />;

  const { clients, revenue, hr, cost, profit, lagging, improvement_flags: flags, trend } = data;

  return (
    <>
      <PageHeader
        title="Overview traction"
        subtitle={`${monthLabel(month)} · compared with ${compare === 'qoq' ? 'the quarter before' : 'last month'}`}
        actions={
          <>
            <Select value={compare} onChange={(e) => setCompare(e.target.value as any)}
              aria-label="Comparison period" className="w-[132px]">
              <option value="mom">Month on month</option>
              <option value="qoq">Quarter on quarter</option>
            </Select>
            <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Period" className="w-[136px]">
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
            <Button icon={<RefreshCw size={15} className={refresh.isPending ? 'animate-spin' : ''} />}
              onClick={() => refresh.mutate()} loading={refresh.isPending}>
              Recompute
            </Button>
          </>
        }
      />

      {/* ================================================== H2 lagging bar */}
      {(lagging.overdue_action_items > 0 || lagging.open_escalations > 0 || lagging.overdue_invoices > 0
        || lagging.leads_without_next_action > 0) && (
        <Card className="mb-6 overflow-hidden border-l-[3px] border-l-[var(--negative)]
                         bg-[linear-gradient(90deg,var(--negative-soft),transparent_45%)]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-negative-soft text-[var(--negative)]">
                <AlertTriangle size={14} />
              </span>
              Lagging indicators
            </div>
            <LaggingChip label="overdue items" value={lagging.overdue_action_items}
              onClick={() => setDrill({ key: 'overdue_items', title: 'Overdue action items' })} />
            <LaggingChip label="open escalations" value={lagging.open_escalations}
              onClick={() => setDrill({ key: 'open_escalations', title: 'Open escalations' })} />
            <LaggingChip label="overdue invoices" value={lagging.overdue_invoices}
              onClick={() => setDrill({ key: 'overdue_invoices', title: 'Overdue invoices' })} />
            <LaggingChip label="leads with no next action" value={lagging.leads_without_next_action}
              onClick={() => setDrill({ key: 'leads_without_next_action', title: 'Leads without a next action' })} />
            <div className="ml-auto flex items-center gap-2 text-[12.5px] text-subtle">
              <span>Escalation SLA</span>
              {lagging.escalation_sla_pct == null ? (
                <Badge tone="neutral">no data yet</Badge>
              ) : (
                <Badge tone={lagging.escalation_sla_pct >= 90 ? 'positive' : lagging.escalation_sla_pct >= 75 ? 'warning' : 'negative'}>
                  {percent(lagging.escalation_sla_pct)}
                </Badge>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* =================================================== H1 five pillars */}
      <SectionLabel>The five pillars</SectionLabel>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-6">
        {/* The sparklines show what `trend` actually carries — new clients won
            per month, not a running headcount, so the shape is not misread. */}
        <Stat label="Active clients" value={num(clients.active.value)} icon={<Users2 size={15} />}
          accent="#3b82f6" spark={trend.map((t: any) => t.new_clients)}
          delta={{ value: clients.active.change, suffix: '' }}
          sub={`${clients.total_leads} leads · ${percent(clients.conversion_ratio)} conversion`}
          onClick={() => setDrill({ key: 'active_clients', title: 'Active clients' })} />

        <Stat label="Revenue" value={money(revenue.revenue.value, { compact: true })} icon={<TrendingUp size={15} />}
          accent="var(--brand)" spark={trend.map((t: any) => t.revenue_minor)}
          delta={{ value: revenue.revenue.change_pct }}
          sub={`MRR ${money(revenue.mrr_minor, { compact: true })} · collected ${money(revenue.collected_minor, { compact: true })}`}
          onClick={() => setDrill({ key: 'revenue', title: `Revenue · ${monthLabel(month)}` })} />

        {/* No sparkline here: `trend` carries no headcount series, and plotting
            completion % under a headcount label would just mislead. */}
        <Stat label="Headcount" value={num(hr.headcount)} icon={<Building2 size={15} />}
          accent="#7c3aed"
          sub={`${percent(hr.attendance_pct)} attendance · ${percent(hr.utilization_pct)} utilised`}
          onClick={() => setDrill({ key: 'headcount', title: 'Team' })} />

        <Stat label="Cost" value={money(cost.total.value, { compact: true })} icon={<Wallet size={15} />}
          accent="var(--accent-bg)" spark={trend.map((t: any) => t.cost_minor)}
          delta={{ value: cost.total.change_pct, invert: true }}
          sub={`HR ${money(cost.hr_cost_minor, { compact: true })} · tools ${money(cost.tools_cost_minor, { compact: true })}`}
          onClick={() => setDrill({ key: 'costs', title: `Costs · ${monthLabel(month)}` })} />

        <Stat label="Gross profit" value={money(profit.gross_profit.value, { compact: true })} icon={<Target size={15} />}
          accent={profit.margin_pct.value >= 35 ? 'var(--positive)' : 'var(--warning)'}
          spark={trend.map((t: any) => t.profit_minor)}
          delta={{ value: profit.gross_profit.change_pct }}
          sub={`${percent(profit.margin_pct.value)} margin (${profit.margin_pct.change >= 0 ? '+' : ''}${profit.margin_pct.change} pts)`}
          onClick={() => navigate('/finance?tab=profitability')} />
      </div>

      <SectionLabel>Money and momentum</SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3 mb-6">
        {/* ------------------------------------------------ revenue & cost */}
        <Card className="lg:col-span-2">
          <CardHeader title="Revenue, cost and profit" subtitle="Last six months"
            icon={<TrendingUp size={16} />}
            action={<Button size="sm" onClick={() => navigate('/finance?tab=profitability')}>Profitability</Button>} />
          <div className="p-4 pt-3">
            <ResponsiveContainer width="100%" height={252}>
              <AreaChart data={trend} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1e40af" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#1e40af" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.24} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tickFormatter={(m) => monthLabel(m).split(' ')[0]} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(v) => money(v, { compact: true })} tickLine={false} axisLine={false} width={62} />
                <Tooltip content={<ChartTooltip formatter={(v: number) => money(v)} labelFormatter={monthLabel} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                <Area type="monotone" dataKey="revenue_minor" name="Revenue" stroke="#1e40af" strokeWidth={2} fill="url(#gRev)" />
                <Area type="monotone" dataKey="cost_minor" name="Cost" stroke="#f59e0b" strokeWidth={2} fill="url(#gCost)" />
                <Line type="monotone" dataKey="profit_minor" name="Gross profit" stroke="#0f766e" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* ------------------------------------------------- H3 flags */}
        <Card>
          <CardHeader title="Improvement flags" subtitle="Weak points surfaced automatically"
            icon={<Lightbulb size={16} />} />
          {!flags?.length ? (
            <EmptyState compact icon={<Check size={18} className="text-[var(--positive)]" />}
              title="Nothing flagged" message="No weak points detected in the current data." />
          ) : (
            <ul className="divide-y divide-[var(--border)] max-h-[260px] overflow-y-auto">
              {flags.map((f: any) => (
                <li key={f.id}>
                  <button onClick={() => f.drill_path && navigate(f.drill_path)}
                    className="w-full text-left px-4 py-3 row-hover cursor-pointer group">
                    <div className="flex items-start gap-2.5">
                      <span className={cx('mt-1.5 h-2 w-2 rounded-full shrink-0',
                        f.severity === 'high' ? 'bg-[var(--negative)]'
                          : f.severity === 'medium' ? 'bg-[var(--warning)]' : 'bg-[var(--ink-subtle)]')} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium text-ink leading-snug group-hover:text-[var(--brand)] transition-colors">
                          {f.title}
                        </span>
                        <span className="block text-[12.5px] text-subtle mt-0.5 leading-snug">{f.detail}</span>
                      </span>
                      <ChevronRight size={14} className="mt-1 text-subtle shrink-0 group-hover:text-[var(--brand)] transition-colors" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <SectionLabel>Pipeline and mix</SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3 mb-6">
        {/* --------------------------------------------------- pipeline */}
        <Card className="lg:col-span-2">
          <CardHeader title="Pipeline by stage" subtitle={`${money(clients.pipeline_value_minor, { compact: true })} in flight`}
            icon={<Users2 size={16} />}
            action={<Button size="sm" onClick={() => navigate('/crm')}>Open CRM</Button>} />
          <div className="p-4 pt-3">
            <ResponsiveContainer width="100%" height={228}>
              <BarChart data={clients.pipeline} margin={{ top: 4, right: 6, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0}
                  tick={{ fontSize: 10.5 }} angle={-18} textAnchor="end" height={48} />
                <YAxis tickFormatter={(v) => money(v, { compact: true })} tickLine={false} axisLine={false} width={62} />
                <Tooltip cursor={{ fill: 'var(--surface-sunken)' }}
                  content={<ChartTooltip formatter={(v: number) => money(v)} extra={(p: any) => `${p.count} client${p.count === 1 ? '' : 's'}`} />} />
                <Bar dataKey="value_minor" name="Pipeline value" radius={[4, 4, 0, 0]}>
                  {clients.pipeline.map((_: any, i: number) => (
                    <Cell key={i} fill={SERIES[i % SERIES.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* ------------------------------------------- revenue by service line */}
        <Card>
          <CardHeader title="Revenue by service line" subtitle={monthLabel(month)} icon={<Receipt size={16} />} />
          {revenue.by_service_line.every((s: any) => !s.value_minor) ? (
            <EmptyState compact title="No revenue this month" message="Invoices issued this month will appear here." />
          ) : (
            <>
              <div className="p-4 pb-0">
                <ResponsiveContainer width="100%" height={168}>
                  <PieChart>
                    <Pie data={revenue.by_service_line.filter((s: any) => s.value_minor > 0)}
                      dataKey="value_minor" nameKey="name" cx="50%" cy="50%"
                      innerRadius={44} outerRadius={72} paddingAngle={2} strokeWidth={0}>
                      {revenue.by_service_line.map((s: any, i: number) => (
                        <Cell key={i} fill={s.color || SERIES[i % SERIES.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip formatter={(v: number) => money(v)} />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="px-4 pb-4 space-y-1.5">
                {revenue.by_service_line.filter((s: any) => s.value_minor > 0).map((s: any, i: number) => (
                  <li key={s.id} className="flex items-center gap-2 text-[13px]">
                    <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.color || SERIES[i % SERIES.length] }} aria-hidden />
                    <span className="text-muted truncate flex-1">{s.name}</span>
                    <span className="text-ink tabular font-medium">{money(s.value_minor, { compact: true })}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <SectionLabel>Accounts and delivery</SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3">
        {/* ----------------------------------------------- retention risk */}
        <Card className="lg:col-span-2">
          <CardHeader title="Clients at retention risk"
            subtitle="Flagged when retention drops below 50 or risk rises above 65"
            icon={<AlertTriangle size={16} />}
            action={<Button size="sm" onClick={() => navigate('/crm?retention_risk=true')}>View all</Button>} />
          {!clients.retention_risk?.length ? (
            <EmptyState compact icon={<Check size={18} className="text-[var(--positive)]" />}
              title="No clients at risk" message="Every active account is scoring healthily right now." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH align="right" width="90px">Health</TH>
                  <TH align="right" width="110px">Retention</TH>
                  <TH align="right" width="90px">Risk</TH>
                </tr>
              </THead>
              <tbody>
                {clients.retention_risk.map((c: any) => (
                  <TR key={c.id} onClick={() => navigate(`/crm/${c.id}`)}>
                    <TD className="font-medium">{c.name}</TD>
                    <TD align="right">
                      <span className={cx('tabular font-medium',
                        c.health_score >= 60 ? 'text-[var(--positive)]'
                          : c.health_score >= 40 ? 'text-[var(--warning)]' : 'text-[var(--negative)]')}>
                        {c.health_score}
                      </span>
                    </TD>
                    <TD align="right">
                      <div className="flex items-center gap-2 justify-end">
                        <Meter value={c.retention_score} tone={c.retention_score < 50 ? 'negative' : 'warning'} className="w-14" />
                        <span className="tabular w-8 text-right">{c.retention_score}</span>
                      </div>
                    </TD>
                    <TD align="right"><span className="tabular text-[var(--negative)]">{c.risk_score}</span></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {/* ------------------------------------------------ HR + completion */}
        <Card>
          <CardHeader title="Delivery & people" subtitle={monthLabel(month)} icon={<Building2 size={16} />} />
          <div className="p-4 space-y-4">
            <MeterRow label="Action item completion" value={hr.completion.value}
              delta={hr.completion.change} target={95} />
            <MeterRow label="Attendance" value={hr.attendance_pct} target={95} />
            <MeterRow label="Utilisation" value={hr.utilization_pct} target={75} />

            <div className="pt-2 border-t border-line grid grid-cols-2 gap-3">
              <div>
                <p className="label-cap">Open roles</p>
                <p className="mt-0.5 text-lg font-semibold text-ink tabular">{hr.open_roles}</p>
                <p className="text-[12px] text-subtle">{hr.candidates_in_pipeline} candidates in pipeline</p>
              </div>
              <div>
                <p className="label-cap">Avg hours / day</p>
                <p className="mt-0.5 text-lg font-semibold text-ink tabular">{hr.avg_work_hours}</p>
                <p className="text-[12px] text-subtle">{hr.pending_leave_requests} leave requests pending</p>
              </div>
            </div>

            <div className="pt-2 border-t border-line">
              <p className="label-cap mb-1.5">Receivables</p>
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-muted">Outstanding</span>
                <span className="tabular font-medium text-ink">{money(revenue.outstanding_minor)}</span>
              </div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="text-[13px] text-muted">Overdue</span>
                <span className={cx('tabular font-medium', revenue.overdue_minor > 0 ? 'text-[var(--negative)]' : 'text-ink')}>
                  {money(revenue.overdue_minor)}
                  {revenue.overdue_count > 0 && <span className="text-subtle font-normal"> · {revenue.overdue_count}</span>}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <DrillDownDrawer drill={drill} month={month} onClose={() => setDrill(null)} />
    </>
  );
}

/* ------------------------------------------------------------- fragments */

/** Quiet rule-and-label that gives the page its sections a rhythm. */
const SectionLabel = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="mb-2.5 flex items-center gap-3">
    <span className="label-cap shrink-0">{children}</span>
    <span className="h-px flex-1 bg-line" aria-hidden />
    {action}
  </div>
);

const LaggingChip = ({ label, value, onClick }: { label: string; value: number; onClick: () => void }) => (
  <button onClick={onClick} disabled={!value}
    className={cx('flex items-baseline gap-1.5 text-[13px] transition-colors duration-150 rounded px-1 -mx-1',
      value ? 'cursor-pointer hover:text-[var(--brand)] text-muted' : 'text-subtle cursor-default')}>
    <span className={cx('tabular font-semibold text-[15px]', value ? 'text-[var(--negative)]' : 'text-ink')}>{value}</span>
    <span>{label}</span>
  </button>
);

function MeterRow({ label, value, target, delta }: { label: string; value: number; target?: number; delta?: number }) {
  const tone = target ? (value >= target ? 'positive' : value >= target * 0.85 ? 'warning' : 'negative') : 'brand';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="tabular font-semibold text-ink">{percent(value)}</span>
          {delta != null && Math.abs(delta) >= 0.5 && (
            <span className={cx('text-[11.5px] tabular', delta > 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]')}>
              {delta > 0 ? '▲' : '▼'}{Math.abs(delta).toFixed(0)}
            </span>
          )}
        </span>
      </div>
      <Meter value={value} tone={tone as any} />
      {target && <p className="mt-1 text-[11.5px] text-subtle">Target {percent(target)}</p>}
    </div>
  );
}

function ChartTooltip({ active, payload, label, formatter, labelFormatter, extra }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 shadow-[var(--shadow-lg)] text-[12.5px]">
      {label != null && (
        <p className="font-medium text-ink mb-1">{labelFormatter ? labelFormatter(label) : label}</p>
      )}
      {payload.map((p: any, i: number) => (
        <p key={i} className="flex items-center gap-2 text-muted">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color || p.fill }} aria-hidden />
          <span>{p.name}</span>
          <span className="ml-auto tabular font-medium text-ink">
            {formatter ? formatter(p.value) : p.value}
          </span>
        </p>
      ))}
      {extra && payload[0]?.payload && (
        <p className="mt-1 pt-1 border-t border-line text-subtle">{extra(payload[0].payload)}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------- H4 drill-through */
function DrillDownDrawer({ drill, month, onClose }: {
  drill: { key: string; title: string } | null; month: string; onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['drilldown', drill?.key, month],
    queryFn: () => api.get(`/dashboard/drilldown/${drill!.key}`, { month }).then((r) => r.data),
    enabled: !!drill,
  });

  const linkFor = (row: any) => {
    if (drill?.key.includes('client') || drill?.key === 'retention_risk' || drill?.key === 'leads_without_next_action') return `/crm/${row.id}`;
    if (drill?.key === 'overdue_items') return `/action-items?open=${row.id}`;
    if (drill?.key.includes('invoice') || drill?.key === 'revenue') return `/invoices/${row.id}`;
    if (drill?.key === 'headcount') return `/team`;
    if (drill?.key === 'open_roles') return `/hr?tab=hiring`;
    return null;
  };

  const columns = (rows: any[]) => {
    if (!rows?.length) return [];
    const preferred = ['name', 'client_name', 'title', 'number', 'label', 'reason', 'to_name'];
    const numeric = ['total_minor', 'balance_minor', 'taxable_minor', 'amount_minor', 'mrr_minor', 'health_score', 'risk_score', 'retention_score'];
    const dates = ['due_date', 'issue_date', 'created_at', 'date_of_joining'];
    const keys = Object.keys(rows[0]).filter((k) => k !== 'id');
    return [
      ...preferred.filter((k) => keys.includes(k)),
      ...keys.filter((k) => !preferred.includes(k) && !k.endsWith('_id')).slice(0, 4),
    ].slice(0, 5).map((key) => ({
      key,
      numeric: numeric.includes(key),
      isDate: dates.includes(key),
      label: key.replace(/_minor$/, '').replace(/_/g, ' '),
    }));
  };

  const rows = data || [];
  const cols = columns(rows);

  return (
    <Drawer open={!!drill} onClose={onClose} title={drill?.title || ''}
      subtitle={`${rows.length} record${rows.length === 1 ? '' : 's'}`} width="max-w-3xl">
      {isLoading ? (
        <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : !rows.length ? (
        <EmptyState title="Nothing here" message="No records behind this number." />
      ) : (
        <Table>
          <THead>
            <tr>{cols.map((c) => <TH key={c.key} align={c.numeric ? 'right' : 'left'}>{c.label}</TH>)}</tr>
          </THead>
          <tbody>
            {rows.map((row: any, i: number) => {
              const link = linkFor(row);
              return (
                <TR key={row.id || i} onClick={link ? () => { onClose(); navigate(link); } : undefined}>
                  {cols.map((c) => (
                    <TD key={c.key} align={c.numeric ? 'right' : 'left'}>
                      {c.key.endsWith('_minor') ? money(row[c.key])
                        : c.isDate ? date(row[c.key])
                          : c.key === 'status' || c.key === 'stage' ? <StatusBadge status={row[c.key]} />
                            : String(row[c.key] ?? '—')}
                    </TD>
                  ))}
                </TR>
              );
            })}
          </tbody>
        </Table>
      )}
    </Drawer>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-56 mb-6" />
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-5">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[100px]" />)}
      </div>
      <div className="grid gap-5 lg:grid-cols-3 mb-5">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-72 lg:col-span-2" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
