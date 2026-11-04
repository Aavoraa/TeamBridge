import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, FileText, Send, Eye, CheckCircle2, XCircle, Link2, FileDown, Trash2, Copy, Sparkles,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date, dateTime, relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, SearchInput, Select, Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead,
  TR, Textarea, useToast, cx,
} from '../components/ui';
import { openUrl } from '../lib/openUrl';

/** Module E5 — templated proposals, tracked share links and e-acceptance. */
export default function Proposals() {
  const { can, tenant } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(params.get('open'));

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['proposals', status, search],
    queryFn: () => api.get('/proposals', { status, search, limit: 50 }),
  });

  const proposals = data?.data || [];
  const summary = data?.meta?.summary || {};

  return (
    <>
      <PageHeader
        title="Proposals"
        subtitle="Generated from service-line templates, shared as a tracked link, accepted online"
        actions={can('proposals', 'create') && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New proposal</Button>
        )}
      />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat label="Awaiting decision" value={summary.pending ?? 0}
          sub={money(summary.pending_value_minor, { compact: true })} icon={<Send size={15} />} />
        <Stat label="Accepted" value={summary.accepted ?? 0}
          sub={money(summary.accepted_value_minor, { compact: true })} tone="positive" icon={<CheckCircle2 size={15} />} />
        <Stat label="Drafts" value={summary.draft ?? 0} icon={<FileText size={15} />} />
        <Stat label="Win rate"
          value={summary.total ? `${Math.round((summary.accepted / summary.total) * 100)}%` : '—'}
          sub={`${summary.total ?? 0} proposals all time`} />
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by title, number or client…"
            className="flex-1 min-w-[220px]" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="w-[140px]">
            <option value="">All statuses</option>
            {['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </div>
      </Card>

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton cols={6} /></Card>
          : !proposals.length ? (
            <Card>
              <EmptyState icon={<FileText size={20} />} title="No proposals yet"
                message="Pick a service-line template and the scope, pricing and terms are pre-filled from your pack."
                action={can('proposals', 'create')
                  ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New proposal</Button>
                  : undefined} />
            </Card>
          ) : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH width="145px">Number</TH>
                    <TH>Proposal</TH>
                    <TH width="170px">Client</TH>
                    <TH align="right" width="120px">Value</TH>
                    <TH width="110px">Engagement</TH>
                    <TH width="130px">Valid until</TH>
                    <TH width="115px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {proposals.map((p: any) => (
                    <TR key={p.id} onClick={() => setOpenId(p.id)}>
                      <TD mono>{p.number}</TD>
                      <TD>
                        <span className="block font-medium text-ink">{p.title}</span>
                        {p.service_line_name && <span className="block text-[12px] text-subtle">{p.service_line_name}</span>}
                      </TD>
                      <TD><span className="text-muted text-[13px] truncate block max-w-[160px]">{p.client_name}</span></TD>
                      <TD align="right" className="font-medium">{money(p.total_minor)}</TD>
                      <TD>
                        {p.view_count > 0 ? (
                          <span className="flex items-center gap-1.5 text-[13px] text-muted">
                            <Eye size={13} /> {p.view_count} view{p.view_count === 1 ? '' : 's'}
                          </span>
                        ) : <span className="text-subtle text-[13px]">not opened</span>}
                      </TD>
                      <TD><span className="text-muted text-[13px]">{p.valid_until ? date(p.valid_until) : '—'}</span></TD>
                      <TD><StatusBadge status={p.status} /></TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

      {createOpen && <CreateProposalModal onClose={() => setCreateOpen(false)} onCreated={setOpenId} />}
      {openId && <ProposalDrawer id={openId} onClose={() => {
        setOpenId(null);
        const next = new URLSearchParams(params); next.delete('open'); setParams(next, { replace: true });
      }} />}
    </>
  );
}

