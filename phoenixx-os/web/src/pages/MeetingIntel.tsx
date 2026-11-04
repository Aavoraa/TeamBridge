import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, AudioLines, Check, CheckCircle2, ChevronDown, Clock, FileText, Loader2, Pencil,
  RotateCcw, ShieldCheck, Sparkles, Upload, UserRound, X, XCircle,
} from 'lucide-react';
import { api, ApiError, request } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date as fmtDate, dateTime } from '../lib/format';
import { CHUNK_BYTES, prepareRecording, sha256 } from '../lib/meetingAudio';
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Meter, Modal,
  PageHeader, Select, Skeleton, Tabs, Textarea, cx, useToast,
} from '../components/ui';

/**
 * AI Meeting Intelligence: upload a recording or transcript, let the AI
 * propose tasks, approve the ones that are right. Nothing is created or
 * assigned until a person approves it here.
 */

type Tab = 'upload' | 'processing' | 'pending' | 'history';
const PROCESSING = ['uploading', 'queued', 'transcribing', 'analyzing'];

const STATUS: Record<string, { label: string; tone: any }> = {
  uploading: { label: 'Uploading', tone: 'info' },
  queued: { label: 'Queued', tone: 'info' },
  transcribing: { label: 'Transcribing', tone: 'info' },
  analyzing: { label: 'Analysing', tone: 'info' },
  review: { label: 'Awaiting approval', tone: 'warning' },
  completed: { label: 'Completed', tone: 'positive' },
  failed: { label: 'Failed', tone: 'negative' },
};

const clock = (s?: number | null) => {
  if (s == null) return '';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};
