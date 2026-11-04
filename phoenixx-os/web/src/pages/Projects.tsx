import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, FolderKanban, UserPlus, Crown, Star, ShieldCheck, Eye, Trash2, Download,
  Users2, Briefcase, PencilLine, GraduationCap, Wrench, Send, Megaphone,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, percent, titleCase } from '../lib/format';
import {
  Avatar, AvatarWithName, Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, Drawer,
  EmptyState, ErrorState, Field, Input, Meter, Modal, PageHeader, SearchInput, Select,
  StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs, useToast, cx,
} from '../components/ui';
import {
  EditOwnersModal, OwnerChecklist, OWNER_ROLES, ProjectUpdateHistory, ProjectUpdateModal, ProjectUpdatesTab,
} from '../components/ProjectUpdates';

/**
 * Module F - projects and the people delivering them.
 *
 * The whole point of this screen is that anyone can see, at a glance, who is
 * accountable for a project (the manager), who runs it day to day (the lead),
 * who the seniors are, and who else is on the team - so seats are shown
 * explicitly everywhere rather than hidden behind a member count.
 */

/** Seat presentation. The server owns the list; this only decides how it looks. */
const SEAT_UI: Record<string, { label: string; short: string; tone: any; icon: any }> = {
  manager: { label: 'Project manager', short: 'Manager', tone: 'accent', icon: Crown },
  lead: { label: 'Team lead', short: 'Lead', tone: 'brand', icon: Star },
  senior: { label: 'Senior', short: 'Senior', tone: 'info', icon: ShieldCheck },
  member: { label: 'Team member', short: 'Member', tone: 'neutral', icon: Users2 },
  junior: { label: 'Junior / trainee', short: 'Junior', tone: 'neutral', icon: GraduationCap },
  reviewer: { label: 'Reviewer / QA', short: 'Reviewer', tone: 'positive', icon: Wrench },
  observer: { label: 'Observer', short: 'Observer', tone: 'neutral', icon: Eye },
};
const seatUi = (id?: string) => SEAT_UI[id || 'member'] || SEAT_UI.member;

function SeatBadge({ seat, className }: { seat: string; className?: string }) {
  const ui = seatUi(seat);
  const Icon = ui.icon;
  return (
    <Badge tone={ui.tone} className={className}>
      <Icon size={11} className="mr-1 inline-block -mt-px" aria-hidden />
      {ui.short}
    </Badge>
  );
}

/** Overlapping faces, in seat order, with the overflow rolled into a +N chip. */
function TeamStack({ team, max = 5 }: { team: any[]; max?: number }) {
  if (!team?.length) return <span className="text-[12.5px] text-subtle">Not staffed</span>;
  const shown = team.slice(0, max);
  const rest = team.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((m) => (
        <span key={m.user_id} className="-ml-1.5 first:ml-0 rounded-full ring-2 ring-[var(--raised)]"
          title={`${m.name} · ${seatUi(m.seat).label}`}>
          <Avatar name={m.name} url={m.avatar_url} size={26} />
        </span>
      ))}
      {rest > 0 && (
        <span className="-ml-1.5 grid h-[26px] w-[26px] place-items-center rounded-full bg-sunken
                         ring-2 ring-[var(--raised)] text-[11px] font-medium text-muted tabular">
          +{rest}
        </span>
      )}
    </span>
  );
}

const allocationTone = (pct: number) => (pct > 100 ? 'negative' : pct >= 80 ? 'warning' : 'positive');

