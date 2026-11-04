import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Download, Receipt, AlertTriangle, ShieldCheck, X, Trash2, Repeat, CheckCircle2, Info,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date, relative, daysUntil, num } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader,
  SearchInput, Select, StatusBadge, Stat, Table, TableSkeleton, TD, TH, THead, TR, Textarea,
  useToast, cx,
} from '../components/ui';

/** Module F — the invoice register, plus the create flow that fixes the numbering defect. */
export default function Invoices() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [page, setPage] = useState(1);

  const filters = {
    status: params.get('status') || '',
    overdue: params.get('overdue') || '',
    client_id: params.get('client_id') || '',
    fy: params.get('fy') || '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
    setPage(1);
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['invoices', filters, search, page],
    queryFn: () => api.get('/invoices', { ...filters, search, page, limit: 25 }),
  });

  const { data: meta } = useQuery({
    queryKey: ['invoice-meta'],
    queryFn: () => api.get('/invoices/meta').then((r) => r.data),
    staleTime: 60_000,
  });

  const invoices = data?.data || [];
  const summary = data?.meta?.summary || {};
  const pageMeta = data?.meta || {};
  const audit = meta?.numbering_audit;

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle={`Financial year ${meta?.financial_year || '—'} · next number ${meta?.next_number?.number || '—'}`}
        actions={
          <>
            {can('invoices', 'export') && (
              <Button icon={<Download size={15} />}
                onClick={() => api.download('/invoices/export', 'invoices-accounting.csv')}>
                Export for accounting
              </Button>
            )}
            {can('invoices', 'create') && (
              <>
                <Button icon={<Repeat size={15} />} onClick={() => setRecurringOpen(true)}>Retainers</Button>
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New invoice</Button>
              </>
            )}
          </>
        }
      />

      {/* --------------------------------------------- numbering assurance */}
      {audit && (
        <Card className={cx('mb-4 border-l-4', audit.clean ? 'border-l-[var(--positive)]' : 'border-l-[var(--negative)]')}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
            <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <ShieldCheck size={15} className={audit.clean ? 'text-[var(--positive)]' : 'text-[var(--negative)]'} />
              Numbering integrity
            </span>
            <span className="text-[13px] text-muted">
              <span className="tabular font-semibold text-ink">{audit.total_invoices}</span> invoices ·{' '}
              <span className={cx('tabular font-semibold', audit.duplicate_numbers ? 'text-[var(--negative)]' : 'text-[var(--positive)]')}>
                {audit.duplicate_numbers}
              </span> duplicates ·{' '}
              <span className={cx('tabular font-semibold', audit.sequence_gaps ? 'text-[var(--warning)]' : 'text-[var(--positive)]')}>
                {audit.sequence_gaps}
              </span> gaps
            </span>
            <Badge tone={audit.clean ? 'positive' : 'negative'} dot>
              {audit.clean ? 'clean sequence' : 'needs review'}
            </Badge>
            <span className="ml-auto text-[12px] text-subtle hidden md:block">
              Numbers are allocated by the system inside the same transaction as the invoice — never by hand.
            </span>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------- summary */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat label="Invoiced" value={money(summary.total_minor, { compact: true })} icon={<Receipt size={15} />} />
        <Stat label="Collected" value={money(summary.paid_minor, { compact: true })} tone="positive" />
        <Stat label="Outstanding" value={money(summary.balance_minor, { compact: true })}
          sub={`${summary.drafts || 0} draft${summary.drafts === 1 ? '' : 's'}`} />
        <Stat label="Overdue" value={money(summary.overdue_minor, { compact: true })}
          tone={summary.overdue_minor > 0 ? 'negative' : 'neutral'}
          icon={<AlertTriangle size={15} />}
          onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')} />
      </div>

      {/* --------------------------------------------------------- filters */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="Search by number or client…" className="flex-1 min-w-[200px]" />
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Status" className="w-[150px]">
            <option value="">All statuses</option>
            {['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'written_off'].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </Select>
          <Button size="sm" variant={filters.overdue ? 'danger' : 'secondary'} icon={<AlertTriangle size={14} />}
            onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')}>
            Overdue only
          </Button>
          {(filters.status || filters.overdue || search) && (
            <Button size="sm" variant="ghost" icon={<X size={14} />}
              onClick={() => { setParams(new URLSearchParams(), { replace: true }); setSearch(''); }}>Clear</Button>
          )}
        </div>
      </Card>

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton cols={6} /></Card>
          : !invoices.length ? (
            <Card>
              <EmptyState icon={<Receipt size={20} />} title="No invoices match"
                message={filters.status || search ? 'Try clearing the filters.' : 'Raise the first invoice against a client.'}
                action={can('invoices', 'create')
                  ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New invoice</Button>
                  : undefined} />
            </Card>
          ) : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH width="150px">Number</TH>
                    <TH>Client</TH>
                    <TH width="105px">Issued</TH>
                    <TH width="120px">Due</TH>
                    <TH align="right" width="115px">Total</TH>
                    <TH align="right" width="115px">Balance</TH>
                    <TH width="125px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {invoices.map((inv: any) => {
                    const days = daysUntil(inv.due_date);
                    const overdue = inv.balance_minor > 0 && days != null && days < 0
                      && !['draft', 'written_off'].includes(inv.status);
                    return (
                      <TR key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
                        <TD mono className="font-medium">{inv.number}</TD>
                        <TD>
                          <span className="block font-medium text-ink truncate max-w-[200px]">{inv.client_name}</span>
                          {inv.project_name && <span className="block text-[12px] text-subtle truncate max-w-[200px]">{inv.project_name}</span>}
                        </TD>
                        <TD><span className="text-muted text-[13px]">{date(inv.issue_date)}</span></TD>
                        <TD>
                          <span className={cx('text-[13px]', overdue ? 'text-[var(--negative)] font-medium' : 'text-muted')}>
                            {overdue ? `${Math.abs(days!)}d overdue` : date(inv.due_date)}
                          </span>
                        </TD>
                        <TD align="right" className="font-medium">{money(inv.total_minor)}</TD>
                        <TD align="right">
                          <span className={inv.balance_minor > 0 ? 'text-[var(--negative)] font-medium' : 'text-subtle'}>
                            {money(inv.balance_minor)}
                          </span>
                        </TD>
                        <TD><StatusBadge status={inv.status} /></TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>

              {pageMeta.pages > 1 && (
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                  <span className="text-[13px] text-subtle">Page {pageMeta.page} of {pageMeta.pages} · {pageMeta.total} invoices</span>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button size="sm" disabled={!pageMeta.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </Card>
          )}

      {createOpen && <CreateInvoiceModal meta={meta} onClose={() => setCreateOpen(false)} />}
      {recurringOpen && <RecurringDrawer onClose={() => setRecurringOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------ create flow */
type Line = {
  description: string; hsn_sac: string; qty: string; rate: string;
  discount_pct: string; gst_rate: string; service_line_id: string;
};

const emptyLine = (): Line => ({
  description: '', hsn_sac: '998361', qty: '1', rate: '', discount_pct: '0', gst_rate: '18', service_line_id: '',
});

function CreateInvoiceModal({ meta, onClose }: { meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { tenant } = useAuth();

  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [terms, setTerms] = useState('15');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [isExport, setIsExport] = useState(false);
  const [notes, setNotes] = useState('Thank you for your business.');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);

  const { data: clients } = useQuery({
    queryKey: ['clients-for-invoice'],
    queryFn: () => api.get('/crm/clients', { limit: 200, status: 'active,lead' }).then((r) => r.data),
  });
  const { data: serviceLines } = useQuery({
    queryKey: ['service-lines'],
    queryFn: () => api.get('/settings/service-lines').then((r) => r.data),
    staleTime: 300_000,
  });
  const { data: projects } = useQuery({
    queryKey: ['projects', clientId],
    queryFn: () => api.get('/finance/projects', { client_id: clientId }).then((r) => r.data),
    enabled: !!clientId,
  });

  const client = clients?.find((c: any) => c.id === clientId);

  // The client's state decides CGST+SGST versus IGST, so surface it live.
  const supplyState = placeOfSupply || client?.state_code || tenant?.state_code;
  const interstate = !isExport && supplyState && String(supplyState) !== String(tenant?.state_code);

  const totals = useMemo(() => {
    let subtotal = 0; let discount = 0; let taxable = 0; let cgst = 0; let sgst = 0; let igst = 0;
    for (const l of lines) {
      const gross = Math.round(Number(l.qty || 0) * Math.round(Number(l.rate || 0) * 100));
      const disc = Math.round((gross * Number(l.discount_pct || 0)) / 100);
      const tax = gross - disc;
      const rate = isExport ? 0 : Number(l.gst_rate || 0);
      subtotal += gross; discount += disc; taxable += tax;
      if (rate > 0) {
        if (interstate) igst += Math.round((tax * rate) / 100);
        else {
          const half = Math.round((tax * rate) / 200);
          cgst += half;
          sgst += Math.round((tax * rate) / 100) - half;
        }
      }
    }
    const before = taxable + cgst + sgst + igst;
    const total = Math.round(before / 100) * 100;
    return { subtotal, discount, taxable, cgst, sgst, igst, roundOff: total - before, total };
  }, [lines, interstate, isExport]);

  const create = useMutation({
    mutationFn: () => api.post('/invoices', {
      client_id: clientId,
      project_id: projectId || null,
      issue_date: issueDate,
      payment_terms_days: Number(terms),
      place_of_supply: placeOfSupply || null,
      is_export: isExport,
      notes: notes || null,
      terms: 'Payment due within the stated terms. Interest at 1.5% per month applies on overdue amounts.',
      items: lines.filter((l) => l.description.trim() && Number(l.rate) > 0).map((l) => ({
        description: l.description.trim(),
        hsn_sac: l.hsn_sac || null,
        qty: Number(l.qty || 1),
        rate_minor: Math.round(Number(l.rate) * 100),
        discount_pct: Number(l.discount_pct || 0),
        gst_rate: Number(l.gst_rate || 0),
        service_line_id: l.service_line_id || null,
      })),
    }, { idempotencyKey: `inv-${clientId}-${issueDate}-${totals.total}` }),
    onSuccess: (res: any) => {
      toast.success(`Invoice ${res.data.number} created as a draft.`);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice-meta'] });
      onClose();
      navigate(`/invoices/${res.data.id}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const setLine = (i: number, key: keyof Line, value: string) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [key]: value } : l)));

  const valid = clientId && lines.some((l) => l.description.trim() && Number(l.rate) > 0);

  return (
    <Modal open onClose={onClose} title="New invoice" size="xl"
      subtitle={`Number will be allocated on save · next is ${meta?.next_number?.number || '—'}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            Create draft · {money(totals.total)}
          </Button>
        </>
      }>
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Client" required className="lg:col-span-2">
            <Select value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(''); }}>
              <option value="">Select a client…</option>
              {clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!clientId}>
              <option value="">No project</option>
              {projects?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Issue date" required>
            <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </Field>
          <Field label="Payment terms">
            <Select value={terms} onChange={(e) => setTerms(e.target.value)}>
              {[0, 7, 15, 30, 45, 60].map((d) => <option key={d} value={d}>{d === 0 ? 'Due on receipt' : `Net ${d} days`}</option>)}
            </Select>
          </Field>
          <Field label="Place of supply" hint="Defaults to the client's state">
            <Select value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)} disabled={isExport}>
              <option value="">
                {client?.state_code ? `${client.state_code} (client default)` : 'Select a state…'}
              </option>
              {meta?.state_codes?.map((s: any) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
            </Select>
          </Field>
          <Field label="Export / SEZ" hint="Zero-rated supply, no GST charged">
            <Select value={isExport ? 'yes' : 'no'} onChange={(e) => setIsExport(e.target.value === 'yes')}>
              <option value="no">Domestic supply</option>
              <option value="yes">Export / SEZ (zero-rated)</option>
            </Select>
          </Field>
        </div>

        {clientId && (
          <div className="flex items-start gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-[12.5px] text-muted">
            <Info size={14} className="mt-0.5 shrink-0 text-[var(--brand)]" />
            <span>
              {isExport
                ? 'Export supply — zero-rated, no GST columns on the invoice.'
                : interstate
                  ? <>Supplier state {tenant?.state_code} → place of supply {supplyState}: <strong className="text-ink">IGST</strong> will be charged at the full rate.</>
                  : <>Supplier and place of supply both in state {supplyState}: <strong className="text-ink">CGST + SGST</strong>, each at half the rate.</>}
              {client?.gstin && <> Client GSTIN <span className="mono">{client.gstin}</span>.</>}
            </span>
          </div>
        )}

        {/* --------------------------------------------------- line items */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="label-cap">Line items</p>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setLines((l) => [...l, emptyLine()])}>
              Add line
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-sunken">
                <tr>
                  <TH width="30%">Description</TH>
                  <TH width="100px">SAC</TH>
                  <TH width="70px" align="right">Qty</TH>
                  <TH width="110px" align="right">Rate ₹</TH>
                  <TH width="80px" align="right">Disc %</TH>
                  <TH width="90px" align="right">GST %</TH>
                  <TH width="130px">Service line</TH>
                  <TH width="42px" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <TD>
                      <Input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)}
                        placeholder="Monthly retainer — digital marketing" className="h-8 text-[13px]" />
                    </TD>
                    <TD>
                      <Input value={l.hsn_sac} onChange={(e) => setLine(i, 'hsn_sac', e.target.value)}
                        list="sac-codes" className="h-8 text-[13px] mono" />
                    </TD>
                    <TD>
                      <Input type="number" min={0} step={0.5} value={l.qty}
                        onChange={(e) => setLine(i, 'qty', e.target.value)} className="h-8 text-[13px] text-right" />
                    </TD>
                    <TD>
                      <Input type="number" min={0} step={100} value={l.rate}
                        onChange={(e) => setLine(i, 'rate', e.target.value)} className="h-8 text-[13px] text-right" placeholder="0" />
                    </TD>
                    <TD>
                      <Input type="number" min={0} max={100} value={l.discount_pct}
                        onChange={(e) => setLine(i, 'discount_pct', e.target.value)} className="h-8 text-[13px] text-right" />
                    </TD>
                    <TD>
                      <Select value={l.gst_rate} onChange={(e) => setLine(i, 'gst_rate', e.target.value)}
                        disabled={isExport} className="h-8 text-[13px]">
                        {(meta?.gst_rates || [0, 5, 12, 18, 28]).map((r: number) => <option key={r} value={r}>{r}%</option>)}
                      </Select>
                    </TD>
                    <TD>
                      <Select value={l.service_line_id} onChange={(e) => setLine(i, 'service_line_id', e.target.value)}
                        className="h-8 text-[13px]">
                        <option value="">—</option>
                        {serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    </TD>
                    <TD align="center">
                      {lines.length > 1 && (
                        <button onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                          aria-label={`Remove line ${i + 1}`}
                          className="text-subtle hover:text-[var(--negative)] transition-colors cursor-pointer p-1">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <datalist id="sac-codes">
            {meta?.sac_codes?.map((s: any) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </datalist>
        </div>

        {/* ------------------------------------------------------- totals */}
        <div className="grid gap-4 sm:grid-cols-[1fr_280px]">
          <Field label="Notes on the invoice">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </Field>

          <div className="rounded-lg border border-line bg-sunken p-3.5 space-y-1.5 text-[13px] self-start">
            <TotalRow label="Subtotal" value={money(totals.subtotal)} />
            {totals.discount > 0 && <TotalRow label="Discount" value={`− ${money(totals.discount)}`} />}
            <TotalRow label="Taxable value" value={money(totals.taxable)} />
            {totals.cgst > 0 && <TotalRow label="CGST" value={money(totals.cgst)} />}
            {totals.sgst > 0 && <TotalRow label="SGST" value={money(totals.sgst)} />}
            {totals.igst > 0 && <TotalRow label="IGST" value={money(totals.igst)} />}
            {totals.roundOff !== 0 && <TotalRow label="Round off" value={money(totals.roundOff)} />}
            <div className="flex items-baseline justify-between border-t border-line pt-2 mt-2">
              <span className="font-semibold text-ink">Total</span>
              <span className="text-[17px] font-semibold text-ink tabular">{money(totals.total)}</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const TotalRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-subtle">{label}</span>
    <span className="text-ink tabular">{value}</span>
  </div>
);

/* --------------------------------------------------------- recurring (F3) */
function RecurringDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['recurring-invoices'],
    queryFn: () => api.get('/invoices/recurring/all').then((r) => r.data),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch(`/invoices/recurring/${id}`, { active }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recurring-invoices'] }); toast.success('Updated.'); },
  });

  return (
    <Modal open onClose={onClose} title="Retainer schedules" size="lg"
      subtitle="Recurring invoices are generated automatically as drafts on their run date"
      footer={<Button onClick={onClose}>Close</Button>}>
      {isLoading ? <TableSkeleton rows={3} cols={4} />
        : !data?.length ? (
          <EmptyState icon={<Repeat size={20} />} title="No retainer schedules"
            message="Set one up from a client's invoice to bill the same lines each month automatically." />
        ) : (
          <Table>
            <THead>
              <tr><TH>Schedule</TH><TH width="110px">Frequency</TH><TH width="120px">Next run</TH><TH width="110px">Runs</TH><TH width="90px">Active</TH></tr>
            </THead>
            <tbody>
              {data.map((r: any) => (
                <TR key={r.id}>
                  <TD>
                    <span className="block font-medium text-ink">{r.title}</span>
                    <span className="block text-[12px] text-subtle">{r.client_name}</span>
                  </TD>
                  <TD><span className="capitalize text-muted text-[13px]">{r.frequency}</span></TD>
                  <TD><span className="text-muted text-[13px]">{date(r.next_run_date)}</span></TD>
                  <TD><span className="tabular text-muted text-[13px]">{r.runs_count}</span></TD>
                  <TD>
                    <Button size="sm" variant={r.active ? 'secondary' : 'ghost'}
                      onClick={() => toggle.mutate({ id: r.id, active: !r.active })}>
                      {r.active ? 'On' : 'Off'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
    </Modal>
  );
}
