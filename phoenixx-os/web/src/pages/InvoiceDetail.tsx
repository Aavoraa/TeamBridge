import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, FileDown, Send, CheckCircle2, Wallet, Ban, FileMinus, AlertTriangle, Printer,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date, dateTime, relative, daysUntil, num } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Select, Skeleton, StatusBadge, Table, TD, TH, THead, TR, Textarea, useToast, cx,
} from '../components/ui';

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, tenant } = useAuth();

  const [payOpen, setPayOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const { data: inv, isLoading, error, refetch } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get(`/invoices/${id}`).then((r) => r.data),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['invoice', id] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
  };

  const approve = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/approve`),
    onSuccess: (res: any) => {
      setWarnings(res.data.warnings || []);
      toast.success(res.data.warnings?.length ? 'Approved with warnings.' : 'Approved by finance.');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const send = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/send`),
    onSuccess: () => {
      toast.success('Sent. The due date is now tracked by the reminder ladder.');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const writeOff = useMutation({
    mutationFn: (reason: string) => api.post(`/invoices/${id}/write-off`, { reason }),
    onSuccess: () => { toast.success('Written off.'); invalidate(); setWriteOffOpen(false); },
    onError: (e: any) => toast.error(e.message),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !inv) return <InvoiceSkeleton />;

  const days = daysUntil(inv.due_date);
  const overdue = inv.balance_minor > 0 && days != null && days < 0 && !['draft', 'written_off'].includes(inv.status);
  const showIgst = inv.igst_minor > 0;

  return (
    <>
      <button onClick={() => navigate('/invoices')}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-subtle hover:text-ink transition-colors cursor-pointer no-print">
        <ArrowLeft size={14} /> Back to invoices
      </button>

      <PageHeader
        title={inv.number}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={inv.status} />
            <Link to={`/crm/${inv.client_id}`} className="text-[var(--brand)] hover:underline">{inv.client_name}</Link>
            <span className="text-subtle">· issued {date(inv.issue_date)}</span>
            {inv.is_export === 1 && <Badge tone="info">export · zero-rated</Badge>}
            {inv.is_interstate === 1 && <Badge tone="neutral">interstate · IGST</Badge>}
          </span>
        }
        actions={
          <>
            <Button icon={<Printer size={15} />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileDown size={15} />} onClick={() => api.openPdf(`/invoices/${id}/pdf`)}>PDF</Button>
            {can('invoices', 'approve') && inv.status === 'draft' && !inv.approved_at && (
              <Button icon={<CheckCircle2 size={15} />} loading={approve.isPending} onClick={() => approve.mutate()}>
                Approve
              </Button>
            )}
            {can('invoices', 'edit') && ['draft', 'sent', 'overdue'].includes(inv.status) && (
              <Button variant="primary" icon={<Send size={15} />} loading={send.isPending} onClick={() => send.mutate()}>
                {inv.status === 'draft' ? 'Send invoice' : 'Resend'}
              </Button>
            )}
            {can('invoices', 'edit') && inv.balance_minor > 0 && inv.status !== 'draft' && (
              <Button variant="accent" icon={<Wallet size={15} />} onClick={() => setPayOpen(true)}>
                Record payment
              </Button>
            )}
          </>
        }
      />

      {overdue && (
        <Card className="mb-4 border-l-4 border-l-[var(--negative)]">
          <div className="flex items-start gap-2.5 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 text-[var(--negative)] shrink-0" />
            <div>
              <p className="text-[13.5px] font-medium text-[var(--negative)]">
                {Math.abs(days!)} days overdue · {money(inv.balance_minor)} outstanding
              </p>
              <p className="text-[12.5px] text-muted mt-0.5">
                The deadline engine is chasing this. After five days overdue it escalates to the reporting manager.
              </p>
            </div>
          </div>
        </Card>
      )}

      {warnings.length > 0 && (
        <Card className="mb-4 border-l-4 border-l-[var(--warning)]">
          <div className="px-4 py-3">
            <p className="text-[13.5px] font-medium text-[var(--warning)]">Approved, with things worth checking</p>
            <ul className="mt-1 space-y-0.5 text-[12.5px] text-muted list-disc list-inside">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Line items"
              subtitle={`${inv.items.length} line${inv.items.length === 1 ? '' : 's'} · ${inv.is_export ? 'zero-rated export' : inv.is_interstate ? 'IGST' : 'CGST + SGST'}`} />
            <Table>
              <THead>
                <tr>
                  <TH width="34px">#</TH>
                  <TH>Description</TH>
                  <TH width="90px">SAC</TH>
                  <TH align="right" width="60px">Qty</TH>
                  <TH align="right" width="105px">Rate</TH>
                  <TH align="right" width="110px">Taxable</TH>
                  {showIgst
                    ? <TH align="right" width="110px">IGST</TH>
                    : <><TH align="right" width="95px">CGST</TH><TH align="right" width="95px">SGST</TH></>}
                  <TH align="right" width="115px">Amount</TH>
                </tr>
              </THead>
              <tbody>
                {inv.items.map((it: any, i: number) => (
                  <tr key={it.id} className="border-b border-line last:border-0">
                    <TD><span className="text-subtle tabular">{i + 1}</span></TD>
                    <TD className="font-medium">{it.description}</TD>
                    <TD mono><span className="text-subtle">{it.hsn_sac || '—'}</span></TD>
                    <TD align="right">{num(it.qty, 2)}</TD>
                    <TD align="right">{money(it.rate_minor)}</TD>
                    <TD align="right">{money(it.taxable_minor)}</TD>
                    {showIgst ? (
                      <TD align="right">
                        {money(it.igst_minor)}
                        <span className="block text-[11px] text-subtle">{it.gst_rate}%</span>
                      </TD>
                    ) : (
                      <>
                        <TD align="right">
                          {money(it.cgst_minor)}
                          <span className="block text-[11px] text-subtle">{it.gst_rate / 2}%</span>
                        </TD>
                        <TD align="right">
                          {money(it.sgst_minor)}
                          <span className="block text-[11px] text-subtle">{it.gst_rate / 2}%</span>
                        </TD>
                      </>
                    )}
                    <TD align="right" className="font-medium">{money(it.amount_minor)}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>

            <div className="flex justify-end border-t border-line p-4">
              <dl className="w-full max-w-xs space-y-1.5 text-[13px]">
                <TotalRow label="Subtotal" value={money(inv.subtotal_minor)} />
                {inv.discount_minor > 0 && <TotalRow label="Discount" value={`− ${money(inv.discount_minor)}`} />}
                <TotalRow label="Taxable value" value={money(inv.taxable_minor)} />
                {inv.cgst_minor > 0 && <TotalRow label="CGST" value={money(inv.cgst_minor)} />}
                {inv.sgst_minor > 0 && <TotalRow label="SGST" value={money(inv.sgst_minor)} />}
                {inv.igst_minor > 0 && <TotalRow label="IGST" value={money(inv.igst_minor)} />}
                {inv.round_off_minor !== 0 && <TotalRow label="Round off" value={money(inv.round_off_minor)} />}
                <div className="flex items-baseline justify-between border-t border-line pt-2 mt-2">
                  <dt className="font-semibold text-ink">Total</dt>
                  <dd className="text-[18px] font-semibold text-ink tabular">{money(inv.total_minor)}</dd>
                </div>
                {inv.paid_minor > 0 && (
                  <>
                    <TotalRow label="Paid" value={money(inv.paid_minor)} tone="positive" />
                    <div className="flex items-baseline justify-between">
                      <dt className="font-medium text-ink">Balance due</dt>
                      <dd className={cx('font-semibold tabular',
                        inv.balance_minor > 0 ? 'text-[var(--negative)]' : 'text-[var(--positive)]')}>
                        {money(inv.balance_minor)}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>
          </Card>

          <Card>
            <CardHeader title="Payments" subtitle={`${inv.payments.length} recorded`} />
            {!inv.payments.length ? (
              <EmptyState compact icon={<Wallet size={18} />} title="No payments recorded"
                message="Record each payment here rather than as a note, so ageing and DSO stay accurate." />
            ) : (
              <Table>
                <THead>
                  <tr><TH width="120px">Date</TH><TH width="110px">Method</TH><TH>Reference</TH>
                    <TH width="140px">Recorded by</TH><TH align="right" width="120px">Amount</TH></tr>
                </THead>
                <tbody>
                  {inv.payments.map((p: any) => (
                    <TR key={p.id}>
                      <TD><span className="text-muted text-[13px]">{date(p.paid_at)}</span></TD>
                      <TD><Badge tone="neutral">{p.method || '—'}</Badge></TD>
                      <TD mono><span className="text-subtle">{p.reference || '—'}</span></TD>
                      <TD><span className="text-muted text-[13px]">{p.recorded_by_name || '—'}</span></TD>
                      <TD align="right" className="font-medium text-[var(--positive)]">{money(p.amount_minor)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {inv.credit_notes?.length > 0 && (
            <Card>
              <CardHeader title="Credit notes" />
              <Table>
                <THead><tr><TH width="150px">Number</TH><TH>Reason</TH><TH width="120px">Issued</TH><TH align="right" width="120px">Amount</TH></tr></THead>
                <tbody>
                  {inv.credit_notes.map((c: any) => (
                    <TR key={c.id}>
                      <TD mono>{c.number}</TD>
                      <TD>{c.reason}</TD>
                      <TD><span className="text-muted text-[13px]">{date(c.issued_at)}</span></TD>
                      <TD align="right">{money(c.total_minor)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>

        {/* ------------------------------------------------------- sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader title="Invoice details" />
            <dl className="p-4 space-y-2.5 text-[13px]">
              <Row label="Number" value={inv.number} mono strong />
              <Row label="Financial year" value={inv.fy} />
              <Row label="Sequence" value={`#${inv.seq}`} />
              <Row label="Issue date" value={date(inv.issue_date)} />
              <Row label="Due date" value={`${date(inv.due_date)} · ${relative(inv.due_date)}`} />
              <Row label="Place of supply" value={inv.place_of_supply} />
              <Row label="Client GSTIN" value={inv.client_gstin} mono />
              <Row label="Currency" value={inv.currency} />
              {inv.project_name && <Row label="Project" value={inv.project_name} />}
              <Row label="Created by" value={inv.created_by_name} />
              {inv.approved_at && <Row label="Approved" value={dateTime(inv.approved_at)} />}
              {inv.sent_at && <Row label="Sent" value={dateTime(inv.sent_at)} />}
              {inv.paid_at && <Row label="Paid in full" value={dateTime(inv.paid_at)} />}
            </dl>
          </Card>

          {inv.notes && (
            <Card>
              <CardHeader title="Notes" />
              <p className="p-4 text-[13px] text-muted leading-relaxed whitespace-pre-wrap">{inv.notes}</p>
            </Card>
          )}

          {can('invoices', 'create') && inv.status !== 'draft' && (
            <Card>
              <CardHeader title="Adjustments" />
              <div className="p-4 space-y-2">
                <Button className="w-full justify-center" icon={<FileMinus size={15} />}
                  onClick={() => setCreditOpen(true)}>Issue credit note</Button>
                {can('invoices', 'approve') && inv.balance_minor > 0 && inv.status !== 'written_off' && (
                  <Button variant="ghost" className="w-full justify-center" icon={<Ban size={15} />}
                    onClick={() => setWriteOffOpen(true)}>Write off</Button>
                )}
                <p className="text-[12px] text-subtle leading-snug pt-1">
                  An issued number is never reused. Corrections go through a credit note, which keeps
                  the sequence intact for your accountant.
                </p>
              </div>
            </Card>
          )}
        </div>
      </div>

      {payOpen && <PaymentModal invoice={inv} onClose={() => setPayOpen(false)} />}
      {creditOpen && <CreditNoteModal invoice={inv} onClose={() => setCreditOpen(false)} />}
      <WriteOffDialog open={writeOffOpen} onClose={() => setWriteOffOpen(false)}
        onConfirm={(reason) => writeOff.mutate(reason)} loading={writeOff.isPending} />
    </>
  );
}

const TotalRow = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-subtle">{label}</dt>
    <dd className={cx('tabular', tone === 'positive' ? 'text-[var(--positive)]' : 'text-ink')}>{value}</dd>
  </div>
);

const Row = ({ label, value, mono, strong }: any) => (
  value ? (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-subtle shrink-0">{label}</dt>
      <dd className={cx('text-right min-w-0 truncate text-ink', mono && 'mono text-[12.5px]', strong && 'font-semibold')}>
        {value}
      </dd>
    </div>
  ) : null
);

function PaymentModal({ invoice, onClose }: { invoice: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState(String(invoice.balance_minor / 100));
  const [method, setMethod] = useState('neft');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');

  const pay = useMutation({
    mutationFn: () => api.post(`/invoices/${invoice.id}/payments`, {
      amount_minor: Math.round(Number(amount) * 100),
      paid_at: `${paidAt}T12:00:00.000Z`,
      method, reference: reference || null, notes: notes || null,
    }, { idempotencyKey: `pay-${invoice.id}-${paidAt}-${amount}` }),
    onSuccess: () => {
      toast.success('Payment recorded.');
      qc.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const amountMinor = Math.round(Number(amount || 0) * 100);
  const tooMuch = amountMinor > invoice.balance_minor;
  const partial = amountMinor > 0 && amountMinor < invoice.balance_minor;

  return (
    <Modal open onClose={onClose} title="Record a payment"
      subtitle={`${invoice.number} · ${money(invoice.balance_minor)} outstanding`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pay.isPending} disabled={!amountMinor || tooMuch}
            onClick={() => pay.mutate()}>Record {money(amountMinor)}</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Amount received (₹)" required
          error={tooMuch ? `That is more than the ${money(invoice.balance_minor)} outstanding` : undefined}
          hint={partial ? `Partial payment — ${money(invoice.balance_minor - amountMinor)} will remain outstanding` : undefined}>
          <Input type="number" min={0} step={100} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {['upi', 'neft', 'imps', 'cheque', 'card', 'cash', 'razorpay', 'other'].map((m) => (
                <option key={m} value={m}>{m.toUpperCase()}</option>
              ))}
            </Select>
          </Field>
          <Field label="Received on">
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Reference" hint="UTR, cheque number or gateway reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR123456789" className="mono" />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

function CreditNoteModal({ invoice, onClose }: { invoice: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const issue = useMutation({
    mutationFn: () => api.post(`/invoices/${invoice.id}/credit-notes`, {
      reason: reason.trim(),
      amount_minor: Math.round(Number(amount) * 100),
      tax_minor: Math.round(Number(amount) * 0.18 * 100),
    }),
    onSuccess: (res: any) => {
      toast.success(`Credit note ${res.data.number} issued.`);
      qc.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Issue a credit note" size="sm"
      subtitle={`Against ${invoice.number} · ${money(invoice.total_minor)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={issue.isPending}
            disabled={!Number(amount) || reason.trim().length < 3} onClick={() => issue.mutate()}>
            Issue credit note
          </Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Taxable amount to credit (₹)" required hint="GST at 18% is added on top">
          <Input type="number" min={0} step={100} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            placeholder="Scope reduced by mutual agreement on 12 Aug." />
        </Field>
      </div>
    </Modal>
  );
}

function WriteOffDialog({ open, onClose, onConfirm, loading }: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => void; loading: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Write off this invoice?" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={loading} disabled={reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}>Write off</Button>
        </>
      }>
      <div className="space-y-4">
        <p className="text-[13.5px] text-muted leading-relaxed">
          The balance stops counting toward receivables and the reminder ladder is cancelled.
          The invoice and its number stay on record.
        </p>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            placeholder="Client wound down operations; balance unrecoverable." autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

function InvoiceSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-4 w-32 mb-4" />
      <Skeleton className="h-8 w-56 mb-2" />
      <Skeleton className="h-4 w-72 mb-5" />
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <Skeleton className="h-96" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