/* =================================================================== PAGE */
export default function Projects() {
  const { can } = useAuth();
  // Employees hold `view` on projects and nothing else. Rather than silently
  // dropping every button, say so once - otherwise the page just looks broken.
  const readOnly = !can('projects', 'create') && !can('projects', 'edit');
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  // Notifications deep-link here as ?tab=updates&open=<project>.
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') || 'projects');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(routeId ?? params.get('open'));

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projects', search, status],
    queryFn: () => api.get('/projects', { search, status }).then((r) => r.data),
    enabled: tab === 'projects',
  });

  const staffed = data?.filter((p: any) => p.team_size > 0).length ?? 0;

  const close = () => {
    setOpenId(null);
    if (routeId) navigate('/projects', { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Projects & teams"
        subtitle={(
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {data
                ? `${data.length} project${data.length === 1 ? '' : 's'} · ${staffed} staffed · every seat named`
                : 'Build a team per project and name who manages, leads and delivers it'}
            </span>
            {readOnly && <Badge tone="neutral">Read-only · managers and admins make changes</Badge>}
          </span>
        )}
        actions={can('projects', 'create') && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
            New project
          </Button>
        )}
        tabs={
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'projects', label: 'Projects' },
            { id: 'updates', label: 'Daily updates' },
            { id: 'workload', label: 'Who is on what' },
          ]} />
        }
      />

      {tab === 'projects' && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <SearchInput value={search} onChange={setSearch} placeholder="Search project, code or client…"
                className="flex-1 min-w-[220px]" />
              <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="w-[150px]">
                <option value="">All statuses</option>
                {['planned', 'active', 'on_hold', 'completed', 'cancelled'].map((s) => (
                  <option key={s} value={s}>{titleCase(s)}</option>
                ))}
              </Select>
            </div>
          </Card>

          {error ? <ErrorState error={error} retry={refetch} />
            : isLoading ? <Card><TableSkeleton cols={6} /></Card>
              : !data?.length ? (
                <Card>
                  <EmptyState icon={<FolderKanban size={20} />} title="No projects yet"
                    message="A project holds the scope, the budget and the team delivering it."
                    action={can('projects', 'create') && (
                      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
                        New project
                      </Button>
                    )} />
                </Card>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {data.map((p: any) => <ProjectCard key={p.id} project={p} onOpen={() => setOpenId(p.id)} />)}
                </div>
              )}
        </>
      )}

      {tab === 'updates' && <ProjectUpdatesTab onOpenProject={setOpenId} />}
      {tab === 'workload' && <WorkloadTab onOpenProject={setOpenId} />}

      {createOpen && <CreateProjectModal onClose={() => setCreateOpen(false)} onCreated={setOpenId} />}
      {openId && <ProjectDrawer id={openId} onClose={close} />}
    </>
  );
}

/* ------------------------------------------------------------------ card */
function ProjectCard({ project: p, onOpen }: { project: any; onOpen: () => void }) {
  const manager = p.team?.find((m: any) => m.seat === 'manager');
  const lead = p.team?.find((m: any) => m.seat === 'lead');
  const others = p.team?.filter((m: any) => m.seat !== 'manager' && m.seat !== 'lead') ?? [];

  return (
    <Card className="flex flex-col">
      <button onClick={onOpen} className="flex-1 p-4 text-left cursor-pointer">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-ink truncate">{p.name}</p>
            <p className="text-[12.5px] text-subtle truncate">{p.client_name}</p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            {p.kind === 'marketing' && <Badge tone="accent">Marketing</Badge>}
            <StatusBadge status={p.status} />
          </span>
        </div>

        <div className="mt-3.5 space-y-2">
          <SeatLine seat="manager" member={manager} />
          <SeatLine seat="lead" member={lead} />
        </div>

        {p.owners?.length > 0 && (
          <p className="mt-3 text-[11.5px] text-subtle truncate" title="Project owners - they receive the daily updates">
            <Crown size={11} className="mr-1 inline-block -mt-px" aria-hidden />
            Owners: {p.owners.map((o: any) => o.name).join(', ')}
          </p>
        )}

        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="flex items-center gap-2 min-w-0">
            {others.length > 0 && <TeamStack team={others} />}
            <span className="text-[12px] text-subtle truncate">
              {p.team_size
                ? `${p.team_size} on team${others.length ? ` · ${others.length} delivering` : ' · no one below the lead'}`
                : 'Nobody staffed yet'}
            </span>
          </span>
          <span className="text-[12px] tabular text-subtle shrink-0">{money(p.budget_minor, { compact: true })}</span>
        </div>
      </button>
    </Card>
  );
}

