import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Palette, Receipt, Workflow, Tags, ShieldCheck, Download, Plus, Trash2, Check,
  History, Webhook, KeyRound, AlertTriangle, ClipboardList, BellRing, Play,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, relative, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Select, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs, Textarea,
  useToast, cx, Skeleton,
} from '../components/ui';

export default function Settings() {
  const [tab, setTab] = useState('workspace');
  const { can } = useAuth();

  return (
    <>
      <PageHeader
        title="Workspace settings"
        subtitle="Branding, invoice numbering, pipeline, reason codes, roles and the audit trail"
        tabs={
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'workspace', label: 'Workspace' },
            { id: 'invoicing', label: 'Invoicing' },
            { id: 'pipeline', label: 'Pipeline & categories' },
            { id: 'reasons', label: 'Reason codes' },
            { id: 'todo', label: 'Advance Planner' },
            { id: 'roles', label: 'Roles' },
            { id: 'webhooks', label: 'Webhooks' },
            { id: 'audit', label: 'Audit log' },
          ]} />
        }
      />
      {tab === 'workspace' && <WorkspaceTab />}
      {tab === 'invoicing' && <InvoicingTab />}
      {tab === 'pipeline' && <PipelineTab />}
      {tab === 'reasons' && <ReasonCodesTab />}
      {tab === 'todo' && <TodoScheduleTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

/* ============================================================= WORKSPACE */
function WorkspaceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh, can } = useAuth();
  const [form, setForm] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.get('/settings/tenant').then((r) => r.data),
  });

  useEffect(() => { if (data && !form) setForm(data); }, [data]);

  const save = useMutation({
    mutationFn: (patch: any) => api.patch('/settings/tenant', patch),
    onSuccess: async () => {
      toast.success('Settings saved.');
      qc.invalidateQueries({ queryKey: ['tenant-settings'] });
      await refresh();
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !form) return <Card><TableSkeleton rows={6} cols={2} /></Card>;

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const editable = can('settings', 'edit');

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Agency profile" subtitle="Appears on invoices, proposals and client reports"
          icon={<Building2 size={16} />} />
        <div className="p-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name">
              <Input value={form.name || ''} onChange={(e) => set('name', e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Legal name" hint="Used on tax documents">
              <Input value={form.legal_name || ''} onChange={(e) => set('legal_name', e.target.value)} disabled={!editable} />
            </Field>
          </div>
          <Field label="Address">
            <Textarea value={form.address || ''} onChange={(e) => set('address', e.target.value)} rows={2} disabled={!editable} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="City">
              <Input value={form.city || ''} onChange={(e) => set('city', e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email || ''} onChange={(e) => set('email', e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Website">
              <Input value={form.website || ''} onChange={(e) => set('website', e.target.value)} disabled={!editable} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="GSTIN">
              <Input value={form.gstin || ''} onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                className="mono" maxLength={15} disabled={!editable} />
            </Field>
            <Field label="PAN">
              <Input value={form.pan || ''} onChange={(e) => set('pan', e.target.value.toUpperCase())}
                className="mono" maxLength={10} disabled={!editable} />
            </Field>
            <Field label="State code" hint="Drives CGST/SGST vs IGST">
              <Select value={form.state_code || ''} onChange={(e) => set('state_code', e.target.value)} disabled={!editable}>
                {data.state_codes?.map((s: any) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
              </Select>
            </Field>
          </div>
          {editable && (
            <Button variant="primary" loading={save.isPending}
              onClick={() => save.mutate({
                name: form.name, legal_name: form.legal_name, address: form.address, city: form.city,
                phone: form.phone, email: form.email, website: form.website,
                gstin: form.gstin || null, pan: form.pan || null, state_code: form.state_code,
              })}>Save profile</Button>
          )}
        </div>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Branding" subtitle="Applied to the app, PDFs and client reports" icon={<Palette size={16} />} />
          <div className="p-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Primary colour">
                <div className="flex gap-2">
                  <input type="color" value={form.brand_primary || '#E15926'} disabled={!editable}
                    onChange={(e) => set('brand_primary', e.target.value.toUpperCase())}
                    aria-label="Primary colour"
                    className="h-9 w-12 rounded-md border border-line-strong cursor-pointer bg-raised p-1" />
                  <Input value={form.brand_primary || ''} onChange={(e) => set('brand_primary', e.target.value.toUpperCase())}
                    className="mono" disabled={!editable} />
                </div>
              </Field>
              <Field label="Accent colour">
                <div className="flex gap-2">
                  <input type="color" value={form.brand_accent || '#F59E0B'} disabled={!editable}
                    onChange={(e) => set('brand_accent', e.target.value.toUpperCase())}
                    aria-label="Accent colour"
                    className="h-9 w-12 rounded-md border border-line-strong cursor-pointer bg-raised p-1" />
                  <Input value={form.brand_accent || ''} onChange={(e) => set('brand_accent', e.target.value.toUpperCase())}
                    className="mono" disabled={!editable} />
                </div>
              </Field>
            </div>

            <div className="rounded-lg border border-line overflow-hidden">
              <div className="h-1.5" style={{ background: form.brand_primary }} />
              <div className="p-3.5">
                <p className="text-[15px] font-semibold" style={{ color: form.brand_primary }}>{form.name}</p>
                <p className="text-[12px] text-subtle mt-0.5">{form.city} · GSTIN {form.gstin || '—'}</p>
                <div className="mt-2.5 inline-flex items-center rounded px-2.5 py-1 text-[12px] font-semibold"
                  style={{ background: form.brand_accent, color: '#1f2937' }}>
                  Total ₹1,18,000
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Currency">
                <Select value={form.currency || 'INR'} onChange={(e) => set('currency', e.target.value)} disabled={!editable}>
                  {['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'].map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Number format" hint="Indian uses lakh and crore">
                <Select value={form.number_format || 'indian'} onChange={(e) => set('number_format', e.target.value)} disabled={!editable}>
                  <option value="indian">Indian (₹1,18,000)</option>
                  <option value="international">International (₹118,000)</option>
                </Select>
              </Field>
            </div>

            {editable && (
              <Button variant="primary" loading={save.isPending}
                onClick={() => save.mutate({
                  brand_primary: form.brand_primary, brand_accent: form.brand_accent,
                  currency: form.currency, number_format: form.number_format,
                })}>Save branding</Button>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Data & privacy" subtitle="DPDP Act 2023 obligations" icon={<ShieldCheck size={16} />} />
          <div className="p-4 space-y-3">
            <p className="text-[13px] text-muted leading-relaxed">
              Export everything this workspace holds as JSON. Passwords, 2FA secrets and invitation
              tokens are never included, even in an owner-initiated export.
            </p>
            <Button icon={<Download size={15} />}
              onClick={() => api.download('/settings/data-export', `phoenixx-export-${new Date().toISOString().slice(0, 10)}.json`)}>
              Export all workspace data
            </Button>
            {editable && (
              <label className="flex items-start gap-2.5 text-[13px] text-muted cursor-pointer pt-2 border-t border-line">
                <input type="checkbox" checked={!!form.settings?.support_access_enabled}
                  onChange={(e) => {
                    set('settings', { ...form.settings, support_access_enabled: e.target.checked });
                    save.mutate({ settings: { support_access_enabled: e.target.checked } });
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                <span>
                  <span className="block text-ink font-medium">Allow platform support access</span>
                  Lets Phoenixx OS support sign in as an owner to help you. Every such session is
                  written to your audit log. Off by default.
                </span>
              </label>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ============================================================= TO-DO SCHEDULE */
const WEEKDAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];

const PHASE_COPY: Record<string, string> = {
  not_open: 'Not open yet today',
  open: 'Open now',
  past_deadline: 'Past today\'s deadline',
  closed: 'No submission today',
};

const to12h = (hhmm?: string) => {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

function TodoScheduleTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState<any>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['todo-schedule'],
    queryFn: () => api.get('/todo-plan/schedule').then((r) => r.data),
  });

  useEffect(() => { if (data && !form) setForm(data.settings); }, [data]);

  const save = useMutation({
    mutationFn: (body: any) => api.put('/todo-plan/settings', body),
    onSuccess: (r: any) => {
      toast.success('Advance Planner settings saved.');
      setForm(r.data);
      qc.invalidateQueries({ queryKey: ['todo-schedule'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const runNow = useMutation({
    mutationFn: () => api.post('/todo-plan/run'),
    onSuccess: (r: any) => {
      toast.success(r.data.sent ? `${r.data.sent} notification(s) sent.` : 'Nothing was due right now.');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (error) return <Card><ErrorState error={error} retry={() => refetch()} /></Card>;
  if (isLoading || !form) return <Card><TableSkeleton rows={6} cols={2} /></Card>;

  const editable = !!data.can_edit_settings;
  const win = data.window;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const toggleIn = (k: string, v: any) => set(k, form[k].includes(v) ? form[k].filter((x: any) => x !== v) : [...form[k], v]);

  const Toggle = ({ k, title, hint }: { k: string; title: string; hint: string }) => (
    <label className="flex items-start gap-2.5 text-[13px] text-muted cursor-pointer">
      <input type="checkbox" checked={!!form[k]} disabled={!editable} onChange={(e) => set(k, e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
      <span><span className="block text-ink font-medium">{title}</span>{hint}</span>
    </label>
  );

  return (
    <div className="space-y-5">
      {!editable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-brand-soft/40 px-4 py-3 text-[13px]">
          <ShieldCheck size={16} className="text-[var(--brand)] shrink-0" />
          <p className="min-w-0 flex-1 text-muted">
            <span className="text-ink font-medium">Only the owner can change these settings.</span>{' '}
            {user?.role === 'manager' && form.managers_can_assign
              ? 'You are allowed to build your own team: go to Home → Team Advance Planner → Build your team.'
              : 'Ask the owner if something here should change.'}
          </p>
          {user?.role === 'manager' && form.managers_can_assign && (
            <Button size="sm" variant="primary" onClick={() => navigate('/')}>Go to my team</Button>
          )}
        </div>
      )}
      <Card>
        <div className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span className="flex items-center gap-2">
            <Badge tone={win.phase === 'open' ? 'positive' : win.phase === 'past_deadline' ? 'warning' : 'neutral'} dot>
              {PHASE_COPY[win.phase] || win.phase}
            </Badge>
          </span>
          <span className="text-muted">Today <span className="text-ink font-medium">{date(win.today)}</span> · {win.tz}</span>
          {win.todo_date && (
            <span className="text-muted">Plans due today are for <span className="text-ink font-medium">{date(win.todo_date)}</span></span>
          )}
          {editable && (
            <Button size="sm" icon={<Play size={14} />} loading={runNow.isPending} className="ml-auto"
              onClick={() => runNow.mutate()}>Run the clock now</Button>
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Schedule" icon={<ClipboardList size={16} />}
            subtitle="Workspace-local times. Each step must come after the one before." />
          <div className="p-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['open_time', 'Submission opens', 'Everyone is told to file tomorrow\'s plan'],
                ['reminder_time', 'Reminder', 'Only to people who have not submitted'],
                ['deadline_time', 'Deadline', 'Unfiled plans become overdue'],
                ['escalation_time', 'Escalation', 'Reporting person is told who is missing'],
              ].map(([k, label, hint]) => (
                <Field key={k} label={label} hint={`${hint} · ${to12h(form[k])}`}>
                  <Input type="time" value={form[k]} disabled={!editable} onChange={(e) => set(k, e.target.value)} />
                </Field>
              ))}
            </div>

            <Field label="Working days" hint="Holidays from HR are skipped too. Friday's plan is for the next working day.">
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => {
                  const on = form.working_days.includes(d.n);
                  return (
                    <button key={d.n} type="button" disabled={!editable} onClick={() => toggleIn('working_days', d.n)}
                      aria-pressed={on}
                      className={cx('h-8 min-w-[3rem] rounded-md border px-2.5 text-[12.5px] font-medium transition-colors duration-150',
                        on ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]' : 'border-line-strong text-muted',
                        editable ? 'cursor-pointer hover:border-[var(--brand)]' : 'cursor-default')}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Rules & notifications" icon={<BellRing size={16} />}
            subtitle="Who hears about what. In-app (the bell) always goes." />
          <div className="p-4 space-y-3.5">
            <Toggle k="enabled" title="Advance Planner is on" hint="Turn off to pause every notification and status change." />
            <Toggle k="allow_late" title="Allow late submission" hint="After the deadline a plan can still be filed; it is marked late with the minutes recorded." />
            <div className="border-t border-line pt-3.5 space-y-3.5">
              <Toggle k="notify_employees" title="Notify employees" hint="Opening, reminder and overdue messages." />
              <Toggle k="notify_managers" title="Notify reporting persons" hint="Escalation when one of their people has not filed." />
              <Toggle k="escalate_to_owner" title="Escalate to owners as well" hint="Owners also get every escalation, not only for people with no reporting person." />
            </div>
            <div className="border-t border-line pt-3.5">
              <p className="text-[12.5px] font-medium text-ink mb-2">Extra channels</p>
              <div className="flex flex-wrap gap-4">
                {[['email', 'Email'], ['whatsapp', 'WhatsApp']].map(([c, label]) => (
                  <label key={c} className="flex items-center gap-2 text-[13px] text-muted cursor-pointer">
                    <input type="checkbox" checked={form.channels.includes(c)} disabled={!editable} onChange={() => toggleIn('channels', c)}
                      className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                    {label}
                  </label>
                ))}
              </div>
              <p className="text-[12px] text-subtle mt-2">Each person's own notification preferences still apply.</p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Reporting & access" icon={<ShieldCheck size={16} />}
          subtitle="Who reports to whom is set on Home → Team Advance Planner. Employees never choose their own reporting person." />
        <div className="p-4 space-y-4">
          <Toggle k="managers_can_assign" title="Managers can build their own team"
            hint="A manager may add people who are not on anyone's team. Only the owner moves someone off a team or between managers." />
          <div className="border-t border-line pt-3.5">
            <p className="text-[13px] text-ink font-medium">People who can see everyone's plans</p>
            <p className="text-[12.5px] text-muted mb-2.5">
              View only. Approving and requesting changes stays with each person's reporting person.
            </p>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {(data.people || []).map((p: any) => (
                <label key={p.id} className="flex items-center gap-2 text-[13px] text-muted cursor-pointer">
                  <input type="checkbox" disabled={!editable} checked={form.full_view_user_ids.includes(p.id)}
                    onChange={() => toggleIn('full_view_user_ids', p.id)}
                    className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                  <span className="text-ink">{p.name}</span> <span className="text-subtle">· {titleCase(p.role)}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {editable && (
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(form)}>Save Advance Planner settings</Button>
      )}
    </div>
  );
}

/* ============================================================= INVOICING */
function InvoicingTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, refresh } = useAuth();
  const [scheme, setScheme] = useState('');
  const [prefix, setPrefix] = useState('');
  const [forceOpen, setForceOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.get('/settings/tenant').then((r) => r.data),
  });

  useEffect(() => {
    if (data) { setScheme(data.invoice_scheme); setPrefix(data.invoice_prefix); }
  }, [data]);

  const preview = useQuery({
    queryKey: ['numbering-preview', scheme],
    queryFn: () => api.post('/settings/tenant/numbering-preview', { scheme }).then((r) => r.data),
    enabled: !!scheme && scheme.includes('{seq'),
  });

  const save = useMutation({
    mutationFn: (force?: boolean) => api.patch(`/settings/tenant${force ? '?force=true' : ''}`, {
      invoice_scheme: scheme, invoice_prefix: prefix,
    }),
    onSuccess: async () => {
      toast.success('Numbering scheme saved.');
      qc.invalidateQueries({ queryKey: ['tenant-settings'] });
      qc.invalidateQueries({ queryKey: ['invoice-meta'] });
      setForceOpen(false);
      await refresh();
    },
    onError: (e: any) => {
      if (e.message?.includes('already been issued')) setForceOpen(true);
      else toast.error(e.message);
    },
  });

  if (isLoading || !data) return <Card><TableSkeleton rows={5} cols={2} /></Card>;

  const audit = data.numbering_audit;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Invoice numbering" icon={<Receipt size={16} />}
          subtitle="The system allocates numbers atomically — never type one by hand" />
        <div className="p-4 space-y-4">
          <div className={cx('rounded-lg border p-3',
            audit.clean
              ? 'border-[color-mix(in_srgb,var(--positive)_30%,transparent)] bg-positive-soft'
              : 'border-[color-mix(in_srgb,var(--negative)_30%,transparent)] bg-negative-soft')}>
            <p className={cx('text-[13px] font-medium', audit.clean ? 'text-[var(--positive)]' : 'text-[var(--negative)]')}>
              {audit.clean ? 'Sequence is clean' : 'Sequence needs review'}
            </p>
            <p className="text-[12.5px] text-muted mt-0.5">
              {audit.total_invoices} invoices · {audit.duplicate_numbers} duplicate numbers ·{' '}
              {audit.sequence_gaps} gaps in {audit.latest_fy || 'the current FY'}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
            <Field label="Prefix">
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                className="mono" maxLength={10} disabled={!can('settings', 'edit')} />
            </Field>
            <Field label="Scheme" hint="Placeholders: {prefix} {fy} {yyyy} {mm} {dd} {seq:4}">
              <Input value={scheme} onChange={(e) => setScheme(e.target.value)}
                className="mono" disabled={!can('settings', 'edit')} />
            </Field>
          </div>

          <div className="rounded-lg bg-sunken p-3">
            <p className="label-cap mb-1">Next invoice number</p>
            <p className="mono text-[17px] font-semibold text-ink">
              {preview.data?.number || data.numbering_preview?.number || '—'}
            </p>
            <p className="text-[12px] text-subtle mt-1">
              Financial year {preview.data?.fy || data.numbering_preview?.fy} · sequence #{preview.data?.seq || data.numbering_preview?.seq}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="label-cap">Common schemes</p>
            {[
              ['{prefix}/{fy}/{seq:4}', 'PHX/2026-27/0007'],
              ['{prefix}-{fy}-{seq:3}', 'PHX-2026-27-007'],
              ['{prefix}/{yyyy}{mm}/{seq:3}', 'PHX/202608/007'],
              ['{prefix}{fyshort}{seq:4}', 'PHX2026270007'],
            ].map(([s, example]) => (
              <button key={s} onClick={() => setScheme(s)} disabled={!can('settings', 'edit')}
                className={cx('flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                  can('settings', 'edit') && 'cursor-pointer hover:border-line-strong',
                  scheme === s ? 'border-[var(--brand)] bg-brand-soft' : 'border-line')}>
                <span className="mono text-[12px] text-muted">{s}</span>
                <span className="mono text-[12px] text-ink">{example}</span>
              </button>
            ))}
          </div>

          {can('settings', 'edit') && (
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>
              Save numbering scheme
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="How numbering is protected"
          subtitle="The safeguards behind the zero-numbering-errors target" />
        <div className="p-4 space-y-3.5 text-[13.5px] text-muted leading-relaxed">
          <Point n={1} title="Atomic allocation">
            The next sequence is claimed by a single atomic update inside the same transaction that
            writes the invoice. Two people saving at once cannot receive the same number.
          </Point>
          <Point n={2} title="Database-level uniqueness">
            Invoice numbers carry a unique constraint per workspace. Even a bug elsewhere surfaces as
            a rejected save rather than a duplicate on a client's desk.
          </Point>
          <Point n={3} title="Numbers are never reused">
            A sent invoice cannot be deleted. Corrections go through a credit note or a write-off,
            so the sequence your accountant sees stays continuous.
          </Point>
          <Point n={4} title="Continuous audit">
            Duplicates and gaps are counted on every load and shown on the invoice list, so a problem
            is visible the same day rather than at year end.
          </Point>
          <Point n={5} title="Scheme changes are guarded">
            Changing the scheme once invoices exist requires an explicit override, because mid-year
            changes are how sequences break.
          </Point>
        </div>
      </Card>

      <ConfirmDialog open={forceOpen} onClose={() => setForceOpen(false)}
        onConfirm={() => save.mutate(true)} loading={save.isPending} danger
        title="Change the numbering scheme anyway?" confirmLabel="Change scheme"
        message={
          <>
            <p>Invoices have already been issued under the current scheme.</p>
            <p className="mt-2">
              Changing it now means your invoice numbers will not follow one continuous pattern for
              the year. Do this only if you have agreed it with your accountant.
            </p>
          </>
        } />
    </div>
  );
}

const Point = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <div className="flex gap-3">
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-soft text-[12px] font-semibold text-[var(--brand)] tabular">
      {n}
    </span>
    <div>
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      <p className="mt-0.5">{children}</p>
    </div>
  </div>
);

/* ============================================================== PIPELINE */
function PipelineTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [stageOpen, setStageOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);

  const stages = useQuery({ queryKey: ['pipeline-stages'], queryFn: () => api.get('/settings/pipeline-stages').then((r) => r.data) });
  const categories = useQuery({ queryKey: ['action-categories'], queryFn: () => api.get('/settings/action-categories').then((r) => r.data) });
  const serviceLines = useQuery({ queryKey: ['service-lines'], queryFn: () => api.get('/settings/service-lines').then((r) => r.data) });

  const updateCategory = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: any }) => api.patch(`/settings/action-categories/${id}`, patch),
    onSuccess: () => { toast.success('Updated.'); qc.invalidateQueries({ queryKey: ['action-categories'] }); },
  });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Pipeline stages" subtitle="Outreach through to retention — reorder or add your own"
          icon={<Workflow size={16} />}
          action={can('settings', 'create') && (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setStageOpen(true)}>Add stage</Button>
          )} />
        {stages.isLoading ? <TableSkeleton rows={6} cols={3} /> : (
          <Table>
            <THead>
              <tr><TH width="50px">#</TH><TH>Stage</TH><TH align="right" width="110px">Probability</TH><TH align="right" width="100px">SLA</TH></tr>
            </THead>
            <tbody>
              {stages.data?.map((s: any, i: number) => (
                <TR key={s.id}>
                  <TD><span className="tabular text-subtle">{i + 1}</span></TD>
                  <TD>
                    <span className="font-medium text-ink">{s.name}</span>
                    {s.is_won === 1 && <Badge tone="positive" className="ml-2">won</Badge>}
                    <span className="mono block text-[11.5px] text-subtle">{s.code}</span>
                  </TD>
                  <TD align="right"><span className="tabular">{s.probability}%</span></TD>
                  <TD align="right"><span className="tabular text-muted">{s.sla_days ? `${s.sla_days}d` : '—'}</span></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Action item categories"
            subtitle="Escalation days per category drive when an overdue item goes to the manager"
            icon={<Tags size={16} />}
            action={can('settings', 'create') && (
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setCategoryOpen(true)}>Add</Button>
            )} />
          {categories.isLoading ? <TableSkeleton rows={5} cols={3} /> : (
            <Table>
              <THead>
                <tr><TH>Category</TH><TH width="180px">Escalates after</TH></tr>
              </THead>
              <tbody>
                {categories.data?.map((c: any) => (
                  <TR key={c.id}>
                    <TD>
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: c.color }} aria-hidden />
                        <span className="font-medium text-ink">{c.name}</span>
                      </span>
                    </TD>
                    <TD>
                      {can('settings', 'edit') ? (
                        <div className="flex items-center gap-2">
                          <Input type="number" min={0} max={60} defaultValue={c.escalation_days}
                            aria-label={`Escalation days for ${c.name}`} className="h-8 w-16 text-[13px] text-right"
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (v !== c.escalation_days) updateCategory.mutate({ id: c.id, patch: { escalation_days: v } });
                            }} />
                          <span className="text-[13px] text-subtle">days overdue</span>
                        </div>
                      ) : <span className="text-muted text-[13px]">{c.escalation_days} days overdue</span>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Service lines" subtitle="What the agency sells — SOPs and KPIs hang off these" />
          {serviceLines.isLoading ? <TableSkeleton rows={4} cols={2} /> : (
            <ul className="divide-y divide-[var(--border)]">
              {serviceLines.data?.map((s: any) => (
                <li key={s.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-1 h-3 w-3 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-ink">{s.name}</p>
                    {s.description && <p className="text-[12.5px] text-subtle leading-snug">{s.description}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {stageOpen && <StageModal onClose={() => setStageOpen(false)} />}
      {categoryOpen && <CategoryModal onClose={() => setCategoryOpen(false)} />}
    </div>
  );
}

function StageModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', code: '', probability: '50', sla_days: '14' });

  const create = useMutation({
    mutationFn: () => api.post('/settings/pipeline-stages', {
      name: form.name.trim(),
      code: form.code.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      probability: Number(form.probability),
      sla_days: Number(form.sla_days) || null,
    }),
    onSuccess: () => { toast.success('Stage added.'); qc.invalidateQueries({ queryKey: ['pipeline-stages'] }); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Add a pipeline stage" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!form.name.trim() || !form.code.trim()} onClick={() => create.mutate()}>Add</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm((f) => ({
            ...f, name: e.target.value, code: f.code || e.target.value.toLowerCase().replace(/\s+/g, '_'),
          }))} autoFocus />
        </Field>
        <Field label="Code" required>
          <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="mono" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Win probability %" hint="Feeds the conversion score">
            <Input type="number" min={0} max={100} value={form.probability}
              onChange={(e) => setForm((f) => ({ ...f, probability: e.target.value }))} />
          </Field>
          <Field label="SLA days" hint="How long is too long in this stage">
            <Input type="number" min={1} value={form.sla_days}
              onChange={(e) => setForm((f) => ({ ...f, sla_days: e.target.value }))} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function CategoryModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', code: '', escalation_days: '3', color: '#64748B' });

  const create = useMutation({
    mutationFn: () => api.post('/settings/action-categories', {
      name: form.name.trim(),
      code: form.code.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      escalation_days: Number(form.escalation_days),
      color: form.color,
    }),
    onSuccess: () => { toast.success('Category added.'); qc.invalidateQueries({ queryKey: ['action-categories'] }); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Add an action category" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!form.name.trim()} onClick={() => create.mutate()}>Add</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm((f) => ({
            ...f, name: e.target.value, code: f.code || e.target.value.toLowerCase().replace(/\s+/g, '_'),
          }))} autoFocus />
        </Field>
        <Field label="Code" required>
          <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="mono" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Escalates after (days overdue)">
            <Input type="number" min={0} max={60} value={form.escalation_days}
              onChange={(e) => setForm((f) => ({ ...f, escalation_days: e.target.value }))} />
          </Field>
          <Field label="Colour">
            <input type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
              aria-label="Category colour"
              className="h-9 w-full rounded-md border border-line-strong cursor-pointer bg-raised p-1" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* =========================================================== REASON CODES */
function ReasonCodesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['reason-codes'],
    queryFn: () => api.get('/settings/reason-codes').then((r) => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/settings/reason-codes/${id}`),
    onSuccess: () => { toast.success('Deactivated.'); qc.invalidateQueries({ queryKey: ['reason-codes'] }); setDeleting(null); },
  });

  const grouped = (data || []).reduce((acc: any, r: any) => {
    (acc[r.category] ||= []).push(r);
    return acc;
  }, {});

  const CATEGORY_HELP: Record<string, string> = {
    retention_risk: 'Why an active client is flagged as at risk. Free text is deliberately not allowed.',
    churn: 'Why a client left. Required when marking a client churned.',
    score_adjust: 'Why someone manually nudged a client score.',
    grievance: 'How a client complaint is classified.',
  };

  return (
    <>
      <Card className="mb-4">
        <div className="flex items-start gap-2.5 px-4 py-3">
          <AlertTriangle size={15} className="mt-0.5 text-[var(--brand)] shrink-0" />
          <p className="text-[13px] text-muted leading-relaxed">
            Reason codes are a managed list, not free text. That is what makes “why did we lose them”
            answerable across a year of records instead of a hundred differently worded notes.
          </p>
          {can('settings', 'create') && (
            <Button size="sm" className="ml-auto shrink-0" icon={<Plus size={14} />}
              onClick={() => setCreateOpen(true)}>Add code</Button>
          )}
        </div>
      </Card>

      {isLoading ? <Card><TableSkeleton cols={4} /></Card> : (
        <div className="grid gap-5 lg:grid-cols-2">
          {Object.entries(grouped).map(([category, codes]: any) => (
            <Card key={category}>
              <CardHeader title={titleCase(category)} subtitle={CATEGORY_HELP[category]} />
              <Table>
                <THead>
                  <tr><TH width="180px">Code</TH><TH>Label</TH><TH width="100px">Severity</TH>{can('settings', 'delete') && <TH width="50px" />}</tr>
                </THead>
                <tbody>
                  {codes.map((r: any) => (
                    <TR key={r.id}>
                      <TD mono><span className="text-subtle">{r.code}</span></TD>
                      <TD className="font-medium">{r.label}</TD>
                      <TD>
                        <Badge tone={r.severity >= 3 ? 'negative' : r.severity === 2 ? 'warning' : 'neutral'}>
                          {r.severity === 3 ? 'high' : r.severity === 2 ? 'medium' : 'low'}
                        </Badge>
                      </TD>
                      {can('settings', 'delete') && (
                        <TD align="center">
                          <button onClick={() => setDeleting(r)} aria-label={`Deactivate ${r.label}`}
                            className="text-subtle hover:text-[var(--negative)] transition-colors cursor-pointer p-1">
                            <Trash2 size={13} />
                          </button>
                        </TD>
                      )}
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          ))}
        </div>
      )}

      {createOpen && <ReasonCodeModal onClose={() => setCreateOpen(false)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutate(deleting.id)} loading={remove.isPending}
        title="Deactivate this reason code?" confirmLabel="Deactivate"
        message={<>“{deleting?.label}” stops appearing in new selections. Records that already reference it keep their label.</>} />
    </>
  );
}

function ReasonCodeModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ category: 'retention_risk', code: '', label: '', severity: '2' });

  const create = useMutation({
    mutationFn: () => api.post('/settings/reason-codes', {
      category: form.category,
      code: form.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      label: form.label.trim(),
      severity: Number(form.severity),
    }),
    onSuccess: () => { toast.success('Reason code added.'); qc.invalidateQueries({ queryKey: ['reason-codes'] }); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Add a reason code" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!form.code.trim() || !form.label.trim()} onClick={() => create.mutate()}>Add</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Category" required>
          <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
            {['retention_risk', 'churn', 'score_adjust', 'grievance'].map((c) => (
              <option key={c} value={c}>{titleCase(c)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Label" required hint="What people will pick from the list">
          <Input value={form.label} onChange={(e) => setForm((f) => ({
            ...f, label: e.target.value,
            code: f.code || e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 20),
          }))} placeholder="Slow decision-making on their side" autoFocus />
        </Field>
        <Field label="Code" required>
          <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            className="mono" />
        </Field>
        <Field label="Severity">
          <Select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
            <option value="1">Low</option>
            <option value="2">Medium</option>
            <option value="3">High</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================= ROLES */
function RolesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get('/settings/roles').then((r) => r.data),
  });

  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  const ROLES = ['owner', 'manager', 'employee', 'finance', 'hr'];
  const ACTION_LABEL: Record<string, string> = {
    view: 'V', create: 'C', edit: 'E', approve: 'A', delete: 'D', export: 'X',
  };

  return (
    <>
      <Card className="mb-4">
        <div className="px-4 py-3 text-[13px] text-muted leading-relaxed">
          Permissions are module × action. <strong className="text-ink">V</strong>iew,{' '}
          <strong className="text-ink">C</strong>reate, <strong className="text-ink">E</strong>dit,{' '}
          <strong className="text-ink">A</strong>pprove, <strong className="text-ink">D</strong>elete,{' '}
          e<strong className="text-ink">X</strong>port. Employees additionally only see their own
          records; managers see their team's.
        </div>
      </Card>

      <Card>
        <CardHeader title="Role permission matrix" subtitle="Built-in templates" icon={<KeyRound size={16} />} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-sunken">
              <tr>
                <th className="label-cap px-3 py-2 text-left border-b border-line sticky left-0 bg-sunken z-10 min-w-[160px]">
                  Module
                </th>
                {ROLES.map((r) => (
                  <th key={r} className="label-cap px-3 py-2 text-center border-b border-line min-w-[110px]">{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.modules.map((m: string) => (
                <tr key={m} className="row-hover">
                  <td className="px-3 py-2 border-b border-line sticky left-0 bg-raised z-10 text-[13px] text-ink capitalize">
                    {m.replace(/_/g, ' ')}
                  </td>
                  {ROLES.map((r) => {
                    const actions: string[] = data.templates[r]?.[m] || [];
                    return (
                      <td key={r} className="px-3 py-2 border-b border-line text-center">
                        {!actions.length ? <span className="text-subtle text-[12px]">—</span> : (
                          <span className="inline-flex gap-0.5">
                            {['view', 'create', 'edit', 'approve', 'delete', 'export'].map((a) => (
                              <span key={a} title={a}
                                className={cx('grid h-[18px] w-[18px] place-items-center rounded text-[10px] font-semibold',
                                  actions.includes(a)
                                    ? 'bg-brand-soft text-[var(--brand)]'
                                    : 'bg-transparent text-transparent')}>
                                {ACTION_LABEL[a]}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {data.custom?.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Custom roles" subtitle="Available on Growth and Scale plans" />
          <Table>
            <THead><tr><TH>Name</TH><TH width="140px">Based on</TH><TH>Overrides</TH></tr></THead>
            <tbody>
              {data.custom.map((r: any) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.name}</TD>
                  <TD><Badge tone="neutral">{titleCase(r.base_role)}</Badge></TD>
                  <TD><span className="text-muted text-[13px]">{Object.keys(r.permissions).length} module overrides</span></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

/* ============================================================== WEBHOOKS */
function WebhooksTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get('/notifications/webhooks').then((r) => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/notifications/webhooks/${id}`),
    onSuccess: () => { toast.success('Endpoint removed.'); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
  });

  if (isLoading || !data) return <Card><TableSkeleton cols={4} /></Card>;

  return (
    <>
      <Card className="mb-4">
        <div className="flex items-start gap-2.5 px-4 py-3">
          <Webhook size={15} className="mt-0.5 text-[var(--brand)] shrink-0" />
          <p className="text-[13px] text-muted leading-relaxed flex-1">
            Outbound webhooks let you automate off platform events. Each delivery is signed with
            HMAC-SHA256 in the <span className="mono text-[12px]">X-Phoenixx-Signature</span> header,
            and retried with backoff up to five times.
          </p>
          {can('settings', 'edit') && (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>Add endpoint</Button>
          )}
        </div>
      </Card>

      {secret && (
        <Card className="mb-4 border-[color-mix(in_srgb,var(--warning)_35%,transparent)]">
          <div className="p-4">
            <p className="text-[13px] font-medium text-[var(--warning)]">Signing secret — shown once</p>
            <p className="mono text-[14px] text-ink mt-1 select-all break-all">{secret}</p>
            <p className="text-[12px] text-muted mt-1.5">Store this now; it cannot be retrieved again.</p>
            <Button size="sm" className="mt-2" onClick={() => setSecret('')}>I have saved it</Button>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Endpoints" />
          {!data.endpoints.length ? (
            <EmptyState compact icon={<Webhook size={18} />} title="No endpoints"
              message="Add one to receive invoice.paid, client.stage_changed and escalation.raised events." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {data.endpoints.map((e: any) => (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="mono text-[12.5px] text-ink truncate">{e.url}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {e.events.map((ev: string) => <Badge key={ev} tone="neutral">{ev}</Badge>)}
                      </div>
                    </div>
                    {can('settings', 'edit') && (
                      <button onClick={() => remove.mutate(e.id)} aria-label="Remove endpoint"
                        className="text-subtle hover:text-[var(--negative)] transition-colors cursor-pointer p-1 shrink-0">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent deliveries" />
          {!data.recent_deliveries.length ? <EmptyState compact title="No deliveries yet" /> : (
            <Table>
              <THead><tr><TH>Event</TH><TH width="90px">Status</TH><TH width="80px">Code</TH><TH width="120px">When</TH></tr></THead>
              <tbody>
                {data.recent_deliveries.slice(0, 15).map((d: any) => (
                  <TR key={d.id}>
                    <TD mono><span className="text-[12px]">{d.event}</span></TD>
                    <TD>
                      <Badge tone={d.status === 'delivered' ? 'positive' : d.status === 'failed' ? 'negative' : 'warning'}>
                        {d.status}
                      </Badge>
                    </TD>
                    <TD><span className="tabular text-muted text-[13px]">{d.response_code || '—'}</span></TD>
                    <TD><span className="text-subtle text-[12.5px]">{relative(d.created_at)}</span></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {createOpen && <WebhookModal availableEvents={data.available_events} onCreated={setSecret} onClose={() => setCreateOpen(false)} />}
    </>
  );
}

function WebhookModal({ availableEvents, onCreated, onClose }: {
  availableEvents: string[]; onCreated: (s: string) => void; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () => api.post('/notifications/webhooks', { url: url.trim(), events }),
    onSuccess: (res: any) => {
      onCreated(res.data.secret);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      toast.success('Endpoint registered.');
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Add a webhook endpoint"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!url.trim() || !events.length}
            onClick={() => create.mutate()}>Register</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Endpoint URL" required>
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.zapier.com/…" className="mono text-[13px]" autoFocus />
        </Field>
        <Field label="Events" required hint={`${events.length} selected`}>
          <div className="space-y-1.5">
            {availableEvents.map((ev) => (
              <label key={ev} className="flex items-center gap-2.5 text-[13px] text-ink cursor-pointer">
                <input type="checkbox" checked={events.includes(ev)}
                  onChange={(e) => setEvents((s) => e.target.checked ? [...s, ev] : s.filter((x) => x !== ev))}
                  className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                <span className="mono text-[12.5px]">{ev}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================= AUDIT */
function AuditTab() {
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['audit', entity, action, page],
    queryFn: () => api.get('/settings/audit', { entity, action, page, limit: 50 }),
  });

  const rows = data?.data || [];
  const meta = data?.meta || {};

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Select value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }}
            aria-label="Entity" className="w-[160px]">
            <option value="">All entities</option>
            {['client', 'invoice', 'action_item', 'user', 'proposal', 'sop', 'cost', 'tenant', 'report']
              .map((e) => <option key={e} value={e}>{titleCase(e)}</option>)}
          </Select>
          <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
            aria-label="Action" className="w-[150px]">
            <option value="">All actions</option>
            {['create', 'update', 'delete', 'approve', 'reject', 'login', 'export']
              .map((a) => <option key={a} value={a}>{titleCase(a)}</option>)}
          </Select>
          <p className="ml-auto text-[12.5px] text-subtle">
            Every create, update, delete and approval is recorded with before/after values.
          </p>
        </div>
      </Card>

      {isLoading ? <Card><TableSkeleton cols={5} /></Card>
        : !rows.length ? <Card><EmptyState icon={<History size={20} />} title="No audit entries match" /></Card>
          : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH width="170px">When</TH>
                    <TH width="160px">Who</TH>
                    <TH width="110px">Action</TH>
                    <TH width="150px">Entity</TH>
                    <TH>Change</TH>
                  </tr>
                </THead>
                <tbody>
                  {rows.map((a: any) => (
                    <TR key={a.id}>
                      <TD><span className="text-muted text-[13px]">{dateTime(a.created_at)}</span></TD>
                      <TD><span className="text-ink text-[13px]">{a.actor_name || 'system'}</span></TD>
                      <TD>
                        <Badge tone={a.action === 'delete' ? 'negative' : a.action === 'create' ? 'positive'
                          : a.action === 'approve' ? 'brand' : 'neutral'}>
                          {a.action}
                        </Badge>
                      </TD>
                      <TD><span className="text-muted text-[13px] capitalize">{a.entity.replace('_', ' ')}</span></TD>
                      <TD>
                        <AuditDiff before={a.before} after={a.after} />
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              {meta.pages > 1 && (
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                  <span className="text-[13px] text-subtle">Page {meta.page} of {meta.pages} · {meta.total} entries</span>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button size="sm" disabled={!meta.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </Card>
          )}
    </>
  );
}

function AuditDiff({ before, after }: { before: any; after: any }) {
  if (!after) return <span className="text-subtle text-[12.5px]">—</span>;

  const SKIP = new Set(['updated_at', 'created_at', 'tenant_id', 'id']);
  const keys = Object.keys(after).filter((k) => !SKIP.has(k)
    && (!before || JSON.stringify(before[k]) !== JSON.stringify(after[k])));

  if (!keys.length) return <span className="text-subtle text-[12.5px]">no field changes</span>;

  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
      {keys.slice(0, 4).map((k) => (
        <span key={k} className="text-muted">
          <span className="text-subtle">{k.replace(/_/g, ' ')}:</span>{' '}
          {before && before[k] !== undefined && (
            <span className="line-through text-subtle">{String(before[k]).slice(0, 22) || '∅'}</span>
          )}{' '}
          <span className="text-ink">{String(after[k]).slice(0, 26)}</span>
        </span>
      ))}
      {keys.length > 4 && <span className="text-subtle">+{keys.length - 4} more</span>}
    </span>
  );
}
