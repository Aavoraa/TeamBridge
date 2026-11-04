import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Users2, Download, Copy, KeyRound, Network, Trash2, Mail, ShieldCheck, PencilLine, FolderKanban,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, percent, relative, titleCase } from '../lib/format';
import {
  Avatar, AvatarWithName, Badge, Button, Card, CardHeader, ConfirmDialog, Drawer, EmptyState,
  ErrorState, Field, Input, Meter, Modal, PageHeader, SearchInput, Select, StatusBadge, Table,
  TableSkeleton, TD, TH, THead, TR, Tabs, useToast, cx,
} from '../components/ui';

const ROLE_TONES: Record<string, any> = {
  owner: 'accent', manager: 'brand', finance: 'info', hr: 'positive', employee: 'neutral', client: 'neutral',
};

/** Seat held on a project team — mirrors the seats on the Projects screen. */
const SEAT_TONES: Record<string, any> = {
  manager: 'accent', lead: 'brand', senior: 'info', reviewer: 'positive',
  member: 'neutral', junior: 'neutral', observer: 'neutral',
};

export default function Team() {
  const { can, user } = useAuth();
  const [tab, setTab] = useState('list');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['team', search, role],
    queryFn: () => api.get('/users', { search, role, limit: 200 }).then((r) => r.data),
    enabled: tab === 'list',
  });

  const org = useQuery({
    queryKey: ['org-chart'],
    queryFn: () => api.get('/users/org/chart').then((r) => r.data),
    enabled: tab === 'org',
  });

  const canSeeCost = ['owner', 'finance', 'hr'].includes(user?.role || '');

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`${data?.length ?? '—'} people · salary bands feed the monthly HR cost line`}
        actions={
          <>
            {can('employees', 'export') && (
              <Button icon={<Download size={15} />} onClick={() => api.download('/users/export/csv', 'team.csv')}>
                Export
              </Button>
            )}
            {can('users', 'create') && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setInviteOpen(true)}>
                Add someone
              </Button>
            )}
          </>
        }
        tabs={
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'list', label: 'Directory' },
            { id: 'org', label: 'Reporting structure' },
            ...(can('projects', 'view') ? [{ id: 'projects', label: 'Projects handled' }] : []),
          ]} />
        }
      />

      {tab === 'list' && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <SearchInput value={search} onChange={setSearch} placeholder="Search by name, email or role…"
                className="flex-1 min-w-[220px]" />
              <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" className="w-[150px]">
                <option value="">All roles</option>
                {['owner', 'manager', 'employee', 'finance', 'hr'].map((r) => (
                  <option key={r} value={r}>{titleCase(r)}</option>
                ))}
              </Select>
            </div>
          </Card>

          {error ? <ErrorState error={error} retry={refetch} />
            : isLoading ? <Card><TableSkeleton cols={6} /></Card>
              : !data?.length ? (
                <Card>
                  <EmptyState icon={<Users2 size={20} />} title="No one matches"
                    message="Invite your team so work can be assigned and attendance tracked." />
                </Card>
              ) : (
                <Card>
                  <Table>
                    <THead>
                      <tr>
                        <TH>Person</TH>
                        <TH width="120px">Role</TH>
                        <TH width="170px">Service line</TH>
                        <TH width="160px">Reports to</TH>
                        {canSeeCost && <TH align="right" width="130px">Monthly cost</TH>}
                        <TH width="140px">Last active</TH>
                        <TH width="110px">Status</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {data.map((u: any) => (
                        <TR key={u.id} onClick={() => setOpenId(u.id)}>
                          <TD><AvatarWithName name={u.name} url={u.avatar_url} sub={u.email} size={30} /></TD>
                          <TD>
                            <Badge tone={ROLE_TONES[u.role]}>{titleCase(u.role)}</Badge>
                            {u.custom_role_name && <span className="block text-[11.5px] text-subtle mt-0.5">{u.custom_role_name}</span>}
                          </TD>
                          <TD><span className="text-muted text-[13px]">{u.service_line_name || '—'}</span></TD>
                          <TD><span className="text-muted text-[13px]">{u.manager_name || '—'}</span></TD>
                          {canSeeCost && (
                            <TD align="right">
                              <span className="tabular">{u.monthly_cost_minor ? money(u.monthly_cost_minor) : '—'}</span>
                            </TD>
                          )}
                          <TD><span className="text-subtle text-[13px]">{u.last_login_at ? relative(u.last_login_at) : 'never'}</span></TD>
                          <TD>
                            <span className="flex items-center gap-1.5">
                              <StatusBadge status={u.status} />
                              {u.twofa_enabled === 1 && <ShieldCheck size={12} className="text-[var(--positive)]" aria-label="2FA on" />}
                            </span>
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}
        </>
      )}

      {tab === 'org' && (
        <Card>
          <CardHeader title="Reporting structure" subtitle="Escalations follow these lines" icon={<Network size={16} />} />
          {org.isLoading ? <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-12" />)}</div>
            : !org.data?.length ? <EmptyState compact title="No reporting structure set" />
              : <div className="p-4"><OrgTree nodes={org.data} onSelect={setOpenId} /></div>}
        </Card>
      )}

      {tab === 'projects' && <ProjectsHandled onSelect={setOpenId} />}

      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}
      {openId && <MemberDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

/* ============================================================ PROJECTS HANDLED */
/**
 * How many projects each person is on, in one short line each: the count, how
 * many they run (manager or lead), the time committed across them, and which
 * ones. Same numbers as Projects → Who is on what, read from the people side.
 */
function ProjectsHandled({ onSelect }: { onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['team-workload'],
    queryFn: () => api.get('/projects/workload').then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <Card><TableSkeleton cols={5} /></Card>;

  const q = search.trim().toLowerCase();
  const people = (data as any[])
    .filter((u) => u.role !== 'client' && (!q || u.name.toLowerCase().includes(q)))
    .sort((a, b) => b.project_count - a.project_count || a.name.localeCompare(b.name));
  const onSome = (data as any[]).filter((u) => u.project_count > 0).length;
  const onNone = (data as any[]).length - onSome;
  const over = (data as any[]).filter((u) => u.allocation_pct > 100).length;

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search a person…" className="flex-1 min-w-[220px]" />
          <span className="text-[13px] text-muted"><span className="text-ink font-semibold tabular">{onSome}</span> on projects</span>
          <span className="text-[13px] text-muted"><span className="text-ink font-semibold tabular">{onNone}</span> on none</span>
          {over > 0 && <span className="text-[13px] text-[var(--negative)]"><span className="font-semibold tabular">{over}</span> over 100% allocated</span>}
        </div>
      </Card>

      <Card>
        <Table>
          <THead>
            <tr>
              <TH>Person</TH>
              <TH align="right" width="100px">Projects</TH>
              <TH align="right" width="100px">Leading</TH>
              <TH width="170px">Time allocated</TH>
              <TH>On</TH>
            </tr>
          </THead>
          <tbody>
            {people.map((u: any) => {
              const pct = Math.round(u.allocation_pct || 0);
              const shown = u.projects.slice(0, 4);
              return (
                <TR key={u.id} onClick={() => onSelect(u.id)}>
                  <TD><AvatarWithName name={u.name} url={u.avatar_url} sub={u.designation || titleCase(u.role)} size={30} /></TD>
                  <TD align="right">
                    <span className={cx('tabular text-[15px] font-semibold', u.project_count ? 'text-ink' : 'text-subtle')}>{u.project_count}</span>
                  </TD>
                  <TD align="right"><span className="tabular text-muted">{u.leads || '—'}</span></TD>
                  <TD>
                    {u.project_count ? (
                      <span className="flex items-center gap-2">
                        <Meter value={Math.min(pct, 100)} className="w-20"
                          tone={pct > 100 ? 'negative' : pct >= 80 ? 'warning' : 'positive'} />
                        <span className={cx('tabular text-[12.5px]', pct > 100 ? 'text-[var(--negative)] font-medium' : 'text-muted')}>{pct}%</span>
                      </span>
                    ) : <span className="text-subtle text-[12.5px]">—</span>}
                  </TD>
                  <TD>
                    {u.project_count ? (
                      <span className="flex flex-wrap gap-1.5">
                        {shown.map((p: any) => (
                          <span key={`${p.project_id}-${p.seat}`} title={p.client_name}
                            className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">
                            <FolderKanban size={11} aria-hidden />
                            <span className="text-ink">{p.project_name}</span> · {titleCase(p.seat)}
                          </span>
                        ))}
                        {u.projects.length > shown.length && (
                          <span className="text-[12px] text-subtle self-center">+{u.projects.length - shown.length} more</span>
                        )}
                      </span>
                    ) : <span className="text-subtle text-[12.5px]">Not on any project</span>}
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

function OrgTree({ nodes, depth = 0, onSelect }: { nodes: any[]; depth?: number; onSelect: (id: string) => void }) {
  return (
    <ul className={cx(depth > 0 && 'ml-5 mt-1.5 border-l border-line pl-4 space-y-1.5', depth === 0 && 'space-y-2')}>
      {nodes.map((n) => (
        <li key={n.id}>
          <button onClick={() => onSelect(n.id)}
            className="flex items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2 w-full max-w-md text-left
                       hover:border-line-strong transition-colors duration-150 cursor-pointer">
            <Avatar name={n.name} url={n.avatar_url} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink truncate">{n.name}</span>
              <span className="block text-[12px] text-subtle truncate">{n.designation || titleCase(n.role)}</span>
            </span>
            <Badge tone={ROLE_TONES[n.role]}>{titleCase(n.role)}</Badge>
            {n.reports?.length > 0 && (
              <span className="text-[11.5px] text-subtle tabular shrink-0">{n.reports.length} report{n.reports.length === 1 ? '' : 's'}</span>
            )}
          </button>
          {n.reports?.length > 0 && <OrgTree nodes={n.reports} depth={depth + 1} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * A password somebody reads off a screen and types into a phone. The alphabet
 * drops O/0 and l/1 because these get transcribed by hand far more often than
 * they get pasted.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const picks = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(picks, (n) => alphabet[n % alphabet.length]).join('');
}

/* ------------------------------------------------------------ add a member */
function InviteModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '', email: '', role: 'employee', designation: '', phone: '',
    service_line_id: '', manager_id: '', monthly_cost: '', date_of_joining: new Date().toISOString().slice(0, 10),
  });
  const [mode, setMode] = useState<'invite' | 'password'>('password');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<{ invite_url?: string; password?: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: meta } = useQuery({
    queryKey: ['team-meta'],
    queryFn: async () => {
      const [directory, serviceLines] = await Promise.all([
        api.get('/users/directory').then((r) => r.data),
        api.get('/settings/service-lines').then((r) => r.data),
      ]);
      return { directory, serviceLines };
    },
    staleTime: 300_000,
  });

  const invite = useMutation({
    mutationFn: (allowAddon?: boolean) => api.post(`/users${allowAddon ? '?allow_addon=true' : ''}`, {
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      role: form.role,
      designation: form.designation || null,
      phone: form.phone || null,
      whatsapp: form.phone || null,
      service_line_id: form.service_line_id || null,
      manager_id: form.manager_id || null,
      monthly_cost_minor: form.monthly_cost ? Math.round(Number(form.monthly_cost) * 100) : 0,
      date_of_joining: form.date_of_joining || null,
      // Omitted entirely in invite mode, which is what keeps the old flow intact.
      ...(mode === 'password' ? { password } : {}),
    }),
    onSuccess: (res: any) => {
      setCreated({
        invite_url: res.data.invite_url,
        password: mode === 'password' ? password : undefined,
      });
      toast.success(mode === 'password'
        ? `${form.name.trim()} can sign in now.`
        : 'Invitation created. Share the link below.');
      qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (e: any) => {
      setErrors(e.fieldErrors || {});
      toast.error(e.message);
    },
  });

  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  const overBand = invite.error && (invite.error as any).message?.includes('covers up to');

  /**
   * What is still stopping the submit. The form is taller than the dialog on a
   * laptop, so the required fields scroll out of sight behind the role and
   * salary rows - a button that is merely greyed out reads as "broken" rather
   * than "not finished". Naming the gap in the footer keeps it on screen.
   */
  const missing = [
    !form.name.trim() && 'a full name',
    !/\S+@\S+\.\S+/.test(form.email) && 'a work email',
    mode === 'password' && password.length < 8 && 'a password of at least 8 characters',
  ].filter(Boolean) as string[];

  if (created) {
    const isPassword = !!created.password;
    const secret = created.password || created.invite_url || '';
    return (
      <Modal open onClose={onClose} size="sm"
        title={isPassword ? 'Account created' : 'Invitation ready'}
        subtitle={isPassword
          ? `${form.email.trim().toLowerCase()} can sign in now`
          : 'Share this link — it lets them set their own password'}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="space-y-3">
          <Input readOnly value={secret} className="mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
          <Button className="w-full justify-center" icon={<Copy size={15} />}
            onClick={() => { navigator.clipboard?.writeText(secret); toast.success('Copied.'); }}>
            {isPassword ? 'Copy password' : 'Copy invitation link'}
          </Button>
          <p className="text-[12.5px] text-subtle leading-relaxed">
            {isPassword
              ? 'This is the only time it is shown. Send it over a secure channel, and ask them to change it after their first sign-in.'
              : 'Send it over your usual channel. The link works once, and the account stays in “invited” state until they set a password.'}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} size="lg"
      title={mode === 'password' ? 'Add a team member' : 'Invite a team member'}
      subtitle={mode === 'password'
        ? 'They can sign in straight away with the role you pick here'
        : 'They pick their own password from a one-time link'}
      footer={
        <>
          {missing.length > 0 && (
            <p className="mr-auto self-center text-[12.5px] text-subtle leading-snug max-w-[60%]">
              Still needed: {missing.join(', ')}
            </p>
          )}
          <Button onClick={onClose}>Cancel</Button>
          {overBand && (
            <Button variant="accent" loading={invite.isPending} onClick={() => invite.mutate(true)}>
              Add as an extra seat
            </Button>
          )}
          <Button variant="primary" loading={invite.isPending}
            disabled={missing.length > 0}
            onClick={() => invite.mutate(false)}>
            {mode === 'password' ? 'Create account' : 'Create invitation'}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <Tabs
          tabs={[
            { id: 'invite', label: 'Send an invite link' },
            { id: 'password', label: 'Set a password now' },
          ]}
          active={mode}
          onChange={(id) => {
            setMode(id as 'invite' | 'password');
            setErrors((e) => ({ ...e, password: '' }));
          }}
        />

        {mode === 'password' ? (
          <Field label="Password" required error={errors.password}
            hint="They sign in with this immediately — no link to pass along.">
            <div className="flex gap-2">
              <Input value={password} className="mono"
                placeholder="At least 8 characters"
                onChange={(e) => { setPassword(e.target.value); setErrors((x) => ({ ...x, password: '' })); }} />
              <Button type="button" icon={<KeyRound size={15} />}
                onClick={() => setPassword(generatePassword())}>Generate</Button>
            </div>
          </Field>
        ) : (
          <p className="text-[12.5px] text-subtle leading-relaxed">
            They get a one-time link and choose their own password. Nothing is emailed while the mail
            provider is set to <code className="mono">log</code> — you copy the link and send it.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required error={errors.name}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label="Work email" required error={errors.email}>
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Role" required hint="Decides what they can see and do">
            <Select value={form.role} onChange={(e) => set('role', e.target.value)}>
              {['employee', 'manager', 'finance', 'hr', 'owner'].map((r) => (
                <option key={r} value={r}>{titleCase(r)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Designation">
            <Input value={form.designation} onChange={(e) => set('designation', e.target.value)}
              placeholder="Performance Marketer" />
          </Field>
          <Field label="Service line">
            <Select value={form.service_line_id} onChange={(e) => set('service_line_id', e.target.value)}>
              <option value="">Not assigned</option>
              {meta?.serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Reports to" hint="Escalations route here">
            <Select value={form.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
              <option value="">No manager</option>
              {meta?.directory?.filter((u: any) => ['owner', 'manager'].includes(u.role))
                .map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="Mobile" hint="For WhatsApp alerts">
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91 98765 43210" />
          </Field>
          <Field label="Date of joining">
            <Input type="date" value={form.date_of_joining} onChange={(e) => set('date_of_joining', e.target.value)} />
          </Field>
        </div>
        <Field label="Monthly cost (₹)" hint="Salary band — feeds the HR cost line and client profitability"
          className="max-w-[240px]">
          <Input type="number" min={0} step={1000} value={form.monthly_cost}
            onChange={(e) => set('monthly_cost', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- drawer */
function MemberDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, user: me } = useAuth();
  const navigate = useNavigate();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState('');
  const [details, setDetails] = useState<any>(null); // the edit form, open when set

  const { data: u, isLoading } = useQuery({
    queryKey: ['team-member', id],
    queryFn: () => api.get(`/users/${id}`).then((r) => r.data),
  });

  const { data: meta } = useQuery({
    queryKey: ['team-meta'],
    queryFn: async () => {
      const [directory, serviceLines] = await Promise.all([
        api.get('/users/directory').then((r) => r.data),
        api.get('/settings/service-lines').then((r) => r.data),
      ]);
      return { directory, serviceLines };
    },
    staleTime: 300_000,
  });

  const update = useMutation({
    mutationFn: (patch: any) => api.patch(`/users/${id}`, patch),
    onSuccess: () => {
      toast.success('Updated.');
      qc.invalidateQueries({ queryKey: ['team-member', id] });
      qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const saveDetails = useMutation({
    mutationFn: (patch: any) => api.patch(`/users/${id}`, patch),
    onSuccess: () => {
      toast.success('Employee details updated.');
      setDetails(null);
      qc.invalidateQueries({ queryKey: ['team-member', id] });
      qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post(`/users/${id}/reset-password`),
    onSuccess: (res: any) => setTempPassword(res.data.temporary_password),
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/users/${id}`),
    onSuccess: (res: any) => {
      toast.success(res.data.reassigned_items
        ? `Removed. ${res.data.reassigned_items} open item(s) went to their manager.`
        : 'Removed.');
      qc.invalidateQueries({ queryKey: ['team'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !u) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={4} cols={2} /></div></Drawer>;
  }

  const editable = can('users', 'edit') && u.id !== me?.id;

  return (
    <>
      <Drawer open onClose={onClose} title={u.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={ROLE_TONES[u.role]}>{titleCase(u.role)}</Badge>
            <StatusBadge status={u.status} />
            <span className="text-subtle">{u.designation}</span>
          </span>
        }
        footer={
          <>
            {editable && !details && (
              <Button icon={<PencilLine size={15} />} onClick={() => setDetails({
                name: u.name || '', designation: u.designation || '', phone: u.phone || '', whatsapp: u.whatsapp || '',
                employment_type: u.employment_type || 'full_time', date_of_joining: u.date_of_joining || '', status: u.status || 'active',
              })}>Edit details</Button>
            )}
            {can('users', 'edit') && (
              <Button icon={<KeyRound size={15} />} loading={resetPassword.isPending}
                onClick={() => resetPassword.mutate()}>Reset password</Button>
            )}
            {can('users', 'delete') && u.id !== me?.id && (
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setRemoveOpen(true)}>Delete employee</Button>
            )}
          </>
        }>
        <div className="p-5 space-y-5">
          {tempPassword && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft p-3">
              <p className="text-[13px] font-medium text-[var(--warning)]">Temporary password</p>
              <p className="mono text-[15px] text-ink mt-1 select-all">{tempPassword}</p>
              <p className="text-[12px] text-muted mt-1.5">
                Share this over a secure channel and ask them to change it after signing in.
                All their other sessions have been signed out.
              </p>
            </div>
          )}

          {details && (
            <div className="space-y-3 rounded-lg border border-[var(--brand)]/40 p-4">
              <p className="label-cap">Edit details</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name" required>
                  <Input value={details.name} maxLength={120} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
                </Field>
                <Field label="Designation">
                  <Input value={details.designation} maxLength={120} onChange={(e) => setDetails({ ...details, designation: e.target.value })} />
                </Field>
                <Field label="Phone">
                  <Input value={details.phone} maxLength={20} onChange={(e) => setDetails({ ...details, phone: e.target.value })} />
                </Field>
                <Field label="WhatsApp">
                  <Input value={details.whatsapp} maxLength={20} onChange={(e) => setDetails({ ...details, whatsapp: e.target.value })} />
                </Field>
                <Field label="Employment">
                  <Select value={details.employment_type} onChange={(e) => setDetails({ ...details, employment_type: e.target.value })}>
                    {['full_time', 'part_time', 'contract', 'intern'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
                  </Select>
                </Field>
                <Field label="Date of joining">
                  <Input type="date" value={details.date_of_joining} onChange={(e) => setDetails({ ...details, date_of_joining: e.target.value })} />
                </Field>
                <Field label="Account" hint="Disabled blocks sign-in but keeps them on the team">
                  <Select value={details.status} onChange={(e) => setDetails({ ...details, status: e.target.value })}>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                    {details.status === 'invited' && <option value="invited">Invited</option>}
                  </Select>
                </Field>
                <Field label="Email" hint="Sign-in email cannot be changed here">
                  <Input value={u.email} disabled />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" loading={saveDetails.isPending} disabled={details.name.trim().length < 2}
                  onClick={() => saveDetails.mutate({
                    name: details.name.trim(),
                    designation: details.designation.trim() || null,
                    phone: details.phone.trim() || null,
                    whatsapp: details.whatsapp.trim() || null,
                    employment_type: details.employment_type,
                    date_of_joining: details.date_of_joining || null,
                    status: details.status,
                  })}>Update</Button>
                <Button variant="ghost" onClick={() => setDetails(null)}>Cancel</Button>
              </div>
            </div>
          )}

          <div className="grid gap-3 grid-cols-3">
            <StatBox label="Completion this month" value={percent(u.this_month.completion_pct)}
              sub={`${u.this_month.done}/${u.this_month.assigned} items`} />
            <StatBox label="Attendance" value={percent(u.this_month.attendance_pct)} />
            <StatBox label="Clients owned" value={String(u.clients?.length || 0)} />
          </div>

          <dl className="space-y-2.5 text-[13px]">
            <Row label="Email" value={u.email} />
            <Row label="Phone" value={u.phone} />
            <Row label="Service line" value={u.service_line_name} />
            <Row label="Reports to" value={u.manager_name} />
            <Row label="Employment" value={titleCase(u.employment_type)} />
            <Row label="Joined" value={u.date_of_joining ? date(u.date_of_joining) : null} />
            {u.monthly_cost_minor != null && <Row label="Monthly cost" value={money(u.monthly_cost_minor)} />}
            <Row label="Two-factor" value={u.twofa_enabled ? 'Enabled' : 'Not enabled'} />
            <Row label="Last sign-in" value={u.last_login_at ? relative(u.last_login_at) : 'never'} />
          </dl>

          {editable && (
            <div className="space-y-3 border-t border-line pt-4">
              <p className="label-cap">Change assignment</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Role">
                  <Select value={u.role} onChange={(e) => update.mutate({ role: e.target.value })}>
                    {['employee', 'manager', 'finance', 'hr', 'owner'].map((r) => (
                      <option key={r} value={r}>{titleCase(r)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reports to">
                  <Select value={u.manager_id || ''} onChange={(e) => update.mutate({ manager_id: e.target.value || null })}>
                    <option value="">No manager</option>
                    {meta?.directory?.filter((x: any) => x.id !== u.id && ['owner', 'manager'].includes(x.role))
                      .map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                </Field>
                <Field label="Service line">
                  <Select value={u.service_line_id || ''} onChange={(e) => update.mutate({ service_line_id: e.target.value || null })}>
                    <option value="">Not assigned</option>
                    {meta?.serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label="Monthly cost (₹)">
                  <Input type="number" min={0} step={1000} defaultValue={(u.monthly_cost_minor || 0) / 100}
                    onBlur={(e) => update.mutate({ monthly_cost_minor: Math.round(Number(e.target.value) * 100) })} />
                </Field>
              </div>
            </div>
          )}

          {u.reports?.length > 0 && (
            <div>
              <p className="label-cap mb-2">Direct reports</p>
              <div className="flex flex-wrap gap-2">
                {u.reports.map((r: any) => (
                  <span key={r.id} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px] text-muted">
                    <Avatar name={r.name} size={18} /> {r.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {u.projects?.length > 0 && (
            <div>
              <p className="label-cap mb-2">Project teams</p>
              <ul className="space-y-1.5">
                {u.projects.map((p: any) => (
                  <li key={p.id}>
                    <button onClick={() => navigate(`/projects/${p.id}`)}
                      className="flex w-full items-center justify-between gap-3 rounded-md border border-line
                                 px-2.5 py-1.5 text-left hover:border-line-strong transition-colors cursor-pointer">
                      <span className="min-w-0">
                        <span className="block text-[13px] text-ink truncate">{p.name}</span>
                        <span className="block text-[11.5px] text-subtle truncate">
                          {p.client_name}{p.responsibility ? ` · ${p.responsibility}` : ''}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <Badge tone={SEAT_TONES[p.seat] || 'neutral'}>{titleCase(p.seat)}</Badge>
                        <span className="text-[11.5px] tabular text-subtle">{percent(p.allocation_pct)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {u.clients?.length > 0 && (
            <div>
              <p className="label-cap mb-2">Clients owned</p>
              <ul className="space-y-1.5">
                {u.clients.map((c: any) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-ink truncate">{c.name}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <Meter value={c.health_score} className="w-14"
                        tone={c.health_score >= 65 ? 'positive' : c.health_score >= 45 ? 'warning' : 'negative'} />
                      <StatusBadge status={c.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Drawer>

      <ConfirmDialog open={removeOpen} onClose={() => setRemoveOpen(false)}
        onConfirm={() => remove.mutate()} loading={remove.isPending}
        title={`Delete ${u.name}?`} danger confirmLabel="Delete employee"
        message="They can no longer sign in and are signed out everywhere. Their open action items go to their manager. Their history (plans, attendance, reports) stays for your records." />
    </>
  );
}

const StatBox = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="rounded-lg bg-sunken p-3">
    <p className="label-cap">{label}</p>
    <p className="mt-1 text-[18px] font-semibold text-ink tabular">{value}</p>
    {sub && <p className="text-[11.5px] text-subtle">{sub}</p>}
  </div>
);

const Row = ({ label, value }: { label: string; value?: string | null }) => (
  value ? (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-subtle shrink-0">{label}</dt>
      <dd className="text-ink text-right min-w-0 truncate">{value}</dd>
    </div>
  ) : null
);