function SeatLine({ seat, member }: { seat: string; member?: any }) {
  const ui = seatUi(seat);
  const Icon = ui.icon;
  return (
    <div className="flex items-center gap-2.5">
      <span className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-md',
        member ? 'bg-sunken text-muted' : 'bg-sunken text-subtle')}>
        <Icon size={14} aria-hidden />
      </span>
      {member ? (
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[13.5px] font-medium text-ink truncate">{member.name}</span>
            <span className="text-[11.5px] text-subtle shrink-0">{ui.short}</span>
          </span>
          <span className="block text-[11.5px] text-subtle truncate">
            {member.responsibility || member.designation || '—'}
          </span>
        </span>
      ) : (
        <span className="text-[12.5px] text-subtle">No {ui.short.toLowerCase()} assigned</span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- workload */
function WorkloadTab({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['project-workload'],
    queryFn: () => api.get('/projects/workload').then((r) => r.data),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading) return <Card><TableSkeleton cols={5} /></Card>;

  return (
    <Card>
      <CardHeader title="Who is on what" icon={<Users2 size={16} />}
        subtitle="Allocation adds up across every project — over 100% means someone is committed twice" />
      <Table>
        <THead>
          <tr>
            <TH>Person</TH>
            <TH width="150px">Service line</TH>
            <TH width="150px">Allocation</TH>
            <TH width="90px" align="right">Projects</TH>
            <TH>On</TH>
          </tr>
        </THead>
        <tbody>
          {data.map((u: any) => (
            <TR key={u.id}>
              <TD><AvatarWithName name={u.name} url={u.avatar_url} sub={u.designation || titleCase(u.role)} size={30} /></TD>
              <TD><span className="text-muted text-[13px]">{u.service_line_name || '—'}</span></TD>
              <TD>
                <span className="flex items-center gap-2">
                  <Meter value={Math.min(u.allocation_pct, 100)} tone={allocationTone(u.allocation_pct)} className="w-14" />
                  <span className={cx('text-[12px] tabular',
                    u.allocation_pct > 100 ? 'text-[var(--negative)]' : 'text-subtle')}>
                    {percent(u.allocation_pct)}
                  </span>
                </span>
              </TD>
              <TD align="right"><span className="tabular text-muted">{u.project_count}</span></TD>
              <TD>
                {!u.projects.length ? <span className="text-[12.5px] text-subtle">Not staffed</span> : (
                  <span className="flex flex-wrap gap-1.5">
                    {u.projects.map((p: any) => (
                      <button key={p.project_id} onClick={() => onOpenProject(p.project_id)}
                        title={`${p.project_name} · ${p.client_name} · ${seatUi(p.seat).label}`}
                        className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5
                                   text-[12px] text-muted hover:border-line-strong transition-colors cursor-pointer">
                        <span className="max-w-[160px] truncate">{p.project_name}</span>
                        <SeatBadge seat={p.seat} />
                      </button>
                    ))}
                  </span>
                )}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/* ---------------------------------------------------------- new project */
function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    client_id: '', name: '', code: '', service_line_id: '', model: 'project', status: 'active',
    start_date: new Date().toISOString().slice(0, 10), end_date: '', budget: '',
    manager_id: '', lead_id: '', scope_total: '', kind: 'delivery',
  });
  // Whoever creates it owns it unless they choose otherwise - when they are allowed to.
  const [ownerIds, setOwnerIds] = useState<string[]>(
    user && OWNER_ROLES.includes(user.role) ? [user.id] : []);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: meta } = useQuery({
    queryKey: ['project-meta'],
    queryFn: async () => {
      const [clients, directory, serviceLines] = await Promise.all([
        // Only clients on the Clients page; leads and old pipeline rows are not project clients.
        api.get('/crm/clients', { limit: 200, on_register: 'true' }).then((r) => r.data),
        api.get('/users/directory').then((r) => r.data),
        api.get('/settings/service-lines').then((r) => r.data),
      ]);
      return { clients, directory, serviceLines };
    },
    staleTime: 300_000,
  });

  const create = useMutation({
    mutationFn: () => api.post('/projects', {
      client_id: form.client_id,
      name: form.name.trim(),
      code: form.code || null,
      service_line_id: form.service_line_id || null,
      model: form.model,
      status: form.status,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      budget_minor: form.budget ? Math.round(Number(form.budget) * 100) : 0,
      manager_id: form.manager_id || null,
      lead_id: form.lead_id || null,
      scope_total: form.scope_total ? Number(form.scope_total) : 0,
      owner_ids: ownerIds,
      kind: form.kind,
    }),
    onSuccess: (res: any) => {
      toast.success('Project created. Add the rest of the team next.');
      qc.invalidateQueries({ queryKey: ['projects'] });
      onCreated(res.data.id);
      onClose();
    },
    onError: (e: any) => { setErrors(e.fieldErrors || {}); toast.error(e.message); },
  });

  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  const people = meta?.directory ?? [];

  return (
    <Modal open onClose={onClose} title="New project" size="lg"
      subtitle="Name the manager and lead now — everyone else can be added from the team tab"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={!form.client_id || form.name.trim().length < 2 || !ownerIds.length}
            onClick={() => create.mutate()}>Create project</Button>
        </>
      }>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client" required error={errors.client_id} className="sm:col-span-2">
          <Select value={form.client_id} onChange={(e) => set('client_id', e.target.value)}>
            <option value="">Choose a client…</option>
            {meta?.clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Project name" required error={errors.name} className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="Brand refresh & always-on marketing" autoFocus />
        </Field>
        <Field label="Project type" className="sm:col-span-2"
          hint={form.kind === 'marketing' ? 'Carries a lead pipeline under Marketing leads' : 'Client delivery work'}>
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="delivery">Delivery</option>
            <option value="marketing">Marketing - with a lead pipeline</option>
          </Select>
        </Field>
        <Field label="Project owners" required error={errors.owner_ids} className="sm:col-span-2"
          hint="They receive the manager's and lead's daily update. Owners and Managers only.">
          <OwnerChecklist people={people} value={ownerIds} onChange={setOwnerIds} />
        </Field>
        <Field label="Project manager" hint="Accountable for scope, budget and the client">
          <Select value={form.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
            <option value="">Decide later</option>
            {people.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.designation ? ` — ${u.designation}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Team lead" hint="Runs delivery day to day">
          <Select value={form.lead_id} onChange={(e) => set('lead_id', e.target.value)}>
            <option value="">Decide later</option>
            {people.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.designation ? ` — ${u.designation}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Service line">
          <Select value={form.service_line_id} onChange={(e) => set('service_line_id', e.target.value)}>
            <option value="">Not assigned</option>
            {meta?.serviceLines?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Engagement model">
          <Select value={form.model} onChange={(e) => set('model', e.target.value)}>
            {['project', 'retainer', 'hybrid'].map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {['planned', 'active', 'on_hold', 'completed', 'cancelled'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Project code" hint="Optional short reference">
          <Input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="PRJ-014" />
        </Field>
        <Field label="Start date">
          <Input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
        </Field>
        <Field label="End date">
          <Input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
        </Field>
        <Field label="Budget (₹)">
          <Input type="number" min={0} step={1000} value={form.budget} onChange={(e) => set('budget', e.target.value)} />
        </Field>
        <Field label="Committed scope" hint="Deliverables promised">
          <Input type="number" min={0} value={form.scope_total} onChange={(e) => set('scope_total', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- drawer */
function ProjectDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('team');
  const [addOpen, setAddOpen] = useState(false);
  const [ownersOpen, setOwnersOpen] = useState(false);
  const [filing, setFiling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const { data: p, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`).then((r) => r.data),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/projects/${id}`),
    onSuccess: () => {
      toast.success('Project deleted.');
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.removeQueries({ queryKey: ['project', id] }); // it is gone: do not refetch it
      setDeleting(false);
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !p) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={4} cols={2} /></div></Drawer>;
  }

  const editable = can('projects', 'edit');
  // The manager and the lead are the two who file the daily project update.
  const mySeat = p.team?.find((m: any) => m.user_id === user?.id)?.seat;
  const files = mySeat === 'manager' || mySeat === 'lead';
  // The server has the final word: a manager may only delete a project they run or own.
  const deletable = can('projects', 'delete') && (user?.role === 'owner'
    || p.manager_id === user?.id || !!p.owners?.some((o: any) => o.user_id === user?.id || o.id === user?.id));

  return (
    <>
      <Drawer open onClose={onClose} title={p.name} width="max-w-3xl"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted">{p.client_name}</span>
            <StatusBadge status={p.status} />
            <Badge tone="neutral">{titleCase(p.model)}</Badge>
            {p.code && <span className="mono text-[12px] text-subtle">{p.code}</span>}
          </span>
        }
        footer={
          <>
            <Button icon={<Download size={15} />}
              onClick={() => api.download(`/projects/${id}/members/export/csv`, `${p.name}-team.csv`)}>
              Export team
            </Button>
            {p.kind === 'marketing' && (
              <Button icon={<Megaphone size={15} />} onClick={() => navigate(`/marketing/${p.id}`)}>Lead pipeline</Button>
            )}
            {files && p.status === 'active' && (
              <Button variant={editable ? 'secondary' : 'primary'} icon={<Send size={15} />} onClick={() => setFiling(true)}>
                File today's update
              </Button>
            )}
            {editable && (
              <Button variant="primary" icon={<UserPlus size={15} />} onClick={() => setAddOpen(true)}>
                Add to team
              </Button>
            )}
            {deletable && (
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setDeleting(true)}>
                Delete project
              </Button>
            )}
          </>
        }>
        <div className="flex items-center gap-2 border-b border-line px-5 py-2.5 text-[12.5px]">
          <Crown size={13} className="text-subtle shrink-0" aria-hidden />
          <span className="text-subtle shrink-0">Owners</span>
          <span className="min-w-0 flex-1 truncate text-ink">
            {p.owners?.length ? p.owners.map((o: any) => o.name).join(', ') : <span className="text-[var(--warning)]">None assigned</span>}
          </span>
          {editable && (
            <Button variant="ghost" size="sm" icon={<PencilLine size={13} />} onClick={() => setOwnersOpen(true)}>
              Change
            </Button>
          )}
        </div>

        <div className="border-b border-line px-5">
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'team', label: `Team (${p.team_size})` },
            { id: 'updates', label: 'Daily updates' },
            { id: 'details', label: 'Project details' },
          ]} />
        </div>

        {tab === 'team' ? <TeamTab project={p} editable={editable} onAdd={() => setAddOpen(true)} />
          : tab === 'updates' ? <ProjectUpdateHistory projectId={p.id} />
            : <DetailsTab project={p} editable={editable} />}
      </Drawer>

      {addOpen && <AddMemberModal project={p} onClose={() => setAddOpen(false)} />}
      {ownersOpen && <EditOwnersModal project={p} onClose={() => setOwnersOpen(false)} />}
      {filing && <DrawerFiling project={p} seat={mySeat} onClose={() => setFiling(false)} />}
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()}
        loading={remove.isPending} danger confirmLabel="Delete project"
        title={`Delete ${p.name}?`}
        message={`It disappears from Projects for everyone and its ${p.team_size || 0} team seat(s) are released. Its chat room closes. Past daily updates, Advance Planner tasks and the audit log keep their history.`} />
    </>
  );
}

/** Opens the update form with whatever this person has already filed today. */
function DrawerFiling({ project: p, seat, onClose }: { project: any; seat?: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['project-updates-to-file'],
    queryFn: () => api.get('/projects/updates/to-file').then((r) => r.data),
  });
  if (isLoading) return null;
  const mine = data?.projects?.find((x: any) => x.id === p.id);
  return (
    <ProjectUpdateModal project={{ id: p.id, name: p.name, client_name: p.client_name, seat }}
      existing={mine?.update} previous={mine?.previous} onClose={onClose} />
  );
}

/* ------------------------------------------------------------- team tab */
function TeamTab({ project: p, editable, onAdd }: { project: any; editable: boolean; onAdd: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<any>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: ({ memberId, patch }: any) => api.patch(`/projects/${p.id}/members/${memberId}`, patch),
    onSuccess: () => {
      toast.success('Team updated.');
      qc.invalidateQueries({ queryKey: ['project', p.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-workload'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: ({ memberId, force }: any) =>
      api.del(`/projects/${p.id}/members/${memberId}${force ? '?force=true' : ''}`),
    onSuccess: () => {
      toast.success('Removed from the team.');
      setRemoving(null);
      qc.invalidateQueries({ queryKey: ['project', p.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-workload'] });
    },
    onError: (e: any, vars: any) => {
      // The API refuses while they still own open work; offer to override.
      if (e.status === 409 && !vars.force) setRemoving((r: any) => ({ ...r, warning: e.message }));
      else toast.error(e.message);
    },
  });

  if (!p.team?.length) {
    return (
      <div className="p-5">
        <EmptyState icon={<Users2 size={20} />} title="No one on this team yet"
          message="Add a manager who owns the outcome, a lead who runs delivery, and the people doing the work."
          action={editable && <Button variant="primary" icon={<UserPlus size={15} />} onClick={onAdd}>Add to team</Button>} />
      </div>
    );
  }

  const overAllocated = p.team.filter((m: any) => m.allocation_pct > 0).length;

  return (
    <>
      <div className="p-5 space-y-5">
        <div className="grid gap-3 grid-cols-3">
          <StatBox label="On the team" value={String(p.team_size)} sub={`${overAllocated} with allocated time`} />
          <StatBox label="Allocated effort" value={percent(p.allocation_total)} sub="sum across the team" />
          <StatBox label="Open items" value={String(p.open_items ?? 0)} sub="not yet done" />
        </div>

        {p.team_by_seat.map((group: any) => (
          <section key={group.id}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <p className="label-cap">{group.label}{group.members.length > 1 ? `s (${group.members.length})` : ''}</p>
              <p className="text-[11.5px] text-subtle truncate">{group.blurb}</p>
            </div>
            <div className="space-y-2">
              {group.members.map((m: any) => (
                <MemberRow key={m.id} member={m} editable={editable}
                  editing={editingId === m.id}
                  onEdit={() => setEditingId(editingId === m.id ? null : m.id)}
                  onPatch={(patch: any) => update.mutate({ memberId: m.id, patch })}
                  onRemove={() => setRemoving(m)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)}
        onConfirm={() => remove.mutate({ memberId: removing.id, force: !!removing.warning })}
        loading={remove.isPending} danger confirmLabel={removing?.warning ? 'Remove anyway' : 'Remove'}
        title={`Remove ${removing?.name} from ${p.name}?`}
        message={removing?.warning
          || 'They come off this project team. Their account, history and other projects are untouched.'} />
    </>
  );
}

function MemberRow({ member: m, editable, editing, onEdit, onPatch, onRemove }: {
  member: any; editable: boolean; editing: boolean;
  onEdit: () => void; onPatch: (patch: any) => void; onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-raised">
      <div className="flex items-center gap-3 p-3">
        <Avatar name={m.name} url={m.avatar_url} size={34} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
            <span className="truncate">{m.name}</span>
            <SeatBadge seat={m.seat} />
            {m.billable === 0 && <Badge tone="neutral">Non-billable</Badge>}
          </p>
          <p className="text-[12px] text-subtle truncate">
            {m.responsibility || m.designation || titleCase(m.org_role)}
            {m.reports_to_name && <span className="text-subtle"> · reports to {m.reports_to_name}</span>}
          </p>
        </div>
        <span className="hidden sm:flex items-center gap-2 shrink-0">
          <Meter value={Math.min(m.allocation_pct, 100)} tone={allocationTone(m.allocation_pct)} className="w-12" />
          <span className="text-[12px] tabular text-subtle w-9 text-right">{percent(m.allocation_pct)}</span>
        </span>
        {editable && (
          <span className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" icon={<PencilLine size={15} />} onClick={onEdit} aria-label={`Edit ${m.name}`} />
            <Button variant="ghost" icon={<Trash2 size={15} />} onClick={onRemove} aria-label={`Remove ${m.name}`} />
          </span>
        )}
      </div>

      {editing && (
        <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2">
          <Field label="Seat on this project">
            <Select value={m.seat} onChange={(e) => onPatch({ seat: e.target.value })}>
              {Object.entries(SEAT_UI).map(([id, ui]) => <option key={id} value={id}>{ui.label}</option>)}
            </Select>
          </Field>
          <Field label="Allocation (%)" hint="Share of their working week">
            <Input type="number" min={0} max={100} step={5} defaultValue={m.allocation_pct}
              onBlur={(e) => {
                const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                if (v !== m.allocation_pct) onPatch({ allocation_pct: v });
              }} />
          </Field>
          <Field label="What they own here" className="sm:col-span-2">
            <Input defaultValue={m.responsibility || ''} placeholder="Weekly reporting and campaign QA"
              onBlur={(e) => e.target.value !== (m.responsibility || '') && onPatch({ responsibility: e.target.value || null })} />
          </Field>
          <Field label="From">
            <Input type="date" defaultValue={m.start_date || ''}
              onBlur={(e) => e.target.value !== (m.start_date || '') && onPatch({ start_date: e.target.value || null })} />
          </Field>
          <Field label="Until" hint="Leave blank while they stay on">
            <Input type="date" defaultValue={m.end_date || ''}
              onBlur={(e) => e.target.value !== (m.end_date || '') && onPatch({ end_date: e.target.value || null })} />
          </Field>
          <div className="sm:col-span-2">
            <Checkbox label="Billable to the client" checked={m.billable === 1}
              onChange={(v) => onPatch({ billable: v })} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- details tab */
function DetailsTab({ project: p, editable }: { project: any; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const update = useMutation({
    mutationFn: (patch: any) => api.patch(`/projects/${p.id}`, patch),
    onSuccess: () => {
      toast.success('Updated.');
      qc.invalidateQueries({ queryKey: ['project', p.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const margin = p.invoiced_minor ? ((p.invoiced_minor - p.cost_minor) / p.invoiced_minor) * 100 : 0;

  return (
    <div className="p-5 space-y-5">
      <div className="grid gap-3 grid-cols-3">
        <StatBox label="Budget" value={money(p.budget_minor, { compact: true })} />
        <StatBox label="Invoiced" value={money(p.invoiced_minor, { compact: true })} />
        <StatBox label="Margin" value={percent(margin)} sub={`cost ${money(p.cost_minor, { compact: true })}`} />
      </div>

      <dl className="space-y-2.5 text-[13px]">
        <Row label="Client" value={p.client_name} onClick={() => navigate(`/crm/${p.client_id}`)} />
        <Row label="Service line" value={p.service_line_name} />
        <Row label="Manager" value={p.manager_name} />
        <Row label="Lead" value={p.lead_name} />
        <Row label="Starts" value={p.start_date ? date(p.start_date) : null} />
        <Row label="Ends" value={p.end_date ? date(p.end_date) : null} />
      </dl>

      <div>
        <p className="label-cap mb-2">Scope delivered</p>
        <span className="flex items-center gap-2">
          <Meter value={p.scope_delivered} max={p.scope_total || 1} className="flex-1"
            tone={p.scope_total && p.scope_delivered / p.scope_total >= 0.8 ? 'positive' : 'warning'} />
          <span className="text-[12.5px] tabular text-subtle">{p.scope_delivered}/{p.scope_total}</span>
        </span>
      </div>

      {editable && (
        <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
          <Field label="Status">
            <Select value={p.status} onChange={(e) => update.mutate({ status: e.target.value })}>
              {['planned', 'active', 'on_hold', 'completed', 'cancelled'].map((s) => (
                <option key={s} value={s}>{titleCase(s)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Project type" hint="Marketing adds a lead pipeline">
            <Select value={p.kind || 'delivery'} onChange={(e) => update.mutate({ kind: e.target.value })}>
              <option value="delivery">Delivery</option>
              <option value="marketing">Marketing</option>
            </Select>
          </Field>
          <Field label="Engagement model">
            <Select value={p.model} onChange={(e) => update.mutate({ model: e.target.value })}>
              {['project', 'retainer', 'hybrid'].map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}
            </Select>
          </Field>
          <Field label="Budget (₹)">
            <Input type="number" min={0} step={1000} defaultValue={(p.budget_minor || 0) / 100}
              onBlur={(e) => update.mutate({ budget_minor: Math.round(Number(e.target.value) * 100) })} />
          </Field>
          <Field label="Scope delivered" hint={`of ${p.scope_total} committed`}>
            <Input type="number" min={0} defaultValue={p.scope_delivered}
              onBlur={(e) => update.mutate({ scope_delivered: Number(e.target.value) || 0 })} />
          </Field>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------- add to team */
function AddMemberModal({ project: p, onClose }: { project: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Record<string, { seat: string; allocation_pct: number; responsibility: string }>>({});

  const { data: available, isLoading } = useQuery({
    queryKey: ['project-available', p.id],
    queryFn: () => api.get(`/projects/${p.id}/available`).then((r) => r.data),
  });

  const add = useMutation({
    mutationFn: () => api.post(`/projects/${p.id}/members/bulk`, {
      members: Object.entries(picked).map(([user_id, v]) => ({
        user_id,
        seat: v.seat,
        allocation_pct: v.allocation_pct,
        responsibility: v.responsibility || null,
        start_date: p.start_date || null,
      })),
    }),
    onSuccess: () => {
      toast.success(`Added ${Object.keys(picked).length} to the team.`);
      qc.invalidateQueries({ queryKey: ['project', p.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-workload'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return available ?? [];
    return (available ?? []).filter((u: any) =>
      [u.name, u.email, u.designation, u.service_line_name].some((v: string) => v?.toLowerCase().includes(q)));
  }, [available, search]);

  const toggle = (u: any) => setPicked((prev) => {
    const next = { ...prev };
    if (next[u.id]) delete next[u.id];
    else next[u.id] = { seat: 'member', allocation_pct: 20, responsibility: '' };
    return next;
  });
  const setFor = (id: string, patch: any) => setPicked((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const count = Object.keys(picked).length;

  return (
    <Modal open onClose={onClose} title={`Add people to ${p.name}`} size="lg"
      subtitle="Pick who joins, then give each of them a seat and a share of their week"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!count} onClick={() => add.mutate()}>
            {count ? `Add ${count} to the team` : 'Add to the team'}
          </Button>
        </>
      }>
      <div className="space-y-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, role or service line…" />

        {isLoading ? <TableSkeleton rows={5} cols={2} />
          : !filtered.length ? (
            <EmptyState compact icon={<Briefcase size={18} />} title="No one left to add"
              message="Everyone in the directory is already on this team." />
          ) : (
            <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-line divide-y divide-[var(--line)]">
              {filtered.map((u: any) => {
                const sel = picked[u.id];
                return (
                  <div key={u.id} className={cx('p-3', sel && 'bg-sunken')}>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={!!sel} onChange={() => toggle(u)}
                        className="h-4 w-4 accent-[var(--brand)] cursor-pointer" />
                      <Avatar name={u.name} url={u.avatar_url} size={30} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium text-ink truncate">{u.name}</span>
                        <span className="block text-[12px] text-subtle truncate">
                          {u.designation || titleCase(u.role)}
                          {u.service_line_name && ` · ${u.service_line_name}`}
                        </span>
                      </span>
                      <span className="text-[11.5px] text-subtle tabular shrink-0 text-right">
                        {u.project_count} project{u.project_count === 1 ? '' : 's'}
                        <span className={cx('block', u.allocation_pct > 100 && 'text-[var(--negative)]')}>
                          {percent(u.allocation_pct)} allocated
                        </span>
                      </span>
                    </label>

                    {sel && (
                      <div className="mt-3 grid gap-2 pl-7 sm:grid-cols-[170px_110px_1fr]">
                        <Select value={sel.seat} onChange={(e) => setFor(u.id, { seat: e.target.value })} aria-label="Seat">
                          {Object.entries(SEAT_UI).map(([id, ui]) => <option key={id} value={id}>{ui.label}</option>)}
                        </Select>
                        <Input type="number" min={0} max={100} step={5} value={sel.allocation_pct}
                          aria-label="Allocation percent"
                          onChange={(e) => setFor(u.id, { allocation_pct: Number(e.target.value) || 0 })} />
                        <Input value={sel.responsibility} placeholder="What they own on this project"
                          aria-label="Responsibility"
                          onChange={(e) => setFor(u.id, { responsibility: e.target.value })} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        <p className="text-[12px] text-subtle leading-relaxed">
          Manager and lead are single seats — assigning one moves whoever held it into a team member seat.
        </p>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------- bits */
const StatBox = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="rounded-lg bg-sunken p-3">
    <p className="label-cap">{label}</p>
    <p className="mt-1 text-[18px] font-semibold text-ink tabular">{value}</p>
    {sub && <p className="text-[11.5px] text-subtle truncate">{sub}</p>}
  </div>
);

const Row = ({ label, value, onClick }: { label: string; value?: string | null; onClick?: () => void }) => (
  value ? (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-subtle shrink-0">{label}</dt>
      <dd className={cx('min-w-0 truncate text-right', onClick ? 'text-[var(--brand)] cursor-pointer hover:underline' : 'text-ink')}
        onClick={onClick}>{value}</dd>
    </div>
  ) : null
);
