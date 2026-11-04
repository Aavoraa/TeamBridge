import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ComposedChart, Line, Cell, PieChart, Pie,
} from 'recharts';
import {
  Plus, Wallet, TrendingUp, Download, RefreshCw, Trash2, Receipt, Building2, AlertTriangle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, monthLabel, percent, date, num, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Select, Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs, Textarea,
  useToast, cx, Meter,
} from '../components/ui';

const CATEGORY_COLORS: Record<string, string> = {
  hr: '#1e40af', tools: '#3b82f6', rent: '#f59e0b', maintenance: '#0f766e',
  marketing: '#7c3aed', misc: '#64748b',
};

/** Module F4–F5 — cost tracking, profitability and receivables. */
export default function Finance() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') || 'profitability');

  const setTabAndUrl = (id: string) => {
    setTab(id);
    const next = new URLSearchParams(params); next.set('tab', id); setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Cost & profitability"
        subtitle="Revenue minus allocated cost, by client, project, service line and company"
        tabs={
          <Tabs active={tab} onChange={setTabAndUrl} tabs={[
            { id: 'profitability', label: 'Profitability' },
            { id: 'costs', label: 'Costs' },
            { id: 'receivables', label: 'Receivables' },
            { id: 'projects', label: 'Projects' },
          ]} />
        }
      />
      {tab === 'profitability' && <ProfitabilityTab />}
      {tab === 'costs' && <CostsTab canEdit={can('costs', 'create')} />}
      {tab === 'receivables' && <ReceivablesTab />}
      {tab === 'projects' && <ProjectsTab canEdit={can('projects', 'create')} />}
    </>
  );
}

