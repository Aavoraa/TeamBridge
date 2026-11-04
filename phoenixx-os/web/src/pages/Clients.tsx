import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Download, Globe, Mail, Pencil, Phone, Plus, Trash2, Users2, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, SearchInput, Select, Table, TableSkeleton, TD, TH, THead, TR,
  Textarea, useToast,
} from '../components/ui';

/**
 * The client register — every company on file, independent of whether there is
 * a live opportunity for them. The CRM pipeline next door is the sales view of
 * a deal in flight; this is the record of who the client actually is, and it is
 * what proposals, invoices and campaign work reuse instead of retyping details.
 */

type Account = {
  id: string;
  name: string;
  legal_name?: string | null;
  industry?: string | null;
  status: 'active' | 'inactive' | 'archived';
  owner_id?: string | null;
  owner_name?: string | null;
  owner_avatar?: string | null;
  contact_name?: string | null;
  contact_designation?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  website?: string | null;
  gstin?: string | null;
  pan?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  country?: string | null;
  currency?: string;
  payment_terms_days?: number;
  tags?: string[];
  notes?: string | null;
  lead_count?: number;
};

const STATUS_TONE = {
  active: 'positive',
  inactive: 'warning',
  archived: 'neutral',
} as const;

export default function Clients() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['client-accounts', search, status],
    queryFn: () => api.get<Account[]>('/clients', {
      search, status, include_archived: status === 'archived' ? 'true' : undefined, limit: 100,
    }).then((r) => r.data),
  });

  const { data: directory } = useQuery({
    queryKey: ['users-directory'],
    queryFn: () => api.get('/users/directory').then((r) => r.data),
    staleTime: 300_000,
  });

  const remove = useMutation({
    mutationFn: (a: Account) => api.del(`/clients/${a.id}`),
    onSuccess: (res: any, a) => {
      const n = res?.data?.detached_leads || 0;
      toast.success(n
        ? `${a.name} archived. ${n} pipeline record${n === 1 ? '' : 's'} kept, now unlinked.`
        : `${a.name} archived.`);
      qc.invalidateQueries({ queryKey: ['client-accounts'] });
      setDeleting(null);
    },
    onError: (e: any) => toast.error(e.message || 'Could not archive that client'),
  });

  const rows = data || [];
  const counts = useMemo(() => ({
    total: rows.length,
    linked: rows.filter((r) => (r.lead_count || 0) > 0).length,
  }), [rows]);

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={rows.length
          ? `${counts.total} on file · ${counts.linked} with pipeline activity`
          : 'Your client register'}
        actions={(
          <div className="flex items-center gap-2">
            {can('crm', 'export') && rows.length > 0 && (
              <Button icon={<Download size={15} />}
                onClick={() => api.download('/clients/export', 'clients.csv')}>
                Export
              </Button>
            )}
            {can('crm', 'create') && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                New client
              </Button>
            )}
          </div>
        )}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch}
          placeholder="Search name, contact, city or industry…" className="w-full max-w-sm" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">Active & inactive</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
          <option value="archived">Archived</option>
        </Select>
        {(search || status) && (
          <Button size="sm" variant="ghost" icon={<X size={14} />}
            onClick={() => { setSearch(''); setStatus(''); }}>
            Clear
          </Button>
        )}
      </div>

      {error ? <ErrorState error={error} retry={() => refetch()} />
        : isLoading ? <Card><TableSkeleton cols={6} /></Card>
          : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Building2 size={20} />}
                title={search || status ? 'No clients match' : 'No clients yet'}
                message={search || status
                  ? 'Try a different search, or clear the filters.'
                  : 'Add your clients here once and reuse their details on every lead, proposal and invoice.'}
                action={can('crm', 'create') && !search && !status
                  ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                      Add your first client
                    </Button>
                  : undefined}
              />
            </Card>
          ) : (
            <Card>
              <Table>
                <THead>
                  <TR>
                    <TH>Client</TH>
                    <TH>Primary contact</TH>
                    <TH>Location</TH>
                    <TH>Account manager</TH>
                    <TH>Pipeline</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <tbody>
                  {rows.map((a) => (
                    <TR key={a.id}>
                      <TD>
                        <button type="button" onClick={() => setViewing(a)}
                          className="text-left font-medium text-ink hover:text-[var(--brand)]">
                          {a.name}
                        </button>
                        <div className="mt-0.5 flex items-center gap-2">
                          {a.industry && <span className="text-[12px] text-subtle">{a.industry}</span>}
                          {a.status !== 'active' && (
                            <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                          )}
                        </div>
                      </TD>
                      <TD>
                        {a.contact_name
                          ? (
                            <>
                              <div className="text-[13px] text-ink">{a.contact_name}</div>
                              {a.email && <div className="text-[12px] text-subtle">{a.email}</div>}
                            </>
                          )
                          : <span className="text-subtle">—</span>}
                      </TD>
                      <TD>{a.city ? <>{a.city}{a.state ? `, ${a.state}` : ''}</> : <span className="text-subtle">—</span>}</TD>
                      <TD>
                        {a.owner_name
                          ? (
                            <span className="inline-flex items-center gap-2">
                              <Avatar name={a.owner_name} url={a.owner_avatar} size={22} />
                              <span className="text-[13px]">{a.owner_name}</span>
                            </span>
                          )
                          : <span className="text-subtle">Unassigned</span>}
                      </TD>
                      <TD>
                        {a.lead_count
                          ? (
                            <Link to={`/crm?client_account_id=${a.id}`}
                              className="text-[13px] font-medium text-[var(--brand)] hover:underline">
                              {a.lead_count} lead{a.lead_count === 1 ? '' : 's'}
                            </Link>
                          )
                          : <span className="text-subtle">—</span>}
                      </TD>
                      <TD className="text-right">
                        <div className="flex justify-end gap-1">
                          {can('crm', 'edit') && (
                            <Button size="icon" variant="ghost" aria-label={`Edit ${a.name}`}
                              onClick={() => setEditing(a)}>
                              <Pencil size={15} />
                            </Button>
                          )}
                          {can('crm', 'delete') && (
                            <Button size="icon" variant="ghost" aria-label={`Archive ${a.name}`}
                              onClick={() => setDeleting(a)}>
                              <Trash2 size={15} />
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

      {(creating || editing) && (
        <ClientForm
          account={editing}
          directory={directory || []}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['client-accounts'] });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {viewing && (
        <ClientDetailModal
          account={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        title={`Archive ${deleting?.name}?`}
        message={
          deleting?.lead_count
            ? `It stays on file and can be restored. Its ${deleting.lead_count} pipeline record${deleting.lead_count === 1 ? '' : 's'} will be kept but unlinked from this client.`
            : 'It stays on file and can be restored later.'
        }
        confirmLabel="Archive"
        danger
        loading={remove.isPending}
      />
    </>
  );
}

/* ------------------------------------------------------------ create / edit */

const BLANK = {
  name: '', legal_name: '', industry: '', status: 'active', owner_id: '',
  contact_name: '', contact_designation: '', email: '', phone: '', whatsapp: '', website: '',
  gstin: '', pan: '', address: '', city: '', state: '', state_code: '',
  payment_terms_days: 30, notes: '',
};

function ClientForm({ account, directory, onClose, onSaved }: {
  account: Account | null;
  directory: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<any>(() => (
    account ? { ...BLANK, ...Object.fromEntries(
      Object.entries(account).map(([k, v]) => [k, v ?? '']),
    ) } : BLANK
  ));
  const set = (key: string, value: any) => setForm((f: any) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: (force: boolean) => {
      // Only the fields the API accepts, and blanks sent as null so clearing a
      // value actually clears it rather than storing an empty string.
      const body: any = {};
      for (const key of Object.keys(BLANK)) {
        const v = form[key];
        body[key] = v === '' ? null : v;
      }
      body.name = String(form.name).trim();
      body.payment_terms_days = Number(form.payment_terms_days) || 0;
      body.status = form.status || 'active';
      const qs = force ? '?force=true' : '';
      return account
        ? api.patch(`/clients/${account.id}${qs}`, body)
        : api.post(`/clients${qs}`, body);
    },
    onSuccess: () => {
      toast.success(account ? `${form.name} updated.` : `${form.name} added to your clients.`);
      onSaved();
    },
    onError: (e: any) => {
      // A duplicate is a question, not a failure — the API hands back the row it
      // matched so the person deciding can see what already exists.
      if (e?.code === 'conflict') {
        const existing = e?.details?.existing;
        if (window.confirm(
          `${existing?.name || 'A client'}${existing?.city ? ` (${existing.city})` : ''} is already on file.\n\nAdd this one anyway?`,
        )) save.mutate(true);
        return;
      }
      toast.error(e.message || 'Could not save that client');
    },
  });

  const valid = String(form.name).trim().length >= 2;

  return (
    <Modal
      open
      onClose={onClose}
      title={account ? `Edit ${account.name}` : 'New client'}
      subtitle="Stored once and reused on every lead, proposal and invoice for this client"
      size="lg"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid}
            onClick={() => save.mutate(false)}>
            {account ? 'Save changes' : 'Add client'}
          </Button>
        </>
      )}
    >
      <div className="space-y-5">
        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="Client name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)}
              placeholder="Cotton India Textiles" autoFocus />
          </Field>
          <Field label="Legal name" hint="As it should appear on an invoice">
            <Input value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)}
              placeholder="Cotton India Textiles Private Limited" />
          </Field>
          <Field label="Industry">
            <Input value={form.industry} onChange={(e) => set('industry', e.target.value)}
              placeholder="textiles" />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          <Field label="Account manager">
            <Select value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              <option value="">Unassigned</option>
              {directory.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
        </section>

        <section>
          <p className="label-cap mb-2">Primary contact</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)}
                placeholder="Ravi Shankar" />
            </Field>
            <Field label="Designation">
              <Input value={form.contact_designation}
                onChange={(e) => set('contact_designation', e.target.value)} placeholder="Director" />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)}
                placeholder="ravi@cottonindia.com" />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => set('phone', e.target.value)}
                placeholder="+91 98765 43210" />
            </Field>
            <Field label="WhatsApp">
              <Input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)}
                placeholder="+91 98765 43210" />
            </Field>
            <Field label="Website">
              <Input value={form.website} onChange={(e) => set('website', e.target.value)}
                placeholder="https://cottonindia.com" />
            </Field>
          </div>
        </section>

        <section>
          <p className="label-cap mb-2">Billing &amp; address</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GSTIN">
              <Input value={form.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                placeholder="33AABCC7654D1Z9" className="mono" />
            </Field>
            <Field label="PAN">
              <Input value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())}
                placeholder="AABCC7654D" className="mono" />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)}
                placeholder="12 Avinashi Road, Tiruppur" />
            </Field>
            <Field label="City">
              <Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Tiruppur" />
            </Field>
            <Field label="State">
              <Input value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="Tamil Nadu" />
            </Field>
            <Field label="State code" hint="Two digits, for GST">
              <Input value={form.state_code} onChange={(e) => set('state_code', e.target.value)}
                placeholder="33" className="mono" />
            </Field>
            <Field label="Payment terms" hint="Days from invoice date">
              <Input type="number" min={0} max={365} value={form.payment_terms_days}
                onChange={(e) => set('payment_terms_days', e.target.value)} />
            </Field>
          </div>
        </section>

        <Field label="Notes">
          <Textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)}
            placeholder="Anything the team should know before contacting this client" />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ detail */