/* ----------------------------------------------------------------- create */
function CreateProposalModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const [clientId, setClientId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [validUntil, setValidUntil] = useState(
    new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  );

  const { data: clients } = useQuery({
    queryKey: ['clients-for-proposal'],
    queryFn: () => api.get('/crm/clients', { limit: 200 }).then((r) => r.data),
  });
  const { data: templates } = useQuery({
    queryKey: ['proposal-templates'],
    queryFn: () => api.get('/proposals/templates').then((r) => r.data),
    staleTime: 300_000,
  });

  const template = templates?.find((t: any) => t.id === templateId);
  const preview = useMemo(() => {
    if (!template) return null;
    const subtotal = (template.default_items || []).reduce(
      (a: number, i: any) => a + Math.round((i.qty ?? 1) * i.rate_minor), 0,
    );
    return { subtotal, tax: Math.round(subtotal * 0.18), total: subtotal + Math.round(subtotal * 0.18) };
  }, [template]);

  const create = useMutation({
    mutationFn: () => api.post('/proposals', {
      client_id: clientId,
      template_id: templateId || null,
      title: title.trim() || template?.name || 'Proposal',
      valid_until: validUntil,
    }),
    onSuccess: (res: any) => {
      toast.success(`Proposal ${res.data.number} created.`);
      qc.invalidateQueries({ queryKey: ['proposals'] });
      onCreated(res.data.id);
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="New proposal" size="lg"
      subtitle="Scope, pricing and terms are pre-filled from the template — edit anything before sending"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!clientId}
            onClick={() => create.mutate()}>Create draft</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Client" required>
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)} autoFocus>
            <option value="">Select a client…</option>
            {clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>

        <Field label="Template" hint="Per service line — from your seeded proposal pack">
          <div className="grid gap-2 sm:grid-cols-2">
            {templates?.map((t: any) => (
              <button key={t.id} type="button"
                onClick={() => { setTemplateId(t.id); if (!title) setTitle(t.name); }}
                className={cx('rounded-lg border p-3 text-left transition-colors duration-150 cursor-pointer',
                  templateId === t.id
                    ? 'border-[var(--brand)] bg-brand-soft ring-1 ring-[var(--brand)]'
                    : 'border-line hover:border-line-strong')}>
                <span className="flex items-center gap-2">
                  <Sparkles size={14} className={templateId === t.id ? 'text-[var(--brand)]' : 'text-subtle'} />
                  <span className="text-[13.5px] font-medium text-ink">{t.name}</span>
                </span>
                <span className="mt-1 block text-[12px] text-subtle">
                  {t.sections?.length || 0} sections · {t.default_items?.length || 0} line items
                </span>
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" hint="Shown on the PDF and the share link">
            <Input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={template?.name || 'Brand identity & digital launch'} />
          </Field>
          <Field label="Valid until">
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>

        {preview && (
          <div className="rounded-lg border border-line bg-sunken p-3.5">
            <p className="label-cap mb-2">Template pricing</p>
            <ul className="space-y-1 text-[13px]">
              {template.default_items.map((i: any, idx: number) => (
                <li key={idx} className="flex justify-between gap-3">
                  <span className="text-muted truncate">{i.description}</span>
                  <span className="text-ink tabular shrink-0">{money(Math.round((i.qty ?? 1) * i.rate_minor))}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-line pt-2 text-[13px]">
              <span className="font-medium text-ink">Total including 18% GST</span>
              <span className="font-semibold text-ink tabular">{money(preview.total)}</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------- drawer */
function ProposalDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [markOpen, setMarkOpen] = useState<'accepted' | 'rejected' | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: p, isLoading } = useQuery({
    queryKey: ['proposal', id],
    queryFn: () => api.get(`/proposals/${id}`).then((r) => r.data),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['proposal', id] });
    qc.invalidateQueries({ queryKey: ['proposals'] });
  };

  const send = useMutation({
    mutationFn: () => api.post(`/proposals/${id}/send`),
    onSuccess: (res: any) => {
      toast.success('Sent. The share link now tracks opens.');
      navigator.clipboard?.writeText(res.data.share_url).catch(() => {});
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const mark = useMutation({
    mutationFn: (status: string) => api.post(`/proposals/${id}/mark`, { status }),
    onSuccess: () => { toast.success('Updated.'); invalidate(); setMarkOpen(null); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/proposals/${id}`),
    onSuccess: () => { toast.success('Deleted.'); invalidate(); onClose(); },
  });

  if (isLoading || !p) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={4} cols={2} /></div></Drawer>;
  }

  const copyLink = () => {
    if (!p.share_url) return;
    navigator.clipboard?.writeText(p.share_url);
    toast.success('Share link copied to your clipboard.');
  };

  return (
    <>
      <Drawer open onClose={onClose} title={p.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.status} />
            <span className="mono text-subtle">{p.number}</span>
            <span className="text-subtle">· {p.client_name}</span>
          </span>
        }
        width="max-w-2xl"
        footer={
          <>
            {can('proposals', 'delete') && p.status === 'draft' && (
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
            )}
            <Button icon={<FileDown size={15} />} onClick={() => api.openPdf(`/public/proposals/${p.share_token}/pdf`)}
              disabled={p.status === 'draft'}>PDF</Button>
            {can('proposals', 'edit') && ['sent', 'viewed'].includes(p.status) && (
              <>
                <Button icon={<XCircle size={15} />} onClick={() => setMarkOpen('rejected')}>Mark lost</Button>
                <Button variant="primary" icon={<CheckCircle2 size={15} />} onClick={() => setMarkOpen('accepted')}>
                  Mark accepted
                </Button>
              </>
            )}
            {can('proposals', 'edit') && p.status === 'draft' && (
              <Button variant="primary" icon={<Send size={15} />} loading={send.isPending} onClick={() => send.mutate()}>
                Send proposal
              </Button>
            )}
          </>
        }>
        <div className="p-5 space-y-5">
          {p.share_url && p.status !== 'draft' && (
            <div className="rounded-lg border border-line bg-sunken p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="label-cap">Client share link</p>
                <span className="flex items-center gap-1.5 text-[12px] text-subtle">
                  <Eye size={12} />
                  {p.view_count > 0
                    ? `${p.view_count} view${p.view_count === 1 ? '' : 's'} · last ${relative(p.last_viewed_at)}`
                    : 'not opened yet'}
                </span>
              </div>
              <div className="flex gap-2">
                <Input readOnly value={p.share_url} className="mono text-[12px]"
                  onFocus={(e) => e.currentTarget.select()} />
                <Button icon={<Copy size={14} />} onClick={copyLink}>Copy</Button>
                <Button icon={<Link2 size={14} />} onClick={() => openUrl(p.share_url)}
                  aria-label="Open share link" />
              </div>
              {p.accepted_at && (
                <p className="mt-2 text-[12.5px] text-[var(--positive)]">
                  Accepted by {p.accepted_by_name} on {dateTime(p.accepted_at)}
                </p>
              )}
            </div>
          )}

          {p.sections?.length > 0 && (
            <div className="space-y-4">
              {p.sections.map((s: any, i: number) => (
                <div key={i}>
                  <h3 className="text-[14px] font-semibold text-ink mb-1">{s.heading}</h3>
                  <p className="text-[13.5px] text-muted leading-relaxed">{s.body}</p>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="label-cap mb-2">Scope & investment</p>
            <Table>
              <THead>
                <tr>
                  <TH>Deliverable</TH>
                  <TH align="right" width="60px">Qty</TH>
                  <TH align="right" width="110px">Rate</TH>
                  <TH align="right" width="115px">Amount</TH>
                </tr>
              </THead>
              <tbody>
                {p.items?.map((it: any) => (
                  <tr key={it.id} className="border-b border-line last:border-0">
                    <TD>
                      <span className="block font-medium text-ink">{it.description}</span>
                      {it.detail && <span className="block text-[12px] text-subtle">{it.detail}</span>}
                    </TD>
                    <TD align="right">{it.qty}</TD>
                    <TD align="right">{money(it.rate_minor)}</TD>
                    <TD align="right" className="font-medium">{money(it.amount_minor)}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>

            <dl className="mt-3 ml-auto max-w-[260px] space-y-1.5 text-[13px]">
              <div className="flex justify-between"><dt className="text-subtle">Subtotal</dt><dd className="tabular text-ink">{money(p.subtotal_minor)}</dd></div>
              {p.discount_minor > 0 && (
                <div className="flex justify-between"><dt className="text-subtle">Discount</dt><dd className="tabular text-ink">− {money(p.discount_minor)}</dd></div>
              )}
              <div className="flex justify-between"><dt className="text-subtle">GST @ {p.tax_rate}%</dt><dd className="tabular text-ink">{money(p.tax_minor)}</dd></div>
              <div className="flex justify-between border-t border-line pt-2">
                <dt className="font-semibold text-ink">Total</dt>
                <dd className="text-[17px] font-semibold text-ink tabular">{money(p.total_minor)}</dd>
              </div>
            </dl>
          </div>

          {p.terms && (
            <div>
              <p className="label-cap mb-1.5">Terms</p>
              <p className="text-[12.5px] text-subtle leading-relaxed">{p.terms}</p>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg bg-sunken p-3.5 text-[13px]">
            <div><dt className="label-cap">Owner</dt><dd className="text-ink mt-0.5">{p.owner_name || '—'}</dd></div>
            <div><dt className="label-cap">Valid until</dt><dd className="text-ink mt-0.5">{date(p.valid_until)}</dd></div>
            <div><dt className="label-cap">Created</dt><dd className="text-ink mt-0.5">{date(p.created_at)}</dd></div>
            {p.sent_at && <div><dt className="label-cap">Sent</dt><dd className="text-ink mt-0.5">{date(p.sent_at)}</dd></div>}
          </dl>
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!markOpen} onClose={() => setMarkOpen(null)}
        onConfirm={() => mark.mutate(markOpen!)} loading={mark.isPending}
        title={markOpen === 'accepted' ? 'Mark this proposal accepted?' : 'Mark this proposal lost?'}
        confirmLabel={markOpen === 'accepted' ? 'Accept' : 'Mark lost'} danger={markOpen === 'rejected'}
        message={markOpen === 'accepted'
          ? 'The client moves to the onboarding stage and the acceptance is logged on their timeline.'
          : 'The proposal is closed and the outcome is logged on the client timeline.'}
      />

      <ConfirmDialog
        open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()}
        title="Delete this draft?" danger confirmLabel="Delete" loading={remove.isPending}
        message="The draft is removed. Its number is not reused."
      />
    </>
  );
}