/* ========================================================== PROFITABILITY */
function ProfitabilityTab() {
  const { can } = useAuth();
  const [months, setMonths] = useState('6');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['profitability', months],
    queryFn: () => api.get('/finance/profitability', { months }).then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  const latest = data.months[data.months.length - 1];
  const chart = data.months.map((m: any) => ({ ...m, label: monthLabel(m.month).split(' ')[0] }));

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 flex-1">
          <Stat label={`Revenue · ${months}m`} value={money(data.company.revenue_minor, { compact: true })}
            icon={<TrendingUp size={15} />} />
          <Stat label="Cost" value={money(data.company.cost_minor, { compact: true })} icon={<Wallet size={15} />} />
          <Stat label="Gross profit" value={money(data.company.gross_profit_minor, { compact: true })}
            tone={data.company.gross_profit_minor > 0 ? 'positive' : 'negative'} />
          <Stat label="Margin" value={percent(data.company.margin_pct)}
            tone={data.company.margin_pct >= 35 ? 'positive' : data.company.margin_pct >= 20 ? 'warning' : 'negative'}
            sub={latest ? `${percent(latest.margin_pct)} in ${monthLabel(latest.month)}` : undefined} />
        </div>
        <Select value={months} onChange={(e) => setMonths(e.target.value)} aria-label="Period" className="w-[120px] self-start">
          {['3', '6', '12', '24'].map((m) => <option key={m} value={m}>{m} months</option>)}
        </Select>
      </div>

      <div className="grid gap-5 lg:grid-cols-3 mb-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Monthly revenue, cost and margin" icon={<TrendingUp size={16} />}
            action={can('profitability', 'export') && (
              <Button size="sm" icon={<Download size={14} />}
                onClick={() => api.download('/finance/profitability/export', 'profitability.csv', { months })}>
                Export
              </Button>
            )} />
          <div className="p-4 pt-3">
            <ResponsiveContainer width="100%" height={272}>
              <ComposedChart data={chart} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis yAxisId="money" tickFormatter={(v) => money(v, { compact: true })} tickLine={false} axisLine={false} width={62} />
                <YAxis yAxisId="pct" orientation="right" tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={40} />
                <Tooltip content={<MoneyTooltip />} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                <Bar yAxisId="money" dataKey="revenue_minor" name="Revenue" fill="#1e40af" radius={[4, 4, 0, 0]} maxBarSize={36} />
                <Bar yAxisId="money" dataKey="cost_minor" name="Cost" fill="#f59e0b" radius={[4, 4, 0, 0]} maxBarSize={36} />
                <Line yAxisId="pct" type="monotone" dataKey="margin_pct" name="Margin %" stroke="#0f766e" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Cost mix" subtitle={latest ? monthLabel(latest.month) : ''} icon={<Wallet size={16} />} />
          {!latest?.cost_breakdown?.some((c: any) => c.amount_minor > 0) ? (
            <EmptyState compact title="No costs recorded" message="Add cost entries to see the split." />
          ) : (
            <>
              <div className="p-4 pb-0">
                <ResponsiveContainer width="100%" height={170}>
                  <PieChart>
                    <Pie data={latest.cost_breakdown.filter((c: any) => c.amount_minor > 0)}
                      dataKey="amount_minor" nameKey="category" cx="50%" cy="50%"
                      innerRadius={44} outerRadius={72} paddingAngle={2} strokeWidth={0}>
                      {latest.cost_breakdown.map((c: any) => (
                        <Cell key={c.category} fill={CATEGORY_COLORS[c.category] || '#64748b'} />
                      ))}
                    </Pie>
                    <Tooltip content={<MoneyTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="px-4 pb-4 space-y-1.5">
                {latest.cost_breakdown.filter((c: any) => c.amount_minor > 0)
                  .sort((a: any, b: any) => b.amount_minor - a.amount_minor).map((c: any) => (
                    <li key={c.category} className="flex items-center gap-2 text-[13px]">
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: CATEGORY_COLORS[c.category] }} aria-hidden />
                      <span className="text-muted capitalize flex-1">{c.category}</span>
                      <span className="text-ink tabular font-medium">{money(c.amount_minor, { compact: true })}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ProfitTable title="By client" subtitle="Direct cost plus overhead allocated by revenue share"
          rows={data.by_client} linkPrefix="/crm/" />
        <ProfitTable title="By service line" rows={data.by_service_line} />
      </div>

      {data.by_project?.length > 0 && (
        <div className="mt-5">
          <ProfitTable title="By project" rows={data.by_project} />
        </div>
      )}
    </>
  );
}

function ProfitTable({ title, subtitle, rows, linkPrefix }: {
  title: string; subtitle?: string; rows: any[]; linkPrefix?: string;
}) {
  const navigate = useNavigate();
  if (!rows?.length) {
    return (
      <Card>
        <CardHeader title={title} subtitle={subtitle} />
        <EmptyState compact title="No data" message="Nothing invoiced in this period." />
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <Table>
        <THead>
          <tr>
            <TH>Name</TH>
            <TH align="right" width="110px">Revenue</TH>
            <TH align="right" width="110px">Cost</TH>
            <TH align="right" width="110px">Profit</TH>
            <TH align="right" width="115px">Margin</TH>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={r.id} onClick={linkPrefix ? () => navigate(`${linkPrefix}${r.id}`) : undefined}>
              <TD className="font-medium truncate max-w-[220px]">{r.name}</TD>
              <TD align="right">{money(r.revenue, { compact: true })}</TD>
              <TD align="right"><span className="text-subtle">{money(r.cost, { compact: true })}</span></TD>
              <TD align="right">
                <span className={r.gross_profit >= 0 ? 'text-[var(--positive)] font-medium' : 'text-[var(--negative)] font-medium'}>
                  {money(r.gross_profit, { compact: true })}
                </span>
              </TD>
              <TD align="right">
                <span className="flex items-center gap-2 justify-end">
                  <Meter value={Math.max(0, Math.min(100, r.margin_pct))}
                    tone={r.margin_pct >= 35 ? 'positive' : r.margin_pct >= 15 ? 'warning' : 'negative'}
                    className="w-12" />
                  <span className="tabular w-11 text-right">{percent(r.margin_pct)}</span>
                </span>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/* ================================================================== COSTS */
function CostsTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['costs', month],
    queryFn: () => api.get('/finance/costs', { period_month: month, limit: 200 }),
  });

  const rollForward = useMutation({
    mutationFn: () => api.post('/finance/costs/roll-forward', { period_month: month }),
    onSuccess: (res: any) => {
      toast.success(`${res.data.copied} recurring cost(s) copied and ${res.data.hr_rows} salary line(s) synced.`);
      qc.invalidateQueries({ queryKey: ['costs'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/finance/costs/${id}`),
    onSuccess: () => { toast.success('Removed.'); qc.invalidateQueries({ queryKey: ['costs'] }); setDeleting(null); },
  });

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  const rows = data?.data || [];
  const summary = data?.meta?.summary || {};

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="w-[150px]">
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </Select>
        <div className="ml-auto flex gap-2">
          {canEdit && (
            <>
              <Button icon={<RefreshCw size={15} className={rollForward.isPending ? 'animate-spin' : ''} />}
                loading={rollForward.isPending} onClick={() => rollForward.mutate()}>
                Roll forward recurring + salaries
              </Button>
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>Add cost</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat label={`Total · ${monthLabel(month)}`} value={money(summary.total_minor, { compact: true })}
          icon={<Wallet size={15} />} />
        {(summary.by_category || []).slice(0, 3).map((c: any) => (
          <Stat key={c.category} label={titleCase(c.category)} value={money(c.amount_minor, { compact: true })}
            sub={`${c.n} entr${c.n === 1 ? 'y' : 'ies'}`} />
        ))}
      </div>

      {isLoading ? <Card><TableSkeleton cols={5} /></Card>
        : !rows.length ? (
          <Card>
            <EmptyState icon={<Wallet size={20} />} title={`No costs recorded for ${monthLabel(month)}`}
              message="Roll forward last month's recurring costs, or add entries individually."
              action={canEdit ? (
                <div className="flex gap-2">
                  <Button onClick={() => rollForward.mutate()} loading={rollForward.isPending}>Roll forward</Button>
                  <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>Add cost</Button>
                </div>
              ) : undefined} />
          </Card>
        ) : (
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>Label</TH>
                  <TH width="120px">Category</TH>
                  <TH width="150px">Vendor</TH>
                  <TH width="160px">Allocated to</TH>
                  <TH align="right" width="120px">Amount</TH>
                  {canEdit && <TH width="50px" />}
                </tr>
              </THead>
              <tbody>
                {rows.map((c: any) => (
                  <TR key={c.id}>
                    <TD>
                      <span className="font-medium text-ink">{c.label}</span>
                      {c.recurring === 1 && <Badge tone="neutral" className="ml-2">recurring</Badge>}
                    </TD>
                    <TD>
                      <span className="flex items-center gap-1.5 text-[13px] text-muted capitalize">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: CATEGORY_COLORS[c.category] }} aria-hidden />
                        {c.category}
                      </span>
                    </TD>
                    <TD><span className="text-muted text-[13px]">{c.vendor || '—'}</span></TD>
                    <TD>
                      <span className="text-muted text-[13px] truncate block max-w-[150px]">
                        {c.client_name || c.project_name || c.service_line_name || c.user_name || 'Company overhead'}
                      </span>
                    </TD>
                    <TD align="right" className="font-medium">{money(c.amount_minor)}</TD>
                    {canEdit && (
                      <TD align="center">
                        <button onClick={() => setDeleting(c)} aria-label={`Remove ${c.label}`}
                          className="text-subtle hover:text-[var(--negative)] transition-colors cursor-pointer p-1">
                          <Trash2 size={14} />
                        </button>
                      </TD>
                    )}
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

      {createOpen && <CostModal month={month} onClose={() => setCreateOpen(false)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutate(deleting.id)} loading={remove.isPending}
        title="Remove this cost entry?" danger confirmLabel="Remove"
        message={<>“{deleting?.label}” ({money(deleting?.amount_minor)}) will stop counting toward {monthLabel(month)} profitability.</>} />
    </>
  );
}

function CostModal({ month, onClose }: { month: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    category: 'tools', label: '', vendor: '', amount: '', period_month: month,
    client_id: '', service_line_id: '', recurring: false, notes: '',
  });

  const { data: meta } = useQuery({
    queryKey: ['cost-meta'],
    queryFn: async () => {
      const [clients, serviceLines] = await Promise.all([
        api.get('/crm/clients', { limit: 200 }).then((r) => r.data).catch(() => []),
        api.get('/settings/service-lines').then((r) => r.data),
      ]);
      return { clients, serviceLines };
    },
    staleTime: 300_000,
  });

  const create = useMutation({
    mutationFn: () => api.post('/finance/costs', {
      category: form.category,
      label: form.label.trim(),
      vendor: form.vendor || null,
      amount_minor: Math.round(Number(form.amount) * 100),
      period_month: form.period_month,
      client_id: form.client_id || null,
      service_line_id: form.service_line_id || null,
      recurring: form.recurring,
      notes: form.notes || null,
    }),
    onSuccess: () => {
      toast.success('Cost recorded.');
      qc.invalidateQueries({ queryKey: ['costs'] });
      qc.invalidateQueries({ queryKey: ['profitability'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title="Record a cost"
      subtitle="Costs pinned to a client are charged directly; the rest are spread by revenue share"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!form.label.trim() || !Number(form.amount)} onClick={() => create.mutate()}>
            Record cost
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category" required>
            <Select value={form.category} onChange={(e) => set('category', e.target.value)}>
              {['hr', 'tools', 'rent', 'maintenance', 'marketing', 'misc'].map((c) => (
                <option key={c} value={c}>{titleCase(c)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Month" required>
            <Input type="month" value={form.period_month} onChange={(e) => set('period_month', e.target.value)} />
          </Field>
        </div>
        <Field label="Label" required>
          <Input value={form.label} onChange={(e) => set('label', e.target.value)}
            placeholder="Google Workspace subscription" autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (₹)" required>
            <Input type="number" min={0} step={100} value={form.amount} onChange={(e) => set('amount', e.target.value)} />
          </Field>
          <Field label="Vendor">
            <Input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Google" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Allocate to client" hint="Leave blank for company overhead">
            <Select value={form.client_id} onChange={(e) => set('client_id', e.target.value)}>
              <option value="">Company overhead</option>
              {meta?.clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Service line">
            <Select value={form.service_line_id} onChange={(e) => set('service_line_id', e.target.value)}>
              <option value="">Not specific</option>
              {meta?.serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2.5 text-[13.5px] text-ink cursor-pointer">
          <input type="checkbox" checked={form.recurring} onChange={(e) => set('recurring', e.target.checked)}
            className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
          Recurring — include when rolling costs forward each month
        </label>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

/* =========================================================== RECEIVABLES */
function ReceivablesTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['receivables'],
    queryFn: () => api.get('/finance/receivables').then((r) => r.data),
  });

  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  const bucketTone = (b: string) => (b === 'current' ? 'positive' : b === '1-30' ? 'warning' : 'negative');

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat label="Total outstanding" value={money(data.total_outstanding_minor, { compact: true })}
          icon={<Receipt size={15} />} />
        <Stat label="Days sales outstanding" value={`${data.dso_days} days`}
          tone={data.dso_days <= 30 ? 'positive' : data.dso_days <= 45 ? 'warning' : 'negative'}
          sub="Target 30 days" />
        <Stat label="Open invoices" value={data.invoices.length} />
        <Stat label="Beyond 60 days"
          value={money((data.aging_buckets.find((b: any) => b.bucket === '61-90')?.amount_minor || 0)
            + (data.aging_buckets.find((b: any) => b.bucket === '90+')?.amount_minor || 0), { compact: true })}
          tone="negative" icon={<AlertTriangle size={15} />} />
      </div>

      <Card className="mb-5">
        <CardHeader title="Ageing" subtitle="Outstanding balance by how long it has been due" />
        <div className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.aging_buckets} margin={{ top: 4, right: 6, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => money(v, { compact: true })} tickLine={false} axisLine={false} width={62} />
              <Tooltip content={<MoneyTooltip />} cursor={{ fill: 'var(--surface-sunken)' }} />
              <Bar dataKey="amount_minor" name="Outstanding" radius={[4, 4, 0, 0]} maxBarSize={64}>
                {data.aging_buckets.map((b: any) => (
                  <Cell key={b.bucket} fill={b.bucket === 'current' ? '#15803d'
                    : b.bucket === '1-30' ? '#f59e0b' : b.bucket === '31-60' ? '#ea580c' : '#b91c1c'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="By client" subtitle="Who owes what, and how old it is" />
          {!data.by_client.length ? <EmptyState compact title="Nothing outstanding" /> : (
            <Table>
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH align="right" width="100px">Current</TH>
                  <TH align="right" width="100px">1–60d</TH>
                  <TH align="right" width="100px">60d+</TH>
                  <TH align="right" width="110px">Total</TH>
                </tr>
              </THead>
              <tbody>
                {data.by_client.map((c: any) => (
                  <TR key={c.client_id} onClick={() => navigate(`/crm/${c.client_id}`)}>
                    <TD className="font-medium truncate max-w-[180px]">{c.client_name}</TD>
                    <TD align="right"><span className="text-subtle">{money(c.current, { compact: true })}</span></TD>
                    <TD align="right">
                      <span className={c['1-30'] + c['31-60'] > 0 ? 'text-[var(--warning)]' : 'text-subtle'}>
                        {money(c['1-30'] + c['31-60'], { compact: true })}
                      </span>
                    </TD>
                    <TD align="right">
                      <span className={c['61-90'] + c['90+'] > 0 ? 'text-[var(--negative)] font-medium' : 'text-subtle'}>
                        {money(c['61-90'] + c['90+'], { compact: true })}
                      </span>
                    </TD>
                    <TD align="right" className="font-medium">{money(c.total)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Open invoices" subtitle="Oldest due date first" />
          {!data.invoices.length ? <EmptyState compact title="All invoices settled" /> : (
            <Table>
              <THead>
                <tr><TH width="140px">Number</TH><TH>Client</TH><TH width="110px">Due</TH><TH align="right" width="110px">Balance</TH></tr>
              </THead>
              <tbody>
                {data.invoices.slice(0, 20).map((i: any) => (
                  <TR key={i.id} onClick={() => navigate(`/invoices/${i.id}`)}>
                    <TD mono>{i.number}</TD>
                    <TD className="truncate max-w-[160px]">{i.client_name}</TD>
                    <TD><span className="text-muted text-[13px]">{date(i.due_date)}</span></TD>
                    <TD align="right" className="font-medium">{money(i.balance_minor)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

/* ============================================================== PROJECTS */
function ProjectsTab({ canEdit }: { canEdit: boolean }) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['projects-all'],
    queryFn: () => api.get('/finance/projects').then((r) => r.data),
  });

  if (isLoading) return <Card><TableSkeleton cols={6} /></Card>;
  if (!data?.length) {
    return (
      <Card>
        <EmptyState icon={<Building2 size={20} />} title="No projects"
          message="Projects carry scope and budget, and let invoices and costs roll up per engagement." />
      </Card>
    );
  }

  return (
    <Card>
      <Table>
        <THead>
          <tr>
            <TH>Project</TH>
            <TH width="170px">Client</TH>
            <TH width="180px">Manager / lead</TH>
            <TH width="110px">Model</TH>
            <TH align="right" width="110px">Budget</TH>
            <TH align="right" width="110px">Invoiced</TH>
            <TH align="right" width="110px">Cost</TH>
            <TH width="140px">Scope</TH>
            <TH width="110px">Status</TH>
          </tr>
        </THead>
        <tbody>
          {data.map((p: any) => (
            <TR key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
              <TD>
                <span className="block font-medium text-ink">{p.name}</span>
                {p.service_line_name && <span className="block text-[12px] text-subtle">{p.service_line_name}</span>}
              </TD>
              <TD><span className="text-muted text-[13px] truncate block max-w-[160px]">{p.client_name}</span></TD>
              <TD>
                <span className="block text-[13px] text-muted truncate">{p.manager_name || 'No manager'}</span>
                <span className="block text-[11.5px] text-subtle truncate">
                  {p.lead_name ? `${p.lead_name} leads` : 'No lead'} · {p.team_size || 0} on team
                </span>
              </TD>
              <TD><span className="capitalize text-muted text-[13px]">{p.model}</span></TD>
              <TD align="right">{money(p.budget_minor, { compact: true })}</TD>
              <TD align="right">{money(p.invoiced_minor, { compact: true })}</TD>
              <TD align="right"><span className="text-subtle">{money(p.cost_minor, { compact: true })}</span></TD>
              <TD>
                <span className="flex items-center gap-2">
                  <Meter value={p.scope_delivered} max={p.scope_total || 1}
                    tone={p.scope_total && p.scope_delivered / p.scope_total >= 0.8 ? 'positive' : 'warning'}
                    className="w-14" />
                  <span className="text-[12px] tabular text-subtle">{p.scope_delivered}/{p.scope_total}</span>
                </span>
              </TD>
              <TD><StatusBadge status={p.status} /></TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function MoneyTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 shadow-[var(--shadow-lg)] text-[12.5px]">
      {label != null && <p className="font-medium text-ink mb-1">{label}</p>}
      {payload.map((p: any, i: number) => (
        <p key={i} className="flex items-center gap-2 text-muted">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color || p.payload?.fill }} aria-hidden />
          <span className="capitalize">{p.name}</span>
          <span className="ml-auto tabular font-medium text-ink">
            {p.name === 'Margin %' ? percent(p.value) : money(p.value)}
          </span>
        </p>
      ))}
    </div>
  );
}
