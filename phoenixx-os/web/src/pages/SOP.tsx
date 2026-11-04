import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenCheck, Plus, Check, Target, ClipboardCheck, Users2, AlertTriangle, Search,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { percent, relative, titleCase, num, date } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Meter, Modal,
  PageHeader, SearchInput, Select, Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR,
  Tabs, Textarea, useToast, cx,
} from '../components/ui';

/** Module D — the SOP library, adherence reporting, and the KPI/KRA definitions. */
export default function SOP() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') || 'library');
  const { can } = useAuth();

  const setTabAndUrl = (id: string) => {
    setTab(id);
    const next = new URLSearchParams(params); next.set('tab', id); setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="SOP & KPI library"
        subtitle="Per service line and workflow, version-controlled, with adherence tracked"
        tabs={
          <Tabs active={tab} onChange={setTabAndUrl} tabs={[
            { id: 'library', label: 'SOP library' },
            { id: 'adherence', label: 'Adherence' },
            { id: 'acknowledgement', label: 'Acknowledgement' },
            { id: 'kpi', label: 'KPI & KRA' },
          ]} />
        }
      />
      {tab === 'library' && <LibraryTab />}
      {tab === 'adherence' && <AdherenceTab />}
      {tab === 'acknowledgement' && <AcknowledgementTab />}
      {tab === 'kpi' && <KpiTab />}
    </>
  );
}

