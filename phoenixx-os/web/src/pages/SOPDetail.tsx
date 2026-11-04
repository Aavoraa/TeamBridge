import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Check, History, Play, Send, RotateCcw, BookOpenCheck, ClipboardCheck, Pencil, Users2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, relative, percent, titleCase } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Meter,
  Modal, PageHeader, Select, Skeleton, StatusBadge, Table, TD, TH, THead, TR, Tabs, Textarea,
  useToast, cx,
} from '../components/ui';

/** A single SOP: content, checklist, version history and its runs. */
export default function SOPDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState('content');
  const [version, setVersion] = useState<number | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  const { data: sop, isLoading, error, refetch } = useQuery({
    queryKey: ['sop', id, version],
    queryFn: () => api.get(`/sop/${id}`, version ? { version } : undefined).then((r) => r.data),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sop', id] });
    qc.invalidateQueries({ queryKey: ['sops'] });
  };

  const acknowledge = useMutation({
    mutationFn: () => api.post(`/sop/${id}/acknowledge`),
    onSuccess: () => { toast.success('Acknowledged. Thanks for reading it.'); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  const publish = useMutation({
    mutationFn: () => api.post(`/sop/${id}/publish`),
    onSuccess: () => {
      toast.success('Published. The team has been notified to acknowledge it.');
      invalidate(); setPublishOpen(false); setVersion(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const restore = useMutation({
    mutationFn: (v: number) => api.post(`/sop/${id}/versions/${v}/restore`),
    onSuccess: () => { toast.success('Copied into a new draft version.'); invalidate(); setVersion(null); },
    onError: (e: any) => toast.error(e.message),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !sop) return <SopSkeleton />;

  const hasDraft = sop.versions?.some((v: any) => v.status === 'draft');
  const viewing = sop.version;
  const isCurrentVersion = !version || version === sop.current_version;

  return (
    <>
      <button onClick={() => navigate('/sop')}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-subtle hover:text-ink transition-colors cursor-pointer">
        <ArrowLeft size={14} /> Back to library
      </button>

      <PageHeader
        title={sop.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={sop.status} />
            {sop.code && <span className="mono text-subtle">{sop.code}</span>}
            {sop.service_line_name && (
              <Badge tone="neutral">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: sop.service_line_color }} aria-hidden />
                {sop.service_line_name}
              </Badge>
            )}
            <Badge tone="neutral">{titleCase(sop.workflow)}</Badge>
            <span className="text-subtle">· owned by {sop.owner_name || 'unassigned'}</span>
          </span>
        }
        actions={
          <>
            {sop.status === 'published' && (
              <Button icon={<Play size={15} />} onClick={() => setRunOpen(true)}>Start a run</Button>
            )}
            {can('sop', 'edit') && (
              <Button icon={<Pencil size={15} />} onClick={() => setEditOpen(true)}>
                {hasDraft ? 'Edit draft' : 'New version'}
              </Button>
            )}
            {can('sop', 'approve') && hasDraft && (
              <Button variant="primary" icon={<Send size={15} />} onClick={() => setPublishOpen(true)}>Publish</Button>
            )}
            {sop.status === 'published' && !sop.acknowledged && isCurrentVersion && (
              <Button variant="accent" icon={<Check size={15} />} loading={acknowledge.isPending}
                onClick={() => acknowledge.mutate()}>I have read this</Button>
            )}
            {sop.acknowledged && isCurrentVersion && (
              <Badge tone="positive" dot>acknowledged</Badge>
            )}
          </>
        }
      />

      {!isCurrentVersion && (
        <Card className="mb-4 border-l-4 border-l-[var(--warning)]">
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <History size={15} className="text-[var(--warning)]" />
            <p className="text-[13.5px] text-ink">
              Viewing version {version}, not the current v{sop.current_version}.
            </p>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => setVersion(null)}>View current</Button>
              {can('sop', 'edit') && (
                <Button size="sm" icon={<RotateCcw size={13} />} loading={restore.isPending}
                  onClick={() => restore.mutate(version!)}>Restore as draft</Button>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_290px]">
        <Card className="min-w-0">
          <Tabs active={tab} onChange={setTab} className="px-2"
            tabs={[
              { id: 'content', label: 'Procedure' },
              { id: 'checklist', label: 'Checklist', count: viewing?.checklist?.length },
              { id: 'runs', label: 'Runs' },
            ]} />

          {tab === 'content' && (
            <div className="p-5">
              {!viewing?.content ? (
                <EmptyState compact title="No content yet" message="Add the procedure so the team knows what to follow." />
              ) : (
                <article className="prose-sop">{renderMarkdown(viewing.content)}</article>
              )}
            </div>
          )}

          {tab === 'checklist' && (
            <div className="p-5">
              {!viewing?.checklist?.length ? (
                <EmptyState compact title="No checklist"
                  message="A checklist is what makes adherence measurable — add the steps that must be ticked." />
              ) : (
                <ol className="space-y-2">
                  {viewing.checklist.map((c: any, i: number) => (
                    <li key={c.id} className="flex items-start gap-3 rounded-lg border border-line p-3">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sunken text-[12px] font-semibold text-muted tabular">
                        {i + 1}
                      </span>
                      <span className="text-[13.5px] text-ink leading-snug pt-0.5">{c.text}</span>
                      {c.required && <Badge tone="neutral" className="ml-auto shrink-0">required</Badge>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {tab === 'runs' && <RunsTab sopId={id!} />}
        </Card>

        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader title="Version history" icon={<History size={16} />} />
            <ul className="divide-y divide-[var(--border)]">
              {sop.versions?.map((v: any) => (
                <li key={v.version}>
                  <button onClick={() => setVersion(v.version === sop.current_version ? null : v.version)}
                    className={cx('w-full text-left px-4 py-2.5 row-hover cursor-pointer',
                      (version || sop.current_version) === v.version && 'bg-brand-soft')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-ink">Version {v.version}</span>
                      <span className="flex items-center gap-1.5">
                        {v.version === sop.current_version && <Badge tone="positive">current</Badge>}
                        {v.status === 'draft' && <Badge tone="accent">draft</Badge>}
                      </span>
                    </div>
                    {v.change_note && <p className="mt-0.5 text-[12px] text-subtle leading-snug">{v.change_note}</p>}
                    <p className="mt-0.5 text-[11.5px] text-subtle">
                      {v.created_by_name || 'system'} · {relative(v.published_at || v.created_at)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Acknowledgements" icon={<Users2 size={16} />}
              subtitle={`${sop.acknowledgements?.length || 0} people have read v${sop.current_version}`} />
            {!sop.acknowledgements?.length ? (
              <EmptyState compact title="Nobody yet" message="Published SOPs ask the team to acknowledge them." />
            ) : (
              <ul className="p-3 space-y-2 max-h-64 overflow-y-auto">
                {sop.acknowledgements.map((a: any) => (
                  <li key={a.id} className="flex items-center gap-2.5">
                    <Avatar name={a.name} url={a.avatar_url} size={24} />
                    <span className="text-[13px] text-ink flex-1 truncate">{a.name}</span>
                    <span className="text-[11.5px] text-subtle shrink-0">{relative(a.acknowledged_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {editOpen && <EditVersionModal sop={sop} onClose={() => setEditOpen(false)} onSaved={invalidate} />}
      {runOpen && <StartRunModal sopId={id!} onClose={() => setRunOpen(false)} />}

      <ConfirmDialog open={publishOpen} onClose={() => setPublishOpen(false)}
        onConfirm={() => publish.mutate()} loading={publish.isPending}
        title="Publish this version?" confirmLabel="Publish"
        message="The draft becomes the live version. Everyone is asked to acknowledge it again, and adherence is measured against this checklist from now on." />
    </>
  );
}

/* ------------------------------------------------------------------ runs */
function RunsTab({ sopId }: { sopId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sop-runs', sopId],
    queryFn: () => api.get(`/sop/${sopId}/runs`).then((r) => r.data),
  });

  const update = useMutation({
    mutationFn: ({ runId, state }: { runId: string; state: any }) =>
      api.patch(`/sop/runs/${runId}`, { checklist_state: state }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sop-runs', sopId] });
      qc.invalidateQueries({ queryKey: ['sop-adherence'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const { data: sop } = useQuery({
    queryKey: ['sop', sopId, null],
    queryFn: () => api.get(`/sop/${sopId}`).then((r) => r.data),
  });

  if (isLoading) return <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (!data?.length) {
    return <EmptyState icon={<ClipboardCheck size={20} />} title="No runs yet"
      message="Start a run when you follow this SOP — ticking the checklist is what produces the adherence number." />;
  }

  return (
    <div className="p-4 space-y-2">
      {data.map((r: any) => (
        <div key={r.id} className="rounded-lg border border-line">
          <button onClick={() => setExpanded(expanded === r.id ? null : r.id)}
            className="w-full flex flex-wrap items-center gap-3 p-3 text-left cursor-pointer row-hover rounded-lg">
            <span className="flex items-center gap-2 min-w-0">
              <Avatar name={r.user_name} size={24} />
              <span className="text-[13px] text-ink truncate">{r.user_name || 'Unknown'}</span>
            </span>
            <span className="text-[12.5px] text-subtle">{relative(r.started_at)} · v{r.version}</span>
            <span className="ml-auto flex items-center gap-2 shrink-0">
              <Meter value={r.adherence_pct}
                tone={r.adherence_pct >= 90 ? 'positive' : r.adherence_pct >= 70 ? 'warning' : 'negative'}
                className="w-20" />
              <span className="tabular text-[13px] font-medium w-14 text-right">
                {r.completed_items}/{r.total_items}
              </span>
              {r.completed_at && <Badge tone="positive">complete</Badge>}
            </span>
          </button>

          {expanded === r.id && sop?.version?.checklist && (
            <ul className="border-t border-line p-3 space-y-1.5">
              {sop.version.checklist.map((c: any) => {
                const checked = !!r.checklist_state?.[c.id];
                return (
                  <li key={c.id}>
                    <label className="flex items-start gap-2.5 text-[13px] cursor-pointer py-1">
                      <input type="checkbox" checked={checked}
                        onChange={(e) => update.mutate({
                          runId: r.id,
                          state: { ...r.checklist_state, [c.id]: e.target.checked },
                        })}
                        className="mt-0.5 h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                      <span className={checked ? 'text-subtle line-through' : 'text-ink'}>{c.text}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function StartRunModal({ sopId, onClose }: { sopId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [clientId, setClientId] = useState('');

  const { data: clients } = useQuery({
    queryKey: ['clients-for-run'],
    queryFn: () => api.get('/crm/clients', { limit: 200 }).then((r) => r.data).catch(() => []),
  });

  const start = useMutation({
    mutationFn: () => api.post(`/sop/${sopId}/runs`, {
      entity: clientId ? 'client' : null,
      entity_id: clientId || null,
    }),
    onSuccess: () => {
      toast.success('Run started. Tick each step as you complete it.');
      qc.invalidateQueries({ queryKey: ['sop-runs', sopId] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Start an SOP run" size="sm"
      subtitle="Ticking the checklist as you go is what produces the adherence number"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Start run</Button>
        </>
      }>
      <Field label="Against which client" hint="Optional — for internal SOPs leave this blank">
        <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">No client (internal)</option>
          {clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}

function EditVersionModal({ sop, onClose, onSaved }: { sop: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [content, setContent] = useState(sop.version?.content || '');
  const [checklist, setChecklist] = useState(
    (sop.version?.checklist || []).map((c: any) => c.text).join('\n'),
  );
  const [changeNote, setChangeNote] = useState('');

  const save = useMutation({
    mutationFn: () => api.post(`/sop/${sop.id}/versions`, {
      content,
      checklist: checklist.split('\n').map((t: string) => t.trim()).filter(Boolean)
        .map((text: string, i: number) => ({ id: `c${i + 1}`, text, required: true })),
      change_note: changeNote || null,
    }),
    onSuccess: () => {
      toast.success('Draft saved. Publish it when you are ready.');
      onSaved();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Edit the draft version" size="xl"
      subtitle="The published version stays live until you publish this draft"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save draft</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="What changed" hint="Shown in the version history">
          <Textarea value={changeNote} onChange={(e) => setChangeNote(e.target.value)} rows={2}
            placeholder="Added the four-hour acknowledgement SLA and the root-cause step." />
        </Field>
        <Field label="Procedure" hint="Markdown: ## headings, numbered steps, - bullets">
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} className="mono text-[12.5px]" />
        </Field>
        <Field label="Checklist" hint="One item per line — adherence is measured against these">
          <Textarea value={checklist} onChange={(e) => setChecklist(e.target.value)} rows={7} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- markdown-lite */
/** Renders the small markdown subset SOP content uses, without a dependency. */
function renderMarkdown(src: string) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;

  const flush = (key: string) => {
    if (!list.length) return;
    const Tag = ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={key} className={cx('my-2.5 space-y-1.5 pl-1', ordered ? 'list-none' : 'list-none')}>
        {list.map((item, i) => (
          <li key={i} className="flex gap-2.5 text-[13.5px] text-muted leading-relaxed">
            <span className={cx('shrink-0 mt-[3px]', ordered ? 'tabular text-[var(--brand)] font-semibold w-4' : 'w-4')}>
              {ordered ? `${i + 1}.` : <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)] mt-1.5" />}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </Tag>,
    );
    list = [];
  };

  src.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flush(`l${i}`); return; }

    if (line.startsWith('## ')) {
      flush(`l${i}`);
      blocks.push(<h2 key={i} className="mt-5 first:mt-0 mb-1.5 text-[15px] font-semibold text-ink">{line.slice(3)}</h2>);
      return;
    }
    if (line.startsWith('# ')) {
      flush(`l${i}`);
      blocks.push(<h1 key={i} className="mt-5 first:mt-0 mb-2 text-[17px] font-semibold text-ink">{line.slice(2)}</h1>);
      return;
    }
    const num = line.match(/^(\d+)\.\s+(.*)$/);
    if (num) {
      if (!ordered) flush(`l${i}`);
      ordered = true;
      list.push(num[2]);
      return;
    }
    if (line.startsWith('- ')) {
      if (ordered) flush(`l${i}`);
      ordered = false;
      list.push(line.slice(2));
      return;
    }
    flush(`l${i}`);
    blocks.push(<p key={i} className="my-2 text-[13.5px] text-muted leading-relaxed">{line}</p>);
  });
  flush('last');

  return <>{blocks}</>;
}

function SopSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-4 w-28 mb-4" />
      <Skeleton className="h-8 w-72 mb-2" />
      <Skeleton className="h-4 w-64 mb-5" />
      <div className="grid gap-5 lg:grid-cols-[1fr_290px]">
        <Skeleton className="h-96" />
        <div className="space-y-4"><Skeleton className="h-56" /><Skeleton className="h-44" /></div>
      </div>
    </div>
  );
}
