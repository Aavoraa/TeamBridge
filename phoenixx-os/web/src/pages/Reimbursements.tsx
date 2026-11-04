import { useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  BadgeIndianRupee, Banknote, CheckCircle2, Clock, Download, FileText, Paperclip,
  Plus, Receipt, Send, ShieldCheck, Trash2, Upload, Wallet, XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, money, monthLabel, relative, titleCase } from '../lib/format';
import {
  AvatarWithName, Badge, Button, Card, CardHeader, ConfirmDialog, Drawer, EmptyState,
  ErrorState, Field, Input, Meter, Modal, PageHeader, SearchInput, Select, Table,
  TableSkeleton, TD, TH, THead, TR, Tabs, Textarea, cx, useToast,
} from '../components/ui';

/**
 * Module I - reimbursement.
 *
 * One screen, six views, chosen so each role opens the one thing it came for:
 *
 *   new        raise a claim                      everyone
 *   mine       my claims and where each one is    everyone
 *   approvals  my team, waiting on me             managers
 *   review     verify bills, approve, pay         finance
 *   history    everything I am allowed to see     everyone
 *   reports    expense and reimbursement totals   managers and finance
 *
 * What a person may do is read from the API rather than inferred from a role
 * here: the list carries `meta.scope`, and a claim carries a `permissions`
 * block naming the actions available on it. The server enforces all of it -
 * these checks only decide what is worth drawing.
 */

const BASE = '/finance/reimbursements';

/** How each status reads, and which stage of the workflow it sits at. */
const STATUS_UI: Record<string, { label: string; tone: any; stage: string }> = {
  draft: { label: 'Draft', tone: 'neutral', stage: 'Draft' },
  submitted: { label: 'Awaiting manager', tone: 'warning', stage: 'Manager approval' },
  manager_approved: { label: 'In finance review', tone: 'info', stage: 'Finance review' },
  approved: { label: 'Approved for payment', tone: 'brand', stage: 'Approved' },
  paid: { label: 'Paid', tone: 'positive', stage: 'Paid' },
  rejected: { label: 'Rejected', tone: 'negative', stage: 'Rejected' },
  cancelled: { label: 'Withdrawn', tone: 'neutral', stage: 'Withdrawn' },
};

/** The happy path, drawn as a track so someone can see how far a claim has got. */
const TRACK = ['draft', 'submitted', 'manager_approved', 'approved', 'paid'];

/** How a payment mode reads. titleCase would give "Upi", which it is not. */
const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', upi: 'UPI', netbanking: 'Net banking', other: 'Other',
};

const PAYMENT_METHODS = [
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'upi', label: 'UPI' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'cash', label: 'Cash' },
  { id: 'payroll', label: 'With payroll' },
  { id: 'other', label: 'Other' },
];

const statusUi = (s?: string) => STATUS_UI[s || ''] || { label: titleCase(s), tone: 'neutral', stage: '—' };

const StatusPill = ({ status }: { status?: string }) => {
  const ui = statusUi(status);
  return <Badge tone={ui.tone} dot>{ui.label}</Badge>;
};

const today = () => new Date().toISOString().slice(0, 10);

/** What the attachments endpoint accepts. Checked here so a 6 MB photo of a
 *  bill is refused while the person is still looking at the form, rather than
 *  half way through saving the claim. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Sub-kilobyte files are not "0 KB" - the smallest real size is 1. */
const fileSize = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Splits a picked batch into what can be sent and what is too big. */
function sift(picked: File[]) {
  return {
    ok: picked.filter((f) => f.size <= MAX_FILE_BYTES),
    tooBig: picked.filter((f) => f.size > MAX_FILE_BYTES),
  };
}