/* =============================================================== LIBRARY */
function LibraryTab() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [serviceLine, setServiceLine] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sops', search, serviceLine, workflow],
    queryFn: () => api.get('/sop', { search, service_line_id: serviceLine, workflow, limit: 100 }).then((r) => r.data),
  });

  const { data: meta } = useQuery({
    queryKey: ['sop-meta'],
    queryFn: async () => {
      const [serviceLines, workflows] = await Promise.all([
        api.get('/settings/service-lines').then((r) => r.data),
        api.get('/sop/workflows').then((r) => r.data),
      ]);
      return { serviceLines, workflows };
    },
    staleTime: 300_000,
  });

  const pendingAck = (data || []).filter((s: any) => s.status === 'published' && !s.acknowledged).length;

  return (
    <>
      {pendingAck > 0 && (
        <Card className="mb-4 border-l-4 border-l-[var(--accent-bg)]">
          <div className="flex items-center gap-2.5 px-4 py-2.5">
            <AlertTriangle size={15} className="text-[var(--accent)] shrink-0" />
            <p className="text-[13.5px] text-ink">
              You have <strong>{pendingAck}</strong> published SOP{pendingAck === 1 ? '' : 's'} you have not acknowledged yet.
            </p>
          </div>
        </Card>
      )}

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search SOPs…" className="flex-1 min-w-[200px]" />
          <Select value={serviceLine} onChange={(e) => setServiceLine(e.target.value)}
            aria-label="Service line" className="w-[190px]">
            <option value="">All service lines</option>
            {meta?.serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select value={workflow} onChange={(e) => setWorkflow(e.target.value)}
            aria-label="Workflow" className="w-[170px]">
            <option value="">All workflows</option>
            {meta?.workflows?.map((w: any) => <option key={w.code} value={w.code}>{w.label} ({w.count})</option>)}
          </Select>
          {can('sop', 'create') && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New SOP</Button>
          )}
        </div>
      </Card>

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-40" />)}
        </div>
          : !data?.length ? (
            <Card>
              <EmptyState icon={<BookOpenCheck size={20} />} title="No SOPs found"
                message="Your workspace ships with starter SOPs for outreach, follow-up, grievance, onboarding, execution, invoicing and retention." />
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.map((s: any) => (
                <button key={s.id} onClick={() => navigate(`/sop/${s.id}`)}
                  className="card p-4 text-left cursor-pointer transition-colors duration-150 hover:border-line-strong group">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[14.5px] font-semibold text-ink leading-snug group-hover:text-[var(--brand)] transition-colors">
                        {s.title}
                      </h3>
                      {s.code && <p className="mono text-[11.5px] text-subtle mt-0.5">{s.code}</p>}
                    </div>
                    <StatusBadge status={s.status} />
                  </div>

                  <p className="mt-2 text-[12.5px] text-subtle leading-snug line-clamp-2">{s.summary}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {s.service_line_name && (
                      <Badge tone="neutral">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.service_line_color }} aria-hidden />
                        {s.service_line_name}
                      </Badge>
                    )}
                    <Badge tone="neutral">{titleCase(s.workflow)}</Badge>
                    <Badge tone="neutral">v{s.current_version}</Badge>
                  </div>

                  <div className="mt-3 pt-3 border-t border-line flex items-center justify-between gap-2 text-[12px]">
                    <span className="text-subtle">
                      {s.ack_count} acknowledged
                      {s.avg_adherence != null && ` · ${percent(s.avg_adherence)} adherence`}
                    </span>
                    {s.status === 'published' && (
                      s.acknowledged
                        ? <Badge tone="positive"><Check size={10} /> read</Badge>
                        : <Badge tone="accent">unread</Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

      {createOpen && <CreateSopModal meta={meta} onClose={() => setCreateOpen(false)} />}
    </>
  );
}

function CreateSopModal({ meta, onClose }: { meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    title: '', code: '', workflow: 'internal', service_line_id: '', summary: '',
    content: '', checklist: '',
  });

  const create = useMutation({
    mutationFn: () => api.post('/sop', {
      title: form.title.trim(),
      code: form.code || null,
      workflow: form.workflow,
      service_line_id: form.service_line_id || null,
      summary: form.summary || null,
      content: form.content,
      checklist: form.checklist.split('\n').map((t) => t.trim()).filter(Boolean)
        .map((text, i) => ({ id: `c${i + 1}`, text, required: true })),
    }),
    onSuccess: (res: any) => {
      toast.success('SOP created as a draft.');
      qc.invalidateQueries({ queryKey: ['sops'] });
      onClose();
      navigate(`/sop/${res.data.id}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title="New SOP" size="lg"
      subtitle="Saved as a draft — publish it when you want the team to acknowledge it"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.title.trim().length < 2}
            onClick={() => create.mutate()}>Create draft</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
          <Field label="Title" required>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)}
              placeholder="Client escalation handling" autoFocus />
          </Field>
          <Field label="Code">
            <Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())}
              placeholder="SOP-ESC-01" className="mono" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Workflow" required>
            <Select value={form.workflow} onChange={(e) => set('workflow', e.target.value)}>
              {meta?.workflows?.map((w: any) => <option key={w.code} value={w.code}>{w.label}</option>)}
            </Select>
          </Field>
          <Field label="Service line">
            <Select value={form.service_line_id} onChange={(e) => set('service_line_id', e.target.value)}>
              <option value="">Applies to all</option>
              {meta?.serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Summary" hint="One line describing when to use this">
          <Input value={form.summary} onChange={(e) => set('summary', e.target.value)} />
        </Field>
        <Field label="Content" hint="Markdown supported">
          <Textarea value={form.content} onChange={(e) => set('content', e.target.value)} rows={8}
            placeholder={'## Purpose\n\n## When to use\n\n## Steps\n1. …\n2. …\n\n## Escalation'} />
        </Field>
        <Field label="Checklist" hint="One item per line — these are what adherence is measured against">
          <Textarea value={form.checklist} onChange={(e) => set('checklist', e.target.value)} rows={5}
            placeholder={'Acknowledge to the client within 4 hours\nRaise an action item under Grievance\nAgree a resolution plan'} />
        </Field>
      </div>
    </Modal>
  );
}

/* ============================================================= ADHERENCE */
function AdherenceTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['sop-adherence'],
    queryFn: () => api.get('/sop/reports/adherence').then((r) => r.data),
  });

  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 mb-4">
        <Stat label="Overall adherence"
          value={data.overall_adherence != null ? percent(data.overall_adherence) : '—'}
          tone={data.overall_adherence >= 90 ? 'positive' : data.overall_adherence >= 75 ? 'warning' : 'negative'}
          sub="Target 90%" icon={<ClipboardCheck size={15} />} />
        <Stat label="SOP runs" value={data.total_runs} sub="Last 30 days" />
        <Stat label="SOPs tracked" value={data.by_sop.length} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="By SOP" subtitle="Weakest adherence first — these are the ones being skipped" />
          {!data.by_sop.length ? <EmptyState compact title="No runs recorded" /> : (
            <Table>
              <THead>
                <tr><TH>SOP</TH><TH width="80px" align="right">Runs</TH><TH width="150px">Adherence</TH></tr>
              </THead>
              <tbody>
                {data.by_sop.map((s: any) => (
                  <TR key={s.id} onClick={() => navigate(`/sop/${s.id}`)}>
                    <TD>
                      <span className="block font-medium text-ink">{s.title}</span>
                      <span className="block text-[12px] text-subtle">
                        {titleCase(s.workflow)}{s.service_line_name ? ` · ${s.service_line_name}` : ''}
                      </span>
                    </TD>
                    <TD align="right"><span className="tabular text-muted">{s.runs}</span></TD>
                    <TD>
                      {s.avg_adherence == null ? <span className="text-subtle text-[13px]">no runs</span> : (
                        <span className="flex items-center gap-2">
                          <Meter value={s.avg_adherence}
                            tone={s.avg_adherence >= 90 ? 'positive' : s.avg_adherence >= 75 ? 'warning' : 'negative'}
                            className="w-16" />
                          <span className="tabular text-[13px] w-10 text-right">{percent(s.avg_adherence)}</span>
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="By person" subtitle="Who is completing the checklists" />
          {!data.by_user.length ? <EmptyState compact title="No runs recorded" /> : (
            <Table>
              <THead>
                <tr><TH>Person</TH><TH width="80px" align="right">Runs</TH><TH width="150px">Adherence</TH></tr>
              </THead>
              <tbody>
                {data.by_user.map((u: any) => (
                  <TR key={u.id}>
                    <TD><span className="flex items-center gap-2.5"><Avatar name={u.name} size={24} />{u.name}</span></TD>
                    <TD align="right"><span className="tabular text-muted">{u.runs}</span></TD>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Meter value={u.avg_adherence}
                          tone={u.avg_adherence >= 90 ? 'positive' : u.avg_adherence >= 75 ? 'warning' : 'negative'}
                          className="w-16" />
                        <span className="tabular text-[13px] w-10 text-right">{percent(u.avg_adherence)}</span>
                      </span>
                    </TD>
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

/* ======================================================= ACKNOWLEDGEMENT */
function AcknowledgementTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['sop-acknowledgement'],
    queryFn: () => api.get('/sop/reports/acknowledgement').then((r) => r.data),
  });

  if (isLoading || !data) return <Card><TableSkeleton cols={4} /></Card>;

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 mb-4">
        <Stat label="Overall coverage" value={percent(data.overall_coverage_pct)}
          tone={data.overall_coverage_pct >= 90 ? 'positive' : data.overall_coverage_pct >= 70 ? 'warning' : 'negative'}
          icon={<Users2 size={15} />} />
        <Stat label="SOPs requiring acknowledgement" value={data.sops.length} />
        <Stat label="Fully acknowledged"
          value={data.sops.filter((s: any) => s.pending === 0).length} tone="positive" />
      </div>

      <Card>
        <CardHeader title="Who has read which version"
          subtitle="Acknowledgements are per version — publishing a new version resets them" />
        {!data.sops.length ? <EmptyState compact title="No published SOPs require acknowledgement" /> : (
          <Table>
            <THead>
              <tr>
                <TH>SOP</TH>
                <TH width="80px">Version</TH>
                <TH width="160px">Coverage</TH>
                <TH>Still to read</TH>
              </tr>
            </THead>
            <tbody>
              {data.sops.map((s: any) => (
                <TR key={s.id} onClick={() => navigate(`/sop/${s.id}`)}>
                  <TD>
                    <span className="block font-medium text-ink">{s.title}</span>
                    <span className="block text-[12px] text-subtle">{titleCase(s.workflow)}</span>
                  </TD>
                  <TD><Badge tone="neutral">v{s.current_version}</Badge></TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <Meter value={s.coverage_pct}
                        tone={s.coverage_pct >= 90 ? 'positive' : s.coverage_pct >= 60 ? 'warning' : 'negative'}
                        className="w-16" />
                      <span className="tabular text-[13px]">{s.acknowledged}/{s.acknowledged + s.pending}</span>
                    </span>
                  </TD>
                  <TD>
                    {s.pending === 0 ? <Badge tone="positive" dot>everyone</Badge> : (
                      <span className="flex flex-wrap gap-1">
                        {s.pending_users.slice(0, 5).map((u: any) => (
                          <span key={u.id} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11.5px] text-muted">
                            <Avatar name={u.name} size={15} /> {u.name.split(' ')[0]}
                          </span>
                        ))}
                        {s.pending_users.length > 5 && (
                          <Badge tone="neutral">+{s.pending_users.length - 5}</Badge>
                        )}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

/* ==================================================================== KPI */
function KpiTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [role, setRole] = useState('');
  const [kind, setKind] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['kpis', role, kind],
    queryFn: () => api.get('/kpis', { role, kind }).then((r) => r.data),
  });

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" className="w-[130px]">
            <option value="">KPI and KRA</option>
            <option value="kpi">KPI only</option>
            <option value="kra">KRA only</option>
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" className="w-[150px]">
            <option value="">All roles</option>
            {['owner', 'manager', 'employee', 'finance', 'hr'].map((r) => (
              <option key={r} value={r}>{titleCase(r)}</option>
            ))}
          </Select>
          {can('kpi', 'create') && (
            <Button variant="primary" icon={<Plus size={15} />} className="ml-auto" onClick={() => setCreateOpen(true)}>
              Define KPI
            </Button>
          )}
        </div>
      </Card>

      {isLoading ? <Card><TableSkeleton cols={6} /></Card>
        : !data?.length ? (
          <Card>
            <EmptyState icon={<Target size={20} />} title="No KPIs defined"
              message="Define what each role is measured on, with a target and a review cadence." />
          </Card>
        ) : (
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH width="70px">Kind</TH>
                  <TH>Metric</TH>
                  <TH width="110px">Role</TH>
                  <TH width="150px">Source</TH>
                  <TH align="right" width="100px">Target</TH>
                  <TH width="110px">Cadence</TH>
                  <TH width="90px">Weight</TH>
                  <TH width="80px">Version</TH>
                </tr>
              </THead>
              <tbody>
                {data.map((k: any) => (
                  <TR key={k.id}>
                    <TD><Badge tone={k.kind === 'kra' ? 'accent' : 'brand'}>{k.kind.toUpperCase()}</Badge></TD>
                    <TD>
                      <span className="block font-medium text-ink">{k.name}</span>
                      <span className="mono block text-[11.5px] text-subtle">{k.code}</span>
                    </TD>
                    <TD><span className="capitalize text-muted text-[13px]">{k.applies_role || 'all'}</span></TD>
                    <TD><span className="mono text-[12px] text-subtle">{k.source || 'manual'}</span></TD>
                    <TD align="right">
                      <span className="font-medium">
                        {k.target_value != null ? (k.unit === 'percent' ? percent(k.target_value) : num(k.target_value, 1)) : '—'}
                      </span>
                      {k.direction === 'lower' && <span className="block text-[11px] text-subtle">lower is better</span>}
                    </TD>
                    <TD><span className="capitalize text-muted text-[13px]">{k.cadence}</span></TD>
                    <TD><span className="tabular text-muted text-[13px]">×{k.weight}</span></TD>
                    <TD><Badge tone="neutral">v{k.version}</Badge></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

      {createOpen && <KpiModal onClose={() => setCreateOpen(false)} />}
    </>
  );
}

function KpiModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '', code: '', kind: 'kpi', applies_role: 'employee', unit: 'percent',
    source: '', target_value: '', direction: 'higher', cadence: 'monthly', weight: '1', description: '',
  });

  const create = useMutation({
    mutationFn: () => api.post('/kpis', {
      name: form.name.trim(),
      code: form.code.trim().toUpperCase(),
      kind: form.kind,
      applies_role: form.applies_role || null,
      unit: form.unit,
      source: form.source || null,
      target_value: form.target_value ? Number(form.target_value) : null,
      direction: form.direction,
      cadence: form.cadence,
      weight: Number(form.weight),
      description: form.description || null,
    }),
    onSuccess: () => {
      toast.success('KPI defined.');
      qc.invalidateQueries({ queryKey: ['kpis'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const SOURCES = [
    { value: '', label: 'Manual entry' },
    { value: 'action_items.completion', label: 'Action item completion rate' },
    { value: 'action_items.on_time', label: 'On-time delivery rate' },
    { value: 'attendance.pct', label: 'Attendance percentage' },
    { value: 'sop.adherence', label: 'SOP adherence' },
    { value: 'crm.follow_up_completion', label: 'Follow-up completion' },
    { value: 'finance.margin', label: 'Gross margin' },
    { value: 'finance.dso', label: 'Days sales outstanding' },
  ];

  return (
    <Modal open onClose={onClose} title="Define a KPI or KRA" size="lg"
      subtitle="Pick a computed source where one exists — those fill in automatically each month"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!form.name.trim() || !form.code.trim()} onClick={() => create.mutate()}>Define</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_140px_120px]">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)}
              placeholder="Proposal turnaround time" autoFocus />
          </Field>
          <Field label="Code" required>
            <Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="PROPTAT" className="mono" />
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
              <option value="kpi">KPI</option>
              <option value="kra">KRA</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applies to role">
            <Select value={form.applies_role} onChange={(e) => set('applies_role', e.target.value)}>
              <option value="">Everyone</option>
              {['owner', 'manager', 'employee', 'finance', 'hr'].map((r) => (
                <option key={r} value={r}>{titleCase(r)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Source" hint="Computed sources fill in automatically">
            <Select value={form.source} onChange={(e) => set('source', e.target.value)}>
              {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Unit">
            <Select value={form.unit} onChange={(e) => set('unit', e.target.value)}>
              {['percent', 'number', 'currency', 'ratio'].map((u) => <option key={u} value={u}>{titleCase(u)}</option>)}
            </Select>
          </Field>
          <Field label="Target">
            <Input type="number" step={0.1} value={form.target_value} onChange={(e) => set('target_value', e.target.value)} />
          </Field>
          <Field label="Direction">
            <Select value={form.direction} onChange={(e) => set('direction', e.target.value)}>
              <option value="higher">Higher is better</option>
              <option value="lower">Lower is better</option>
            </Select>
          </Field>
          <Field label="Weight">
            <Input type="number" min={0} max={10} step={0.5} value={form.weight} onChange={(e) => set('weight', e.target.value)} />
          </Field>
        </div>
        <Field label="Cadence">
          <Select value={form.cadence} onChange={(e) => set('cadence', e.target.value)} className="max-w-[200px]">
            {['weekly', 'monthly', 'quarterly'].map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
        </Field>
        <Field label="Description">
          <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2}
            placeholder="How this is measured and why it matters." />
        </Field>
      </div>
    </Modal>
  );
}
