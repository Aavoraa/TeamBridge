import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  RadialBarChart, RadialBar, PolarAngleAxis,
} from 'recharts';
import {
  ArrowLeft, Phone, Mail, MessageSquare, CalendarDays, FileText, Receipt, StickyNote,
  AlertTriangle, Plus, RefreshCw, TrendingUp, Users2, Building2, Sliders, ChevronRight, Globe,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date, dateTime, relative, percent, titleCase, daysUntil, dueLabel } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Meter,
  Modal, PageHeader, Select, StatusBadge, Table, TD, TH, THead, TR, Tabs, Textarea,
  Skeleton, useToast, cx, Stat,
} from '../components/ui';

const ACTIVITY_ICONS: Record<string, any> = {
  call: Phone, whatsapp: MessageSquare, email: Mail, meeting: CalendarDays,
  note: StickyNote, proposal: FileText, invoice: Receipt, grievance: AlertTriangle,
  stage_change: ChevronRight,
};

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState('timeline');
  const [logOpen, setLogOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const { data: client, isLoading, error, refetch } = useQuery({
    queryKey: ['client', id],
    queryFn: () => api.get(`/crm/clients/${id}`).then((r) => r.data),
  });

  const { data: meta } = useQuery({
    queryKey: ['crm-meta'],
    queryFn: async () => {
      const [stages, directory, reasonCodes] = await Promise.all([
        api.get('/settings/pipeline-stages').then((r) => r.data),
        api.get('/users/directory').then((r) => r.data),
        api.get('/settings/reason-codes').then((r) => r.data),
      ]);
      return { stages, directory, reasonCodes };
    },
    staleTime: 300_000,
  });

  const update = useMutation({
    mutationFn: (patch: any) => api.patch(`/crm/clients/${id}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['client', id] }); toast.success('Updated.'); },
    onError: (e: any) => toast.error(e.message),
  });

  const rescore = useMutation({
    mutationFn: () => api.post(`/crm/clients/${id}/rescore`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['client', id] }); toast.success('Scores recomputed from current data.'); },
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !client) return <DetailSkeleton />;

  const scores = client.scores || {};
  const nextDays = daysUntil(client.next_action_date);

  return (
    <>
      <button onClick={() => navigate('/crm')}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-subtle hover:text-ink transition-colors cursor-pointer">
        <ArrowLeft size={14} /> Back to pipeline
      </button>

      <PageHeader
        title={client.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={client.status} />
            {client.stage_name && <Badge tone="brand">{client.stage_name}</Badge>}
            {client.industry && <span className="capitalize text-subtle">{client.industry}</span>}
            {client.city && <span className="text-subtle">· {client.city}</span>}
            {client.retention_risk === 1 && (
              <Badge tone="negative" dot>at risk{client.retention_reason_label ? `: ${client.retention_reason_label}` : ''}</Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button icon={<RefreshCw size={15} className={rescore.isPending ? 'animate-spin' : ''} />}
              onClick={() => rescore.mutate()} loading={rescore.isPending}>Rescore</Button>
            {can('crm', 'create') && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setLogOpen(true)}>
                Log touchpoint
              </Button>
            )}
          </>
        }
      />

      {/* ---------------------------------------------------- next action */}
      <Card className={cx('mb-4 border-l-4',
        !client.next_action ? 'border-l-[var(--accent-bg)]'
          : nextDays != null && nextDays < 0 ? 'border-l-[var(--negative)]' : 'border-l-[var(--brand)]')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="label-cap">Next action</p>
            {client.next_action ? (
              <p className="text-[14px] text-ink mt-0.5">
                {client.next_action}
                <span className={cx('ml-2 text-[13px]',
                  nextDays != null && nextDays < 0 ? 'text-[var(--negative)] font-medium' : 'text-subtle')}>
                  · {relative(client.next_action_date)}
                </span>
              </p>
            ) : (
              <p className="text-[14px] text-[var(--accent)] font-medium mt-0.5">
                Not set — this lead is flagged until you set one
              </p>
            )}
          </div>
          {can('crm', 'edit') && (
            <div className="flex items-end gap-2">
              <Field label="Update next action" className="w-[220px]">
                <Input defaultValue={client.next_action || ''} placeholder="What happens next?"
                  onBlur={(e) => e.target.value !== (client.next_action || '') && update.mutate({ next_action: e.target.value })} />
              </Field>
              <Field label="By" className="w-[145px]">
                <Input type="date" defaultValue={client.next_action_date || ''}
                  onChange={(e) => update.mutate({ next_action_date: e.target.value || null })} />
              </Field>
            </div>
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* =========================================================== main */}
        <div className="min-w-0">
          <Card>
            <Tabs
              active={tab} onChange={setTab}
              tabs={[
                { id: 'timeline', label: 'Timeline', count: client.timeline?.length },
                { id: 'scores', label: 'Scorecard' },
                { id: 'work', label: 'Work', count: client.action_items?.length },
                { id: 'money', label: 'Proposals & invoices', count: (client.proposals?.length || 0) + (client.invoices?.length || 0) },
                { id: 'contacts', label: 'Contacts', count: client.contacts?.length },
              ]}
              className="px-2"
            />

            {tab === 'timeline' && <Timeline items={client.timeline || []} />}
            {tab === 'scores' && <Scorecard client={client} scores={scores} onAdjust={() => setAdjustOpen(true)} canAdjust={can('crm', 'approve')} />}
            {tab === 'work' && <WorkTab client={client} />}
            {tab === 'money' && <MoneyTab client={client} />}
            {tab === 'contacts' && <ContactsTab client={client} />}
          </Card>
        </div>

        {/* ======================================================== sidebar */}
        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader title="Health" subtitle="Computed from engagement and payment data" />
            <div className="p-4">
              <div className="flex items-center justify-center">
                <ResponsiveContainer width="100%" height={140}>
                  <RadialBarChart innerRadius="66%" outerRadius="100%" data={[{ name: 'health', value: scores.health || 0 }]}
                    startAngle={210} endAngle={-30}>
                    <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                    <RadialBar dataKey="value" cornerRadius={8} background={{ fill: 'var(--surface-sunken)' }}
                      fill={scores.health >= 65 ? '#15803d' : scores.health >= 45 ? '#d97706' : '#b91c1c'} />
                  </RadialBarChart>
                </ResponsiveContainer>
              </div>
              <p className="-mt-12 text-center text-[30px] font-semibold text-ink tabular leading-none">
                {Math.round(scores.health || 0)}
              </p>
              <p className="mt-1 mb-6 text-center text-[12px] text-subtle">out of 100</p>

              <div className="space-y-3">
                <ScoreRow label="Conversion" value={scores.conversion} hint="likelihood to close" />
                <ScoreRow label="Relevancy" value={scores.relevancy} hint="fit to your ICP" />
                <ScoreRow label="Retention" value={scores.retention} hint="likelihood to stay" />
                <ScoreRow label="Risk" value={scores.risk} hint="lower is better" invert />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Commercials" />
            <dl className="p-4 space-y-2.5 text-[13px]">
              <Row label="Model" value={titleCase(client.engagement_model)} />
              {client.mrr_minor > 0 && <Row label="MRR" value={money(client.mrr_minor)} strong />}
              {client.deal_value_minor > 0 && <Row label="Deal value" value={money(client.deal_value_minor)} />}
              <Row label="Outstanding" value={money(client.outstanding_minor)}
                tone={client.outstanding_minor > 0 ? 'negative' : undefined} />
              {client.scope_total > 0 && (
                <div>
                  <div className="flex justify-between mb-1">
                    <dt className="text-subtle">Scope delivered</dt>
                    <dd className="text-ink tabular">{client.scope_delivered}/{client.scope_total}</dd>
                  </div>
                  <Meter value={client.scope_delivered} max={client.scope_total}
                    tone={client.scope_delivered / client.scope_total >= 0.8 ? 'positive' : 'warning'} />
                </div>
              )}
              {client.renewal_date && <Row label="Renewal" value={`${date(client.renewal_date)} · ${relative(client.renewal_date)}`} />}
              {client.satisfaction && <Row label="Satisfaction" value={`${client.satisfaction} / 5`} />}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <dl className="p-4 space-y-2.5 text-[13px]">
              <Row label="Owner" value={client.owner_name} />
              <Row label="Source" value={titleCase(client.source)} />
              <Row label="GSTIN" value={client.gstin} mono />
              <Row label="State code" value={client.state_code} />
              {client.website && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-subtle shrink-0">Website</dt>
                  <dd className="min-w-0">
                    <a href={client.website} target="_blank" rel="noopener noreferrer"
                      className="text-[var(--brand)] hover:underline truncate flex items-center gap-1">
                      <Globe size={12} className="shrink-0" />
                      <span className="truncate">{client.website.replace(/^https?:\/\//, '')}</span>
                    </a>
                  </dd>
                </div>
              )}
              <Row label="Client since" value={client.onboarded_at ? date(client.onboarded_at) : '—'} />
              <Row label="Last activity" value={relative(client.last_activity_at)} />
            </dl>

            {can('crm', 'edit') && (
              <div className="border-t border-line p-4 space-y-3">
                <Field label="Stage">
                  <Select value={client.stage_id || ''} onChange={(e) => update.mutate({ stage_id: e.target.value })}>
                    {meta?.stages?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label="Owner">
                  <Select value={client.owner_id || ''} onChange={(e) => update.mutate({ owner_id: e.target.value })}>
                    {meta?.directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <Field label="Retention risk reason"
                  hint="Structured reasons only — free text is not accepted here">
                  <Select value={client.retention_reason_code_id || ''}
                    onChange={(e) => update.mutate({ retention_reason_code_id: e.target.value || null })}>
                    <option value="">Not flagged</option>
                    {meta?.reasonCodes?.filter((r: any) => r.category === 'retention_risk')
                      .map((r: any) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </Select>
                </Field>
              </div>
            )}
          </Card>
        </div>
      </div>

      {logOpen && <LogActivityModal clientId={id!} onClose={() => setLogOpen(false)} />}
      {adjustOpen && <AdjustScoreModal clientId={id!} reasonCodes={meta?.reasonCodes || []} onClose={() => setAdjustOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------- fragments */
const Row = ({ label, value, strong, mono, tone }: any) => (
  value ? (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-subtle shrink-0">{label}</dt>
      <dd className={cx('text-right min-w-0 truncate',
        strong ? 'font-semibold text-ink' : 'text-ink', mono && 'mono text-[12.5px]',
        tone === 'negative' && 'text-[var(--negative)]')}>{value}</dd>
    </div>
  ) : null
);

function ScoreRow({ label, value, hint, invert }: { label: string; value?: number; hint: string; invert?: boolean }) {
  const v = value ?? 0;
  const good = invert ? v < 40 : v >= 65;
  const mid = invert ? v < 65 : v >= 45;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] text-muted">{label}</span>
        <span className={cx('text-[13.5px] font-semibold tabular',
          good ? 'text-[var(--positive)]' : mid ? 'text-[var(--warning)]' : 'text-[var(--negative)]')}>
          {Math.round(v)}
        </span>
      </div>
      <Meter value={v} tone={good ? 'positive' : mid ? 'warning' : 'negative'} className="mt-1" />
      <p className="mt-0.5 text-[11.5px] text-subtle">{hint}</p>
    </div>
  );
}

function Timeline({ items }: { items: any[] }) {
  if (!items.length) {
    return <EmptyState icon={<MessageSquare size={20} />} title="No activity yet"
      message="Calls, messages, meetings, proposals and invoices all land on this timeline." />;
  }
  return (
    <ol className="p-4 space-y-0">
      {items.map((a, i) => {
        const Icon = ACTIVITY_ICONS[a.type] || StickyNote;
        return (
          <li key={a.id} className="flex gap-3 pb-4 last:pb-0 relative">
            {i < items.length - 1 && (
              <span className="absolute left-[15px] top-8 bottom-0 w-px bg-line" aria-hidden />
            )}
            <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full border z-10',
              a.type === 'grievance' ? 'bg-negative-soft border-[color-mix(in_srgb,var(--negative)_30%,transparent)] text-[var(--negative)]'
                : a.outcome === 'positive' ? 'bg-positive-soft border-[color-mix(in_srgb,var(--positive)_30%,transparent)] text-[var(--positive)]'
                  : 'bg-sunken border-line text-subtle')}>
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[13.5px] font-medium text-ink">{a.subject || titleCase(a.type)}</span>
                {a.outcome && (
                  <Badge tone={a.outcome === 'positive' ? 'positive' : a.outcome === 'negative' ? 'negative'
                    : a.outcome === 'no_response' ? 'warning' : 'neutral'}>
                    {a.outcome.replace('_', ' ')}
                  </Badge>
                )}
                <span className="text-[12px] text-subtle ml-auto shrink-0">{dateTime(a.occurred_at)}</span>
              </div>
              {a.body && <p className="mt-0.5 text-[13px] text-muted leading-relaxed">{a.body}</p>}
              <p className="mt-0.5 text-[12px] text-subtle">
                {titleCase(a.type)}{a.user_name ? ` · ${a.user_name}` : ''}
                {a.duration_minutes ? ` · ${a.duration_minutes} min` : ''}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Scorecard({ client, scores, onAdjust, canAdjust }: any) {
  const b = scores.breakdown || {};
  const history = (client.score_history || []).map((h: any) => ({ ...h, label: date(h.snapshot_date, 'day') }));

  return (
    <div className="p-4 space-y-5">
      {history.length > 2 && (
        <div>
          <p className="label-cap mb-2">Score trend</p>
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={history} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={32} />
              <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11.5 }} />
              <Line type="monotone" dataKey="health" name="Health" stroke="#1e40af" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="retention" name="Retention" stroke="#15803d" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="risk" name="Risk" stroke="#b91c1c" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <BreakdownCard title="Conversion" score={scores.conversion} rows={[
          ['Stage progress', b.conversion?.stage_progress],
          ['Stage velocity', b.conversion?.stage_velocity],
          ['Days in stage', b.conversion?.days_in_stage],
          ['Response rate', b.conversion?.response_rate],
          ['Touchpoints', b.conversion?.touchpoints],
          ['Days since contact', b.conversion?.days_since_contact],
        ]} />
        <BreakdownCard title="Risk" score={scores.risk} invert rows={[
          ['Avg days late', b.risk?.avg_days_late],
          ['Payment delay risk', b.risk?.payment_delay_risk],
          ['Overdue invoices', b.risk?.overdue_invoices],
          ['Overdue amount', b.risk?.overdue_amount_minor != null ? money(b.risk.overdue_amount_minor) : null],
          ['Grievances (90d)', b.risk?.grievances_90d],
          ['Scope gap', b.risk?.scope_gap_pct != null ? percent(b.risk.scope_gap_pct) : null],
        ]} />
        <BreakdownCard title="Relevancy" score={scores.relevancy} rows={[
          ['Industry fit', b.relevancy?.industry_fit],
          ['Service lines engaged', b.relevancy?.service_lines_engaged],
          ['Service line overlap', b.relevancy?.service_line_overlap],
          ['Annualised value', b.relevancy?.annualised_value_minor != null ? money(b.relevancy.annualised_value_minor) : null],
          ['Model fit', b.relevancy?.model_fit],
        ]} />
        <BreakdownCard title="Retention" score={scores.retention} rows={[
          ['Activities (30d)', b.retention?.activities_30d],
          ['Previous 30d', b.retention?.activities_prev_30d],
          ['Engagement trend', b.retention?.engagement_trend],
          ['Renewal proximity', b.retention?.renewal_proximity],
          ['Delivery ratio', b.retention?.delivery_ratio],
          ['Payment reliability', b.retention?.payment_reliability],
        ]} />
      </div>

      {b.adjustments?.length > 0 && (
        <div className="rounded-lg border border-line bg-sunken p-3.5">
          <p className="label-cap mb-2">Manual adjustments applied</p>
          <ul className="space-y-1.5">
            {b.adjustments.map((a: any, i: number) => (
              <li key={i} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-muted">
                  <span className="capitalize font-medium text-ink">{a.type}</span> · {a.reason}
                </span>
                <span className={cx('tabular font-medium', a.delta > 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]')}>
                  {a.delta > 0 ? '+' : ''}{a.delta}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canAdjust && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line p-3.5">
          <p className="text-[13px] text-muted">
            Need to override a score? Adjustments always carry a structured reason code.
          </p>
          <Button size="sm" icon={<Sliders size={14} />} onClick={onAdjust}>Adjust</Button>
        </div>
      )}
    </div>
  );
}

function BreakdownCard({ title, score, rows, invert }: any) {
  const v = score ?? 0;
  const good = invert ? v < 40 : v >= 65;
  const mid = invert ? v < 65 : v >= 45;
  return (
    <div className="rounded-lg border border-line p-3.5">
      <div className="flex items-baseline justify-between mb-2.5">
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        <span className={cx('text-[18px] font-semibold tabular',
          good ? 'text-[var(--positive)]' : mid ? 'text-[var(--warning)]' : 'text-[var(--negative)]')}>
          {Math.round(v)}
        </span>
      </div>
      <dl className="space-y-1 text-[12.5px]">
        {rows.filter(([, val]: any) => val != null).map(([label, val]: any) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-subtle">{label}</dt>
            <dd className="text-ink tabular">{typeof val === 'number' ? Math.round(val * 10) / 10 : val}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function WorkTab({ client }: { client: any }) {
  const navigate = useNavigate();
  return (
    <div className="p-4 space-y-5">
      <div>
        <p className="label-cap mb-2">Open action items</p>
        {!client.action_items?.length ? (
          <EmptyState compact title="No action items" message="Work created against this client will show here." />
        ) : (
          <Table>
            <THead><tr><TH>Item</TH><TH width="130px">Owner</TH><TH width="110px">Due</TH><TH width="110px">Status</TH></tr></THead>
            <tbody>
              {client.action_items.map((a: any) => (
                <TR key={a.id} onClick={() => navigate(`/action-items?open=${a.id}`)}>
                  <TD className="font-medium">{a.title}</TD>
                  <TD><span className="text-muted text-[13px]">{a.owner_name || '—'}</span></TD>
                  <TD><span className="text-muted text-[13px]">{dueLabel(a)}</span></TD>
                  <TD><StatusBadge status={a.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div>
        <p className="label-cap mb-2">Projects</p>
        {!client.projects?.length ? (
          <EmptyState compact title="No projects" message="Accepted proposals become projects with tracked scope." />
        ) : (
          <Table>
            <THead><tr><TH>Project</TH><TH width="190px">Team</TH><TH width="110px">Model</TH><TH align="right" width="120px">Budget</TH><TH width="140px">Scope</TH></tr></THead>
            <tbody>
              {client.projects.map((p: any) => (
                <TR key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
                  <TD className="font-medium">{p.name}</TD>
                  <TD>
                    <span className="block text-[13px] text-muted truncate">{p.manager_name || 'No manager'}</span>
                    <span className="block text-[11.5px] text-subtle truncate">
                      {p.lead_name ? `${p.lead_name} leads` : 'No lead'} · {p.team_size || 0} on team
                    </span>
                  </TD>
                  <TD><span className="capitalize text-muted text-[13px]">{p.model}</span></TD>
                  <TD align="right">{money(p.budget_minor)}</TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <Meter value={p.scope_delivered} max={p.scope_total || 1} className="w-14" />
                      <span className="text-[12px] tabular text-subtle">{p.scope_delivered}/{p.scope_total}</span>
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

function MoneyTab({ client }: { client: any }) {
  const navigate = useNavigate();
  return (
    <div className="p-4 space-y-5">
      <div>
        <p className="label-cap mb-2">Proposals</p>
        {!client.proposals?.length ? <EmptyState compact title="No proposals yet" /> : (
          <Table>
            <THead><tr><TH>Number</TH><TH>Title</TH><TH align="right" width="110px">Value</TH><TH width="90px">Views</TH><TH width="110px">Status</TH></tr></THead>
            <tbody>
              {client.proposals.map((p: any) => (
                <TR key={p.id} onClick={() => navigate(`/proposals?open=${p.id}`)}>
                  <TD mono>{p.number}</TD>
                  <TD className="font-medium">{p.title}</TD>
                  <TD align="right">{money(p.total_minor)}</TD>
                  <TD><span className="text-muted tabular text-[13px]">{p.view_count || 0}</span></TD>
                  <TD><StatusBadge status={p.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div>
        <p className="label-cap mb-2">Invoices</p>
        {!client.invoices?.length ? <EmptyState compact title="No invoices yet" /> : (
          <Table>
            <THead>
              <tr><TH>Number</TH><TH width="110px">Issued</TH><TH width="110px">Due</TH>
                <TH align="right" width="110px">Total</TH><TH align="right" width="110px">Balance</TH><TH width="120px">Status</TH></tr>
            </THead>
            <tbody>
              {client.invoices.map((i: any) => (
                <TR key={i.id} onClick={() => navigate(`/invoices/${i.id}`)}>
                  <TD mono>{i.number}</TD>
                  <TD><span className="text-muted text-[13px]">{date(i.issue_date)}</span></TD>
                  <TD><span className="text-muted text-[13px]">{date(i.due_date)}</span></TD>
                  <TD align="right">{money(i.total_minor)}</TD>
                  <TD align="right">
                    <span className={i.balance_minor > 0 ? 'text-[var(--negative)] font-medium' : 'text-subtle'}>
                      {money(i.balance_minor)}
                    </span>
                  </TD>
                  <TD><StatusBadge status={i.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

function ContactsTab({ client }: { client: any }) {
  if (!client.contacts?.length) {
    return <EmptyState icon={<Users2 size={20} />} title="No contacts" message="Add the people you actually deal with." />;
  }
  return (
    <ul className="divide-y divide-[var(--border)]">
      {client.contacts.map((c: any) => (
        <li key={c.id} className="flex items-start gap-3 px-4 py-3.5">
          <Avatar name={c.name} size={34} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[14px] font-medium text-ink">{c.name}</p>
              {c.is_primary === 1 && <Badge tone="brand">primary</Badge>}
              {c.consent_whatsapp === 1 && <Badge tone="positive">WhatsApp consent</Badge>}
            </div>
            {c.designation && <p className="text-[12.5px] text-subtle">{c.designation}</p>}
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
              {c.email && <a href={`mailto:${c.email}`} className="text-[var(--brand)] hover:underline flex items-center gap-1"><Mail size={11} />{c.email}</a>}
              {c.phone && <a href={`tel:${c.phone}`} className="text-[var(--brand)] hover:underline flex items-center gap-1"><Phone size={11} />{c.phone}</a>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- modals */
function LogActivityModal({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    type: 'call', direction: 'outbound', subject: '', body: '', outcome: 'connected',
    next_action: '', next_action_date: '', duration_minutes: '',
  });

  const log = useMutation({
    mutationFn: () => api.post(`/crm/clients/${clientId}/activities`, {
      type: form.type,
      direction: form.direction,
      subject: form.subject || null,
      body: form.body || null,
      outcome: form.outcome || null,
      duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
      next_action: form.next_action || undefined,
      next_action_date: form.next_action_date || undefined,
    }),
    onSuccess: () => {
      toast.success('Touchpoint logged.');
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title="Log a touchpoint"
      subtitle="Setting the next action here is what keeps the follow-up engine honest"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={log.isPending} onClick={() => log.mutate()}>Log it</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            <Select value={form.type} onChange={(e) => set('type', e.target.value)}>
              {['call', 'whatsapp', 'email', 'meeting', 'note', 'grievance'].map((t) => (
                <option key={t} value={t}>{titleCase(t)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={form.direction} onChange={(e) => set('direction', e.target.value)}>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </Select>
          </Field>
          <Field label="Outcome">
            <Select value={form.outcome} onChange={(e) => set('outcome', e.target.value)}>
              {['connected', 'no_response', 'positive', 'negative', 'scheduled'].map((o) => (
                <option key={o} value={o}>{titleCase(o)}</option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Subject">
          <Input value={form.subject} onChange={(e) => set('subject', e.target.value)}
            placeholder="Campaign review call" autoFocus />
        </Field>
        <Field label="Notes">
          <Textarea value={form.body} onChange={(e) => set('body', e.target.value)} rows={3}
            placeholder="What was discussed, what was agreed…" />
        </Field>
        <Field label="Duration (minutes)" className="max-w-[160px]">
          <Input type="number" min={0} value={form.duration_minutes}
            onChange={(e) => set('duration_minutes', e.target.value)} placeholder="30" />
        </Field>

        <div className="rounded-lg border border-line bg-sunken p-3">
          <p className="text-[12.5px] font-medium text-ink mb-2.5">Set the next action</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
            <Field label="What happens next">
              <Input value={form.next_action} onChange={(e) => set('next_action', e.target.value)}
                placeholder="Send the revised scope" />
            </Field>
            <Field label="By when">
              <Input type="date" value={form.next_action_date} onChange={(e) => set('next_action_date', e.target.value)} />
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AdjustScoreModal({ clientId, reasonCodes, onClose }: { clientId: string; reasonCodes: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ score_type: 'relevancy', delta: '5', reason_code_id: '', note: '' });

  const codes = reasonCodes.filter((r) => r.category === 'score_adjust' || r.category === 'retention_risk');

  const adjust = useMutation({
    mutationFn: () => api.post(`/crm/clients/${clientId}/score-adjustments`, {
      score_type: form.score_type,
      delta: Number(form.delta),
      reason_code_id: form.reason_code_id,
      note: form.note || null,
    }),
    onSuccess: () => {
      toast.success('Adjustment applied and logged.');
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Adjust a score" size="sm"
      subtitle="Recorded against your name with the reason code, and visible in the scorecard"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={adjust.isPending} disabled={!form.reason_code_id}
            onClick={() => adjust.mutate()}>Apply</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Which score">
          <Select value={form.score_type} onChange={(e) => setForm((f) => ({ ...f, score_type: e.target.value }))}>
            <option value="conversion">Conversion</option>
            <option value="risk">Risk</option>
            <option value="relevancy">Relevancy</option>
            <option value="retention">Retention</option>
          </Select>
        </Field>
        <Field label="Adjustment" hint="Between -50 and +50 points">
          <Input type="number" min={-50} max={50} value={form.delta}
            onChange={(e) => setForm((f) => ({ ...f, delta: e.target.value }))} />
        </Field>
        <Field label="Reason code" required hint="Free text is not accepted — pick from the managed list">
          <Select value={form.reason_code_id} onChange={(e) => setForm((f) => ({ ...f, reason_code_id: e.target.value }))}>
            <option value="">Select a reason…</option>
            {codes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Note">
          <Textarea value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} rows={2}
            placeholder="Context for whoever reviews this later" />
        </Field>
      </div>
    </Modal>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-4 w-28 mb-4" />
      <Skeleton className="h-8 w-72 mb-2" />
      <Skeleton className="h-4 w-52 mb-5" />
      <Skeleton className="h-16 mb-4" />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Skeleton className="h-96" />
        <div className="space-y-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
      </div>
    </div>
  );
}
