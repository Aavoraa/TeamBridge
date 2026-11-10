import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, Mail, MailWarning, RefreshCw, Send, UserPlus, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import {
  AvatarWithName, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Table,
  TableSkeleton, TD, TH, THead, TR, Tabs, Textarea, useToast,
} from './ui';

const ROLES = [
  { id: 'employee', label: 'Employee' },
  { id: 'manager', label: 'Manager' },
  { id: 'finance', label: 'Finance' },
  { id: 'hr', label: 'HR' },
];
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]));

export const usePendingJoinCount = (enabled: boolean) => useQuery({
  queryKey: ['join-requests', 'pending'],
  queryFn: () => api.get('/team-join/requests', { status: 'pending' }),
  enabled,
  refetchInterval: 60_000,
  select: (r: any) => Number(r.meta?.pending || 0),
});

/** Owner's view: people who created their account and wait for approval, and invitations not used yet. */
export default function JoinRequests({ onInvite }: { onInvite?: () => void }) {
  // Without onInvite this is a manager: they approve employees and do not send invitations.
  const [status, setStatus] = useState('pending');
  const requests = useQuery({
    queryKey: ['join-requests', status],
    queryFn: () => api.get('/team-join/requests', { status }),
  });
  const rows: any[] = (requests.data as any)?.data || [];
  const pending = Number((requests.data as any)?.meta?.pending || 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Waiting for your approval" icon={<UserPlus size={16} />}
          subtitle={onInvite
            ? 'People you invited who have created their account. They cannot sign in until you approve them.'
            : 'People joining as an employee. They cannot sign in until you, HR or the owner approves them. Anyone you approve reports to you unless you pick someone else.'}
          action={onInvite && <Button variant="primary" icon={<Mail size={15} />} onClick={onInvite}>Invite people</Button>} />
        <div className="px-5 pb-3">
          <Tabs active={status} onChange={setStatus} tabs={[
            { id: 'pending', label: 'Waiting', count: pending },
            { id: 'approved', label: 'Approved' },
            { id: 'rejected', label: 'Rejected' },
          ]} />
        </div>
        {requests.isLoading ? <TableSkeleton cols={4} />
          : !rows.length ? (
            <EmptyState compact icon={<UserPlus size={20} />}
              title={status === 'pending' ? 'No one is waiting' : `No ${status} requests`}
              message={status === 'pending' ? 'When someone you invited creates their account, it shows up here for you to approve.' : undefined} />
          ) : status === 'pending' ? (
            <div className="border-t border-line divide-y divide-[var(--border)]">
              {rows.map((r) => <PendingRow key={r.id} r={r} />)}
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Person</TH>
                  <TH width="130px">Asked for</TH>
                  <TH width="130px">Decided</TH>
                  <TH width="170px" align="right">By</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD><AvatarWithName name={r.name} sub={`${r.email}${r.designation ? ` · ${r.designation}` : ''}`} size={30} /></TD>
                    <TD><Badge>{ROLE_LABEL[r.requested_role] || r.requested_role}</Badge></TD>
                    <TD><span className="text-subtle text-[13px]">{r.decided_at ? relative(r.decided_at) : '—'}</span></TD>
                    <TD align="right">
                      <span className="text-muted text-[13px]">{r.decided_by_name || '—'}</span>
                      {r.decision_note && <span className="block text-[12px] text-subtle">{r.decision_note}</span>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
      </Card>
      {onInvite && <OpenInvites />}
    </div>
  );
}

function PendingRow({ r }: { r: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  const [role, setRole] = useState(r.requested_role);
  // A manager approving someone is their manager unless they choose another.
  const [managerId, setManagerId] = useState(isManager ? user?.id || '' : '');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');

  const directory = useQuery({
    queryKey: ['directory'],
    queryFn: () => api.get('/users/directory').then((x) => x.data),
    staleTime: 300_000,
  });

  const done = () => {
    qc.invalidateQueries({ queryKey: ['join-requests'] });
    qc.invalidateQueries({ queryKey: ['team'] });
    qc.invalidateQueries({ queryKey: ['directory'] });
  };
  const approve = useMutation({
    mutationFn: (allowAddon?: boolean) => api.post(`/team-join/requests/${r.id}/approve${allowAddon ? '?allow_addon=true' : ''}`, {
      role, manager_id: managerId || null,
    }),
    onSuccess: (res: any) => {
      toast.success(res.data.email_status === 'sent'
        ? `${r.name} approved and emailed. They can sign in now.`
        : `${r.name} approved. They can sign in now with the password they chose.`);
      done();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/team-join/requests/${r.id}/reject`, { note: note.trim() || null }),
    onSuccess: () => { toast.success(`Request from ${r.name} rejected.`); setRejectOpen(false); done(); },
    onError: (e: any) => toast.error(e.message),
  });
  const overBand = approve.error && (approve.error as any).message?.includes('covers up to');
  // A paid seat beyond the plan is the owner's decision; HR sees why it stopped.
  const ownerDecides = !!overBand && user?.role !== 'owner';

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-5 py-4">
      <div className="min-w-[240px] flex-1">
        <AvatarWithName name={r.name} size={34}
          sub={[r.email, r.phone].filter(Boolean).join(' · ')} />
        <p className="mt-1.5 text-[12.5px] text-subtle">
          Asked to join as <strong className="text-muted font-medium">{ROLE_LABEL[r.requested_role]}</strong>
          {[r.designation, r.department].filter(Boolean).length ? ` · ${[r.designation, r.department].filter(Boolean).join(' · ')}` : ''}
          {' · '}{relative(r.created_at)}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="block mb-1 text-[11.5px] text-subtle">Role to give</span>
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label={`Role for ${r.name}`} className="w-[140px]">
            {ROLES.filter((x) => !isManager || x.id === 'employee').map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </label>
        <label className="block">
          <span className="block mb-1 text-[11.5px] text-subtle">Reports to</span>
          <Select value={managerId} onChange={(e) => setManagerId(e.target.value)} aria-label={`Manager for ${r.name}`} className="w-[180px]">
            <option value="">No manager yet</option>
            {(directory.data || []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </label>
        <Button icon={<X size={14} />} onClick={() => setRejectOpen(true)}>Reject</Button>
        {ownerDecides ? (
          <span className="max-w-[220px] text-[12.5px] text-[var(--warning)]">The plan is full. The owner needs to approve this one as an extra seat.</span>
        ) : (
          <Button variant={overBand ? 'accent' : 'primary'} icon={<Check size={14} />} loading={approve.isPending}
            onClick={() => approve.mutate(!!overBand)}>
            {overBand ? 'Approve as extra seat' : 'Approve'}
          </Button>
        )}
      </div>
      <ConfirmDialog open={rejectOpen} onClose={() => setRejectOpen(false)} onConfirm={() => reject.mutate()}
        title={`Reject ${r.name}?`} danger confirmLabel="Reject request" loading={reject.isPending}
        message={(
          <div className="space-y-3">
            <p>They will not get an account. They can send a new request later if the link is still on.</p>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional, only you see it)" />
          </div>
        )} />
    </div>
  );
}

/** Invitations sent but not used yet: the person has not created their account. */
function OpenInvites() {
  const qc = useQueryClient();
  const toast = useToast();
  const invites = useQuery({ queryKey: ['join-invites'], queryFn: () => api.get('/team-join/invites').then((r) => r.data) });
  const [revoke, setRevoke] = useState<any>(null);

  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/team-join/invites/${id}/resend`, {}).then((r) => r.data),
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ['join-invites'] });
      if (d.email_status === 'sent') toast.success('Invitation emailed again. The old link no longer works.');
      else { navigator.clipboard?.writeText(d.invite_url); toast.success('New link copied. The old one no longer works.'); }
    },
    onError: (e: any) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/team-join/invites/${id}/revoke`, {}),
    onSuccess: () => { setRevoke(null); qc.invalidateQueries({ queryKey: ['join-invites'] }); toast.success('Invitation cancelled.'); },
    onError: (e: any) => toast.error(e.message),
  });

  const rows: any[] = invites.data || [];
  return (
    <Card>
      <CardHeader title="Invited, not signed up yet" icon={<Mail size={16} />}
        subtitle="Each link is personal and works once. Copy it to send over WhatsApp, or send a fresh one." />
      {invites.isLoading ? <TableSkeleton cols={3} />
        : !rows.length ? <EmptyState compact title="No open invitations" message="Everyone you invited has created their account." />
          : (
            <div className="border-t border-line divide-y divide-[var(--border)]">
              {rows.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                  <div className="min-w-[220px] flex-1">
                    <AvatarWithName name={i.name || i.email} sub={`${i.name ? `${i.email} · ` : ''}invited ${relative(i.updated_at)}`} size={30} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" icon={<Copy size={14} />}
                      onClick={() => { navigator.clipboard?.writeText(i.invite_url); toast.success('Invitation link copied.'); }}>
                      Copy link
                    </Button>
                    <Button size="sm" icon={<RefreshCw size={14} />} loading={resend.isPending && resend.variables === i.id}
                      onClick={() => resend.mutate(i.id)}>Resend</Button>
                    <Button size="sm" icon={<X size={14} />} onClick={() => setRevoke(i)}>Cancel</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} onConfirm={() => cancel.mutate(revoke.id)}
        title="Cancel this invitation?" confirmLabel="Cancel invitation" danger loading={cancel.isPending}
        message={`The link sent to ${revoke?.email} stops working. You can invite them again later.`} />
    </Card>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** "Name, email", "email", or "Name <email>" per line (commas, tabs or a pasted sheet). */
export function parseInviteList(text: string) {
  const seen = new Set<string>();
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line, idx) => {
    const email = (line.match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/) || [''])[0].toLowerCase();
    const name = line.replace(/<[^>]*>/, '').replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
      .replace(/[,;\t"]+/g, ' ').trim().replace(/\s+/g, ' ');
    let problem: string | null = null;
    if (!email) problem = 'No email found';
    else if (seen.has(email)) problem = 'Listed twice';
    if (email && !problem) seen.add(email);
    return { line: idx + 1, email, name: /@/.test(name) ? '' : name, problem };
  });
}

/** Owner invites specific people by email; each gets a personal sign-up link. */
export function InvitePeopleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const status = useQuery({
    queryKey: ['invite-email-status'],
    queryFn: () => api.get('/users/invite/email-status').then((r) => r.data),
    staleTime: 60_000,
  });
  const emailOn = !!status.data?.email_configured;
  const rows = parseInviteList(text);
  const good = rows.filter((r) => !r.problem);

  const send = useMutation({
    mutationFn: () => api.post('/team-join/invites', { people: good.map((r) => ({ email: r.email, name: r.name || null })) }),
    onSuccess: (res: any) => {
      setResult(res.data);
      qc.invalidateQueries({ queryKey: ['join-invites'] });
      toast.success(res.data.emailed ? `${res.data.invited} invited, ${res.data.emailed} emailed.` : `${res.data.invited} invitation link(s) ready.`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (result) {
    const sent = result.results.filter((r: any) => r.invite_url);
    const links = sent.map((r: any) => `${r.name ? `${r.name} <${r.email}>` : r.email}: ${r.invite_url}`).join('\n');
    return (
      <Modal open onClose={onClose} size="lg" title="Invitations ready"
        subtitle={`${result.invited} invited · ${result.emailed} emailed · ${result.skipped} skipped`}
        footer={(
          <>
            {sent.length > 0 && (
              <>
                <Button icon={<Download size={15} />} onClick={() => download('invitation-links.csv',
                  'name,email,emailed,link\n' + sent.map((r: any) =>
                    [r.name, r.email, r.email_status === 'sent' ? 'yes' : 'no', r.invite_url].map(csvCell).join(',')).join('\n'))}>
                  Download links
                </Button>
                <Button icon={<Copy size={15} />} onClick={() => { navigator.clipboard?.writeText(links); toast.success('All links copied.'); }}>
                  Copy all links
                </Button>
              </>
            )}
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        )}>
        <div className="space-y-3">
          {!result.email_configured && sent.length > 0 && (
            <p className="flex gap-2 items-start text-[13px] text-muted rounded-xl bg-[var(--surface-sunken)] p-3">
              <MailWarning size={16} className="shrink-0 mt-0.5" />
              Email sending is not set up yet, so nobody was emailed. Copy each person their own link and send it on WhatsApp or email.
            </p>
          )}
          <div className="max-h-[50vh] overflow-auto">
            <Table>
              <THead><tr><TH>Person</TH><TH width="130px">Invitation</TH><TH width="150px" align="right"> </TH></tr></THead>
              <tbody>
                {result.results.map((r: any) => (
                  <TR key={r.row}>
                    <TD><span className="block font-medium">{r.name || r.email}</span>{r.name && <span className="text-[12px] text-subtle">{r.email}</span>}</TD>
                    <TD>
                      {!r.invite_url ? <Badge>Skipped</Badge>
                        : r.email_status === 'sent' ? <Badge tone="positive" dot>Emailed</Badge>
                          : r.email_status === 'failed' ? <Badge tone="negative" dot>Email failed</Badge>
                            : <Badge tone="info">Link ready</Badge>}
                    </TD>
                    <TD align="right">
                      {r.invite_url ? (
                        <Button size="sm" icon={<Copy size={14} />}
                          onClick={() => { navigator.clipboard?.writeText(r.invite_url); toast.success(`Link for ${r.email} copied.`); }}>
                          Copy link
                        </Button>
                      ) : <span className="text-[12.5px] text-subtle">{r.reason}</span>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Invite people"
      subtitle="Each person gets their own link to create an account and pick their role. You approve them after."
      footer={(
        <>
          <p className="mr-auto self-center text-[12.5px] text-subtle">
            {rows.length ? `${good.length} ready${rows.length > good.length ? ` · ${rows.length - good.length} left out` : ''}` : 'Up to 200 at a time'}
          </p>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={send.isPending}
            disabled={!good.length || good.length > 200} onClick={() => send.mutate()}>
            {emailOn ? `Send ${good.length || ''} invitation${good.length === 1 ? '' : 's'}` : `Create ${good.length || ''} link${good.length === 1 ? '' : 's'}`}
          </Button>
        </>
      )}>
      <div className="space-y-4">
        <Field label="Who to invite" hint="One person per line: an email, or a name and email. You can paste a column from Excel or Google Sheets.">
          <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} className="mono text-[12.5px]" autoFocus
            placeholder={'priya@aavoraa.com\nKarthik S, karthik@aavoraa.com'} />
        </Field>
        <p className="flex gap-2 items-start text-[12.5px] text-subtle">
          {emailOn ? <Mail size={15} className="shrink-0 mt-px" /> : <MailWarning size={15} className="shrink-0 mt-px" />}
          {emailOn
            ? `Each person is emailed their link${status.data?.from ? ` from ${status.data.from}` : ''}.`
            : 'Email sending is not set up yet: you will get each person’s link to send yourself.'}
        </p>
        {rows.length > 0 && (
          <div className="max-h-[32vh] overflow-auto">
            <Table>
              <THead><tr><TH width="44px">#</TH><TH>Email</TH><TH>Name</TH><TH width="140px">Check</TH></tr></THead>
              <tbody>
                {rows.map((r) => (
                  <TR key={r.line}>
                    <TD><span className="text-subtle tabular">{r.line}</span></TD>
                    <TD><span className="text-[13px]">{r.email || '—'}</span></TD>
                    <TD><span className="text-muted text-[13px]">{r.name || '—'}</span></TD>
                    <TD>{r.problem ? <Badge tone="negative">{r.problem}</Badge> : <Badge tone="positive" dot>Ready</Badge>}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Modal>
  );
}