function ClientDetailModal({ account, onClose, onEdit }: {
  account: Account; onClose: () => void; onEdit: () => void;
}) {
  const { can } = useAuth();
  const { data } = useQuery({
    queryKey: ['client-account', account.id],
    queryFn: () => api.get(`/clients/${account.id}`).then((r) => r.data),
  });
  const a: any = data || account;
  const leads: any[] = a.leads || [];

  return (
    <Modal
      open
      onClose={onClose}
      title={a.name}
      subtitle={[a.industry, a.city].filter(Boolean).join(' · ') || undefined}
      size="lg"
      footer={(
        <>
          <Button onClick={onClose}>Close</Button>
          {can('crm', 'edit') && <Button variant="primary" icon={<Pencil size={15} />} onClick={onEdit}>Edit</Button>}
        </>
      )}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-4">
          {a.email && (
            <a href={`mailto:${a.email}`} className="inline-flex items-center gap-2 text-[13px] text-[var(--brand)] hover:underline">
              <Mail size={14} />{a.email}
            </a>
          )}
          {a.phone && (
            <a href={`tel:${a.phone}`} className="inline-flex items-center gap-2 text-[13px] text-[var(--brand)] hover:underline">
              <Phone size={14} />{a.phone}
            </a>
          )}
          {a.website && (
            <a href={a.website} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-2 text-[13px] text-[var(--brand)] hover:underline">
              <Globe size={14} />{a.website.replace(/^https?:\/\//, '')}
            </a>
          )}
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <DetailRow label="Legal name" value={a.legal_name} />
          <DetailRow label="Primary contact"
            value={a.contact_name && [a.contact_name, a.contact_designation].filter(Boolean).join(' · ')} />
          <DetailRow label="GSTIN" value={a.gstin} mono />
          <DetailRow label="PAN" value={a.pan} mono />
          <DetailRow label="Address"
            value={[a.address, a.city, a.state].filter(Boolean).join(', ')} />
          <DetailRow label="Payment terms"
            value={a.payment_terms_days != null ? `${a.payment_terms_days} days` : null} />
          <DetailRow label="Account manager" value={a.owner_name} />
          <DetailRow label="Status" value={a.status} />
        </dl>

        {a.notes && (
          <div>
            <p className="label-cap mb-1">Notes</p>
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-muted">{a.notes}</p>
          </div>
        )}

        <div>
          <p className="label-cap mb-2">Pipeline activity</p>
          {leads.length === 0
            ? (
              <p className="text-[13px] text-subtle">
                No leads linked yet. Pick this client when creating a lead in the CRM pipeline and
                its details carry across.
              </p>
            )
            : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {leads.map((l) => (
                  <li key={l.id}>
                    <Link to={`/crm/${l.id}`}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-sunken">
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] text-ink">{l.name}</span>
                        {l.stage_name && <span className="text-[12px] text-subtle">{l.stage_name}</span>}
                      </span>
                      <Badge tone={l.status === 'active' ? 'positive' : 'neutral'}>{l.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </Modal>
  );
}

function DetailRow({ label, value, mono }: { label: string; value?: any; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] uppercase tracking-wide text-subtle">{label}</dt>
      <dd className={`mt-0.5 break-words text-[13.5px] text-ink ${mono ? 'mono' : ''}`}>
        {value || <span className="text-subtle">—</span>}
      </dd>
    </div>
  );
}
