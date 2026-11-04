import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, X, FileDown, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Field, Input, Modal, Textarea, cx } from '../components/ui';
import { API_BASE } from '../lib/config';
import { openUrl } from '../lib/openUrl';

/**
 * E5 — the client-facing proposal view behind a share token. No sign-in, and
 * no app chrome: it is the document, the price, and a decision.
 */
export default function PublicProposal() {
  const { token } = useParams<{ token: string }>();
  const [decision, setDecision] = useState<'accept' | 'reject' | null>(null);
  const [done, setDone] = useState<'accepted' | 'rejected' | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['public-proposal', token],
    queryFn: () => api.get(`/public/proposals/${token}`).then((r) => r.data),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen grid place-items-center bg-surface">
        <Loader2 size={26} className="animate-spin text-subtle" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center bg-surface px-5">
        <div className="text-center max-w-sm">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-sunken">
            <AlertTriangle size={22} className="text-subtle" />
          </div>
          <h1 className="text-[18px] font-semibold text-ink">This proposal is not available</h1>
          <p className="mt-1.5 text-[13.5px] text-subtle leading-relaxed">
            The link may have expired or been withdrawn. Please ask your contact for a fresh one.
          </p>
        </div>
      </div>
    );
  }

  const { proposal: p, items, tenant, client } = data;
  const money = (minor: number) => new Intl.NumberFormat(
    tenant.number_format === 'indian' ? 'en-IN' : 'en-US',
    { style: 'currency', currency: p.currency || tenant.currency, maximumFractionDigits: 0 },
  ).format(minor / 100);

  const settled = done || (p.accepted_at ? 'accepted' : p.status === 'rejected' ? 'rejected' : null);
  const canDecide = !settled && !p.expired && ['sent', 'viewed'].includes(p.status);

  return (
    <div className="min-h-screen bg-surface">
      {/* --------------------------------------------------------- header */}
      <header style={{ borderTop: `4px solid ${tenant.brand_primary}` }} className="bg-raised border-b border-line">
        <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[17px] font-semibold" style={{ color: tenant.brand_primary }}>{tenant.name}</p>
              <p className="mt-0.5 text-[12.5px] text-subtle">
                {[tenant.city, tenant.phone, tenant.email].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="text-right">
              <p className="label-cap">Proposal</p>
              <p className="mono text-[14px] font-medium text-ink">{p.number}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
        {/* ------------------------------------------------------- status */}
        {settled === 'accepted' && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-[color-mix(in_srgb,var(--positive)_30%,transparent)] bg-positive-soft p-4">
            <CheckCircle2 size={20} className="mt-0.5 text-[var(--positive)] shrink-0" />
            <div>
              <p className="text-[14px] font-semibold text-[var(--positive)]">Proposal accepted</p>
              <p className="text-[13px] text-muted mt-0.5">
                Thank you{p.accepted_by_name ? `, ${p.accepted_by_name}` : ''}. {tenant.name} has been
                notified and will be in touch to get started.
              </p>
            </div>
          </div>
        )}

        {settled === 'rejected' && (
          <div className="mb-6 rounded-lg border border-line bg-sunken p-4">
            <p className="text-[14px] font-semibold text-ink">This proposal is closed</p>
            <p className="text-[13px] text-muted mt-0.5">Thank you for taking the time to review it.</p>
          </div>
        )}

        {p.expired && !settled && (
          <div className="mb-6 rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft p-4">
            <p className="text-[14px] font-semibold text-[var(--warning)]">This proposal has expired</p>
            <p className="text-[13px] text-muted mt-0.5">
              It was valid until {p.valid_until}. Please ask {tenant.name} for an updated version.
            </p>
          </div>
        )}

        <h1 className="text-[26px] leading-tight font-semibold text-ink tracking-[-0.01em]">{p.title}</h1>
        <p className="mt-1.5 text-[14px] text-subtle">
          Prepared for <span className="text-ink font-medium">{client.name}</span>
          {p.valid_until && <> · valid until {p.valid_until}</>}
        </p>

        {/* ------------------------------------------------------ sections */}
        {p.sections?.length > 0 && (
          <div className="mt-8 space-y-6">
            {p.sections.map((s: any, i: number) => (
              <section key={i}>
                <h2 className="text-[16px] font-semibold text-ink mb-1.5">{s.heading}</h2>
                <p className="text-[14px] text-muted leading-relaxed">{s.body}</p>
              </section>
            ))}
          </div>
        )}

        {/* --------------------------------------------------------- items */}
        <section className="mt-8">
          <h2 className="text-[16px] font-semibold text-ink mb-3">Scope &amp; investment</h2>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: tenant.brand_primary }}>
                    <th className="label-cap px-3.5 py-2.5 text-left text-white/90">Deliverable</th>
                    <th className="label-cap px-3.5 py-2.5 text-right text-white/90 w-[70px]">Qty</th>
                    <th className="label-cap px-3.5 py-2.5 text-right text-white/90 w-[110px]">Rate</th>
                    <th className="label-cap px-3.5 py-2.5 text-right text-white/90 w-[120px]">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it: any, i: number) => (
                    <tr key={i} className={cx('border-b border-line last:border-0', i % 2 === 1 && 'bg-sunken/50')}>
                      <td className="px-3.5 py-3">
                        <span className="block text-[13.5px] font-medium text-ink">{it.description}</span>
                        {it.detail && <span className="block text-[12.5px] text-subtle mt-0.5">{it.detail}</span>}
                      </td>
                      <td className="px-3.5 py-3 text-right tabular text-muted">{it.qty}</td>
                      <td className="px-3.5 py-3 text-right tabular text-muted">{money(it.rate_minor)}</td>
                      <td className="px-3.5 py-3 text-right tabular font-medium text-ink">{money(it.amount_minor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-t border-line p-4 flex justify-end">
              <dl className="w-full max-w-[280px] space-y-1.5 text-[13.5px]">
                <div className="flex justify-between"><dt className="text-subtle">Subtotal</dt><dd className="tabular text-ink">{money(p.subtotal_minor)}</dd></div>
                {p.discount_minor > 0 && (
                  <div className="flex justify-between"><dt className="text-subtle">Discount</dt><dd className="tabular text-ink">− {money(p.discount_minor)}</dd></div>
                )}
                <div className="flex justify-between"><dt className="text-subtle">GST @ {p.tax_rate}%</dt><dd className="tabular text-ink">{money(p.tax_minor)}</dd></div>
                <div className="mt-2 flex items-center justify-between rounded-md px-3 py-2"
                  style={{ background: tenant.brand_accent }}>
                  <dt className="font-semibold text-slate-900">Total investment</dt>
                  <dd className="text-[16px] font-semibold text-slate-900 tabular">{money(p.total_minor)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        {p.terms && (
          <section className="mt-7">
            <h2 className="text-[14px] font-semibold text-ink mb-1.5">Terms &amp; conditions</h2>
            <p className="text-[12.5px] text-subtle leading-relaxed">{p.terms}</p>
          </section>
        )}

        {/* ------------------------------------------------------ decision */}
        <section className="mt-9 card p-5">
          <h2 className="text-[16px] font-semibold text-ink">
            {canDecide ? 'Ready to go ahead?' : 'Your copy'}
          </h2>
          <p className="mt-1 text-[13.5px] text-muted leading-relaxed">
            {canDecide
              ? 'Accepting here is recorded against your name and time, and lets us start straight away. You can also download a PDF for your records.'
              : 'You can download a PDF of this proposal for your records at any time.'}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button icon={<FileDown size={15} />}
              onClick={() => openUrl(`${API_BASE}/public/proposals/${token}/pdf`)}>
              Download PDF
            </Button>
            {canDecide && (
              <>
                <Button variant="ghost" icon={<X size={15} />} onClick={() => setDecision('reject')}>
                  Not proceeding
                </Button>
                <Button variant="accent" size="lg" icon={<Check size={16} />} onClick={() => setDecision('accept')}>
                  Accept this proposal
                </Button>
              </>
            )}
          </div>
        </section>

        <footer className="mt-8 pb-8 text-center text-[12px] text-subtle">
          {tenant.name}
          {tenant.website && <> · {tenant.website.replace(/^https?:\/\//, '')}</>}
        </footer>
      </main>

      {decision && (
        <DecisionModal token={token!} kind={decision} tenantName={tenant.name}
          onClose={() => setDecision(null)}
          onDone={(k) => { setDone(k); setDecision(null); refetch(); }} />
      )}
    </div>
  );
}

function DecisionModal({ token, kind, tenantName, onClose, onDone }: {
  token: string; kind: 'accept' | 'reject'; tenantName: string;
  onClose: () => void; onDone: (k: 'accepted' | 'rejected') => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const submit = useMutation({
    mutationFn: () => api.post(`/public/proposals/${token}/${kind}`, {
      name: name.trim(),
      ...(kind === 'accept' ? { note: note || undefined } : { reason: note || undefined }),
    }),
    onSuccess: () => onDone(kind === 'accept' ? 'accepted' : 'rejected'),
    onError: (e: any) => setError(e.message),
  });

  return (
    <Modal open onClose={onClose}
      title={kind === 'accept' ? 'Accept this proposal' : 'Let them know'}
      subtitle={kind === 'accept'
        ? `${tenantName} will be notified straight away`
        : 'A short reason helps them improve the next one'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={kind === 'accept' ? 'accent' : 'secondary'} loading={submit.isPending}
            disabled={name.trim().length < 2} onClick={() => submit.mutate()}>
            {kind === 'accept' ? 'Confirm acceptance' : 'Send'}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Your full name" required
          hint={kind === 'accept' ? 'Recorded as the authorising signatory' : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ravi Shankar" />
        </Field>
        <Field label={kind === 'accept' ? 'Anything to add' : 'Reason'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
            placeholder={kind === 'accept'
              ? 'Please start with the discovery workshop in the first week of September.'
              : 'Going with an in-house option for now.'} />
        </Field>

        {error && (
          <p role="alert" className="rounded-md border border-[color-mix(in_srgb,var(--negative)_30%,transparent)]
                                      bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]">
            {error}
          </p>
        )}

        {kind === 'accept' && (
          <p className="text-[12px] text-subtle leading-relaxed">
            By confirming, you agree to the scope, pricing and terms set out in this proposal. Your
            name, the time, and your IP address are recorded as the record of acceptance.
          </p>
        )}
      </div>
    </Modal>
  );
}