const size = (b?: number | null) => (!b ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export default function MeetingIntel() {
  const { id } = useParams();
  return id ? <MeetingReview id={id} /> : <MeetingHome />;
}

// ======================================================================= home
function MeetingHome() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'upload';
  const { can } = useAuth();
  const canUpload = can('meeting_intelligence', 'create');

  const processing = useQuery({
    queryKey: ['meeting-intel', 'list', 'processing'],
    queryFn: () => api.get<any[]>('/meeting-intel', { tab: 'processing' }).then((r) => r.data),
    refetchInterval: (q) => ((q.state.data || []).some((m: any) => PROCESSING.includes(m.status)) ? 5000 : false),
  });
  const pending = useQuery({
    queryKey: ['meeting-intel', 'list', 'pending'],
    queryFn: () => api.get<any[]>('/meeting-intel', { tab: 'pending' }).then((r) => r.data),
  });

  // While someone watches this tab, keep the oldest in-progress meeting moving.
  useEffect(() => {
    if (tab !== 'processing') return;
    const live = (processing.data || []).filter((m: any) => ['queued', 'transcribing', 'analyzing'].includes(m.status));
    if (!live.length) return;
    api.post(`/meeting-intel/${live[0].id}/advance`).then(() => processing.refetch()).catch(() => {});
  }, [tab, processing.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = [
    ...(canUpload ? [{ id: 'upload', label: 'Upload meeting', icon: <Upload size={14} /> }] : []),
    { id: 'processing', label: 'Processing', count: processing.data?.filter((m: any) => m.status !== 'failed').length },
    { id: 'pending', label: 'Pending approvals', count: pending.data?.length },
    { id: 'history', label: 'Meeting history' },
  ];

  return (
    <div>
      <PageHeader
        title="AI Meeting Intelligence"
        subtitle="Upload a meeting recording or transcript. The AI proposes tasks; nothing is assigned until you approve it."
        tabs={<Tabs tabs={tabs} active={canUpload ? tab : (tab === 'upload' ? 'pending' : tab)} onChange={(t) => setParams({ tab: t })} />}
      />
      {tab === 'upload' && canUpload && <UploadPanel />}
      {tab === 'processing' && <MeetingList q={processing} empty="Nothing is processing." hint="Uploads appear here while they are transcribed and analysed." />}
      {(tab === 'pending' || (tab === 'upload' && !canUpload)) && <MeetingList q={pending} empty="No meetings are waiting for approval." hint="Analysed meetings appear here for review." />}
      {tab === 'history' && <History />}
    </div>
  );
}

function History() {
  const q = useQuery({
    queryKey: ['meeting-intel', 'list', 'history'],
    queryFn: () => api.get<any[]>('/meeting-intel', { tab: 'history' }).then((r) => r.data),
  });
  return <MeetingList q={q} empty="No meetings yet." hint="Every uploaded meeting is kept here with its transcript and tasks." full />;
}

function MeetingList({ q, empty, hint, full }: { q: any; empty: string; hint: string; full?: boolean }) {
  const navigate = useNavigate();
  if (q.isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data?.length) return <Card><EmptyState icon={<AudioLines size={20} />} title={empty} message={hint} /></Card>;
  return (
    <Card className="divide-y divide-line">
      {q.data.map((m: any) => (
        <button key={m.id} type="button" onClick={() => navigate(`/meeting-intel/${m.id}`)}
          className="w-full text-left px-4 py-3 hover:bg-sunken transition-colors cursor-pointer flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {m.source_kind !== 'transcript' ? <AudioLines size={15} className="text-subtle" /> : <FileText size={15} className="text-subtle" />}
              <span className="font-medium text-ink truncate">{m.title}</span>
              <Badge tone={STATUS[m.status]?.tone}>{STATUS[m.status]?.label || m.status}</Badge>
            </div>
            <p className="mt-0.5 text-[12.5px] text-subtle">
              {m.meeting_date ? `Meeting ${fmtDate(m.meeting_date)} · ` : ''}{m.source_kind === 'live' ? 'Recorded in AI Meetings' : 'Uploaded'} {dateTime(m.created_at)} by {m.uploaded_by_name}
              {m.project_name ? ` · ${m.project_name}` : m.client_name ? ` · ${m.client_name}` : ''}
            </p>
            {m.status === 'failed' && <p className="mt-0.5 text-[12.5px] text-[var(--negative)] truncate">{m.error}</p>}
          </div>
          <div className="flex gap-4 text-[12.5px] text-muted shrink-0">
            {PROCESSING.includes(m.status) ? (
              <span className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" />
                {m.status === 'uploading' ? `${m.parts_uploaded}/${m.parts_expected} parts uploaded`
                  : m.status === 'transcribing' ? `${m.parts_transcribed}/${m.parts_expected} parts transcribed` : STATUS[m.status]?.label}
              </span>
            ) : (
              <>
                <span><strong className="text-ink">{m.items_total}</strong> extracted</span>
                <span><strong className="text-[var(--positive)]">{m.items_approved}</strong> approved</span>
                {full && <span><strong className="text-[var(--negative)]">{m.items_rejected}</strong> rejected</span>}
                {m.items_pending > 0 && <span><strong className="text-[var(--warning)]">{m.items_pending}</strong> to review</span>}
              </>
            )}
          </div>
        </button>
      ))}
    </Card>
  );
}

// ===================================================================== upload
function UploadPanel() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useQuery({ queryKey: ['meeting-intel', 'config'], queryFn: () => api.get<any>('/meeting-intel/config').then((r) => r.data) });
  const [kind, setKind] = useState<'recording' | 'transcript'>('recording');
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({ title: '', meeting_date: '', project_id: '', client_id: '', department: '', description: '' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dup, setDup] = useState<any>(null);
  const input = useRef<HTMLInputElement>(null);

  const exts: string[] = (kind === 'recording' ? cfg.data?.recording_ext : cfg.data?.transcript_ext) || [];
  const pick = (f?: File | null) => {
    setError('');
    if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop() || '';
    if (!exts.includes(ext)) { setError(`That file type is not supported here. Use ${exts.join(', ').toUpperCase()}.`); return; }
    if (kind === 'transcript' && f.size > (cfg.data?.max_document_bytes || 10e6)) { setError('Transcript files are limited to 10 MB.'); return; }
    if (kind === 'recording' && f.size > 1.5e9) { setError('Recordings over 1.5 GB cannot be processed in the browser. Export the audio only (MP3/M4A) and try again.'); return; }
    setFile(f);
    if (!form.title) setForm((s) => ({ ...s, title: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') }));
  };

  const sendChunks = async (meetingId: string, index: number, blob: Blob, done: number, total: number) => {
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const chunk = blob.slice(offset, offset + CHUNK_BYTES);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await request<Response>(`/meeting-intel/${meetingId}/parts/${index}?offset=${offset}`, {
            method: 'PUT', raw: true, body: chunk, headers: { 'Content-Type': 'application/octet-stream' },
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new ApiError(res.status, j?.error?.code || 'error', j?.error?.message || 'Upload failed');
          }
          break;
        } catch (e) {
          // A dropped connection: retry the same chunk; the server ignores a repeat.
          if (attempt >= 3 || (e instanceof ApiError && e.status < 500 && e.status !== 409)) throw e;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      setProgress(Math.round(((done + Math.min(blob.size, offset + CHUNK_BYTES)) / total) * 100));
    }
  };

  const start = async (allowDuplicate = false) => {
    if (!file || !consent || form.title.trim().length < 2) return;
    setBusy(true); setError(''); setProgress(0); setDup(null);
    try {
      let parts: { index: number; offset_seconds: number; blob: Blob; mime: string }[];
      let hash: string; let duration: number | null = null;
      if (kind === 'recording') {
        const prep = await prepareRecording(file, setStage);
        parts = prep.parts.map((p) => ({ ...p, mime: 'audio/wav' }));
        hash = prep.hash; duration = prep.duration;
        if (parts.length > (cfg.data?.max_parts || 30)) throw new Error('This recording is longer than 5 hours. Split it and upload each half.');
      } else {
        setStage('Reading the file…');
        hash = await sha256(await file.arrayBuffer());
        parts = [{ index: 0, offset_seconds: 0, blob: file, mime: file.type || 'text/plain' }];
      }
      setStage('Starting the upload…');
      const created = await api.post<{ id: string }>('/meeting-intel', {
        ...form,
        meeting_date: form.meeting_date || null,
        project_id: form.project_id || null,
        client_id: form.client_id || null,
        source_kind: kind,
        file_name: file.name, file_mime: file.type || null, file_size: file.size, file_sha256: hash,
        duration_seconds: duration, consent: true, allow_duplicate: allowDuplicate,
        parts: parts.map((p) => ({ index: p.index, size: p.blob.size, mime: p.mime, offset_seconds: p.offset_seconds })),
      });
      const total = parts.reduce((a, p) => a + p.blob.size, 0);
      let done = 0;
      for (const p of parts) {
        setStage(parts.length > 1 ? `Uploading part ${p.index + 1} of ${parts.length}…` : 'Uploading…');
        await sendChunks(created.data.id, p.index, p.blob, done, total);
        done += p.blob.size;
      }
      qc.invalidateQueries({ queryKey: ['meeting-intel'] });
      toast.success('Upload complete. Processing has started.', file.name);
      navigate(`/meeting-intel/${created.data.id}`);
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'duplicate_upload') setDup((e.details as any)?.existing || {});
      else setError(e?.message || 'The upload failed. Check your connection and try again.');
    } finally {
      setBusy(false); setStage('');
    }
  };

  const projects = cfg.data?.projects || [];
  const clients = cfg.data?.clients || [];
  const notReady = cfg.data && ((kind === 'recording' && !cfg.data.speech_to_text) || !cfg.data.analysis);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What are you uploading?">
          {([['recording', 'Meeting recording', 'MP3, WAV, M4A, MP4, WEBM', AudioLines], ['transcript', 'Meeting transcript', 'TXT, PDF, DOCX (also VTT, SRT)', FileText]] as const).map(([k, label, sub, Icon]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} disabled={busy}
              onClick={() => { setKind(k); setFile(null); setError(''); }}
              className={cx('rounded-lg border p-3 text-left transition-colors cursor-pointer',
                kind === k ? 'border-[var(--brand)] bg-brand-soft' : 'border-line hover:bg-sunken')}>
              <Icon size={18} className={kind === k ? 'text-[var(--brand)]' : 'text-subtle'} />
              <p className="mt-1.5 text-[14px] font-medium text-ink">{label}</p>
              <p className="text-[12px] text-subtle">{sub}</p>
            </button>
          ))}
        </div>

        {notReady && (
          <p className="flex gap-2 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-[var(--warning)]">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            {!cfg.data.analysis ? 'AI analysis is not configured on the server yet (ANTHROPIC_API_KEY). Uploads will wait as failed until it is.'
              : 'Speech-to-text is not configured on the server yet (GEMINI_API_KEY or OPENAI_API_KEY). Upload a transcript instead, or ask an admin.'}
          </p>
        )}

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (!busy) pick(e.dataTransfer.files?.[0]); }}
          className="rounded-lg border-2 border-dashed border-line px-4 py-6 text-center">
          <input ref={input} type="file" className="hidden" accept={exts.map((e) => `.${e}`).join(',')}
            onChange={(e) => pick(e.target.files?.[0])} />
          {file ? (
            <div className="flex items-center justify-center gap-3 flex-wrap">
              {kind === 'recording' ? <AudioLines size={18} className="text-[var(--brand)]" /> : <FileText size={18} className="text-[var(--brand)]" />}
              <span className="text-[14px] font-medium text-ink">{file.name}</span>
              <span className="text-[12.5px] text-subtle">{size(file.size)}</span>
              {!busy && <button type="button" onClick={() => setFile(null)} className="text-[12.5px] text-[var(--brand)] hover:underline cursor-pointer">Change</button>}
            </div>
          ) : (
            <>
              <Upload size={22} className="mx-auto text-subtle" />
              <p className="mt-2 text-[14px] text-ink">Drop the file here, or <button type="button" onClick={() => input.current?.click()} className="text-[var(--brand)] font-medium hover:underline cursor-pointer">choose a file</button></p>
              <p className="text-[12px] text-subtle mt-1">
                {kind === 'recording' ? 'The audio is extracted and prepared in your browser before upload.' : 'Up to 10 MB. Lines like “Priya: …” and [00:12:30] timestamps are recognised.'}
              </p>
            </>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Meeting title" required><Input value={form.title} maxLength={200} disabled={busy} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Project Weekly Review" /></Field>
          <Field label="Meeting date" hint="Needed to turn “by Friday” into a date"><Input type="date" value={form.meeting_date} disabled={busy} onChange={(e) => setForm({ ...form, meeting_date: e.target.value })} /></Field>
          <Field label="Project">
            <Select value={form.project_id} disabled={busy} onChange={(e) => {
              const p = projects.find((x: any) => x.id === e.target.value);
              setForm({ ...form, project_id: e.target.value, client_id: p?.client_id || form.client_id });
            }}>
              <option value="">None</option>
              {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Client">
            <Select value={form.client_id} disabled={busy} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
              <option value="">None</option>
              {clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Department"><Input value={form.department} maxLength={80} disabled={busy} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Delivery" /></Field>
          <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={form.description} disabled={busy} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional context for the analysis" /></Field>
        </div>

        <div className="rounded-lg border border-line bg-sunken px-3 py-2">
          <Checkbox checked={consent} disabled={busy} onChange={setConsent}
            label={<span>I am authorised to use this {kind === 'recording' ? 'recording' : 'transcript'}, and everyone in the meeting knew it was being {kind === 'recording' ? 'recorded' : 'transcribed'} and agreed to it.</span>} />
        </div>

        {error && <p className="flex gap-2 rounded-md bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]" role="alert"><AlertCircle size={15} className="mt-0.5 shrink-0" />{error}</p>}
        {busy && (
          <div className="space-y-1.5" aria-live="polite">
            <p className="text-[13px] text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{stage}</p>
            {progress > 0 && <Meter value={progress} showLabel />}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="primary" icon={<Sparkles size={15} />} loading={busy} onClick={() => start()}
            disabled={!file || !consent || form.title.trim().length < 2}>
            Upload and analyse
          </Button>
        </div>
      </Card>

      <Card className="p-4 h-fit">
        <p className="label-cap mb-2">How it works</p>
        <ol className="space-y-2.5 text-[13px] text-muted list-decimal pl-4">
          <li>Upload a recording or transcript. Recordings are transcribed with timestamps and speaker labels.</li>
          <li>The AI writes a summary and proposes tasks, matching names to your team. It never guesses a person or a deadline.</li>
          <li>You check each proposed task: approve, edit or reject. Only approved tasks are created and assigned.</li>
          <li>Each assignee is notified that the task came from this meeting.</li>
        </ol>
        <p className="mt-3 text-[12px] text-subtle flex gap-1.5"><ShieldCheck size={14} className="shrink-0 mt-0.5" />Audio is deleted once transcribed; the transcript is kept for verification and visible only to you and the owner.</p>
      </Card>

      <Modal open={!!dup} onClose={() => setDup(null)} title="This file was uploaded before"
        footer={<>
          <Button variant="ghost" onClick={() => setDup(null)}>Cancel</Button>
          {dup?.id && <Button onClick={() => navigate(`/meeting-intel/${dup.id}`)}>Open the earlier one</Button>}
          <Button variant="primary" onClick={() => start(true)}>Process it again</Button>
        </>}>
        <p className="text-[14px] text-ink">“{dup?.title}” was uploaded {dup?.created_at ? dateTime(dup.created_at) : 'earlier'}{dup?.uploaded_by_name ? ` by ${dup.uploaded_by_name}` : ''}.</p>
        <p className="mt-2 text-[13px] text-muted">Processing it again uses another transcription and analysis, and can propose the same tasks twice.</p>
      </Modal>
    </div>
  );
}

// ===================================================================== review
function MeetingReview({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);

  const q = useQuery({
    queryKey: ['meeting-intel', 'detail', id],
    queryFn: () => api.get<any>(`/meeting-intel/${id}`).then((r) => r.data),
  });
  const m = q.data;
  const live = m && ['queued', 'transcribing', 'analyzing'].includes(m.status);

  // While the page is open it drives processing one step at a time.
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api.post<any>(`/meeting-intel/${id}/advance`);
        qc.setQueryData(['meeting-intel', 'detail', id], r.data);
        if (['queued', 'transcribing', 'analyzing'].includes(r.data.status)) setTimeout(tick, 1500);
        else qc.invalidateQueries({ queryKey: ['meeting-intel', 'list'] });
      } catch { if (!stop) setTimeout(tick, 5000); }
    };
    tick();
    return () => { stop = true; };
  }, [live, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (data: any) => { qc.setQueryData(['meeting-intel', 'detail', id], data); qc.invalidateQueries({ queryKey: ['meeting-intel', 'list'] }); };

  const decide = async (kind: 'approve' | 'reject', payload: any, label: string) => {
    setBusy(label);
    try {
      const r = await api.post<any>(`/meeting-intel/${id}/items/${kind}`, payload);
      set(r.data.meeting);
      setSelected(new Set());
      if (kind === 'approve') {
        const okN = r.data.results.filter((x: any) => x.ok).length;
        const failed = r.data.results.filter((x: any) => !x.ok);
        if (okN) toast.success(`${okN} task${okN === 1 ? '' : 's'} created and assigned. The assignees have been notified.`);
        if (failed.length) toast.warn(failed.map((f: any) => f.error).slice(0, 2).join(' · '), `${failed.length} not created`);
        if (!okN && !failed.length) toast.info('No verified tasks to approve.');
        qc.invalidateQueries({ queryKey: ['action-items'] });
      } else toast.info(`${r.data.rejected} rejected.`);
    } catch (e: any) {
      toast.error(e?.message || 'That did not go through. Try again.');
    } finally { setBusy(''); }
  };

  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (q.isError) return <ErrorState error={q.error} retry={q.refetch} />;

  const items = m.items as any[];
  const open = items.filter((i) => i.status === 'proposed' || i.status === 'approving');
  const decided = items.filter((i) => i.status === 'approved' || i.status === 'rejected');
  const cancelled = items.filter((i) => i.status === 'cancelled_in_meeting');
  const verified = open.filter((i) => i.verified);
  const people = new Set(items.filter((i) => i.assignee_user_id && i.status !== 'cancelled_in_meeting').map((i) => i.assignee_user_id));
  const unassigned = items.filter((i) => !i.assignee_user_id && i.status === 'proposed').length;
  const reviewing = m.status === 'review' && m.can_approve;

  return (
    <div className="space-y-4">
      <div>
        <Link to="/meeting-intel?tab=history" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft size={14} /> AI Meeting Intelligence</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-[21px] font-semibold text-ink">{m.title}</h1>
          <Badge tone={STATUS[m.status]?.tone}>{STATUS[m.status]?.label}</Badge>
        </div>
        <p className="text-[13px] text-subtle mt-0.5">
          {m.meeting_date ? `Meeting on ${fmtDate(m.meeting_date)}` : 'Meeting date not given'} · Uploaded {dateTime(m.created_at)} by {m.uploaded_by_name}
          {m.file_name ? ` · ${m.file_name}` : ''}{m.duration_seconds ? ` · ${clock(m.duration_seconds)}` : ''}
          {m.project_name ? ` · ${m.project_name}` : ''}{m.client_name ? ` · ${m.client_name}` : ''}
        </p>
      </div>

      {(PROCESSING.includes(m.status) || m.status === 'failed') && <ProcessingCard m={m} onRetry={async () => {
        try { set((await api.post<any>(`/meeting-intel/${id}/retry`)).data); } catch (e: any) { toast.error(e?.message); }
      }} />}

      {m.summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              ['Action items', items.length - cancelled.length],
              ['People identified', people.size],
              ['Unassigned', unassigned],
              ['Approved', m.items_approved],
              ['Rejected', m.items_rejected],
            ].map(([label, n]) => (
              <Card key={label as string} className="px-3 py-2.5">
                <p className="text-[11.5px] text-subtle uppercase tracking-wide">{label}</p>
                <p className="text-[20px] font-semibold text-ink">{n}</p>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4 min-w-0">
              <Card>
                <CardHeader title="Tasks proposed from this meeting"
                  subtitle={reviewing ? 'Approve, edit or reject each one. Only approved tasks are created.' : m.status === 'completed' ? 'Every proposal has been decided.' : undefined}
                  action={reviewing && open.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="primary" icon={<CheckCircle2 size={14} />} disabled={!verified.length || !!busy}
                        loading={busy === 'verified'} onClick={() => decide('approve', { all_verified: true }, 'verified')}>
                        Approve all verified ({verified.length})
                      </Button>
                      <Button size="sm" disabled={!selected.size || !!busy} loading={busy === 'selected'}
                        onClick={() => decide('approve', { item_ids: [...selected] }, 'selected')}>
                        Approve selected{selected.size ? ` (${selected.size})` : ''}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmReject(true)}>Reject all</Button>
                    </div>
                  )} />
                <div className="p-3 space-y-3">
                  {!items.length && <EmptyState compact icon={<CheckCircle2 size={18} />} title="No tasks found" message="The AI did not find any clear commitments or instructions in this meeting." />}
                  {open.map((it) => (
                    <TaskCard key={it.id} it={it} m={m} reviewing={reviewing} busy={busy}
                      selected={selected.has(it.id)}
                      onSelect={(v) => setSelected((s) => { const n = new Set(s); v ? n.add(it.id) : n.delete(it.id); return n; })}
                      onApprove={() => decide('approve', { item_ids: [it.id] }, it.id)}
                      onReject={() => decide('reject', { item_ids: [it.id] }, it.id)}
                      onSaved={set} onFocus={setFocus} />
                  ))}
                  {decided.map((it) => <TaskCard key={it.id} it={it} m={m} reviewing={false} busy="" onFocus={setFocus} />)}
                  {cancelled.length > 0 && (
                    <details className="rounded-lg border border-line px-3 py-2">
                      <summary className="cursor-pointer text-[13px] text-muted">{cancelled.length} called off during the meeting (not proposed)</summary>
                      <ul className="mt-2 space-y-1 text-[13px] text-subtle">{cancelled.map((c) => <li key={c.id}>· {c.title}{c.assignee_name ? ` (${c.assignee_name})` : ''}</li>)}</ul>
                    </details>
                  )}
                </div>
              </Card>

              {m.speaker_labels?.length > 0 && <Speakers m={m} canEdit={reviewing} onSaved={set} />}
              <Transcript segments={m.transcript} focus={focus} />
            </div>

            <div className="space-y-4">
              <Summary s={m.summary} />
              <OpenItems x={m.extras} />
            </div>
          </div>
        </>
      )}

      <Modal open={confirmReject} onClose={() => setConfirmReject(false)} title="Reject all remaining tasks?" size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmReject(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => { setConfirmReject(false); decide('reject', { all: true }, 'all'); }}>Reject {open.length}</Button>
        </>}>
        <p className="text-[14px] text-ink">None of the {open.length} undecided proposals will be created. Approved tasks stay as they are.</p>
      </Modal>
    </div>
  );
}

function ProcessingCard({ m, onRetry }: { m: any; onRetry: () => void }) {
  const steps = m.source_kind === 'live'
    ? [['queued', 'Recorded'], ['transcribing', 'Transcribe'], ['analyzing', 'Analyse'], ['review', 'Review']]
    : m.source_kind === 'recording'
    ? [['uploading', 'Upload'], ['transcribing', 'Transcribe'], ['analyzing', 'Analyse'], ['review', 'Review']]
    : [['uploading', 'Upload'], ['queued', 'Read'], ['analyzing', 'Analyse'], ['review', 'Review']];
  const order = steps.map((s) => s[0]);
  const at = m.status === 'failed' ? ({ transcribing: 'transcribing', extracting: 'queued', analyzing: 'analyzing' } as any)[m.failed_stage] || 'queued'
    : m.status === 'queued' && m.source_kind !== 'transcript' ? 'transcribing' : m.status;
  const idx = Math.max(0, order.indexOf(at));
  return (
    <Card className="p-4">
      <ol className="flex items-center gap-2 overflow-x-auto">
        {steps.map(([k, label], i) => (
          <li key={k} className="flex items-center gap-2 shrink-0">
            <span className={cx('grid h-6 w-6 place-items-center rounded-full text-[12px] font-semibold',
              i < idx ? 'bg-positive-soft text-[var(--positive)]'
                : i === idx ? (m.status === 'failed' ? 'bg-negative-soft text-[var(--negative)]' : 'bg-brand-soft text-[var(--brand)]')
                  : 'bg-sunken text-subtle')}>
              {i < idx ? <Check size={13} /> : i === idx && m.status === 'failed' ? <X size={13} /> : i === idx ? <Loader2 size={13} className="animate-spin" /> : i + 1}
            </span>
            <span className={cx('text-[13px]', i === idx ? 'text-ink font-medium' : 'text-subtle')}>{label}</span>
            {i < steps.length - 1 && <span className="w-6 h-px bg-line" />}
          </li>
        ))}
      </ol>
      {m.status === 'transcribing' && m.parts_expected > 1 && (
        <div className="mt-3"><Meter value={m.parts_transcribed} max={m.parts_expected} /><p className="mt-1 text-[12px] text-subtle">{m.parts_transcribed} of {m.parts_expected} parts transcribed</p></div>
      )}
      {m.status === 'uploading' && <p className="mt-3 text-[13px] text-muted">{m.parts_uploaded} of {m.parts_expected} parts uploaded. If the upload was interrupted, start it again from Upload meeting.</p>}
      {PROCESSING.includes(m.status) && m.status !== 'uploading' && <p className="mt-3 text-[13px] text-muted">This can take a few minutes for a long recording. You can leave this page; processing continues in the background.</p>}
      {m.status === 'failed' && (
        <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <p className="flex gap-2 text-[13px] text-[var(--negative)]"><AlertCircle size={15} className="mt-0.5 shrink-0" />{m.error}</p>
          <Button icon={<RotateCcw size={14} />} onClick={onRetry}>Retry</Button>
        </div>
      )}
    </Card>
  );
}

const ACCEPT: Record<string, { label: string; tone: any }> = {
  accepted: { label: 'Accepted in meeting', tone: 'positive' },
  not_confirmed: { label: 'Assigned, no response', tone: 'warning' },
  declined: { label: 'Declined in meeting', tone: 'negative' },
  unclear: { label: 'Acceptance unclear', tone: 'neutral' },
};
const PRIORITY: Record<string, string> = { low: 'Low', medium: 'Normal', high: 'High', urgent: 'Urgent' };

function TaskCard({ it, m, reviewing, busy, selected, onSelect, onApprove, onReject, onSaved, onFocus }: {
  it: any; m: any; reviewing: boolean; busy: string; selected?: boolean; onSelect?: (v: boolean) => void;
  onApprove?: () => void; onReject?: () => void; onSaved?: (d: any) => void; onFocus: (i: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const isOpen = it.status === 'proposed';
  const assignable = (m.staff as any[]).filter((p) => p.assignable);

  const save = async (patch: any) => {
    try {
      const r = await api.patch<any>(`/meeting-intel/${m.id}/items/${it.id}`, patch);
      onSaved?.(r.data);
      setEditing(false);
    } catch (e: any) { toast.error(e?.message || 'Could not save'); }
  };

  return (
    <div className={cx('rounded-lg border p-3 sm:p-4',
      it.status === 'approved' ? 'border-[color-mix(in_srgb,var(--positive)_35%,transparent)] bg-positive-soft/40'
        : it.status === 'rejected' ? 'border-line opacity-70' : it.verified ? 'border-line' : 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)]')}>
      <div className="flex items-start gap-2.5">
        {reviewing && isOpen && (
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)] cursor-pointer" checked={!!selected}
            aria-label={`Select ${it.title}`} onChange={(e) => onSelect?.(e.target.checked)} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14.5px] font-semibold text-ink">{it.title}</p>
            {it.status === 'approved' && <Badge tone="positive"><CheckCircle2 size={12} /> Approved{it.decided_by_name ? ` by ${it.decided_by_name}` : ''}</Badge>}
            {it.status === 'rejected' && <Badge tone="neutral"><XCircle size={12} /> Rejected</Badge>}
            {isOpen && (it.verified ? <Badge tone="positive">Verified</Badge> : <Badge tone="warning">Needs attention</Badge>)}
            <Badge tone={it.confidence === 'high' ? 'brand' : it.confidence === 'low' ? 'warning' : 'neutral'}>{it.confidence} confidence</Badge>
          </div>
          {it.description && !editing && <p className="mt-1 text-[13px] text-muted">{it.description}</p>}

          {!editing ? (
            <dl className="mt-2.5 grid gap-x-4 gap-y-1.5 sm:grid-cols-2 text-[13px]">
              <Detail label="Assigned to">
                {it.assignee_display ? (
                  <span className="inline-flex items-center gap-1.5"><Avatar name={it.assignee_display} size={18} />{it.assignee_display}
                    {it.assignee_name && it.assignee_name !== it.assignee_display && <span className="text-subtle">(heard “{it.assignee_name}”)</span>}
                    {it.assignee_status === 'matched' && it.candidates?.length > 1 && (
                      <span className="block text-[11.5px] text-subtle">
                        Chosen because they were in the meeting; also matches {it.candidates.filter((c: any) => c.id !== it.assignee_user_id).map((c: any) => c.name).join(', ')}
                      </span>
                    )}
                  </span>
                ) : it.assignee_status === 'ambiguous' ? (
                  <span className="text-[var(--warning)]">“{it.assignee_name}” matches {it.candidates.length} people</span>
                ) : it.assignee_status === 'not_found' ? (
                  <span className="text-[var(--warning)]">“{it.assignee_name}” is not in the team</span>
                ) : it.assignee_status === 'speaker_unmapped' ? (
                  <span className="text-[var(--warning)]">{it.assignee_speaker} (who is this?)</span>
                ) : <span className="text-[var(--warning)]">Nobody was named</span>}
              </Detail>
              <Detail label="Acceptance"><Badge tone={ACCEPT[it.acceptance]?.tone}>{ACCEPT[it.acceptance]?.label}</Badge></Detail>
              <Detail label="Deadline">
                {it.due_date ? `${fmtDate(it.due_date)}${it.due_time ? `, ${it.due_time}` : ''}` : <span className="text-subtle">None set</span>}
                {it.deadline_text && <span className="text-subtle"> · said “{it.deadline_text}”</span>}
              </Detail>
              <Detail label="Priority">{it.priority ? PRIORITY[it.priority] : <span className="text-subtle">Not said (Normal)</span>}</Detail>
              <Detail label="Project / client">{it.project_name || it.client_name || <span className="text-subtle">{it.related_text || 'None'}</span>}</Detail>
              <Detail label="Assigned by">{it.assigned_by_name || <span className="text-subtle">Unclear</span>}</Detail>
            </dl>
          ) : (
            <EditItem it={it} m={m} assignable={assignable} onCancel={() => setEditing(false)} onSave={save} />
          )}

          {it.start_seconds != null && m.live_meeting_id && (
            <Link to={`/ai-meetings/m/${m.live_meeting_id}?t=${Math.floor(it.start_seconds)}`}
              className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-[var(--brand)] hover:underline">
              <Clock size={12} /> Play the recording at {clock(it.start_seconds)}
            </Link>
          )}
          {it.evidence?.quote && (
            <button type="button" onClick={() => onFocus(it.evidence.segments?.[0] ?? null)}
              className="mt-2.5 block w-full text-left rounded-md border-l-2 border-[var(--brand)] bg-sunken px-3 py-2 text-[12.5px] text-muted hover:text-ink cursor-pointer">
              {it.start_seconds != null && <span className="font-mono text-[11.5px] text-subtle mr-1.5"><Clock size={11} className="inline -mt-0.5" /> {clock(it.start_seconds)}</span>}
              “{it.evidence.quote}”
            </button>
          )}

          {isOpen && it.problems?.length > 0 && (
            <ul className="mt-2 space-y-0.5">{it.problems.map((p: string) => <li key={p} className="text-[12.5px] text-[var(--warning)] flex gap-1.5"><AlertCircle size={13} className="mt-0.5 shrink-0" />{p}</li>)}</ul>
          )}

          {reviewing && isOpen && it.assignee_status === 'ambiguous' && !it.assignee_user_id && !editing && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {it.candidates.map((c: any) => (
                <Button key={c.id} size="sm" disabled={!assignable.some((a) => a.id === c.id)}
                  title={assignable.some((a) => a.id === c.id) ? undefined : 'Not in your team'}
                  icon={<UserRound size={13} />} onClick={() => save({ assignee_user_id: c.id })}>{c.name}</Button>
              ))}
            </div>
          )}

          {reviewing && isOpen && !editing && !it.assignee_user_id && it.assignee_status !== 'ambiguous' && (
            <label className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <UserRound size={13} /> Assign employee
              <Select aria-label={`Assign an employee to ${it.title}`} className="!w-auto min-w-[200px]" value=""
                onChange={(e) => e.target.value && save({ assignee_user_id: e.target.value })}>
                <option value="">Choose a person…</option>
                {assignable.map((pp: any) => <option key={pp.id} value={pp.id}>{pp.name}{pp.designation ? ` · ${pp.designation}` : ''}</option>)}
              </Select>
            </label>
          )}
          {reviewing && isOpen && !editing && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" icon={<Check size={14} />} disabled={!it.verified || !!busy} loading={busy === it.id} onClick={onApprove}>Approve task</Button>
              <Button size="sm" icon={<Pencil size={13} />} disabled={!!busy} onClick={() => setEditing(true)}>Edit task</Button>
              <Button size="sm" variant="ghost" icon={<X size={14} />} disabled={!!busy} onClick={onReject}>Reject task</Button>
            </div>
          )}
          {it.status === 'approved' && it.action_item_id && (
            <Link to={`/action-items?open=${it.action_item_id}`} className="mt-2 inline-block text-[12.5px] text-[var(--brand)] hover:underline">Open the created task →</Link>
          )}
        </div>
      </div>
    </div>
  );
}