/* =================================================================== PAGE */
export default function Reimbursements() {
  const { can } = useAuth();
  const { view: routeView } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const isManager = can('reimbursements', 'approve');
  const isFinance = can('reimbursement_finance', 'view');
  const canReport = can('reimbursements', 'export');

  const { data: queues } = useQuery({
    queryKey: ['reimbursements', 'queues'],
    queryFn: () => api.get(`${BASE}/queues`).then((r) => r.data),
    refetchInterval: 120_000,
  });

  const tabs = [
    { id: 'mine', label: 'My reimbursements', count: queues?.mine_open || undefined },
    ...(isManager ? [{ id: 'approvals', label: 'Pending approvals', count: queues?.manager_pending || undefined }] : []),
    ...(isFinance ? [{ id: 'review', label: 'Finance review', count: queues?.finance_pending || undefined }] : []),
    { id: 'history', label: 'History' },
    ...(canReport ? [{ id: 'reports', label: 'Reports' }] : []),
  ];

  // The nav links straight at a view, so the URL is the source of truth and a
  // tab a role cannot use falls back to the one everybody has.
  const requested = routeView || 'mine';
  const view = requested === 'new' || tabs.some((t) => t.id === requested) ? requested : 'mine';

  const [composeOpen, setComposeOpen] = useState(view === 'new');
  const [openId, setOpenId] = useState<string | null>(params.get('open'));

  const go = (id: string) => navigate(id === 'mine' ? BASE : `${BASE}/${id}`);

  // Landing on /new opens the form over "My reimbursements" rather than being a
  // page of its own: raising a claim and watching it are one job, not two. Both
  // ways out of the form drop the /new segment, so the URL never claims a form
  // is open when it is not.
  const closeCompose = () => {
    setComposeOpen(false);
    if (routeView === 'new') navigate(BASE, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Reimbursement"
        subtitle="Claim back what you spent on company business, and follow it through to payment"
        actions={(
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setComposeOpen(true)}>
            New reimbursement
          </Button>
        )}
        tabs={<Tabs active={view === 'new' ? 'mine' : view} onChange={go} tabs={tabs} />}
      />

      {(view === 'mine' || view === 'new') && <ClaimList key="mine" mine onOpen={setOpenId} />}
      {view === 'approvals' && <ClaimList key="approvals" queue="manager" onOpen={setOpenId} />}
      {view === 'review' && <FinanceReview onOpen={setOpenId} />}
      {view === 'history' && <ClaimList key="history" history onOpen={setOpenId} />}
      {view === 'reports' && <ReportsTab />}

      {composeOpen && (
        <ComposeModal
          onClose={closeCompose}
          onCreated={(id) => { closeCompose(); setOpenId(id); }}
        />
      )}
      {openId && <ClaimDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

/* ============================================================ CLAIM LIST */
function ClaimList({ mine, queue, history, onOpen }: {
  mine?: boolean; queue?: 'manager'; history?: boolean; onOpen: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const query = {
    ...(mine ? { mine: 'true' } : {}),
    ...(queue ? { queue } : {}),
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    limit: 100,
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reimbursements', 'list', query],
    queryFn: () => api.get(BASE, query).then((r) => ({ rows: r.data, meta: r.meta })),
  });

  const rows = data?.rows || [];
  const totals = data?.meta?.by_status || [];

  const emptyCopy = queue
    ? { title: 'Nothing waiting on you', message: 'Claims from your team appear here the moment they are submitted.' }
    : mine
      ? { title: 'No claims yet', message: 'Spent something on company business? Raise it here and track it to payment.' }
      : history
        ? { title: 'No history yet', message: 'Every claim you can see, at every stage, ends up on this list.' }
        : { title: 'Nothing to show', message: 'No reimbursement requests match this filter.' };

  return (
    <>
      {!!totals.length && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TRACK.filter((s) => totals.some((t: any) => t.status === s))
            .concat(totals.some((t: any) => t.status === 'rejected') ? ['rejected'] : [])
            .map((s) => {
              const row = totals.find((t: any) => t.status === s);
              const ui = statusUi(s);
              return (
                <Card key={s} className="p-3">
                  <p className="label-cap">{ui.label}</p>
                  <p className="mt-1 text-[19px] font-semibold text-ink tabular">{money(row.amount_minor)}</p>
                  <p className="text-[12px] text-subtle">{row.n} request{row.n === 1 ? '' : 's'}</p>
                </Card>
              );
            })}
        </div>
      )}

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput value={search} onChange={setSearch} className="min-w-[220px] flex-1"
            placeholder="Search by number, description, merchant or person…" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="w-[190px]">
            <option value="">All statuses</option>
            {Object.entries(STATUS_UI).map(([id, ui]) => <option key={id} value={id}>{ui.label}</option>)}
          </Select>
        </div>
      </Card>

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton cols={6} /></Card>
          : !rows.length ? <Card><EmptyState icon={<Receipt size={20} />} {...emptyCopy} /></Card>
            : <ClaimTable rows={rows} showPerson={!mine} onOpen={onOpen} />}
    </>
  );
}

