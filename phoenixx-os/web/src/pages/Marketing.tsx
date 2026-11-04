import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Upload, Star, Phone, Mail, MessageCircle, CalendarCheck, StickyNote, Skull, RotateCcw, Crown,
  Send, Megaphone, Activity, FileBarChart, Settings2, CheckCircle2, ArrowRight, Flag, UserRound,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, money, relative, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, Checkbox, Drawer, EmptyState, ErrorState, Field, Input,
  Meter, Modal, PageHeader, SearchInput, Select, Table, TableSkeleton, TD, TH, THead, TR, Tabs, Textarea, useToast, cx,
} from '../components/ui';

/**
 * Marketing projects and their lead pipelines.
 *
 * One lead, one row: every view here (⭐ Progressive, My leads, Follow-up
 * today ...) is a filter over the same leads. Status moves from a dropdown;
 * everything that happens lands on the lead's timeline; leads given up on are
 * marked dead with a reason and kept in the dead lead register.
 */

const HEALTH_UI: Record<string, { tone: any; dot: string }> = {
  moving: { tone: 'positive', dot: '🟢' },
  waiting: { tone: 'warning', dot: '🟡' },
  needs_followup: { tone: 'accent', dot: '🟠' },
  stalled: { tone: 'negative', dot: '🔴' },
};
const PRIORITY_TONE: Record<string, any> = { critical: 'negative', high: 'warning', normal: 'neutral' };
const TEMP_TONE: Record<string, any> = { hot: 'negative', warm: 'warning', cold: 'info' };
const EVENT_ICON: Record<string, any> = {
  call: Phone, email: Mail, whatsapp: MessageCircle, meeting: CalendarCheck, note: StickyNote,
  marked_dead: Skull, revived: RotateCcw, progressive_enabled: Star, progressive_disabled: Star,
  owner_action_raised: Crown, owner_action_resolved: CheckCircle2, status_changed: ArrowRight,
  daily_update: Send, assigned: UserRound, converted: Flag,
};
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function HealthBadge({ health }: { health?: any }) {
  if (!health) return <span className="text-subtle text-[12px]">—</span>;
  const ui = HEALTH_UI[health.id];
  return <span title={health.why}><Badge tone={ui.tone}>{ui.dot} {health.label}</Badge></span>;
}

const useMeta = () => useQuery({ queryKey: ['marketing-meta'], queryFn: () => api.get('/marketing/meta').then((r) => r.data), staleTime: 300_000 });
const statusLabel = (meta: any, id: string) => (id === 'dead' ? 'Dead' : meta?.statuses?.find((s: any) => s.id === id)?.label || titleCase(id));

/* ================================================================== PAGE */
export default function Marketing() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: projects, isLoading, error, refetch } = useQuery({
    queryKey: ['marketing-projects'],
    queryFn: () => api.get('/marketing/projects').then((r) => r.data),
  });

  if (projectId) return <MarketingProject projectId={projectId} projects={projects ?? []} />;

  return (
    <>
      <PageHeader title="Marketing leads"
        subtitle="Every marketing project's lead pipeline - progressive leads, follow-ups, dead leads and reports" />
      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton rows={3} cols={4} /></Card>
          : !projects?.length ? (
            <Card>
              <EmptyState icon={<Megaphone size={20} />} title="No marketing projects you can see"
                message='A project becomes a marketing project when its type is set to "Marketing" under Projects & teams. You see the ones you are on or own.'
                action={<Button onClick={() => navigate('/projects')}>Go to Projects & teams</Button>} />
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((p: any) => (
                <Card key={p.id}>
                  <button className="w-full p-4 text-left cursor-pointer" onClick={() => navigate(`/marketing/${p.id}`)}>
                    <p className="font-medium text-ink truncate">{p.name}</p>
                    <p className="text-[12.5px] text-subtle truncate">{p.client_name}</p>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                      <Mini label="Open" value={p.open} />
                      <Mini label="⭐" value={p.progressive} />
                      <Mini label="Due" value={p.followups_due} tone={p.followups_due ? 'warning' : undefined} />
                      <Mini label="Stalled" value={p.stalled} tone={p.stalled ? 'negative' : undefined} />
                    </div>
                    <p className="mt-3 text-[12px] text-subtle">{p.total} leads · {p.won} won · {p.dead} dead</p>
                  </button>
                </Card>
              ))}
            </div>
          )}
    </>
  );
}

const Mini = ({ label, value, tone }: { label: string; value: any; tone?: 'warning' | 'negative' }) => (
  <div className="rounded-md bg-sunken py-1.5">
    <p className={cx('text-[16px] font-semibold tabular', tone === 'negative' ? 'text-[var(--negative)]' : tone === 'warning' ? 'text-[var(--warning)]' : 'text-ink')}>{value}</p>
    <p className="text-[10.5px] text-subtle uppercase tracking-wide">{label}</p>
  </div>
);

/* ============================================================== PROJECT */
function MarketingProject({ projectId, projects }: { projectId: string; projects: any[] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') || 'overview');
  const openLead = params.get('lead');
  const { data: meta } = useMeta();
  const overview = useQuery({
    queryKey: ['marketing-overview', projectId],
    queryFn: () => api.get(`/marketing/projects/${projectId}/overview`).then((r) => r.data),
  });

  const setLead = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('lead', id); else next.delete('lead');
    setParams(next, { replace: true });
  };
  const go = (t: string) => { setTab(t); const n = new URLSearchParams(params); n.set('tab', t); setParams(n, { replace: true }); };

  if (overview.error) return <ErrorState error={overview.error} retry={overview.refetch} />;
  const o = overview.data;
  const perms = { can_work: !!o?.can_work, can_steer: !!o?.can_steer };

  return (
    <>
      <PageHeader
        title={o?.project?.name || 'Marketing project'}
        subtitle={o ? `${o.totals.open} open leads · ⭐ ${o.totals.progressive} progressive · ${o.totals.followups_due_today} follow-up(s) due` : 'Loading…'}
        actions={projects.length > 1 && (
          <Select value={projectId} onChange={(e) => navigate(`/marketing/${e.target.value}`)} aria-label="Marketing project" className="w-[240px]">
            {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        tabs={<Tabs active={tab} onChange={go} tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'leads', label: 'Leads' },
          { id: 'progressive', label: `⭐ Progressive${o ? ` (${o.totals.progressive})` : ''}` },
          { id: 'attention', label: `Owner attention${o?.totals.owner_actions_open ? ` (${o.totals.owner_actions_open})` : ''}` },
          { id: 'activity', label: 'Activity' },
          { id: 'dead', label: 'Dead leads' },
          { id: 'reports', label: 'Reports' },
          ...(meta?.can_edit_settings ? [{ id: 'settings', label: 'Settings' }] : []),
        ]} />}
      />

      {tab === 'overview' && (o ? <Overview o={o} meta={meta} onTab={go} /> : <Card><TableSkeleton rows={4} cols={4} /></Card>)}
      {tab === 'leads' && <LeadsTab projectId={projectId} perms={perms} onOpen={setLead} />}
      {tab === 'progressive' && <LeadsTab projectId={projectId} perms={perms} onOpen={setLead} fixedView="progressive" />}
      {tab === 'attention' && <AttentionTab projectId={projectId} onOpen={setLead} />}
      {tab === 'activity' && <ActivityTab projectId={projectId} onOpen={setLead} />}
      {tab === 'dead' && <DeadTab projectId={projectId} perms={perms} onOpen={setLead} />}
      {tab === 'reports' && <ReportsTab projectId={projectId} perms={perms} />}
      {tab === 'settings' && <SettingsTab />}

      {openLead && <LeadDrawer id={openLead} onClose={() => setLead(null)} />}
    </>
  );
}

