import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell,
} from 'recharts';
import {
  ShieldCheck, Building2, TrendingUp, Activity, Play, Megaphone, Ticket, LogIn, AlertTriangle, Plus,
} from 'lucide-react';
import { api, tokens } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date, dateTime, relative, percent, monthLabel, titleCase, num } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, Select, Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs,
  Textarea, useToast, cx, Skeleton,
} from '../components/ui';

/** S9 — the platform Super Admin console: tenants, plans, coupons, health. */
export default function Admin() {
  const [tab, setTab] = useState('overview');

  return (
    <>
      <PageHeader
        title="Platform console"
        subtitle="Across every tenant — MRR, activation, health and background jobs"
        tabs={
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'tenants', label: 'Tenants' },
            { id: 'plans', label: 'Plans & coupons' },
            { id: 'health', label: 'System health' },
          ]} />
        }
      />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'tenants' && <TenantsTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'health' && <HealthTab />}
    </>
  );
}

/* ============================================================== OVERVIEW */
function OverviewTab() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-metrics'],
    queryFn: () => api.get('/admin/metrics').then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
    {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
  </div>;

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-5">
        <Stat label="MRR" value={money(data.mrr_minor, { compact: true })} icon={<TrendingUp size={15} />}
          sub={`ARR ${money(data.arr_minor, { compact: true })}`} />
        <Stat label="Paying tenants" value={data.subscriptions.active} icon={<Building2 size={15} />}
          sub={`${data.subscriptions.trial} on trial`} />
        <Stat label="ARPA" value={money(data.arpa_minor, { compact: true })}
          sub="Average revenue per account" />
        <Stat label="Logo churn" value={percent(data.logo_churn_pct)}
          tone={data.logo_churn_pct < 3 ? 'positive' : 'negative'} sub="This month · target under 3%" />
        <Stat label="Trial conversion" value={percent(data.trial_conversion_pct)}
          tone={data.trial_conversion_pct >= 15 ? 'positive' : 'warning'} sub="Target 15%" />
        <Stat label="Activation" value={percent(data.activation_pct)}
          sub="Tenants with 3+ clients created" />
        <Stat label="Total users" value={num(data.total_users)} />
        <Stat label="Past due" value={data.subscriptions.past_due}
          tone={data.subscriptions.past_due ? 'negative' : 'neutral'} icon={<AlertTriangle size={15} />} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Tenant signups" subtitle="Last six months" icon={<TrendingUp size={16} />} />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={230}>
              <AreaChart data={data.signups_trend.map((s: any) => ({ ...s, label: monthLabel(s.month).split(' ')[0] }))}
                margin={{ top: 6, right: 6, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gSignup" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1e40af" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#1e40af" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="signups" name="Signups" stroke="#1e40af" strokeWidth={2} fill="url(#gSignup)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Revenue by plan band" />
          <Table>
            <THead>
              <tr><TH>Plan</TH><TH align="right" width="70px">Active</TH><TH align="right" width="100px">MRR</TH></tr>
            </THead>
            <tbody>
              {data.by_plan.map((p: any) => (
                <TR key={p.plan}>
                  <TD>
                    <span className="font-medium text-ink">{p.name}</span>
                    <span className="block text-[11.5px] text-subtle">{p.trial} on trial</span>
                  </TD>
                  <TD align="right"><span className="tabular">{p.active}</span></TD>
                  <TD align="right" className="font-medium">{money(p.mrr_minor, { compact: true })}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}

/* =============================================================== TENANTS */
function TenantsTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['admin-tenants'],
    queryFn: () => api.get('/admin/tenants').then((r) => r.data),
  });

  if (isLoading) return <Card><TableSkeleton cols={7} /></Card>;

  return (
    <>
      <Card>
        <Table>
          <THead>
            <tr>
              <TH>Tenant</TH>
              <TH width="120px">Plan</TH>
              <TH width="120px">Subscription</TH>
              <TH align="right" width="90px">Users</TH>
              <TH align="right" width="90px">Clients</TH>
              <TH width="130px">Last activity</TH>
              <TH width="110px">Health</TH>
            </tr>
          </THead>
          <tbody>
            {data?.map((t: any) => (
              <TR key={t.id} onClick={() => setOpenId(t.id)}>
                <TD>
                  <span className="block font-medium text-ink">{t.name}</span>
                  <span className="mono block text-[11.5px] text-subtle">{t.slug}</span>
                </TD>
                <TD><Badge tone="neutral">{t.plan_name || '—'}</Badge></TD>
                <TD><StatusBadge status={t.subscription_status} /></TD>
                <TD align="right">
                  <span className={cx('tabular', t.over_band && 'text-[var(--warning)] font-medium')}>
                    {t.usage.users}
                  </span>
                  {t.band_max_users && <span className="text-subtle">/{t.band_max_users}</span>}
                </TD>
                <TD align="right"><span className="tabular">{t.usage.clients}</span></TD>
                <TD>
                  <span className="text-muted text-[13px]">
                    {t.last_activity_at ? relative(t.last_activity_at) : 'never'}
                  </span>
                </TD>
                <TD><StatusBadge status={t.health} /></TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>

      {openId && <TenantDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function TenantDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [impersonateOpen, setImpersonateOpen] = useState(false);
  const [statusChange, setStatusChange] = useState<string | null>(null);

  const { data: t, isLoading } = useQuery({
    queryKey: ['admin-tenant', id],
    queryFn: () => api.get(`/admin/tenants/${id}`).then((r) => r.data),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/admin/tenants/${id}/status`, { status }),
    onSuccess: () => {
      toast.success('Tenant status updated.');
      qc.invalidateQueries({ queryKey: ['admin-tenants'] });
      qc.invalidateQueries({ queryKey: ['admin-tenant', id] });
      setStatusChange(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const setFlag = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.put(`/admin/tenants/${id}/flags`, { flag_key: key, enabled }),
    onSuccess: () => { toast.success('Feature flag updated.'); qc.invalidateQueries({ queryKey: ['admin-tenant', id] }); },
  });

  if (isLoading || !t) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={5} cols={2} /></div></Drawer>;
  }

  const supportEnabled = !!t.settings?.support_access_enabled;

  return (
    <>
      <Drawer open onClose={onClose} title={t.name} width="max-w-2xl"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            <Badge tone="neutral">{t.subscription?.plan_name}</Badge>
            <span className="mono text-subtle">{t.slug}</span>
          </span>
        }
        footer={
          <>
            {t.status === 'active' ? (
              <Button variant="ghost" onClick={() => setStatusChange('suspended')}>Suspend</Button>
            ) : (
              <Button onClick={() => setStatusChange('active')}>Reactivate</Button>
            )}
            <Button variant="primary" icon={<LogIn size={15} />} disabled={!supportEnabled}
              onClick={() => setImpersonateOpen(true)}>
              {supportEnabled ? 'Impersonate' : 'Support access off'}
            </Button>
          </>
        }>
        <div className="p-5 space-y-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg bg-sunken p-3.5 text-[13px]">
            <Detail label="Created" value={date(t.created_at)} />
            <Detail label="Timezone" value={t.timezone} />
            <Detail label="Currency" value={t.currency} />
            <Detail label="GSTIN" value={t.gstin} />
            <Detail label="Subscription" value={titleCase(t.subscription?.status)} />
            <Detail label="Period ends" value={t.subscription?.current_period_end ? date(t.subscription.current_period_end) : '—'} />
          </dl>

          <div>
            <p className="label-cap mb-2">Users ({t.users.length})</p>
            <Table>
              <THead><tr><TH>Name</TH><TH width="110px">Role</TH><TH width="130px">Last sign-in</TH><TH width="90px">Status</TH></tr></THead>
              <tbody>
                {t.users.map((u: any) => (
                  <TR key={u.id}>
                    <TD>
                      <span className="block font-medium text-ink">{u.name}</span>
                      <span className="block text-[11.5px] text-subtle">{u.email}</span>
                    </TD>
                    <TD><Badge tone="neutral">{titleCase(u.role)}</Badge></TD>
                    <TD><span className="text-subtle text-[12.5px]">{u.last_login_at ? relative(u.last_login_at) : 'never'}</span></TD>
                    <TD><StatusBadge status={u.status} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>

          <div>
            <p className="label-cap mb-2">Feature flag overrides</p>
            <p className="text-[12.5px] text-subtle mb-2.5">
              Overrides sit on top of the plan matrix — use them for pilots and support fixes.
            </p>
            <div className="space-y-1.5">
              {['custom_roles', 'client_portal', 'report_builder', 'api_access', 'white_label_reports'].map((key) => {
                const flag = t.feature_flags?.find((f: any) => f.flag_key === key);
                return (
                  <label key={key} className="flex items-center gap-2.5 text-[13px] text-ink cursor-pointer">
                    <input type="checkbox" checked={!!flag?.enabled}
                      onChange={(e) => setFlag.mutate({ key, enabled: e.target.checked })}
                      className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                    <span className="capitalize">{key.replace(/_/g, ' ')}</span>
                    {flag && <Badge tone="brand">override</Badge>}
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <p className="label-cap mb-2">Recent activity</p>
            {!t.recent_activity?.length ? (
              <p className="text-[13px] text-subtle">No audit entries.</p>
            ) : (
              <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                {t.recent_activity.map((a: any) => (
                  <li key={a.id} className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="text-subtle shrink-0 w-[110px]">{dateTime(a.created_at)}</span>
                    <span className="text-muted">
                      <span className="text-ink">{a.actor_name || 'system'}</span> {a.action}d {a.entity.replace('_', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Drawer>

      {impersonateOpen && <ImpersonateModal tenantId={id} tenantName={t.name} onClose={() => setImpersonateOpen(false)} />}

      <ConfirmDialog open={!!statusChange} onClose={() => setStatusChange(null)}
        onConfirm={() => setStatus.mutate(statusChange!)} loading={setStatus.isPending}
        danger={statusChange === 'suspended'}
        title={statusChange === 'suspended' ? `Suspend ${t.name}?` : `Reactivate ${t.name}?`}
        confirmLabel={statusChange === 'suspended' ? 'Suspend' : 'Reactivate'}
        message={statusChange === 'suspended'
          ? 'The workspace becomes read-only. Users can still sign in and export, but nothing can be changed. No data is deleted.'
          : 'The workspace returns to normal read-write operation.'} />
    </>
  );
}

const Detail = ({ label, value }: { label: string; value?: string | null }) => (
  value ? (
    <div>
      <dt className="label-cap">{label}</dt>
      <dd className="text-ink mt-0.5 truncate">{value}</dd>
    </div>
  ) : null
);

function ImpersonateModal({ tenantId, tenantName, onClose }: {
  tenantId: string; tenantName: string; onClose: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');

  const impersonate = useMutation({
    mutationFn: () => api.post(`/admin/tenants/${tenantId}/impersonate`, { reason: reason.trim() }),
    onSuccess: (res: any) => {
      // Swapping the access token drops this session into the tenant's workspace.
      tokens.set(res.data.access_token);
      toast.warn(`Now acting as ${res.data.impersonating.user} in ${res.data.impersonating.tenant}. This is logged in their audit trail.`);
      setTimeout(() => { window.location.href = '/'; }, 900);
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={`Impersonate ${tenantName}`} size="sm"
      subtitle="Only possible because this tenant has granted support access"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={impersonate.isPending} disabled={reason.trim().length < 5}
            onClick={() => impersonate.mutate()}>Start session</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft p-3">
          <p className="text-[13px] font-medium text-[var(--warning)]">This is recorded</p>
          <p className="text-[12.5px] text-muted mt-0.5 leading-relaxed">
            A login entry naming you and this reason is written to the tenant's own audit log, where
            their owner can see it. The session lasts 15 minutes.
          </p>
        </div>
        <Field label="Reason" required hint="Reference the support ticket where you can">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            placeholder="Ticket #482 — invoice PDF not rendering; reproducing with their data." autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================= PLANS */
function PlansTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [couponOpen, setCouponOpen] = useState(false);

  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get('/admin/plans').then((r) => r.data) });
  const coupons = useQuery({ queryKey: ['admin-coupons'], queryFn: () => api.get('/admin/coupons').then((r) => r.data) });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.del(`/admin/coupons/${id}`),
    onSuccess: () => { toast.success('Coupon deactivated.'); qc.invalidateQueries({ queryKey: ['admin-coupons'] }); },
  });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Plans" subtitle="Flat rate by agency-size band" />
        {plans.isLoading ? <TableSkeleton cols={4} /> : (
          <Table>
            <THead>
              <tr><TH>Plan</TH><TH width="110px">Band</TH><TH align="right" width="110px">Monthly</TH><TH align="right" width="110px">Yearly</TH></tr>
            </THead>
            <tbody>
              {plans.data?.map((p: any) => (
                <TR key={p.id}>
                  <TD>
                    <span className="font-medium text-ink">{p.name}</span>
                    <span className="mono block text-[11.5px] text-subtle">{p.code}</span>
                  </TD>
                  <TD><span className="text-muted text-[13px]">{p.band_min_users}–{p.band_max_users}</span></TD>
                  <TD align="right">{money(p.price_monthly_minor)}</TD>
                  <TD align="right">{money(p.price_yearly_minor)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Coupons" icon={<Ticket size={16} />}
          action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setCouponOpen(true)}>New coupon</Button>} />
        {coupons.isLoading ? <TableSkeleton cols={4} />
          : !coupons.data?.length ? <EmptyState compact title="No coupons" />
            : (
              <Table>
                <THead>
                  <tr><TH width="140px">Code</TH><TH>Offer</TH><TH width="110px">Redeemed</TH><TH width="90px">Status</TH></tr>
                </THead>
                <tbody>
                  {coupons.data.map((c: any) => (
                    <TR key={c.id}>
                      <TD mono className="font-medium">{c.code}</TD>
                      <TD>
                        <span className="text-muted text-[13px]">
                          {c.kind === 'percent' ? `${c.value}% off`
                            : c.kind === 'amount' ? `${money(c.value)} off`
                              : `${c.value} months free`}
                        </span>
                      </TD>
                      <TD>
                        <span className="tabular text-muted text-[13px]">
                          {c.redeemed}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}
                        </span>
                      </TD>
                      <TD>
                        {c.active ? (
                          <button onClick={() => deactivate.mutate(c.id)}
                            className="text-[12px] text-[var(--brand)] hover:underline cursor-pointer">
                            Deactivate
                          </button>
                        ) : <Badge tone="neutral">inactive</Badge>}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
      </Card>

      <AnnouncementsCard />

      {couponOpen && <CouponModal onClose={() => setCouponOpen(false)} />}
    </div>
  );
}

function CouponModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ code: '', kind: 'percent', value: '20', max_redemptions: '100', duration_months: '3' });

  const create = useMutation({
    mutationFn: () => api.post('/admin/coupons', {
      code: form.code.trim().toUpperCase(),
      kind: form.kind,
      value: Number(form.value),
      max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : undefined,
      duration_months: form.kind === 'free_months' ? Number(form.duration_months) : undefined,
    }),
    onSuccess: () => { toast.success('Coupon created.'); qc.invalidateQueries({ queryKey: ['admin-coupons'] }); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Create a coupon" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.code.trim().length < 3}
            onClick={() => create.mutate()}>Create</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Code" required>
          <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            className="mono" placeholder="LAUNCH3" autoFocus />
        </Field>
        <Field label="Type">
          <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
            <option value="percent">Percentage off</option>
            <option value="amount">Fixed amount off</option>
            <option value="free_months">Free months</option>
          </Select>
        </Field>
        <Field label={form.kind === 'percent' ? 'Percentage' : form.kind === 'amount' ? 'Amount (paise)' : 'Number of months'} required>
          <Input type="number" min={1} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
        </Field>
        <Field label="Maximum redemptions">
          <Input type="number" min={1} value={form.max_redemptions}
            onChange={(e) => setForm((f) => ({ ...f, max_redemptions: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

function AnnouncementsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', level: 'info' });

  const { data } = useQuery({
    queryKey: ['admin-announcements'],
    queryFn: () => api.get('/admin/announcements').then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: () => api.post('/admin/announcements', {
      title: form.title.trim(), body: form.body || null, level: form.level,
    }),
    onSuccess: () => {
      toast.success('Announcement published to every tenant.');
      qc.invalidateQueries({ queryKey: ['admin-announcements'] });
      setForm({ title: '', body: '', level: 'info' });
      setOpen(false);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/admin/announcements/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-announcements'] }),
  });

  return (
    <>
      <Card>
        <CardHeader title="Announcements" subtitle="Shown as a banner across every tenant" icon={<Megaphone size={16} />}
          action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setOpen(true)}>New</Button>} />
        {!data?.length ? <EmptyState compact title="No announcements" /> : (
          <ul className="divide-y divide-[var(--border)]">
            {data.slice(0, 8).map((a: any) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <Badge tone={a.level === 'critical' ? 'negative' : a.level === 'warning' ? 'warning' : 'brand'}>
                  {a.level}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-ink">{a.title}</p>
                  {a.body && <p className="text-[12.5px] text-subtle leading-snug">{a.body}</p>}
                  <p className="text-[11.5px] text-subtle mt-0.5">{relative(a.created_at)}</p>
                </div>
                <button onClick={() => remove.mutate(a.id)} aria-label="Remove announcement"
                  className="text-subtle hover:text-[var(--negative)] transition-colors cursor-pointer shrink-0">×</button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && (
        <Modal open onClose={() => setOpen(false)} title="New announcement" size="sm"
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={create.isPending} disabled={form.title.trim().length < 3}
                onClick={() => create.mutate()}>Publish</Button>
            </>
          }>
          <div className="space-y-4">
            <Field label="Title" required>
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} autoFocus />
            </Field>
            <Field label="Body">
              <Textarea value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} rows={3} />
            </Field>
            <Field label="Level">
              <Select value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </Select>
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ================================================================ HEALTH */
function HealthTab() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api.get('/admin/health').then((r) => r.data),
    refetchInterval: 30_000,
  });

  const runJob = useMutation({
    mutationFn: (key: string) => api.post(`/admin/jobs/${key}/run`),
    onSuccess: (res: any) => {
      toast.success(`Ran ${res.data.job}.`);
      qc.invalidateQueries({ queryKey: ['admin-health'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Background jobs" subtitle="Deadline ladder, scoring, reports, webhooks"
          icon={<Activity size={16} />} />
        <Table>
          <THead>
            <tr><TH>Job</TH><TH align="right" width="70px">Runs</TH><TH align="right" width="80px">Errors</TH>
              <TH width="120px">Last run</TH><TH width="80px" /></tr>
          </THead>
          <tbody>
            {data.job_summary?.map((j: any) => (
              <TR key={j.job_key}>
                <TD mono><span className="text-[12.5px]">{j.job_key}</span></TD>
                <TD align="right"><span className="tabular text-muted">{j.runs}</span></TD>
                <TD align="right">
                  <span className={cx('tabular', Number(j.errors) > 0 ? 'text-[var(--negative)] font-medium' : 'text-subtle')}>
                    {j.errors}
                  </span>
                </TD>
                <TD><span className="text-subtle text-[12.5px]">{relative(j.last_run)}</span></TD>
                <TD>
                  <Button size="sm" icon={<Play size={12} />} loading={runJob.isPending}
                    onClick={() => runJob.mutate(j.job_key)}>Run</Button>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
        <div className="border-t border-line p-3 flex flex-wrap gap-1.5">
          {data.available_jobs?.filter((k: string) => !data.job_summary?.some((j: any) => j.job_key === k))
            .map((k: string) => (
              <Button key={k} size="sm" variant="ghost" icon={<Play size={12} />} onClick={() => runJob.mutate(k)}>
                {k}
              </Button>
            ))}
        </div>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Notification delivery" subtitle="Last 24 hours by channel" />
          {!data.notifications_24h?.length ? <EmptyState compact title="Nothing sent in the last day" /> : (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.values(
                  data.notifications_24h.reduce((acc: any, r: any) => {
                    acc[r.channel] ||= { channel: r.channel, delivered: 0, failed: 0, sent: 0 };
                    acc[r.channel][r.status === 'failed' ? 'failed' : 'delivered'] += r.n;
                    return acc;
                  }, {}),
                )} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="channel" tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={34} />
                  <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="delivered" name="Delivered" fill="#15803d" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="failed" name="Failed" fill="#b91c1c" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent job runs" />
          <div className="max-h-80 overflow-y-auto">
            <Table>
              <THead>
                <tr><TH>Job</TH><TH width="90px">Status</TH><TH align="right" width="90px">Processed</TH><TH width="120px">Started</TH></tr>
              </THead>
              <tbody>
                {data.jobs?.slice(0, 25).map((j: any) => (
                  <TR key={j.id}>
                    <TD mono><span className="text-[12px]">{j.job_key}</span></TD>
                    <TD>
                      <Badge tone={j.status === 'ok' ? 'positive' : j.status === 'error' ? 'negative' : 'warning'}>
                        {j.status}
                      </Badge>
                    </TD>
                    <TD align="right"><span className="tabular text-muted text-[13px]">{j.processed}</span></TD>
                    <TD><span className="text-subtle text-[12px]">{relative(j.started_at)}</span></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
          {data.webhook_failures > 0 && (
            <div className="border-t border-line px-4 py-2.5 text-[13px] text-[var(--negative)]">
              {data.webhook_failures} webhook deliveries have exhausted their retries.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
