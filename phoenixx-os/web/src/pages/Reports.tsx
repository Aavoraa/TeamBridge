import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Plus, FileDown, Send, Calendar, Clock, Users2, Check, Play, Trash2, Settings2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, relative, monthLabel, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Select, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs, useToast, cx,
} from '../components/ui';

/** Module G — generated reports, and the saved definitions that schedule them. */
export default function Reports() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState('runs');
  const [kind, setKind] = useState('');
  const [generateOpen, setGenerateOpen] = useState(false);

  const runs = useQuery({
    queryKey: ['reports', kind],
    queryFn: () => api.get('/reports', { kind, limit: 50 }).then((r) => r.data),
    enabled: tab === 'runs',
  });

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Daily, weekly and monthly internal reports, plus the client-facing monthly report"
        actions={can('reports', 'create') && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setGenerateOpen(true)}>Generate</Button>
        )}
        tabs={
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'runs', label: 'Generated reports' },
            { id: 'scheduled', label: 'Scheduled reports' },
          ]} />
        }
      />

      {tab === 'runs' && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type" className="w-[180px]">
                <option value="">All report types</option>
                <option value="daily">Daily operations</option>
                <option value="weekly">Weekly scorecard</option>
                <option value="monthly">Monthly business review</option>
                <option value="client_monthly">Client monthly</option>
                <option value="custom">Custom</option>
              </Select>
              <p className="ml-auto text-[12.5px] text-subtle hidden md:block">
                Daily at 08:30 IST · weekly on Monday · monthly on the 1st
              </p>
            </div>
          </Card>

          {runs.error ? <ErrorState error={runs.error} retry={runs.refetch} />
            : runs.isLoading ? <Card><TableSkeleton cols={5} /></Card>
              : !runs.data?.length ? (
                <Card>
                  <EmptyState icon={<BarChart3 size={20} />} title="No reports generated yet"
                    message="Reports are generated on a schedule, or you can generate one now."
                    action={can('reports', 'create')
                      ? <Button variant="primary" onClick={() => setGenerateOpen(true)}>Generate a report</Button>
                      : undefined} />
                </Card>
              ) : (
                <Card>
                  <Table>
                    <THead>
                      <tr>
                        <TH>Report</TH>
                        <TH width="150px">Type</TH>
                        <TH width="180px">Period</TH>
                        <TH width="150px">Generated</TH>
                        <TH width="130px">Status</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {runs.data.map((r: any) => (
                        <TR key={r.id} onClick={() => navigate(`/reports/${r.id}`)}>
                          <TD>
                            <span className="block font-medium text-ink">{r.title}</span>
                            {r.client_name && <span className="block text-[12px] text-subtle">{r.client_name}</span>}
                          </TD>
                          <TD>
                            <Badge tone={r.kind === 'client_monthly' ? 'accent' : 'neutral'}>
                              {titleCase(r.kind)}
                            </Badge>
                          </TD>
                          <TD>
                            <span className="text-muted text-[13px]">
                              {r.period_start === r.period_end ? date(r.period_start) : `${date(r.period_start, 'day')} – ${date(r.period_end)}`}
                            </span>
                          </TD>
                          <TD><span className="text-subtle text-[13px]">{relative(r.generated_at)}</span></TD>
                          <TD>
                            <span className="flex items-center gap-1.5">
                              <StatusBadge status={r.status} />
                              {r.pdf_path && <FileDown size={12} className="text-subtle" aria-label="PDF available" />}
                            </span>
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}
        </>
      )}

      {tab === 'scheduled' && <ScheduledTab />}

      {generateOpen && <GenerateModal onClose={() => setGenerateOpen(false)} />}
    </>
  );
}

/* -------------------------------------------------------------- generate */
function GenerateModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const lastMonth = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const [kind, setKind] = useState('weekly');
  const [month, setMonth] = useState(lastMonth);
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [clientId, setClientId] = useState('');
  const [allClients, setAllClients] = useState(true);

  const { data: clients } = useQuery({
    queryKey: ['clients-active'],
    queryFn: () => api.get('/crm/clients', { status: 'active', limit: 200 }).then((r) => r.data),
    enabled: kind === 'client_monthly',
  });

  const generate = useMutation({
    mutationFn: () => api.post('/reports/generate', {
      kind,
      ...(kind === 'daily' || kind === 'weekly' ? { date: reportDate } : {}),
      ...(kind === 'monthly' || kind === 'client_monthly' ? { month } : {}),
      ...(kind === 'client_monthly' ? (allClients ? { all_clients: true } : { client_id: clientId }) : {}),
    }),
    onSuccess: (res: any) => {
      if (res.data.generated != null) {
        toast.success(`${res.data.generated} client report(s) generated and queued for approval.`);
      } else {
        toast.success('Report generated.');
        navigate(`/reports/${res.data.id}`);
      }
      qc.invalidateQueries({ queryKey: ['reports'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const DESCRIPTIONS: Record<string, string> = {
    daily: 'Items due and overdue today, follow-ups, invoices due, and attendance.',
    weekly: 'Completion and on-time rates by owner, SOP adherence, escalations raised, pipeline movement.',
    monthly: 'Company scorecard, client profitability, KPI/KRA review per employee, dashboard summary.',
    client_monthly: 'Branded, client-facing: work delivered, key metrics and next month\'s plan. Queued for approval before dispatch.',
  };

  return (
    <Modal open onClose={onClose} title="Generate a report"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={generate.isPending}
            disabled={kind === 'client_monthly' && !allClients && !clientId}
            onClick={() => generate.mutate()}>Generate</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Report type" required>
          <div className="space-y-2">
            {(['daily', 'weekly', 'monthly', 'client_monthly'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={cx('w-full rounded-lg border p-3 text-left transition-colors duration-150 cursor-pointer',
                  kind === k ? 'border-[var(--brand)] bg-brand-soft ring-1 ring-[var(--brand)]'
                    : 'border-line hover:border-line-strong')}>
                <span className="text-[13.5px] font-medium text-ink">{titleCase(k)}</span>
                <span className="mt-0.5 block text-[12.5px] text-subtle leading-snug">{DESCRIPTIONS[k]}</span>
              </button>
            ))}
          </div>
        </Field>

        {(kind === 'daily' || kind === 'weekly') && (
          <Field label={kind === 'daily' ? 'Date' : 'Week ending'}>
            <Input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
          </Field>
        )}

        {(kind === 'monthly' || kind === 'client_monthly') && (
          <Field label="Month">
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
        )}

        {kind === 'client_monthly' && (
          <>
            <label className="flex items-center gap-2.5 text-[13.5px] text-ink cursor-pointer">
              <input type="checkbox" checked={allClients} onChange={(e) => setAllClients(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
              Generate for every active client
            </label>
            {!allClients && (
              <Field label="Client" required>
                <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                  <option value="">Select a client…</option>
                  {clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- scheduled */
function ScheduledTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['report-definitions'],
    queryFn: () => api.get('/reports/definitions/all').then((r) => r.data),
  });

  const run = useMutation({
    mutationFn: (id: string) => api.post(`/reports/definitions/${id}/run`),
    onSuccess: (res: any) => {
      toast.success('Report generated.');
      qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(`/reports/${res.data.id}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/reports/definitions/${id}`),
    onSuccess: () => { toast.success('Removed.'); qc.invalidateQueries({ queryKey: ['report-definitions'] }); setDeleting(null); },
  });

  return (
    <>
      {can('reports', 'create') && (
        <div className="flex justify-end mb-4">
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
            New scheduled report
          </Button>
        </div>
      )}

      {isLoading ? <Card><TableSkeleton cols={5} /></Card>
        : !data?.length ? (
          <Card>
            <EmptyState icon={<Clock size={20} />} title="No scheduled reports"
              message="Pick metrics, a date range and a delivery schedule, and the report arrives on its own."
              action={can('reports', 'create')
                ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create one</Button>
                : undefined} />
          </Card>
        ) : (
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH width="180px">Metrics</TH>
                  <TH width="150px">Schedule</TH>
                  <TH width="150px">Next run</TH>
                  <TH width="140px">Channels</TH>
                  <TH width="140px" />
                </tr>
              </THead>
              <tbody>
                {data.map((d: any) => (
                  <TR key={d.id}>
                    <TD>
                      <span className="block font-medium text-ink">{d.name}</span>
                      <span className="block text-[12px] text-subtle">{titleCase(d.kind)}</span>
                    </TD>
                    <TD><span className="text-muted text-[13px]">{d.metrics.length} metrics</span></TD>
                    <TD><span className="mono text-[12.5px] text-subtle">{d.schedule || 'manual'}</span></TD>
                    <TD><span className="text-muted text-[13px]">{d.next_run_at ? relative(d.next_run_at) : '—'}</span></TD>
                    <TD>
                      <span className="flex flex-wrap gap-1">
                        {d.channels.map((c: string) => <Badge key={c} tone="neutral">{c.replace('_', '-')}</Badge>)}
                      </span>
                    </TD>
                    <TD>
                      <span className="flex gap-1.5 justify-end">
                        <Button size="sm" icon={<Play size={13} />} loading={run.isPending}
                          onClick={() => run.mutate(d.id)}>Run</Button>
                        {can('reports', 'delete') && (
                          <button onClick={() => setDeleting(d)} aria-label={`Delete ${d.name}`}
                            className="text-subtle hover:text-[var(--negative)] transition-colors cursor-pointer p-1.5">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

      {createOpen && <DefinitionModal onClose={() => setCreateOpen(false)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutate(deleting.id)} loading={remove.isPending}
        title="Delete this scheduled report?" danger confirmLabel="Delete"
        message={<>“{deleting?.name}” will stop running. Reports already generated stay available.</>} />
    </>
  );
}

function DefinitionModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [metrics, setMetrics] = useState<string[]>([]);
  const [schedule, setSchedule] = useState('weekly@mon-03:30');
  const [channels, setChannels] = useState<string[]>(['in_app', 'email']);
  const [recipients, setRecipients] = useState<string[]>([]);

  const { data: meta } = useQuery({
    queryKey: ['report-metrics'],
    queryFn: () => api.get('/reports/metrics').then((r) => r.data),
    staleTime: 300_000,
  });
  const { data: directory } = useQuery({
    queryKey: ['directory'],
    queryFn: () => api.get('/users/directory').then((r) => r.data),
    staleTime: 300_000,
  });

  const create = useMutation({
    mutationFn: () => api.post('/reports/definitions', {
      name: name.trim(), kind: 'custom', metrics, schedule, channels, recipients,
    }),
    onSuccess: () => {
      toast.success('Scheduled report saved.');
      qc.invalidateQueries({ queryKey: ['report-definitions'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) =>
    setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  return (
    <Modal open onClose={onClose} title="New scheduled report" size="lg"
      subtitle="Pick the metrics, when it runs and who receives it"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!name.trim() || !metrics.length} onClick={() => create.mutate()}>Save</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Monday leadership snapshot" autoFocus />
        </Field>

        <Field label="Metrics" required hint={`${metrics.length} selected`}>
          <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto rounded-md border border-line p-2.5">
            {meta?.metrics?.map((m: any) => (
              <button key={m.key} type="button" onClick={() => toggle(metrics, setMetrics, m.key)}
                className={cx('rounded-full border px-2.5 py-1 text-[12.5px] transition-colors duration-150 cursor-pointer capitalize',
                  metrics.includes(m.key)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                {m.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Schedule">
          <Select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
            <option value="daily@03:30">Every day at 09:00 IST</option>
            <option value="weekly@mon-03:30">Every Monday at 09:00 IST</option>
            <option value="weekly@fri-11:30">Every Friday at 17:00 IST</option>
            <option value="monthly@1-03:30">1st of the month at 09:00 IST</option>
          </Select>
        </Field>

        <Field label="Delivery channels">
          <div className="flex flex-wrap gap-2">
            {['in_app', 'email', 'whatsapp', 'teams'].map((c) => (
              <button key={c} type="button" onClick={() => toggle(channels, setChannels, c)}
                className={cx('rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors duration-150 cursor-pointer',
                  channels.includes(c)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                {c.replace('_', '-')}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Recipients" hint="Leave empty to send to owners and managers">
          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
            {directory?.map((u: any) => (
              <button key={u.id} type="button" onClick={() => toggle(recipients, setRecipients, u.id)}
                className={cx('rounded-full border px-2.5 py-1 text-[12.5px] transition-colors duration-150 cursor-pointer',
                  recipients.includes(u.id)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                {u.name}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