/* ============================================================= OVERVIEW */
function Overview({ o, meta, onTab }: { o: any; meta: any; onTab: (t: string) => void }) {
  const max = Math.max(1, ...Object.values(o.by_status as Record<string, number>));
  const t = o.today_counts;
  return (
    <div className="space-y-4">
      {o.campaign_progress_pct != null && (
        <Card>
          <div className="flex items-center gap-4 p-4">
            <p className="label-cap shrink-0">Campaign progress</p>
            <Meter value={o.campaign_progress_pct} className="flex-1" />
            <span className="tabular font-semibold">{o.campaign_progress_pct}%</span>
          </div>
        </Card>
      )}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Tile label="Total leads" value={o.totals.total} sub={`${o.totals.open} open`} />
        <Tile label="⭐ Progressive" value={o.totals.progressive}
          sub={`${o.progressive_by_priority.critical} critical · ${o.progressive_by_priority.high} high · ${o.progressive_by_priority.normal} normal`} />
        <Tile label="Pipeline value" value={money(o.totals.pipeline_value_minor, { compact: true })} sub="expected, open leads" />
        <Tile label="Owner actions" value={o.totals.owner_actions_open} tone={o.totals.owner_actions_open ? 'negative' : undefined} sub="waiting on an owner" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Leads by status" />
          <div className="space-y-2 p-4 pt-0">
            {[...(meta?.statuses ?? []), { id: 'dead', label: 'Dead' }].map((s: any) => (
              <div key={s.id} className="flex items-center gap-3 text-[13px]">
                <span className="w-24 text-muted">{s.label}</span>
                <Meter value={o.by_status[s.id] || 0} max={max} className="flex-1"
                  tone={s.id === 'won' ? 'positive' : s.id === 'dead' ? 'negative' : 'brand'} />
                <span className="w-8 text-right tabular">{o.by_status[s.id] || 0}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="⭐ Progressive leads" subtitle="Health of every open ⭐ lead"
            action={<Button size="sm" onClick={() => onTab('progressive')}>Open</Button>} />
          <div className="grid grid-cols-2 gap-3 p-4 pt-0">
            <Tile label="🔴 Need attention" value={o.progressive_health.stalled} tone={o.progressive_health.stalled ? 'negative' : undefined} />
            <Tile label="🟠 Follow-up due" value={o.progressive_health.needs_followup} />
            <Tile label="🟡 Waiting" value={o.progressive_health.waiting} />
            <Tile label="🟢 Moving" value={o.progressive_health.moving} tone="positive" />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Today" subtitle={date(o.today)} />
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 p-4 pt-0">
          {[['New leads', t.new_leads], ['Follow-ups', t.follow_ups], ['Responses', t.responses], ['Meetings', t.meetings],
            ['Proposals', t.proposals], ['⭐ added', t.progressive_added], ['Won', t.won], ['Dead', t.dead]].map(([l, v]) => (
            <Tile key={l as string} label={l as string} value={v} />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Team" subtitle="All time on this project" />
        <Table>
          <THead><tr>
            <TH>Member</TH><TH align="right">Assigned</TH><TH align="right">⭐</TH><TH align="right">Follow-ups</TH>
            <TH align="right">Responses</TH><TH align="right">Meetings</TH><TH align="right">Proposals</TH><TH align="right">Won</TH>
          </tr></THead>
          <tbody>
            {o.team.map((m: any) => (
              <tr key={m.user_id} className="border-b border-line last:border-0">
                <TD className="font-medium">{m.name}</TD>
                {['assigned', 'progressive', 'touches', 'responses', 'meetings', 'proposals', 'won'].map((k) => <TD key={k} align="right"><span className="tabular">{m[k]}</span></TD>)}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

const Tile = ({ label, value, sub, tone }: { label: string; value: any; sub?: string; tone?: 'positive' | 'negative' }) => (
  <div className="rounded-lg border border-line bg-raised p-3">
    <p className="label-cap">{label}</p>
    <p className={cx('mt-1 text-[20px] font-semibold tabular', tone === 'negative' ? 'text-[var(--negative)]' : tone === 'positive' ? 'text-[var(--positive)]' : 'text-ink')}>{value}</p>
    {sub && <p className="text-[11.5px] text-subtle truncate">{sub}</p>}
  </div>
);

/* ================================================================ LEADS */
const VIEWS = [
  { id: 'all', label: 'All leads' }, { id: 'mine', label: 'My leads' }, { id: 'new', label: 'New' },
  { id: 'followup_today', label: 'Follow-up today' }, { id: 'progressive', label: '⭐ Progressive' }, { id: 'won', label: 'Won' },
];

function useInvalidate(projectId?: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['marketing-leads'] });
    qc.invalidateQueries({ queryKey: ['marketing-lead'] });
    qc.invalidateQueries({ queryKey: ['marketing-overview', projectId] });
    qc.invalidateQueries({ queryKey: ['marketing-projects'] });
    qc.invalidateQueries({ queryKey: ['marketing-dead'] });
    qc.invalidateQueries({ queryKey: ['marketing-attention'] });
    qc.invalidateQueries({ queryKey: ['marketing-activity'] });
  };
}

function LeadsTab({ projectId, perms, onOpen, fixedView }: {
  projectId: string; perms: { can_work: boolean; can_steer: boolean }; onOpen: (id: string) => void; fixedView?: string;
}) {
  const { data: meta } = useMeta();
  const [view, setView] = useState(fixedView || 'all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [assignee, setAssignee] = useState('');
  const [temperature, setTemperature] = useState('');
  const [health, setHealth] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const v = fixedView || view;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['marketing-leads', projectId, v, search, status, assignee, temperature, health],
    queryFn: () => api.get(`/marketing/projects/${projectId}/leads`, {
      view: v, search, status, assigned_to: assignee, temperature, health,
    }).then((r) => r.data),
  });
  const team = useTeam(projectId);

  return (
    <>
      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2 p-3">
          {!fixedView && (
            <div className="flex flex-wrap gap-1.5 w-full mb-1">
              {VIEWS.map((x) => (
                <button key={x.id} onClick={() => setView(x.id)}
                  className={cx('rounded-full border px-3 py-1 text-[12.5px] cursor-pointer transition-colors',
                    view === x.id ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]' : 'border-line text-muted hover:border-line-strong')}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
          <SearchInput value={search} onChange={setSearch} placeholder="Search company, contact, phone or email…" className="flex-1 min-w-[220px]" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="w-[140px]">
            <option value="">All statuses</option>
            {meta?.statuses?.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee" className="w-[150px]">
            <option value="">Anyone</option>
            {team.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
          </Select>
          <Select value={temperature} onChange={(e) => setTemperature(e.target.value)} aria-label="Temperature" className="w-[120px]">
            <option value="">Any temp.</option>
            {meta?.temperatures?.map((t: string) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </Select>
          <Select value={health} onChange={(e) => setHealth(e.target.value)} aria-label="Health" className="w-[150px]">
            <option value="">Any health</option>
            {Object.entries(HEALTH_UI).map(([id, ui]) => <option key={id} value={id}>{ui.dot} {titleCase(id)}</option>)}
          </Select>
          {perms.can_work && (
            <span className="ml-auto flex gap-2">
              <Button icon={<Upload size={15} />} onClick={() => setImporting(true)}>Import CSV</Button>
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add lead</Button>
            </span>
          )}
        </div>
      </Card>

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton cols={7} /></Card>
          : !data?.length ? (
            <Card><EmptyState icon={<Megaphone size={20} />} title={v === 'progressive' ? 'No ⭐ progressive leads' : 'No leads here'}
              message={v === 'progressive' ? 'The project manager or team lead stars a lead from the list when it shows a real buying signal.' : 'Add a lead or import a CSV to start the pipeline.'} /></Card>
          ) : (
            <Card>
              <Table>
                <THead><tr>
                  <TH width="40px"> </TH><TH>Lead</TH><TH width="150px">Status</TH><TH width="80px">Temp.</TH>
                  <TH width="140px">Assigned</TH><TH width="110px">Last activity</TH><TH>Next</TH><TH width="150px">Health</TH>
                </tr></THead>
                <tbody>
                  {data.map((l: any) => <LeadRow key={l.id} l={l} meta={meta} perms={perms} projectId={projectId} onOpen={() => onOpen(l.id)} />)}
                </tbody>
              </Table>
            </Card>
          )}

      {adding && <AddLeadModal projectId={projectId} team={team} onClose={() => setAdding(false)} onCreated={onOpen} />}
      {importing && <ImportModal projectId={projectId} team={team} onClose={() => setImporting(false)} />}
    </>
  );
}

function useTeam(projectId: string) {
  const { data } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.get(`/projects/${projectId}/members`).then((r) => r.data),
    staleTime: 120_000,
  });
  return data ?? [];
}

function LeadRow({ l, meta, perms, projectId, onOpen }: { l: any; meta: any; perms: any; projectId: string; onOpen: () => void }) {
  const [starring, setStarring] = useState(false);
  const [winning, setWinning] = useState(false);
  const status = useStatusChange(l, projectId);
  const stop = (e: any) => e.stopPropagation();

  return (
    <>
      <TR onClick={onOpen}>
        <TD>
          <button onClick={(e) => { stop(e); if (perms.can_steer) setStarring(true); }} disabled={!perms.can_steer}
            title={perms.can_steer ? (l.is_progressive ? 'Remove ⭐' : 'Mark ⭐ progressive') : 'Only the project manager or team lead can star a lead'}
            className={cx('p-1', perms.can_steer ? 'cursor-pointer' : 'cursor-default')}>
            <Star size={17} className={l.is_progressive ? 'fill-[var(--accent-bg)] text-[var(--accent-bg)]' : 'text-line-strong'} />
          </button>
        </TD>
        <TD>
          <span className="block font-medium text-ink truncate max-w-[240px]">{l.company_name}</span>
          <span className="block text-[12px] text-subtle truncate max-w-[240px]">
            {[l.contact_name, l.phone || l.email].filter(Boolean).join(' · ') || '—'}
            {l.is_progressive && l.progressive_priority && <Badge tone={PRIORITY_TONE[l.progressive_priority]} className="ml-1.5">{l.progressive_priority}</Badge>}
            {l.owner_action_required && <Badge tone="negative" className="ml-1.5">owner action</Badge>}
          </span>
        </TD>
        <TD>
          <span onClick={stop}>
            {perms.can_work && l.status !== 'won' ? (
              <Select value={l.status} aria-label={`Status of ${l.company_name}`} className="h-8 text-[12.5px]"
                onChange={(e) => (e.target.value === 'won' ? setWinning(true) : status.mutate({ status: e.target.value }))}>
                {meta?.statuses?.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            ) : <Badge tone={l.status === 'won' ? 'positive' : 'neutral'}>{statusLabel(meta, l.status)}</Badge>}
          </span>
        </TD>
        <TD><Badge tone={TEMP_TONE[l.temperature]}>{titleCase(l.temperature)}</Badge></TD>
        <TD><span className="text-[12.5px] text-muted truncate">{l.assigned_name || 'Unassigned'}</span></TD>
        <TD><span className="text-[12.5px] text-subtle">{relative(l.last_activity_at)}</span></TD>
        <TD>
          <span className="block text-[12.5px] text-ink truncate max-w-[220px]">{l.next_action || <span className="text-[var(--warning)]">Not recorded</span>}</span>
          <span className={cx('block text-[11.5px]', l.next_followup_date && l.next_followup_date < today() ? 'text-[var(--negative)]' : 'text-subtle')}>
            {l.next_followup_date ? (l.next_followup_date === today() ? 'Today' : date(l.next_followup_date)) : 'no date'}
          </span>
        </TD>
        <TD><HealthBadge health={l.health} /></TD>
      </TR>
      {starring && <StarModal lead={l} projectId={projectId} onClose={() => setStarring(false)} />}
      {winning && <WonModal lead={l} projectId={projectId} onClose={() => setWinning(false)} />}
    </>
  );
}

function useStatusChange(lead: any, projectId: string) {
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (patch: any) => api.patch(`/marketing/leads/${lead.id}`, patch),
    onSuccess: (_r, patch: any) => { toast.success(patch.status ? `${lead.company_name} moved to ${titleCase(patch.status)}.` : 'Saved.'); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
}

function WonModal({ lead, projectId, onClose }: { lead: any; projectId: string; onClose: () => void }) {
  const [createClient, setCreateClient] = useState(true);
  const status = useStatusChange(lead, projectId);
  return (
    <Modal open onClose={onClose} title={`Mark ${lead.company_name} as won`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={status.isPending} onClick={() => status.mutate({ status: 'won', create_client: createClient }, { onSuccess: onClose })}>Mark won</Button></>}>
      <div className="space-y-3 text-[13.5px]">
        <p>The lead closes as won{lead.is_progressive ? ' and its ⭐ is closed as converted' : ''}. Its whole history stays here.</p>
        <Checkbox checked={createClient} onChange={setCreateClient}
          label="Also create it as a client in the CRM, so proposals and invoices can follow" />
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- ⭐ flow */
function StarModal({ lead, projectId, onClose }: { lead: any; projectId: string; onClose: () => void }) {
  const { data: meta } = useMeta();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const turningOn = !lead.is_progressive;
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState('high');
  const [nextAction, setNextAction] = useState(lead.next_action || '');
  const [followup, setFollowup] = useState(lead.next_followup_date && lead.next_followup_date >= today() ? lead.next_followup_date : plusDays(1));
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () => api.post(`/marketing/leads/${lead.id}/progressive`, turningOn
      ? { on: true, reasons, reason_note: note || null, priority, next_action: nextAction, next_followup_date: followup }
      : { on: false, reason }),
    onSuccess: () => { toast.success(turningOn ? `⭐ ${lead.company_name} is now progressive.` : '⭐ removed. The history is kept.'); invalidate(); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const valid = turningOn
    ? reasons.length > 0 && (!reasons.includes('other') || note.trim()) && nextAction.trim() && followup
    : reason.trim().length > 1;

  return (
    <Modal open onClose={onClose} title={turningOn ? `⭐ Mark ${lead.company_name} progressive` : `Remove ⭐ from ${lead.company_name}`}
      subtitle={turningOn ? 'It stays in the pipeline and also shows in ⭐ Progressive - it is never copied' : 'The lead stays in the pipeline; the ⭐ history is kept'}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>{turningOn ? 'Mark ⭐ progressive' : 'Remove ⭐'}</Button></>}>
      {turningOn ? (
        <div className="space-y-4">
          <Field label="Why is this lead progressive?" required>
            <div className="grid gap-x-4 sm:grid-cols-2">
              {meta?.progressive_reasons?.map((r: any) => (
                <Checkbox key={r.id} label={r.label} checked={reasons.includes(r.id)}
                  onChange={(on) => setReasons(on ? [...reasons, r.id] : reasons.filter((x) => x !== r.id))} />
              ))}
            </div>
          </Field>
          {reasons.includes('other') && <Field label="Other reason" required><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          <Field label="Priority" required>
            <div className="flex gap-2">
              {['critical', 'high', 'normal'].map((p) => (
                <button key={p} type="button" onClick={() => setPriority(p)}
                  className={cx('rounded-md border px-3 py-1.5 text-[13px] cursor-pointer', priority === p ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]' : 'border-line text-muted')}>
                  {titleCase(p)}
                </button>
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
            <Field label="Next action" required><Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Send revised quotation" /></Field>
            <Field label="Next follow-up" required><Input type="date" value={followup} onChange={(e) => setFollowup(e.target.value)} /></Field>
          </div>
        </div>
      ) : (
        <Field label="Reason" required hint="e.g. Client postponed project">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- add lead */
const emptyLead = {
  company_name: '', contact_name: '', designation: '', phone: '', email: '', website: '', location: '', industry: '',
  source: 'campaign', assigned_to: '', status: 'new', temperature: 'cold', expected_value: '', expected_close_date: '',
  next_action: '', next_followup_date: '', notes: '',
};
const toPayload = (f: any) => ({
  ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? null : v])),
  company_name: f.company_name.trim(),
  expected_value_minor: f.expected_value ? Math.round(Number(f.expected_value) * 100) : 0,
  expected_value: undefined,
});

function LeadFields({ form, set, team, meta, withStatus }: { form: any; set: (k: string, v: any) => void; team: any[]; meta: any; withStatus?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Company name" required className="sm:col-span-2"><Input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} autoFocus /></Field>
      <Field label="Contact person"><Input value={form.contact_name || ''} onChange={(e) => set('contact_name', e.target.value)} /></Field>
      <Field label="Designation"><Input value={form.designation || ''} onChange={(e) => set('designation', e.target.value)} /></Field>
      <Field label="Phone"><Input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="Email"><Input type="email" value={form.email || ''} onChange={(e) => set('email', e.target.value)} /></Field>
      <Field label="Website"><Input value={form.website || ''} onChange={(e) => set('website', e.target.value)} /></Field>
      <Field label="Location"><Input value={form.location || ''} onChange={(e) => set('location', e.target.value)} /></Field>
      <Field label="Industry"><Input value={form.industry || ''} onChange={(e) => set('industry', e.target.value)} /></Field>
      <Field label="Lead source">
        <Select value={form.source || ''} onChange={(e) => set('source', e.target.value)}>
          {meta?.sources?.map((s: string) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
      </Field>
      <Field label="Assigned to">
        <Select value={form.assigned_to || ''} onChange={(e) => set('assigned_to', e.target.value)}>
          <option value="">Unassigned</option>
          {team.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
        </Select>
      </Field>
      {withStatus && (
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {meta?.statuses?.filter((s: any) => s.id !== 'won').map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Temperature">
        <Select value={form.temperature} onChange={(e) => set('temperature', e.target.value)}>
          {meta?.temperatures?.map((t: string) => <option key={t} value={t}>{titleCase(t)}</option>)}
        </Select>
      </Field>
      <Field label="Expected value (₹)"><Input type="number" min={0} value={form.expected_value} onChange={(e) => set('expected_value', e.target.value)} /></Field>
      <Field label="Expected close date"><Input type="date" value={form.expected_close_date || ''} onChange={(e) => set('expected_close_date', e.target.value)} /></Field>
      <Field label="Next action"><Input value={form.next_action || ''} onChange={(e) => set('next_action', e.target.value)} placeholder="First outreach call" /></Field>
      <Field label="Next follow-up"><Input type="date" value={form.next_followup_date || ''} onChange={(e) => set('next_followup_date', e.target.value)} /></Field>
      <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></Field>
    </div>
  );
}

function AddLeadModal({ projectId, team, onClose, onCreated }: { projectId: string; team: any[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { data: meta } = useMeta();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const [form, setForm] = useState<any>(emptyLead);
  const [dup, setDup] = useState<string | null>(null);
  const set = (k: string, v: any) => { setForm((f: any) => ({ ...f, [k]: v })); setDup(null); };

  const save = useMutation({
    mutationFn: (force: boolean) => api.post(`/marketing/projects/${projectId}/leads`, { ...toPayload(form), force }),
    onSuccess: (r: any) => { toast.success('Lead added.'); invalidate(); onClose(); onCreated(r.data.id); },
    onError: (e: any) => { if (e.status === 409) setDup(e.message); else toast.error(e.message); },
  });

  return (
    <Modal open onClose={onClose} title="Add lead" size="lg" subtitle="Entered once - every view finds it from here"
      footer={<><Button onClick={onClose}>Cancel</Button>
        {dup && <Button loading={save.isPending} onClick={() => save.mutate(true)}>Save anyway</Button>}
        <Button variant="primary" disabled={!form.company_name.trim()} loading={save.isPending && !dup} onClick={() => save.mutate(false)}>Add lead</Button></>}>
      {dup && <p className="mb-3 rounded-md border border-[var(--warning)] bg-warning-soft px-3 py-2 text-[13px]">{dup} Check it is not the same lead before saving anyway.</p>}
      <LeadFields form={form} set={set} team={team} meta={meta} withStatus />
    </Modal>
  );
}

function ImportModal({ projectId, team, onClose }: { projectId: string; team: any[]; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const [csv, setCsv] = useState('');
  const [assignee, setAssignee] = useState('');
  const [result, setResult] = useState<any>(null);
  const run = useMutation({
    mutationFn: () => api.post(`/marketing/projects/${projectId}/leads/import`, { csv, assigned_to: assignee || null }),
    onSuccess: (r: any) => { setResult(r.data); invalidate(); toast.success(`${r.data.created} lead(s) imported.`); },
    onError: (e: any) => toast.error(e.message),
  });
  const onFile = (f?: File) => { if (!f) return; const rd = new FileReader(); rd.onload = () => setCsv(String(rd.result || '')); rd.readAsText(f); };

  return (
    <Modal open onClose={onClose} title="Import leads from CSV" size="lg"
      subtitle="Columns: Company (required), Contact, Designation, Phone, Email, Website, Location, Industry, Source, Assignee (email), Notes"
      footer={<><Button onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
        {!result && <Button variant="primary" disabled={!csv.trim()} loading={run.isPending} onClick={() => run.mutate()}>Import</Button>}</>}>
      {result ? (
        <div className="space-y-3 text-[13.5px]">
          <p><b>{result.created}</b> lead(s) created · <b>{result.duplicates.length}</b> duplicate(s) skipped · <b>{result.errors.length}</b> row(s) with errors</p>
          {result.duplicates.length > 0 && (
            <div><p className="label-cap mb-1">Duplicates - not created</p>
              <ul className="space-y-0.5 text-[12.5px] text-muted">{result.duplicates.map((d: any) => <li key={d.line}>Line {d.line}: {d.company} matches {d.existing} in {d.project}</li>)}</ul></div>
          )}
          {result.errors.length > 0 && (
            <div><p className="label-cap mb-1">Errors</p>
              <ul className="space-y-0.5 text-[12.5px] text-[var(--negative)]">{result.errors.map((d: any) => <li key={d.line}>Line {d.line}: {d.message}</li>)}</ul></div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-[13px]" />
          <Field label="…or paste the CSV"><Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} className="mono text-[12px]"
            placeholder={'Company,Contact,Phone,Email,Source\nABC Technologies,Ramesh,9840012345,ramesh@abc.com,linkedin'} /></Field>
          <Field label="Assign rows without an assignee to">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Nobody</option>
              {team.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
            </Select>
          </Field>
        </div>
      )}
    </Modal>
  );
}

/* ============================================================ LEAD DRAWER */
function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: meta } = useMeta();
  const [tab, setTab] = useState('timeline');
  const [modal, setModal] = useState<string | null>(null);
  const { data: l, isLoading, error, refetch } = useQuery({
    queryKey: ['marketing-lead', id],
    queryFn: () => api.get(`/marketing/leads/${id}`).then((r) => r.data),
  });
  const status = useStatusChange(l || { id }, l?.project_id);

  if (error) return <Drawer open onClose={onClose} title="Lead"><div className="p-5"><ErrorState error={error} retry={refetch} /></div></Drawer>;
  if (isLoading || !l) return <Drawer open onClose={onClose} title="Loading…"><div className="p-5"><TableSkeleton rows={5} cols={2} /></div></Drawer>;
  const open = !['won', 'dead'].includes(l.status);

  return (
    <>
      <Drawer open onClose={onClose} width="max-w-3xl"
        title={`${l.is_progressive ? '⭐ ' : ''}${l.company_name}`}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <span className="text-muted">{l.project.name}</span>
          {l.status === 'dead' ? <Badge tone="negative">Dead</Badge> : l.status === 'won' ? <Badge tone="positive">Won</Badge> : null}
          <HealthBadge health={l.health} />
          {l.is_progressive && <Badge tone={PRIORITY_TONE[l.progressive_priority]}>{l.progressive_priority}</Badge>}
        </span> as any}
        footer={(
          <>
            {open && l.can_work && <Button variant="primary" icon={<Send size={15} />} onClick={() => setModal('update')}>Add update</Button>}
            {open && l.can_work && <Button icon={<Phone size={15} />} onClick={() => setModal('activity')}>Log activity</Button>}
            {open && l.can_steer && <Button icon={<Star size={15} />} onClick={() => setModal('star')}>{l.is_progressive ? 'Remove ⭐' : 'Mark ⭐'}</Button>}
            {open && l.can_work && !l.owner_action_required && <Button icon={<Crown size={15} />} onClick={() => setModal('owner')}>Owner action</Button>}
            {open && l.can_steer && <Button variant="ghost" icon={<Skull size={15} />} onClick={() => setModal('dead')}>Mark dead</Button>}
            {l.status === 'dead' && l.can_steer && <Button variant="primary" icon={<RotateCcw size={15} />} onClick={() => setModal('revive')}>Revive</Button>}
          </>
        )}>
        <div className="p-5 space-y-4">
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Box label="Status">
              {open && l.can_work ? (
                <Select value={l.status} className="h-8 text-[13px]" aria-label="Status"
                  onChange={(e) => (e.target.value === 'won' ? setModal('won') : status.mutate({ status: e.target.value }))}>
                  {meta?.statuses?.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </Select>
              ) : <span className="font-medium">{statusLabel(meta, l.status)}</span>}
            </Box>
            <Box label="Assigned">{l.assigned_name || 'Unassigned'}</Box>
            <Box label="Expected value">{money(l.expected_value_minor, { compact: true })}</Box>
            <Box label="Last activity">{relative(l.last_activity_at)}</Box>
          </div>

          <div className="rounded-lg border border-line p-3 grid gap-2 sm:grid-cols-2 text-[13px]">
            <p><span className="text-subtle">Next action: </span>{l.next_action || <span className="text-[var(--warning)]">Not recorded</span>}</p>
            <p><span className="text-subtle">Next follow-up: </span>{l.next_followup_date ? date(l.next_followup_date) : '—'}</p>
            {l.health && <p className="sm:col-span-2 text-subtle">{HEALTH_UI[l.health.id].dot} {l.health.why}</p>}
            {l.is_progressive && (
              <p className="sm:col-span-2"><span className="text-subtle">⭐ Why: </span>
                {l.progressive_reasons.map((r: string) => meta?.progressive_reasons?.find((x: any) => x.id === r)?.label || r).join(', ')}
                {l.progressive_note && ` - ${l.progressive_note}`}
                <span className="text-subtle"> · since {date(l.progressive_since)}</span>
              </p>
            )}
          </div>

          {l.owner_action_required && <OwnerActionBox lead={l} />}
          {l.status === 'dead' && l.dead_record && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--negative)_40%,transparent)] bg-negative-soft p-3 text-[13px]">
              <p className="font-medium text-[var(--negative)]">Dead · {meta?.dead_reasons?.find((r: any) => r.id === l.dead_record.reason_code)?.label}</p>
              {l.dead_record.reason_note && <p>{l.dead_record.reason_note}</p>}
              <p className="text-subtle text-[12px]">Marked by {l.dead_record.marked_by_name} on {date(l.dead_record.marked_at)} · was {statusLabel(meta, l.dead_record.status_at_death)}</p>
            </div>
          )}
          {l.converted_client_id && (
            <p className="text-[13px]"><a className="text-[var(--brand)] hover:underline" href={`/crm/${l.converted_client_id}`}>Open the CRM client →</a></p>
          )}

          <div className="border-b border-line">
            <Tabs active={tab} onChange={setTab} tabs={[
              { id: 'timeline', label: `Timeline (${l.timeline.length})` },
              { id: 'updates', label: `Daily updates (${l.updates.length})` },
              { id: 'details', label: 'Details' },
              { id: 'star', label: `⭐ History (${l.progressive_history.length})` },
            ]} />
          </div>
          {tab === 'timeline' && <Timeline items={l.timeline} />}
          {tab === 'updates' && <UpdatesList updates={l.updates} meta={meta} />}
          {tab === 'details' && <DetailsForm lead={l} />}
          {tab === 'star' && (
            l.progressive_history.length ? (
              <ul className="space-y-2">
                {l.progressive_history.map((h: any) => (
                  <li key={h.id} className="rounded-md border border-line p-2.5 text-[13px]">
                    <span className="font-medium">{{ enabled: '⭐ Added', disabled: '⭐ Removed', priority_changed: 'Priority changed', converted: '⭐ Converted', dead: '⭐ Closed - dead' }[h.action as string] || h.action}</span>
                    <span className="text-subtle"> · {dateTime(h.changed_at)} · {h.user_name || 'System'}</span>
                    {h.reason && <p className="text-muted">{h.reason}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-subtle">This lead has never been ⭐ progressive.</p>
          )}
        </div>
      </Drawer>

      {modal === 'update' && <UpdateModal lead={l} onClose={() => setModal(null)} />}
      {modal === 'activity' && <ActivityModal lead={l} onClose={() => setModal(null)} />}
      {modal === 'star' && <StarModal lead={l} projectId={l.project_id} onClose={() => setModal(null)} />}
      {modal === 'owner' && <OwnerActionModal lead={l} onClose={() => setModal(null)} />}
      {modal === 'dead' && <DeadModal lead={l} onClose={() => setModal(null)} />}
      {modal === 'revive' && <ReviveModal lead={l} onClose={() => setModal(null)} />}
      {modal === 'won' && <WonModal lead={l} projectId={l.project_id} onClose={() => setModal(null)} />}
    </>
  );
}

const Box = ({ label, children }: { label: string; children: any }) => (
  <div className="rounded-lg bg-sunken p-3 text-[13px]"><p className="label-cap mb-1">{label}</p>{children}</div>
);

function Timeline({ items }: { items: any[] }) {
  if (!items.length) return <p className="text-[13px] text-subtle">Nothing recorded yet.</p>;
  return (
    <ol className="space-y-0">
      {items.map((a) => {
        const Icon = EVENT_ICON[a.event_type] || Activity;
        return (
          <li key={a.id} className="flex gap-3 border-l border-line pl-4 pb-3 relative">
            <span className="absolute -left-[11px] top-0 grid h-[22px] w-[22px] place-items-center rounded-full bg-raised border border-line">
              <Icon size={11} className={a.event_type === 'marked_dead' ? 'text-[var(--negative)]' : 'text-muted'} />
            </span>
            <div className="min-w-0 text-[13px]">
              <p className="text-ink">{a.description || titleCase(a.event_type)}</p>
              <p className="text-[11.5px] text-subtle">{dateTime(a.created_at)} · {a.user_name || 'System'} · {titleCase(a.event_type)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function UpdatesList({ updates, meta }: { updates: any[]; meta: any }) {
  if (!updates.length) return <p className="text-[13px] text-subtle">No daily updates yet.</p>;
  return (
    <ul className="space-y-2">
      {updates.map((u) => (
        <li key={u.id} className="rounded-md border border-line p-3 text-[13px]">
          <p className="font-medium">{meta?.outcomes?.find((o: any) => o.id === u.outcome)?.label}
            <span className="text-subtle font-normal"> · {date(u.update_date)} · {u.user_name}</span></p>
          {u.progress_note && <p className="text-muted">{u.progress_note}</p>}
          {u.next_action && <p className="text-[12.5px]"><span className="text-subtle">Next: </span>{u.next_action}{u.next_followup_date && ` on ${date(u.next_followup_date)}`}</p>}
          {!!u.owner_action_required && <p className="text-[12.5px] text-[var(--negative)]">Owner action: {u.owner_action_text}</p>}
        </li>
      ))}
    </ul>
  );
}

function DetailsForm({ lead }: { lead: any }) {
  const { data: meta } = useMeta();
  const team = useTeam(lead.project_id);
  const toast = useToast();
  const invalidate = useInvalidate(lead.project_id);
  const [form, setForm] = useState<any>(() => ({ ...emptyLead, ...Object.fromEntries(Object.keys(emptyLead).map((k) => [k, lead[k] ?? ''])), expected_value: lead.expected_value_minor ? lead.expected_value_minor / 100 : '' }));
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () => { const { status: _s, ...rest } = toPayload(form) as any; return api.patch(`/marketing/leads/${lead.id}`, rest); },
    onSuccess: () => { toast.success('Lead updated. Changes are on the timeline.'); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const editable = lead.can_work && lead.status !== 'dead';
  return (
    <div className="space-y-3">
      <fieldset disabled={!editable}><LeadFields form={form} set={set} team={team} meta={meta} /></fieldset>
      {editable && <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></div>}
    </div>
  );
}

/* --------------------------------------------------------------- modals */
function useLeadAction(lead: any, onDone: () => void, success: string) {
  const toast = useToast();
  const invalidate = useInvalidate(lead.project_id);
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: any }) => api.post(`/marketing/leads/${lead.id}${path}`, body),
    onSuccess: () => { toast.success(success); invalidate(); onDone(); },
    onError: (e: any) => toast.error(e.message),
  });
}

function UpdateModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { data: meta } = useMeta();
  const [f, setF] = useState<any>({
    outcome: 'follow_up_done', progress_note: '', next_action: lead.next_action || '', next_followup_date: plusDays(2),
    owner_action_required: false, owner_action_text: '', owner_action_due: plusDays(1), owner_action_priority: 'normal',
  });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const act = useLeadAction(lead, onClose, 'Update saved. Status, next action and timeline are up to date.');
  const closing = f.outcome === 'converted';
  const valid = (f.outcome === 'no_response' || f.progress_note.trim()) && (closing || (f.next_action.trim() && f.next_followup_date))
    && (!f.owner_action_required || f.owner_action_text.trim());
  return (
    <Modal open onClose={onClose} title={`Today's update · ${lead.company_name}${lead.is_progressive ? ' ⭐' : ''}`} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Send size={15} />} disabled={!valid} loading={act.isPending}
          onClick={() => act.mutate({ path: '/updates', body: { ...f, owner_action_text: f.owner_action_required ? f.owner_action_text : null } })}>Save update</Button></>}>
      <div className="space-y-4">
        <Field label="What happened today?" required>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {meta?.outcomes?.map((o: any) => (
              <button key={o.id} type="button" onClick={() => set('outcome', o.id)}
                className={cx('rounded-md border px-2.5 py-1.5 text-left text-[12.5px] cursor-pointer', f.outcome === o.id ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]' : 'border-line text-muted hover:border-line-strong')}>
                {o.label}{o.moves_to && <span className="block text-[10.5px] opacity-70">→ {titleCase(o.moves_to)}</span>}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Progress / update" required={f.outcome !== 'no_response'}>
          <Textarea rows={2} value={f.progress_note} onChange={(e) => set('progress_note', e.target.value)} placeholder="Client requested revised pricing" />
        </Field>
        {!closing && (
          <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
            <Field label="Next action" required><Input value={f.next_action} onChange={(e) => set('next_action', e.target.value)} placeholder="Send revised quotation" /></Field>
            <Field label="Next follow-up" required><Input type="date" value={f.next_followup_date} onChange={(e) => set('next_followup_date', e.target.value)} /></Field>
          </div>
        )}
        <div className="rounded-lg border border-line p-3 space-y-3">
          <Checkbox label="Owner action required" checked={f.owner_action_required} onChange={(v) => set('owner_action_required', v)} />
          {f.owner_action_required && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Action required" required className="sm:col-span-3"><Input value={f.owner_action_text} onChange={(e) => set('owner_action_text', e.target.value)} placeholder="Approve revised quotation" /></Field>
              <Field label="Required by"><Input type="date" value={f.owner_action_due} onChange={(e) => set('owner_action_due', e.target.value)} /></Field>
              <Field label="Priority">
                <Select value={f.owner_action_priority} onChange={(e) => set('owner_action_priority', e.target.value)}>
                  {['critical', 'high', 'normal'].map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}
                </Select>
              </Field>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ActivityModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const [type, setType] = useState('call');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState('connected');
  const act = useLeadAction(lead, onClose, 'Activity logged.');
  return (
    <Modal open onClose={onClose} title={`Log activity · ${lead.company_name}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!description.trim()} loading={act.isPending}
          onClick={() => act.mutate({ path: '/activities', body: { type, description, outcome: type === 'note' ? null : outcome } })}>Log it</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {[['call', Phone], ['email', Mail], ['whatsapp', MessageCircle], ['meeting', CalendarCheck], ['note', StickyNote]].map(([t, Icon]: any) => (
            <button key={t} type="button" onClick={() => setType(t)}
              className={cx('flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] cursor-pointer', type === t ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]' : 'border-line text-muted')}>
              <Icon size={14} /> {titleCase(t)}
            </button>
          ))}
        </div>
        <Field label="What happened" required><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {type !== 'note' && (
          <Field label="Outcome">
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {['connected', 'no_response', 'positive', 'negative'].map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function OwnerActionModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const [text, setText] = useState('');
  const [due, setDue] = useState(plusDays(1));
  const [priority, setPriority] = useState('high');
  const act = useLeadAction(lead, onClose, 'The project owners have been told.');
  return (
    <Modal open onClose={onClose} title={`Owner action · ${lead.company_name}`} subtitle="Goes straight to the project's owners"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={text.trim().length < 2} loading={act.isPending}
          onClick={() => act.mutate({ path: '/owner-action', body: { owner_action_text: text, owner_action_due: due, owner_action_priority: priority } })}>Raise</Button></>}>
      <div className="space-y-3">
        <Field label="Action required" required><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Join the client meeting" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Required by"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{['critical', 'high', 'normal'].map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}</Select></Field>
        </div>
      </div>
    </Modal>
  );
}

function OwnerActionBox({ lead }: { lead: any }) {
  const [note, setNote] = useState('');
  const act = useLeadAction(lead, () => setNote(''), 'Owner action closed.');
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--negative)_40%,transparent)] p-3 text-[13px] space-y-2">
      <p className="font-medium"><Crown size={13} className="inline -mt-0.5 mr-1" />Owner action: {lead.owner_action_text}</p>
      <p className="text-subtle text-[12px]">{lead.owner_action_priority} · due {lead.owner_action_due ? date(lead.owner_action_due) : '—'} · raised {relative(lead.owner_action_raised_at)}</p>
      {lead.can_work && (
        <div className="flex gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was decided (optional)" className="flex-1" />
          <Button loading={act.isPending} icon={<CheckCircle2 size={15} />} onClick={() => act.mutate({ path: '/owner-action/resolve', body: { note: note || null } })}>Mark done</Button>
        </div>
      )}
    </div>
  );
}

function DeadModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { data: meta } = useMeta();
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const act = useLeadAction(lead, onClose, 'Marked dead and recorded in the dead lead register.');
  return (
    <Modal open onClose={onClose} title={`Mark ${lead.company_name} dead`}
      subtitle="It leaves the live pipeline and is kept in Dead leads with its full history. It can be revived later."
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={!code || (code === 'other' && !note.trim())} loading={act.isPending}
          onClick={() => act.mutate({ path: '/dead', body: { reason_code: code, note: note || null } })}>Mark dead</Button></>}>
      <div className="space-y-3">
        <Field label="Reason" required>
          <Select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose…</option>
            {meta?.dead_reasons?.map((r: any) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Note" required={code === 'other'}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Five follow-ups over three weeks, no reply" /></Field>
      </div>
    </Modal>
  );
}

function ReviveModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const [note, setNote] = useState('');
  const act = useLeadAction(lead, onClose, 'Lead revived.');
  return (
    <Modal open onClose={onClose} title={`Revive ${lead.company_name}`} subtitle="It returns to the status it had when it died"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={note.trim().length < 2} loading={act.isPending} onClick={() => act.mutate({ path: '/revive', body: { note } })}>Revive</Button></>}>
      <Field label="Why is it back?" required><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="They replied and asked for a call" /></Field>
    </Modal>
  );
}

/* ============================================================== TABS */
function AttentionTab({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['marketing-attention'], queryFn: () => api.get('/marketing/owner-attention').then((r) => r.data) });
  const rows = (data ?? []).filter((l: any) => l.project_id === projectId);
  if (isLoading) return <Card><TableSkeleton cols={4} /></Card>;
  if (!rows.length) return <Card><EmptyState icon={<Crown size={20} />} title="Nothing waiting on an owner" message="Owner actions raised from a lead's daily update or drawer appear here, worst first." /></Card>;
  return (
    <Card>
      <CardHeader title="Owner attention required" subtitle="Critical first, then by due date" />
      <div className="divide-y divide-[var(--line)]">
        {rows.map((l: any) => (
          <button key={l.id} onClick={() => onOpen(l.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer hover:bg-sunken">
            <span>{l.owner_action_priority === 'critical' ? '🔴' : l.owner_action_priority === 'high' ? '🟠' : '🟡'}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{l.is_progressive ? '⭐ ' : ''}{l.company_name}</span>
              <span className="block text-[12.5px] text-muted">Action: {l.owner_action_text}</span>
            </span>
            <span className={cx('text-[12px] shrink-0', l.owner_action_due && l.owner_action_due < today() ? 'text-[var(--negative)]' : 'text-subtle')}>
              {l.owner_action_due ? `due ${date(l.owner_action_due)}` : 'no date'} · {l.assigned_name || 'Unassigned'}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function ActivityTab({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['marketing-activity', projectId], queryFn: () => api.get(`/marketing/projects/${projectId}/activities`).then((r) => r.data) });
  if (isLoading) return <Card><TableSkeleton cols={3} /></Card>;
  if (!data?.length) return <Card><EmptyState icon={<Activity size={20} />} title="No activity yet" message="Everything that happens to any lead on this project shows here." /></Card>;
  return (
    <Card>
      <CardHeader title="Every lead, everything that happened" subtitle="Newest first" />
      <div className="divide-y divide-[var(--line)]">
        {data.map((a: any) => {
          const Icon = EVENT_ICON[a.event_type] || Activity;
          return (
            <button key={a.id} onClick={() => onOpen(a.lead_id)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left cursor-pointer hover:bg-sunken">
              <Icon size={14} className="mt-0.5 text-muted shrink-0" />
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="font-medium text-ink">{a.is_progressive ? '⭐ ' : ''}{a.company_name}</span>
                <span className="text-muted"> - {a.description || titleCase(a.event_type)}</span>
              </span>
              <span className="text-[11.5px] text-subtle shrink-0">{a.user_name || 'System'} · {relative(a.created_at)}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function DeadTab({ projectId, perms, onOpen }: { projectId: string; perms: any; onOpen: (id: string) => void }) {
  const { data: meta } = useMeta();
  const [revived, setRevived] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['marketing-dead', projectId, revived],
    queryFn: () => api.get(`/marketing/projects/${projectId}/dead-leads`, { include_revived: revived ? 'true' : undefined }).then((r) => r.data),
  });
  const byReason = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of data ?? []) if (!d.revived_at) m[d.reason_label] = (m[d.reason_label] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-3 p-3">
          <Checkbox label="Show revived leads too" checked={revived} onChange={setRevived} />
          {byReason.length > 0 && (
            <span className="flex flex-wrap gap-1.5 text-[12px] text-subtle">
              Why leads die: {byReason.map(([r, n]) => <Badge key={r} tone="neutral">{r} · {n}</Badge>)}
            </span>
          )}
        </div>
      </Card>
      {isLoading ? <Card><TableSkeleton cols={5} /></Card>
        : !data?.length ? <Card><EmptyState icon={<Skull size={20} />} title="No dead leads" message={perms.can_steer ? 'Mark a lead dead from its drawer when it is given up on - the reason is recorded here.' : 'Leads the project manager or lead gives up on are recorded here with the reason.'} /></Card>
          : (
            <Card>
              <Table>
                <THead><tr><TH>Lead</TH><TH>Reason</TH><TH width="120px">Was</TH><TH width="150px">Marked</TH><TH width="140px">Assigned</TH><TH width="120px"> </TH></tr></THead>
                <tbody>
                  {data.map((d: any) => (
                    <TR key={d.id} onClick={() => onOpen(d.lead_id)}>
                      <TD><span className="font-medium">{d.was_progressive ? '⭐ ' : ''}{d.company_name}</span>
                        {d.contact_name && <span className="block text-[12px] text-subtle">{d.contact_name}</span>}</TD>
                      <TD><span className="text-[13px]">{d.reason_label}</span>{d.reason_note && <span className="block text-[12px] text-subtle">{d.reason_note}</span>}</TD>
                      <TD><Badge tone="neutral">{statusLabel(meta, d.status_at_death)}</Badge></TD>
                      <TD><span className="text-[12.5px]">{date(d.marked_at)}</span><span className="block text-[11.5px] text-subtle">{d.marked_by_name}</span></TD>
                      <TD><span className="text-[12.5px] text-muted">{d.assigned_name || '—'}</span></TD>
                      <TD>{d.revived_at ? <Badge tone="positive">Revived {date(d.revived_at)}</Badge> : <Badge tone="negative">Dead</Badge>}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
    </div>
  );
}

function ReportsTab({ projectId, perms }: { projectId: string; perms: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: meta } = useMeta();
  const { data, isLoading } = useQuery({ queryKey: ['marketing-reports', projectId], queryFn: () => api.get(`/marketing/projects/${projectId}/reports`).then((r) => r.data) });
  const gen = useMutation({
    mutationFn: (kind: string) => api.post(`/marketing/projects/${projectId}/reports`, { kind }),
    onSuccess: (r: any) => { toast.success('Report generated.'); qc.invalidateQueries({ queryKey: ['marketing-reports', projectId] }); navigate(`/reports/${r.data.id}`); },
    onError: (e: any) => toast.error(e.message),
  });
  const s = meta?.settings;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return (
    <Card>
      <CardHeader title="Marketing reports" icon={<FileBarChart size={16} />}
        subtitle={s ? `Daily at ${s.daily_report_time} · weekly on ${days[s.weekly_report_day]} at ${s.weekly_report_time} · sent to the project's owners, manager and lead` : undefined}
        action={perms.can_work && (
          <span className="flex gap-2">
            <Button size="sm" loading={gen.isPending && gen.variables === 'marketing_daily'} onClick={() => gen.mutate('marketing_daily')}>Generate daily now</Button>
            <Button size="sm" loading={gen.isPending && gen.variables === 'marketing_weekly'} onClick={() => gen.mutate('marketing_weekly')}>Generate weekly now</Button>
          </span>
        )} />
      {isLoading ? <TableSkeleton cols={3} />
        : !data?.length ? <EmptyState compact icon={<FileBarChart size={18} />} title="No reports yet" message="The first daily report arrives at the time set in Settings." />
          : (
            <Table>
              <THead><tr><TH>Report</TH><TH width="200px">Period</TH><TH width="170px">Generated</TH></tr></THead>
              <tbody>
                {data.map((r: any) => (
                  <TR key={r.id} onClick={() => navigate(`/reports/${r.id}`)}>
                    <TD><span className="font-medium">{r.kind === 'marketing_daily' ? 'Daily update' : 'Weekly report'}</span></TD>
                    <TD><span className="text-[12.5px]">{r.period_start === r.period_end ? date(r.period_start) : `${date(r.period_start)} – ${date(r.period_end)}`}</span></TD>
                    <TD><span className="text-[12.5px] text-subtle">{dateTime(r.generated_at)}</span></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
    </Card>
  );
}

function SettingsTab() {
  const { data: meta } = useMeta();
  if (!meta) return <Card><TableSkeleton rows={4} cols={2} /></Card>;
  return <SettingsForm meta={meta} />;
}

function SettingsForm({ meta }: { meta: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<any>(meta.settings);
  const set = (k: string, v: any) => setS((x: any) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.put('/marketing/settings', s),
    onSuccess: () => { toast.success('Marketing settings saved.'); qc.invalidateQueries({ queryKey: ['marketing-meta'] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const num = (k: string) => <Input type="number" min={1} max={60} value={s[k]} onChange={(e) => set(k, Number(e.target.value))} className="w-24" />;
  const time = (k: string) => <Input type="time" value={s[k]} onChange={(e) => set(k, e.target.value)} className="w-32" />;
  return (
    <Card>
      <CardHeader title="Marketing settings" icon={<Settings2 size={16} />} subtitle="Apply to every marketing project in the workspace. Times are the workspace's own clock." />
      <div className="grid gap-5 p-4 pt-0 md:grid-cols-2">
        <section className="space-y-3">
          <p className="label-cap">⭐ escalation ladder (working days without activity)</p>
          <Field label="Remind the assignee after" hint="Follow-up pending">{num('remind_after_days')}</Field>
          <Field label="Warn the assignee after" hint="Inactive warning">{num('warn_after_days')}</Field>
          <Field label="Stalled after" hint="Health turns 🔴; the project manager and lead are told">{num('stalled_days')}</Field>
          <Field label="Escalate to project owners after" hint="Owners told and an escalation raised">{num('escalate_after_days')}</Field>
        </section>
        <section className="space-y-3">
          <p className="label-cap">Times</p>
          <Field label="Daily ⭐ watch">{time('watch_time')}</Field>
          <Field label="Missing-update reminder">{time('update_reminder_time')}</Field>
          <Field label="Daily marketing report">{time('daily_report_time')}</Field>
          <Field label="Weekly report">
            <div className="flex gap-2">
              <Select value={s.weekly_report_day} onChange={(e) => set('weekly_report_day', Number(e.target.value))} className="w-36">
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
              {time('weekly_report_time')}
            </div>
          </Field>
        </section>
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-3">
        <Button onClick={() => setS(meta.defaults)}>Reset to defaults</Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
      </div>
    </Card>
  );
}

