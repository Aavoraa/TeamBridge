import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard, Check, Zap, Users2, HardDrive, MessageSquare, AlertTriangle, Package,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date, relative, percent, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, Meter,
  Modal, PageHeader, Select, Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR,
  Textarea, useToast, cx, Skeleton,
} from '../components/ui';

const FEATURE_LABELS: Record<string, string> = {
  custom_roles: 'Custom roles', client_portal: 'Client portal', report_builder: 'Report builder',
  api_access: 'API access', white_label_reports: 'White-label reports', whatsapp: 'WhatsApp alerts',
};

/** PRD §4 — plan, usage against limits, plan changes with proration, and add-ons. */
export default function Billing() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, refresh } = useAuth();
  const [changing, setChanging] = useState<any>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [addonOpen, setAddonOpen] = useState(false);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');

  const sub = useQuery({
    queryKey: ['subscription'],
    queryFn: () => api.get('/billing/subscription').then((r) => r.data),
  });
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get('/billing/plans').then((r) => r.data),
  });

  const cancel = useMutation({
    mutationFn: () => api.post('/billing/subscription/cancel', { immediate: false }),
    onSuccess: (res: any) => {
      toast.success(res.data.message);
      qc.invalidateQueries({ queryKey: ['subscription'] });
      setCancelOpen(false);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const reactivate = useMutation({
    mutationFn: () => api.post('/billing/subscription/reactivate'),
    onSuccess: async () => {
      toast.success('Subscription reactivated.');
      qc.invalidateQueries({ queryKey: ['subscription'] });
      await refresh();
    },
  });

  if (sub.error) return <ErrorState error={sub.error} retry={sub.refetch} />;
  if (sub.isLoading || !sub.data) return <BillingSkeleton />;

  const s = sub.data;
  const usage = s.usage;
  const trialDays = s.trial_days_left;

  return (
    <>
      <PageHeader
        title="Billing & plan"
        subtitle={`${s.plan_name} · billed ${s.billing_cycle}`}
        actions={
          <>
            {s.cancelled_at ? (
              <Button variant="primary" loading={reactivate.isPending} onClick={() => reactivate.mutate()}>
                Reactivate
              </Button>
            ) : can('billing', 'edit') && (
              <>
                <Button icon={<Package size={15} />} onClick={() => setAddonOpen(true)}>Buy add-ons</Button>
                <Button variant="ghost" onClick={() => setCancelOpen(true)}>Cancel plan</Button>
              </>
            )}
          </>
        }
      />

      {s.status === 'trial' && (
        <Card className="mb-5 border-l-4 border-l-[var(--accent-bg)]">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Zap size={16} className="text-[var(--accent)] shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-ink">
                Trial ends {relative(s.trial_ends_at)}{trialDays != null && ` · ${trialDays} day${trialDays === 1 ? '' : 's'} left`}
              </p>
              <p className="text-[12.5px] text-subtle">
                No card on file. Pick a plan below to keep everything running when the trial ends.
              </p>
            </div>
          </div>
        </Card>
      )}

      {s.status === 'past_due' && (
        <Card className="mb-5 border-l-4 border-l-[var(--negative)]">
          <div className="flex items-start gap-2.5 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 text-[var(--negative)] shrink-0" />
            <div>
              <p className="text-[13.5px] font-medium text-[var(--negative)]">Payment outstanding</p>
              <p className="text-[12.5px] text-muted mt-0.5">
                The workspace keeps working during the grace period. If it lapses, the workspace becomes
                read-only until billing is restored — nothing is deleted.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ usage */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-5">
        <UsageStat label="Users" icon={<Users2 size={15} />}
          used={usage.users} limit={usage.users_limit} unit="" />
        <UsageStat label="Clients" icon={<CreditCard size={15} />}
          used={usage.clients} limit={usage.clients_limit} unit="" />
        <UsageStat label="Storage" icon={<HardDrive size={15} />}
          used={usage.storage_mb} limit={usage.storage_limit_mb} unit=" MB" />
        <UsageStat label="WhatsApp credits" icon={<MessageSquare size={15} />}
          used={usage.whatsapp_sent} limit={usage.whatsapp_credits} unit="" />
      </div>

      {s.addon_seats > 0 && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Users2 size={15} className="text-[var(--accent)] shrink-0" />
            <p className="text-[13.5px] text-ink">
              <strong>{s.addon_seats}</strong> user{s.addon_seats === 1 ? '' : 's'} beyond your plan band —
              billed as add-on seats at {money(s.addon_user_monthly_minor)} each per month.
            </p>
            <span className="ml-auto tabular font-semibold text-ink">{money(s.addon_monthly_minor)}/mo</span>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ plans */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[16px] font-semibold text-ink">Plans</h2>
        <div className="flex rounded-md border border-line-strong overflow-hidden">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} onClick={() => setCycle(c)} aria-pressed={cycle === c}
              className={cx('px-3 h-8 text-[13px] font-medium cursor-pointer transition-colors duration-150',
                cycle === c ? 'bg-brand-soft text-[var(--brand)]' : 'text-subtle hover:bg-sunken',
                c === 'yearly' && 'border-l border-line')}>
              {c === 'monthly' ? 'Monthly' : 'Yearly · save ~17%'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-5">
        {plans.data?.map((p: any) => {
          const current = p.code === s.plan_code;
          const price = cycle === 'yearly' ? p.price_yearly_minor : p.price_monthly_minor;
          const tooSmall = usage.users > p.band_max_users;
          return (
            <Card key={p.code} className={cx('flex flex-col', current && 'ring-1 ring-[var(--brand)] border-[var(--brand)]')}>
              <div className="p-4 border-b border-line">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[16px] font-semibold text-ink">{p.name}</h3>
                  {current && <Badge tone="brand" dot>current</Badge>}
                </div>
                <p className="mt-2">
                  <span className="text-[26px] font-semibold text-ink tabular">{money(price)}</span>
                  <span className="text-[13px] text-subtle">/{cycle === 'yearly' ? 'year' : 'month'}</span>
                </p>
                <p className="mt-0.5 text-[12.5px] text-subtle">
                  {p.band_min_users === 1 ? `Up to ${p.band_max_users}` : `${p.band_min_users}–${p.band_max_users}`} users ·
                  unlimited within the band
                </p>
                <p className="text-[12px] text-subtle">Plus 18% GST</p>
              </div>

              <ul className="p-4 space-y-2 grow">
                <PlanFeature ok>{p.limits.clients ? `${p.limits.clients} clients` : 'Unlimited clients'}</PlanFeature>
                <PlanFeature ok>{(p.limits.storage_mb / 1000).toFixed(0)} GB storage</PlanFeature>
                <PlanFeature ok>{p.limits.wa_credits.toLocaleString('en-IN')} WhatsApp credits / month</PlanFeature>
                {Object.entries(FEATURE_LABELS).map(([key, label]) => (
                  <PlanFeature key={key} ok={!!p.features[key]}>{label}</PlanFeature>
                ))}
              </ul>

              <div className="p-4 pt-0">
                {current ? (
                  <Button className="w-full justify-center" disabled>Current plan</Button>
                ) : can('billing', 'edit') ? (
                  <Button variant={tooSmall ? 'secondary' : 'primary'} className="w-full justify-center"
                    disabled={tooSmall} onClick={() => setChanging({ plan: p, cycle })}>
                    {tooSmall ? `Needs ≥ ${usage.users} user seats` : `Switch to ${p.name}`}
                  </Button>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Billing history" subtitle="Subscription invoices for this workspace" />
        {!s.invoices?.length ? (
          <EmptyState compact title="No invoices yet"
            message="Your first subscription invoice appears when the trial converts." />
        ) : (
          <Table>
            <THead>
              <tr><TH width="190px">Number</TH><TH width="180px">Period</TH>
                <TH align="right" width="110px">Amount</TH><TH align="right" width="100px">GST</TH>
                <TH align="right" width="110px">Total</TH><TH width="110px">Status</TH></tr>
            </THead>
            <tbody>
              {s.invoices.map((i: any) => (
                <TR key={i.id}>
                  <TD mono>{i.number}</TD>
                  <TD>
                    <span className="text-muted text-[13px]">
                      {i.period_start ? `${date(i.period_start, 'day')} – ${date(i.period_end)}` : date(i.created_at)}
                    </span>
                  </TD>
                  <TD align="right">{money(i.amount_minor)}</TD>
                  <TD align="right"><span className="text-subtle">{money(i.tax_minor)}</span></TD>
                  <TD align="right" className="font-medium">{money(i.total_minor)}</TD>
                  <TD><StatusBadge status={i.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {changing && <ChangePlanModal change={changing} onClose={() => setChanging(null)} />}
      {addonOpen && <AddonModal onClose={() => setAddonOpen(false)} />}

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)}
        onConfirm={() => cancel.mutate()} loading={cancel.isPending} danger confirmLabel="Cancel plan"
        title="Cancel this subscription?"
        message={
          <>
            <p>The workspace keeps working until the end of the current period.</p>
            <p className="mt-2">
              After that it becomes read-only, and your data stays exportable for 90 days. Nothing is
              deleted during that window.
            </p>
          </>
        } />
    </>
  );
}

function UsageStat({ label, icon, used, limit, unit }: {
  label: string; icon: React.ReactNode; used: number; limit?: number | null; unit: string;
}) {
  const pct = limit ? (used / limit) * 100 : 0;
  const tone = !limit ? 'brand' : pct >= 90 ? 'negative' : pct >= 75 ? 'warning' : 'positive';
  return (
    <Card className="p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label-cap truncate">{label}</span>
        <span className="text-subtle shrink-0">{icon}</span>
      </div>
      <p className="mt-1.5 text-[20px] font-semibold text-ink tabular">
        {used.toLocaleString('en-IN')}{unit}
        {limit != null && <span className="text-[13px] font-normal text-subtle"> / {limit.toLocaleString('en-IN')}{unit}</span>}
      </p>
      {limit != null
        ? <Meter value={used} max={limit} tone={tone as any} className="mt-2" />
        : <p className="mt-1 text-[12px] text-subtle">Unlimited on this plan</p>}
    </Card>
  );
}

const PlanFeature = ({ ok, children }: { ok?: boolean; children: React.ReactNode }) => (
  <li className={cx('flex items-start gap-2 text-[13px]', ok ? 'text-muted' : 'text-subtle')}>
    <Check size={14} className={cx('mt-0.5 shrink-0', ok ? 'text-[var(--positive)]' : 'text-line-strong')} />
    <span className={!ok ? 'line-through decoration-1' : ''}>{children}</span>
  </li>
);

/* -------------------------------------------------------------- change plan */
function ChangePlanModal({ change, onClose }: { change: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();
  const [coupon, setCoupon] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');

  const quote = useQuery({
    queryKey: ['plan-quote', change.plan.code, change.cycle, appliedCoupon],
    queryFn: () => api.post('/billing/subscription/quote', {
      plan_code: change.plan.code,
      billing_cycle: change.cycle,
      ...(appliedCoupon ? { coupon_code: appliedCoupon } : {}),
    }).then((r) => r.data),
  });

  const apply = useMutation({
    mutationFn: () => api.post('/billing/subscription/change', {
      plan_code: change.plan.code,
      billing_cycle: change.cycle,
      ...(appliedCoupon ? { coupon_code: appliedCoupon } : {}),
    }, { idempotencyKey: `plan-${change.plan.code}-${change.cycle}-${Date.now()}` }),
    onSuccess: async (res: any) => {
      if (res.data.status === 'awaiting_payment') {
        toast.info('Plan updated. Complete the payment to activate it.', 'Awaiting payment');
      } else {
        toast.success('Plan activated.');
      }
      qc.invalidateQueries({ queryKey: ['subscription'] });
      await refresh();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const q = quote.data;

  return (
    <Modal open onClose={onClose} title={`Switch to ${change.plan.name}`}
      subtitle={`Billed ${change.cycle} · unused time on your current plan is credited`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={apply.isPending} disabled={!q}
            onClick={() => apply.mutate()}>
            {q ? `Pay ${money(q.total_minor)}` : 'Loading…'}
          </Button>
        </>
      }>
      <div className="space-y-4">
        {quote.isLoading || !q ? <Skeleton className="h-40" /> : (
          <dl className="rounded-lg border border-line p-3.5 space-y-2 text-[13px]">
            <QuoteRow label={`${change.plan.name} · ${change.cycle}`} value={money(q.base_minor)} />
            {q.addon_seats > 0 && (
              <QuoteRow label={`${q.addon_seats} add-on seat${q.addon_seats === 1 ? '' : 's'}`} value={money(q.addon_minor)} />
            )}
            {q.proration_credit_minor > 0 && (
              <QuoteRow label="Credit for unused time" value={`− ${money(q.proration_credit_minor)}`} tone="positive" />
            )}
            {q.coupon && (
              <QuoteRow label={`Coupon ${q.coupon.code}`} value={`− ${money(q.coupon.discount_minor)}`} tone="positive" />
            )}
            <QuoteRow label="GST @ 18%" value={money(q.gst_minor)} />
            <div className="flex items-baseline justify-between border-t border-line pt-2 mt-2">
              <dt className="font-semibold text-ink">Due now</dt>
              <dd className="text-[19px] font-semibold text-ink tabular">{money(q.total_minor)}</dd>
            </div>
          </dl>
        )}

        <Field label="Coupon code" hint="Launch offers and partner codes">
          <div className="flex gap-2">
            <Input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())}
              placeholder="LAUNCH3" className="mono" />
            <Button onClick={() => setAppliedCoupon(coupon.trim())} disabled={!coupon.trim()}>Apply</Button>
          </div>
        </Field>

        <p className="text-[12.5px] text-subtle leading-relaxed">
          Payment is taken through Razorpay for INR (UPI, cards, netbanking) and Stripe for other
          currencies. A GST invoice for the subscription is raised automatically.
        </p>
      </div>
    </Modal>
  );
}

const QuoteRow = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-subtle">{label}</dt>
    <dd className={cx('tabular', tone === 'positive' ? 'text-[var(--positive)]' : 'text-ink')}>{value}</dd>
  </div>
);

/* -------------------------------------------------------------- add-ons */
function AddonModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [addon, setAddon] = useState('whatsapp_pack');
  const [quantity, setQuantity] = useState('1');

  const CATALOGUE = [
    { id: 'whatsapp_pack', label: '1,000 WhatsApp message credits', price: 80_000, icon: MessageSquare },
    { id: 'storage_pack', label: '50 GB extra storage', price: 50_000, icon: HardDrive },
    { id: 'implementation', label: 'Implementation & configuration service', price: 2_500_000, icon: Package },
  ];

  const buy = useMutation({
    mutationFn: () => api.post('/billing/addons', { addon, quantity: Number(quantity) },
      { idempotencyKey: `addon-${addon}-${quantity}-${Date.now()}` }),
    onSuccess: (res: any) => {
      toast.success(`Add-on invoiced: ${money(res.data.total_minor)} including GST.`);
      qc.invalidateQueries({ queryKey: ['subscription'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const selected = CATALOGUE.find((c) => c.id === addon)!;
  const taxable = selected.price * Number(quantity || 1);
  const gst = Math.round(taxable * 0.18);

  return (
    <Modal open onClose={onClose} title="Buy add-ons"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={buy.isPending} onClick={() => buy.mutate()}>
            Buy · {money(taxable + gst)}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="space-y-2">
          {CATALOGUE.map((c) => (
            <button key={c.id} type="button" onClick={() => setAddon(c.id)}
              className={cx('w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors duration-150 cursor-pointer',
                addon === c.id ? 'border-[var(--brand)] bg-brand-soft ring-1 ring-[var(--brand)]'
                  : 'border-line hover:border-line-strong')}>
              <c.icon size={18} className={addon === c.id ? 'text-[var(--brand)]' : 'text-subtle'} />
              <span className="flex-1 min-w-0">
                <span className="block text-[13.5px] font-medium text-ink">{c.label}</span>
              </span>
              <span className="tabular font-semibold text-ink shrink-0">{money(c.price)}</span>
            </button>
          ))}
        </div>

        <Field label="Quantity" className="max-w-[140px]">
          <Input type="number" min={1} max={100} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>

        <dl className="rounded-lg bg-sunken p-3 space-y-1.5 text-[13px]">
          <QuoteRow label="Subtotal" value={money(taxable)} />
          <QuoteRow label="GST @ 18%" value={money(gst)} />
          <div className="flex items-baseline justify-between border-t border-line pt-1.5 mt-1.5">
            <dt className="font-semibold text-ink">Total</dt>
            <dd className="font-semibold text-ink tabular">{money(taxable + gst)}</dd>
          </div>
        </dl>
      </div>
    </Modal>
  );
}

function BillingSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-52 mb-6" />
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-5">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-96" />)}
      </div>
    </div>
  );
}