const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-2 min-w-0"><dt className="text-subtle w-28 shrink-0">{label}</dt><dd className="text-ink min-w-0">{children}</dd></div>
);

function EditItem({ it, m, assignable, onCancel, onSave }: { it: any; m: any; assignable: any[]; onCancel: () => void; onSave: (p: any) => void }) {
  const cfg = useQuery({ queryKey: ['meeting-intel', 'config'], queryFn: () => api.get<any>('/meeting-intel/config').then((r) => r.data) });
  const [f, setF] = useState({
    title: it.title, description: it.description || '', assignee_user_id: it.assignee_user_id || '',
    due_date: it.due_date || '', due_time: it.due_time || '', priority: it.priority || 'medium',
    project_id: it.project_id || '', client_id: it.client_id || '',
  });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    await onSave({ ...f, assignee_user_id: f.assignee_user_id || null, project_id: f.project_id || null, client_id: f.client_id || null, due_time: f.due_date ? f.due_time : '' });
    setSaving(false);
  };
  return (
    <div className="mt-3 space-y-3">
      <Field label="Task title" required><Input value={f.title} maxLength={240} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Assigned employee" required hint={m.staff.length > assignable.length ? 'Only people you can assign are listed' : undefined}>
          <Select value={f.assignee_user_id} onChange={(e) => setF({ ...f, assignee_user_id: e.target.value })}>
            <option value="">Choose a person…</option>
            {assignable.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` · ${p.designation}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {Object.entries(PRIORITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Deadline" hint="Leave empty for no deadline"><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <Field label="Time (optional)"><Input type="time" value={f.due_time} disabled={!f.due_date} onChange={(e) => setF({ ...f, due_time: e.target.value })} /></Field>
        <Field label="Project">
          <Select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
            <option value="">None</option>
            {(cfg.data?.projects || []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Client">
          <Select value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })}>
            <option value="">None</option>
            {(cfg.data?.clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={f.title.trim().length < 2} onClick={submit}>Save changes</Button>
      </div>
    </div>
  );
}

function Speakers({ m, canEdit, onSaved }: { m: any; canEdit: boolean; onSaved: (d: any) => void }) {
  const toast = useToast();
  const [map, setMap] = useState<Record<string, string | null>>(m.speakers || {});
  useEffect(() => setMap(m.speakers || {}), [m.speakers]);
  const save = async (label: string, uid: string) => {
    const next = { ...map, [label]: uid || null };
    setMap(next);
    try { onSaved((await api.put<any>(`/meeting-intel/${m.id}/speakers`, { speakers: next })).data); } catch (e: any) { toast.error(e?.message); }
  };
  return (
    <Card>
      <CardHeader title="Who is who" subtitle="Speaker labels come from the transcript. Say who each one is; it is never guessed from a voice." />
      <div className="p-3 grid gap-2 sm:grid-cols-2">
        {m.speaker_labels.map((label: string) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-36 shrink-0 truncate text-[13px] text-ink" title={label}>{label}</span>
            <Select value={map[label] || ''} disabled={!canEdit} onChange={(e) => save(label, e.target.value)} aria-label={`Who is ${label}`}>
              <option value="">Not set</option>
              {m.staff.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Transcript({ segments, focus }: { segments: any[]; focus: number | null }) {
  const [openT, setOpenT] = useState(false);
  const refs = useRef<Record<number, HTMLDivElement | null>>({});
  useEffect(() => {
    if (focus == null) return;
    setOpenT(true);
    setTimeout(() => refs.current[focus]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }, [focus]);
  return (
    <Card>
      <button type="button" onClick={() => setOpenT((o) => !o)} className="w-full flex items-center justify-between px-4 py-3 cursor-pointer">
        <span className="text-[14px] font-semibold text-ink">Original transcript <span className="text-subtle font-normal">· {segments.length} segments</span></span>
        <ChevronDown size={16} className={cx('text-subtle transition-transform', openT && 'rotate-180')} />
      </button>
      {openT && (
        <div className="max-h-[420px] overflow-y-auto border-t border-line px-4 py-2 space-y-1.5">
          {segments.map((s) => (
            <div key={s.i} ref={(el) => { refs.current[s.i] = el; }}
              className={cx('rounded px-2 py-1 text-[13px] leading-relaxed', focus === s.i && 'bg-warning-soft')}>
              <span className="font-mono text-[11px] text-subtle mr-2">{s.start != null ? clock(s.start) : `#${s.i}`}</span>
              {s.speaker && <span className="font-medium text-ink mr-1">{s.speaker}:</span>}
              <span className="text-muted">{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Summary({ s }: { s: any }) {
  const sections: [string, string[]][] = [
    ['Decisions', s.decisions], ['Conclusions', s.conclusions], ['Updates', s.updates], ['Problems', s.problems],
    ['Client discussions', s.client_discussions], ['Topics', s.topics],
  ];
  const people: any[] = s.participants || [];
  return (
    <Card>
      <CardHeader title="Meeting summary" icon={<Sparkles size={15} className="text-[var(--brand)]" />} />
      <div className="p-4 space-y-3">
        {s.overview && <p className="text-[13.5px] text-ink leading-relaxed">{s.overview}</p>}
        {people.length > 0 && (
          <div>
            <p className="label-cap mb-1">Participants</p>
            <p className="text-[13px] text-muted">
              {people.map((p, i) => (
                <span key={p.user_id || i}>
                  {i > 0 && ', '}
                  <span className={p.attended ? 'text-ink' : 'text-subtle line-through decoration-1'} title={p.attended ? undefined : 'Invited, did not join'}>{p.name}</span>
                  {p.host && <span className="text-subtle"> (host)</span>}
                </span>
              ))}
            </p>
          </div>
        )}
        {sections.filter(([, l]) => l?.length).map(([label, list]) => (
          <div key={label}>
            <p className="label-cap mb-1">{label}</p>
            <ul className="space-y-1 text-[13px] text-muted">{list.map((x, i) => <li key={i} className="flex gap-1.5"><span className="text-subtle">·</span>{x}</li>)}</ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OpenItems({ x }: { x: any }) {
  if (!x) return null;
  const sections: [string, string[]][] = [
    ['Tasks with nobody assigned', x.unassigned_tasks], ['Unclear deadlines', x.unclear_deadlines],
    ['Pending decisions', x.pending_decisions], ['Unresolved issues', x.unresolved_issues],
    ['Risks raised', x.risks], ['Issues that keep coming up', x.repeated_issues],
    ['Follow-up meetings needed', x.follow_up_meetings], ['Follow-ups needed', x.follow_ups],
  ];
  const any = sections.some(([, l]) => l?.length);
  return (
    <Card>
      <CardHeader title="Still open after the meeting" />
      <div className="p-4 space-y-3">
        {!any && <p className="text-[13px] text-subtle">Nothing left open.</p>}
        {sections.filter(([, l]) => l?.length).map(([label, list]) => (
          <div key={label}>
            <p className="label-cap mb-1">{label}</p>
            <ul className="space-y-1 text-[13px] text-muted">{list.map((t, i) => <li key={i} className="flex gap-1.5"><span className="text-subtle">·</span>{t}</li>)}</ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