function ClaimTable({ rows, showPerson, onOpen }: {
  rows: any[]; showPerson?: boolean; onOpen: (id: string) => void;
}) {
  return (
    <Card>
      {/* The table scrolls inside the card rather than pushing the page sideways. */}
      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TH width="120px">Number</TH>
            {showPerson && <TH>Employee</TH>}
            <TH>Expense</TH>
            <TH width="110px">Date</TH>
            <TH align="right" width="120px">Amount</TH>
            <TH width="170px">Status</TH>
            <TH align="right" width="90px">Docs</TH>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id} onClick={() => onOpen(r.id)}>
                <TD mono>{r.number || <span className="text-subtle">—</span>}</TD>
                {showPerson && (
                  <TD>
                    <AvatarWithName name={r.user_name} url={r.avatar_url} sub={r.designation} size={26} />
                  </TD>
                )}
                <TD>
                  <span className="block max-w-[320px] truncate text-[13.5px] text-ink">{r.description}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-subtle">
                    {r.category_name && (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: r.category_color }} aria-hidden />
                        {r.category_name}
                      </>
                    )}
                    {r.merchant && <span className="truncate">· {r.merchant}</span>}
                  </span>
                </TD>
                <TD>{date(r.expense_date)}</TD>
                <TD align="right" mono>
                  {money(r.amount_minor)}
                  {r.approved_minor != null && r.approved_minor !== r.amount_minor && (
                    <span className="block text-[11.5px] text-[var(--warning)]">
                      {money(r.approved_minor)} approved
                    </span>
                  )}
                </TD>
                <TD><StatusPill status={r.status} /></TD>
                <TD align="right">
                  {r.document_count > 0
                    ? <span className="inline-flex items-center gap-1 text-[12.5px] text-subtle">
                        <Paperclip size={12} />{r.document_count}
                      </span>
                    : <span className="text-subtle">—</span>}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

/* ========================================================= FINANCE REVIEW */
/** Two queues side by side: what needs a decision, and what needs paying. */
function FinanceReview({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reimbursements', 'finance-queue'],
    queryFn: () => api.get(BASE, { queue: 'finance', limit: 200 }).then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading) return <Card><TableSkeleton cols={6} /></Card>;

  const toReview = (data || []).filter((r: any) => r.status === 'manager_approved');
  const toPay = (data || []).filter((r: any) => r.status === 'approved');
  const sum = (rows: any[]) => rows.reduce((a, r) => a + (r.approved_minor ?? r.amount_minor), 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-3">
          <p className="label-cap">Waiting on review</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{toReview.length}</p>
          <p className="text-[12px] text-subtle">{money(sum(toReview))} claimed</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Approved, unpaid</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{toPay.length}</p>
          <p className="text-[12px] text-subtle">{money(sum(toPay))} to pay out</p>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-[15px] font-semibold text-ink">Ready for review</h2>
        {!toReview.length
          ? <Card><EmptyState compact icon={<ShieldCheck size={20} />} title="Nothing to verify"
              message="Claims land here once a reporting manager has approved them." /></Card>
          : <ClaimTable rows={toReview} showPerson onOpen={onOpen} />}
      </div>

      <div>
        <h2 className="mb-2 text-[15px] font-semibold text-ink">Approved, awaiting payment</h2>
        {!toPay.length
          ? <Card><EmptyState compact icon={<Banknote size={20} />} title="Nothing outstanding"
              message="Everything approved has been paid." /></Card>
          : <ClaimTable rows={toPay} showPerson onOpen={onOpen} />}
      </div>
    </div>
  );
}

/* ================================================================ COMPOSE */
function ComposeModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    category_id: '', expense_date: today(), amount: '', description: '', merchant: '', payment_mode: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const { data: categories } = useQuery({
    queryKey: ['reimbursements', 'categories'],
    queryFn: () => api.get(`${BASE}/categories`).then((r) => r.data),
    staleTime: 600_000,
  });

  const category = categories?.find((c: any) => c.id === form.category_id);
  const amountMinor = Math.round(Number(form.amount || 0) * 100);
  const overCap = category?.cap_minor && amountMinor > category.cap_minor;

  /**
   * Saving is three calls - create, upload each bill, submit - and any of them
   * can fail. Holding the claim id and the bills already up means pressing the
   * button again carries on from where it stopped instead of raising a second
   * claim for the same expense.
   */
  const draftId = useRef<string | null>(null);
  const uploaded = useRef<Set<string>>(new Set());

  const create = useMutation({
    mutationFn: async (submit: boolean) => {
      if (!draftId.current) {
        const { data } = await api.post(BASE, {
          ...(form.category_id ? { category_id: form.category_id } : {}),
          expense_date: form.expense_date,
          amount_minor: amountMinor,
          description: form.description.trim(),
          ...(form.merchant.trim() ? { merchant: form.merchant.trim() } : {}),
          ...(form.payment_mode ? { payment_mode: form.payment_mode } : {}),
        });
        draftId.current = data.id;
      }
      const id = draftId.current!;

      // Bills go up before the claim is filed, so a category that requires a
      // receipt does not bounce the submission straight back at the person.
      for (const [i, file] of files.entries()) {
        const key = `${i}:${file.name}:${file.size}`;
        if (uploaded.current.has(key)) continue;
        await uploadDocument(id, file);
        uploaded.current.add(key);
      }
      if (submit) await api.post(`${BASE}/${id}/submit`, {});
      return { id };
    },
    onSuccess: (claim, submit) => {
      toast.success(submit ? 'Reimbursement submitted.' : 'Saved as a draft.');
      qc.invalidateQueries({ queryKey: ['reimbursements'] });
      onCreated(claim.id);
    },
    onError: (e: any) => {
      setErrors(e.fieldErrors || {});
      toast.error(e.message);
    },
  });

  const invalid = !form.description.trim() || !(amountMinor > 0) || !form.expense_date;

  return (
    <Modal
      open onClose={onClose} size="lg"
      title="New reimbursement"
      subtitle="What you spent on company business, and the bill to back it up"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate(false)} disabled={invalid} loading={create.isPending && !create.variables}>
            Save draft
          </Button>
          <Button variant="primary" icon={<Send size={15} />} disabled={invalid}
            loading={create.isPending && !!create.variables} onClick={() => create.mutate(true)}>
            Submit
          </Button>
        </>
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Expense date" required error={errors.expense_date}
          hint="The day the money went out">
          <Input type="date" max={today()} value={form.expense_date}
            onChange={(e) => set('expense_date', e.target.value)} />
        </Field>

        <Field label="Category" error={errors.category_id}
          hint={category?.requires_receipt ? 'A bill is required for this category' : undefined}>
          <Select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">Choose a category…</option>
            {(categories || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>

        <Field label="Amount" required error={errors.amount_minor}
          hint={overCap ? `Above the usual ${money(category.cap_minor)} for this category — say why below` : undefined}>
          <Input type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00"
            value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </Field>

        <Field label="Paid by" hint="How you paid at the time">
          <Select value={form.payment_mode} onChange={(e) => set('payment_mode', e.target.value)}>
            <option value="">Not stated</option>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="upi">UPI</option>
            <option value="netbanking">Net banking</option>
            <option value="other">Other</option>
          </Select>
        </Field>

        <Field label="Merchant" className="sm:col-span-2" hint="Who you paid — the airline, the hotel, the shop">
          <Input value={form.merchant} onChange={(e) => set('merchant', e.target.value)}
            placeholder="Uber, Taj Coimbatore, Amazon…" />
        </Field>

        <Field label="What was it for?" required className="sm:col-span-2" error={errors.description}
          hint="Enough for a manager to recognise the spend without asking">
          <Textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Cab to the client office in Chennai for the quarterly review" />
        </Field>

        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-medium text-muted">Bills and supporting documents</p>
          <input
            ref={fileRef} type="file" multiple className="hidden"
            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
            // Read the picked files before resetting the input, never inside the
            // updater: React runs that later, by which point clearing `value`
            // has already emptied `files` and the attachment is silently lost.
            // The reset is what lets the same file be picked twice in a row.
            onChange={(e) => {
              const { ok, tooBig } = sift(Array.from(e.target.files || []));
              e.target.value = '';
              if (tooBig.length) {
                toast.error(`${tooBig.map((f) => f.name).join(', ')} is over 15 MB. `
                  + 'Send a photo of the bill rather than the original scan.');
              }
              if (ok.length) setFiles((prev) => [...prev, ...ok]);
            }}
          />
          <Button icon={<Upload size={15} />} onClick={() => fileRef.current?.click()}>Attach a file</Button>

          {!!files.length && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}
                  className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
                  <FileText size={14} className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.name}</span>
                  <span className="shrink-0 text-[11.5px] text-subtle tabular">{fileSize(f.size)}</span>
                  <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove ${f.name}`}
                    className="shrink-0 text-subtle hover:text-[var(--negative)] cursor-pointer">
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Reads a file into the base64 body the attachments endpoint takes. */
async function uploadDocument(claimId: string, file: File) {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  return api.post('/files', {
    entity: 'reimbursement',
    entity_id: claimId,
    filename: file.name,
    mime: file.type || 'application/octet-stream',
    content_base64: base64,
  });
}

/* ================================================================= DRAWER */
function ClaimDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [decision, setDecision] = useState<null | { gate: 'manager' | 'finance'; outcome: 'approved' | 'rejected' }>(null);
  const [paying, setPaying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: r, isLoading } = useQuery({
    queryKey: ['reimbursement', id],
    queryFn: () => api.get(`${BASE}/${id}`).then((res) => res.data),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['reimbursement', id] });
    qc.invalidateQueries({ queryKey: ['reimbursements'] });
  };

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: any }) => api.post(`${BASE}/${id}/${path}`, body || {}),
    onSuccess: () => { refresh(); setDecision(null); setPaying(false); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`${BASE}/${id}`),
    onSuccess: () => { toast.success('Draft deleted.'); refresh(); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !r) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={5} cols={2} /></div></Drawer>;
  }

  const p = r.permissions || {};

  return (
    <>
      <Drawer
        open onClose={onClose} width="max-w-2xl"
        title={r.number || 'Draft reimbursement'}
        subtitle={(
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted">{r.user_name}</span>
            <StatusPill status={r.status} />
            {r.category_name && <Badge tone="neutral">{r.category_name}</Badge>}
          </span>
        )}
        footer={(
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {p.delete && (
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
            )}
            {p.withdraw && (
              <Button onClick={() => act.mutate({ path: 'withdraw' })} loading={act.isPending}>Withdraw</Button>
            )}
            {p.submit && (
              <Button variant="primary" icon={<Send size={15} />} loading={act.isPending}
                onClick={() => act.mutate({ path: 'submit' })}>
                Submit for approval
              </Button>
            )}
            {p.manager_decide && (
              <>
                <Button variant="danger" icon={<XCircle size={15} />}
                  onClick={() => setDecision({ gate: 'manager', outcome: 'rejected' })}>Reject</Button>
                <Button variant="primary" icon={<CheckCircle2 size={15} />}
                  onClick={() => setDecision({ gate: 'manager', outcome: 'approved' })}>Approve</Button>
              </>
            )}
            {p.finance_decide && (
              <>
                <Button variant="danger" icon={<XCircle size={15} />}
                  onClick={() => setDecision({ gate: 'finance', outcome: 'rejected' })}>Reject</Button>
                <Button variant="primary" icon={<ShieldCheck size={15} />}
                  onClick={() => setDecision({ gate: 'finance', outcome: 'approved' })}>Approve claim</Button>
              </>
            )}
            {p.pay && (
              <Button variant="accent" icon={<Banknote size={15} />} onClick={() => setPaying(true)}>
                Record payment
              </Button>
            )}
          </div>
        )}
      >
        <div className="space-y-5 p-5">
          <WorkflowTrack claim={r} />

          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label="Amount claimed" value={<span className="text-[17px] font-semibold tabular">{money(r.amount_minor)}</span>} />
            {r.approved_minor != null && (
              <Detail label="Approved" value={<span className="tabular">{money(r.approved_minor)}</span>} />
            )}
            <Detail label="Expense date" value={date(r.expense_date, 'long')} />
            <Detail label="Category" value={r.category_name || '—'} />
            {r.merchant && <Detail label="Merchant" value={r.merchant} />}
            {r.payment_mode && <Detail label="Paid by" value={MODE_LABEL[r.payment_mode] || titleCase(r.payment_mode)} />}
            {r.submitted_at && <Detail label="Submitted" value={dateTime(r.submitted_at)} />}
            {r.manager_name && <Detail label="Approver" value={r.manager_name} />}
          </div>

          <div>
            <p className="label-cap mb-1">What it was for</p>
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{r.description}</p>
          </div>

          {r.rejection_reason && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--negative)_30%,transparent)] bg-negative-soft p-3">
              <p className="text-[12.5px] font-semibold text-[var(--negative)]">Rejected</p>
              <p className="mt-0.5 text-[13px] leading-snug text-muted">{r.rejection_reason}</p>
            </div>
          )}

          {r.status === 'paid' && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--positive)_30%,transparent)] bg-positive-soft p-3">
              <p className="text-[12.5px] font-semibold text-[var(--positive)]">
                Paid {money(r.paid_minor)} · {PAYMENT_METHODS.find((m) => m.id === r.payment_method)?.label
                  || titleCase((r.payment_method || '').replace('_', ' '))}
              </p>
              <p className="mt-0.5 text-[13px] text-muted">
                {date(r.paid_at, 'long')}
                {r.payment_reference && <span className="mono"> · {r.payment_reference}</span>}
                {r.paid_by_name && ` · recorded by ${r.paid_by_name}`}
              </p>
            </div>
          )}

          <Documents claim={r} canUpload={!!p.upload} onChange={refresh} />
          <HistoryTrail events={r.history || []} />
        </div>
      </Drawer>

      {decision && (
        <DecisionModal
          claim={r} gate={decision.gate} outcome={decision.outcome}
          onClose={() => setDecision(null)}
          onSubmit={(body) => act.mutate({ path: `${decision.gate}-decision`, body })}
          pending={act.isPending}
        />
      )}

      {paying && (
        <PaymentModal claim={r} onClose={() => setPaying(false)} pending={act.isPending}
          onSubmit={(body) => act.mutate({ path: 'pay', body })} />
      )}

      <ConfirmDialog
        open={confirmDelete} onClose={() => setConfirmDelete(false)} danger
        title="Delete this draft?" confirmLabel="Delete" loading={remove.isPending}
        message="It has not been submitted, so nobody has seen it. This cannot be undone."
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

const Detail = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="min-w-0">
    <p className="label-cap">{label}</p>
    <div className="mt-0.5 text-[13.5px] text-ink">{value}</div>
  </div>
);

/** Where the claim has got to, as a track rather than a single word. */
function WorkflowTrack({ claim }: { claim: any }) {
  const rejected = claim.status === 'rejected' || claim.status === 'cancelled';
  const reached = rejected ? -1 : TRACK.indexOf(claim.status);

  if (rejected) {
    return (
      <div className="rounded-lg border border-line bg-sunken px-3 py-2.5">
        <p className="text-[13px] text-muted">
          {claim.status === 'cancelled'
            ? 'Withdrawn by the claimant before a decision was made.'
            : `Rejected at ${claim.finance_decision === 'rejected' ? 'finance review' : 'manager approval'}.`}
        </p>
      </div>
    );
  }

  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Approval progress">
      {TRACK.map((s, i) => {
        const ui = statusUi(s);
        const state = i < reached ? 'done' : i === reached ? 'here' : 'todo';
        return (
          <li key={s} className="flex items-center gap-1">
            <span className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium',
              state === 'done' && 'border-transparent bg-positive-soft text-[var(--positive)]',
              state === 'here' && 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]',
              state === 'todo' && 'border-line bg-sunken text-subtle',
            )}>
              {state === 'done' ? <CheckCircle2 size={12} /> : state === 'here' ? <Clock size={12} /> : null}
              {ui.stage}
            </span>
            {i < TRACK.length - 1 && <span className="text-subtle" aria-hidden>›</span>}
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------- documents */
function Documents({ claim, canUpload, onChange }: { claim: any; canUpload: boolean; onChange: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => { for (const f of files) await uploadDocument(claim.id, f); },
    onSuccess: () => { toast.success('Attached.'); onChange(); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (docId: string) => api.del(`/files/${docId}`),
    onSuccess: () => onChange(),
    onError: (e: any) => toast.error(e.message),
  });

  const docs = claim.documents || [];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="label-cap">Bills and supporting documents</p>
        {canUpload && (
          <>
            <input ref={fileRef} type="file" multiple className="hidden"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
              onChange={(e) => {
                const { ok, tooBig } = sift(Array.from(e.target.files || []));
                e.target.value = '';
                if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} is over 15 MB.`);
                if (ok.length) upload.mutate(ok);
              }} />
            <Button size="sm" icon={<Upload size={14} />} loading={upload.isPending}
              onClick={() => fileRef.current?.click()}>Attach</Button>
          </>
        )}
      </div>

      {!docs.length ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-subtle">
          Nothing attached yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {docs.map((d: any) => (
            <li key={d.id} className="flex items-center gap-2.5 rounded-md border border-line bg-sunken px-3 py-2">
              <Paperclip size={14} className="shrink-0 text-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{d.filename}</span>
                <span className="text-[11.5px] text-subtle">
                  {fileSize(d.size_bytes)} · {d.uploaded_by_name} · {relative(d.created_at)}
                </span>
              </span>
              <Button size="sm" variant="ghost" icon={<Download size={14} />}
                onClick={() => api.download(d.url.replace('/api/v1', ''), d.filename)}>
                Open
              </Button>
              {canUpload && (
                <button onClick={() => remove.mutate(d.id)} aria-label={`Remove ${d.filename}`}
                  className="shrink-0 text-subtle hover:text-[var(--negative)] cursor-pointer">
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- trail */
const ACTION_LABEL: Record<string, string> = {
  created: 'Raised the claim',
  updated: 'Edited the claim',
  submitted: 'Submitted for approval',
  manager_approved: 'Approved at manager review',
  manager_rejected: 'Rejected at manager review',
  finance_approved: 'Approved at finance review',
  finance_rejected: 'Rejected at finance review',
  withdrawn: 'Withdrew the claim',
  paid: 'Recorded the payment',
};

function HistoryTrail({ events }: { events: any[] }) {
  if (!events.length) return null;
  return (
    <div>
      <p className="label-cap mb-2">History</p>
      <ol className="space-y-0">
        {events.map((e, i) => (
          <li key={e.id} className="flex gap-3">
            <span className="flex flex-col items-center">
              <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full',
                e.action.includes('rejected') ? 'bg-[var(--negative)]'
                  : e.action === 'paid' ? 'bg-[var(--positive)]' : 'bg-[var(--brand)]')} aria-hidden />
              {i < events.length - 1 && <span className="w-px flex-1 bg-[var(--border)]" aria-hidden />}
            </span>
            <span className="min-w-0 flex-1 pb-3">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13.5px] font-medium text-ink">
                  {ACTION_LABEL[e.action] || titleCase(e.action)}
                </span>
                <span className="text-[12px] text-subtle">
                  {e.actor_name} · {dateTime(e.created_at)}
                </span>
              </span>
              {e.note && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{e.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* -------------------------------------------------------------- decisions */
function DecisionModal({ claim, gate, outcome, onClose, onSubmit, pending }: {
  claim: any; gate: 'manager' | 'finance'; outcome: 'approved' | 'rejected';
  onClose: () => void; onSubmit: (body: any) => void; pending: boolean;
}) {
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState(String((claim.amount_minor / 100).toFixed(2)));
  const rejecting = outcome === 'rejected';
  const trims = gate === 'finance' && !rejecting;
  const approvedMinor = Math.round(Number(amount || 0) * 100);

  return (
    <Modal
      open onClose={onClose}
      title={rejecting ? 'Reject this claim' : gate === 'finance' ? 'Approve for payment' : 'Approve this claim'}
      subtitle={`${claim.number || 'Draft'} · ${claim.user_name} · ${money(claim.amount_minor)}`}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={rejecting ? 'danger' : 'primary'} loading={pending}
            disabled={rejecting ? !note.trim() : trims && !(approvedMinor > 0)}
            onClick={() => onSubmit({
              decision: outcome,
              ...(note.trim() ? { note: note.trim() } : {}),
              ...(trims && approvedMinor !== claim.amount_minor ? { approved_minor: approvedMinor } : {}),
            })}
          >
            {rejecting ? 'Reject' : 'Approve'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {trims && (
          <Field label="Amount to reimburse" required
            hint="Defaults to the full claim. Lower it if only part of the spend is reimbursable.">
            <Input type="number" min="0" max={(claim.amount_minor / 100).toFixed(2)} step="0.01"
              value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}

        <Field
          label={rejecting ? 'Why is it being rejected?' : 'Note (optional)'}
          required={rejecting}
          hint={rejecting
            ? 'The claimant sees this, so it should tell them what to fix.'
            : 'Anything the next person in the chain should know.'}
        >
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus
            placeholder={rejecting ? 'The bill does not match the amount claimed' : ''} />
        </Field>
      </div>
    </Modal>
  );
}

function PaymentModal({ claim, onClose, onSubmit, pending }: {
  claim: any; onClose: () => void; onSubmit: (body: any) => void; pending: boolean;
}) {
  const settled = claim.approved_minor ?? claim.amount_minor;
  const [form, setForm] = useState({
    payment_method: 'bank_transfer',
    payment_reference: '',
    paid_at: today(),
    amount: String((settled / 100).toFixed(2)),
    note: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const paidMinor = Math.round(Number(form.amount || 0) * 100);

  return (
    <Modal
      open onClose={onClose}
      title="Record the payment"
      subtitle={`${claim.number} · ${claim.user_name} · ${money(settled)} approved`}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} disabled={!(paidMinor > 0) || paidMinor > settled}
            onClick={() => onSubmit({
              payment_method: form.payment_method,
              paid_minor: paidMinor,
              paid_at: form.paid_at,
              ...(form.payment_reference.trim() ? { payment_reference: form.payment_reference.trim() } : {}),
              ...(form.note.trim() ? { note: form.note.trim() } : {}),
            })}>
            Mark as paid
          </Button>
        </>
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount paid" required
          hint={paidMinor > settled ? 'This is more than was approved' : undefined}>
          <Input type="number" min="0" step="0.01" value={form.amount}
            onChange={(e) => set('amount', e.target.value)} />
        </Field>
        <Field label="Paid on" required>
          <Input type="date" value={form.paid_at} onChange={(e) => set('paid_at', e.target.value)} />
        </Field>
        <Field label="Method" required>
          <Select value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label="Reference" hint="UTR, cheque number or payroll cycle">
          <Input value={form.payment_reference} onChange={(e) => set('payment_reference', e.target.value)} />
        </Field>
        <Field label="Note" className="sm:col-span-2">
          <Textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================ REPORTS */
function ReportsTab() {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 5, 1);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today());

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reimbursements', 'reports', from, to],
    queryFn: () => api.get(`${BASE}/reports`, { from, to }).then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <Card><TableSkeleton cols={4} /></Card>;

  const t = data.totals || {};
  const months = (data.by_month || []).map((m: any) => ({ ...m, label: monthLabel(m.month) }));
  const maxUser = Math.max(1, ...(data.by_user || []).map((u: any) => u.claimed_minor));

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Field label="From" className="w-[160px]">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" className="w-[160px]">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button className="ml-auto" icon={<Download size={15} />}
            onClick={() => api.download(`${BASE}/reports/export`, 'reimbursements.csv', { from, to })}>
            Export CSV
          </Button>
        </div>
      </Card>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card className="p-3">
          <p className="label-cap">Claimed</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{money(t.claimed_minor)}</p>
          <p className="text-[12px] text-subtle">{t.n || 0} requests</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Paid out</p>
          <p className="mt-1 text-[19px] font-semibold text-[var(--positive)] tabular">{money(t.paid_minor)}</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Approved, unpaid</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{money(t.awaiting_payment_minor)}</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">In the chain</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{money(t.in_flight_minor)}</p>
          <p className="text-[12px] text-subtle">not yet decided</p>
        </Card>
        <Card className="p-3">
          <p className="label-cap">Rejected</p>
          <p className="mt-1 text-[19px] font-semibold text-ink tabular">{money(t.rejected_minor)}</p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Claimed and paid by month" icon={<BadgeIndianRupee size={16} />} />
          <div className="p-4 pt-3">
            {!months.length ? (
              <EmptyState compact title="Nothing in this period" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={months} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v) => money(v, { compact: true })} tickLine={false} axisLine={false} width={62} />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-sunken)' }}
                    formatter={(v: any, name: any) => [money(Number(v)), name === 'claimed_minor' ? 'Claimed' : 'Paid']}
                  />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                  <Bar dataKey="claimed_minor" name="Claimed" fill="#1e40af" radius={[4, 4, 0, 0]} maxBarSize={34} />
                  <Bar dataKey="paid_minor" name="Paid" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={34} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="By category" icon={<Wallet size={16} />} />
          {!data.by_category?.length ? <EmptyState compact title="Nothing to break down" /> : (
            <ul className="divide-y divide-[var(--border)]">
              {data.by_category.map((c: any) => (
                <li key={c.category} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: c.color || 'var(--ink-subtle)' }} aria-hidden />
                      <span className="truncate text-[13.5px] text-ink">{c.category}</span>
                    </span>
                    <span className="shrink-0 text-[13px] tabular text-ink">{money(c.claimed_minor)}</span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-subtle">{c.n} claim{c.n === 1 ? '' : 's'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="By person" icon={<Receipt size={16} />}
            subtitle="Who is claiming, how much of it has been paid" />
          {!data.by_user?.length ? <EmptyState compact title="No claims in this period" /> : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TH>Person</TH>
                  <TH align="right" width="90px">Claims</TH>
                  <TH align="right" width="130px">Claimed</TH>
                  <TH align="right" width="130px">Paid</TH>
                  <TH width="180px">Share</TH>
                </THead>
                <tbody>
                  {data.by_user.map((u: any) => (
                    <TR key={u.user_id}>
                      <TD><AvatarWithName name={u.name} url={u.avatar_url} sub={u.designation} size={26} /></TD>
                      <TD align="right" mono>{u.n}</TD>
                      <TD align="right" mono>{money(u.claimed_minor)}</TD>
                      <TD align="right" mono>{money(u.paid_minor)}</TD>
                      <TD><Meter value={u.claimed_minor} max={maxUser} /></TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
