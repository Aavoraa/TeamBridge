import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Inbox, Paperclip, Send, Trash2, Undo2, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clockTime, date as fmtDate, relative, workspaceToday } from '../lib/format';
import {
  Avatar, Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea, useToast, cx,
} from './ui';
import { ATTACH_ACCEPT, AttachmentList, MAX_FILE_BYTES, uploadAttachment } from './Attachments';

/**
 * Task requests. Only owners and managers hand work to other people, so
 * everyone else asks for a task of their own here. It goes to their reporting
 * manager, and to the lead and manager of the project it is for; the first of
 * them to decide settles it. Approved, it becomes an ordinary task on their list.
 */

/** These roles assign work. The API holds the same rule (services/taskAssignment.js). */
export const ASSIGNING_ROLES = ['owner', 'manager', 'super_admin'];
export const assignsWork = (role?: string) => !!role && ASSIGNING_ROLES.includes(role);

const PRIORITIES = [
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }, { id: 'urgent', label: 'Urgent' },
];

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['task-requests'] });
  qc.invalidateQueries({ queryKey: ['action-items'] });
  qc.invalidateQueries({ queryKey: ['home-counters'] });
};

/** Requests waiting on me, for the tab badge. */
export function useTaskRequestCount() {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['task-requests', 'count'],
    queryFn: () => api.get<any>('/task-requests/count').then((r) => r.data),
    enabled: !!user && user.role !== 'client',
    staleTime: 30_000,
  });
  return data?.review || 0;
}

const when = (r: any) => (r.due_date
  ? `${fmtDate(r.due_date)}${r.due_time ? `, ${clockTime(r.due_time)}` : ''}` : 'No due date');

const orList = (names: string[]) => (names.length <= 1 ? names[0] || ''
  : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);

/* ------------------------------------------------------------ request form */
export function RequestTaskModal({ onClose, onSent }: { onClose: () => void; onSent?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ title: '', description: '', project_id: '', priority: 'medium', due_date: '', due_time: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const { data: projects } = useQuery({
    queryKey: ['task-requests', 'projects'],
    queryFn: () => api.get<any>('/task-requests/projects').then((r) => r.data),
    staleTime: 300_000,
  });

  const send = useMutation({
    mutationFn: async () => {
      const res = await api.post<any>('/task-requests', {
        title: form.title.trim(),
        description: form.description.trim() || null,
        project_id: form.project_id || null,
        priority: form.priority,
        due_date: form.due_date || null,
        due_time: form.due_date ? (form.due_time || null) : null,
      });
      const failed: string[] = [];
      for (const f of files) {
        try { await uploadAttachment('task_request', res.data.id, f); } catch { failed.push(f.name); }
      }
      return { res, failed };
    },
    onSuccess: ({ res, failed }: any) => {
      const names = (res.data.approvers || []).map((a: any) => a.name);
      toast.success(`Sent for approval to ${orList(names)}.`);
      if (failed.length) toast.error(`Could not attach ${failed.join(', ')}. Add it from My requests.`);
      invalidate(qc);
      onSent?.();
      onClose();
    },
    onError: (e: any) => { setErrors(e.fieldErrors || {}); toast.error(e.message); },
  });

  const pastDate = !!form.due_date && form.due_date < workspaceToday();

  return (
    <Modal open onClose={onClose} title="Request a task"
      subtitle="Ask to take this on. Your manager or project lead approves it, then it joins your tasks."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={send.isPending}
            disabled={form.title.trim().length < 2 || pastDate} onClick={() => send.mutate()}>
            Send for approval
          </Button>
        </>
      }>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Task" required error={errors.title} className="sm:col-span-2">
          <Input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={240} autoFocus
            placeholder="Prepare the client onboarding checklist" />
        </Field>
        <Field label="Details" className="sm:col-span-2" error={errors.description}>
          <Textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Why it is needed and what done looks like" />
        </Field>
        <Field label="Project" error={errors.project_id}
          hint={form.project_id ? 'The project lead and manager can approve it too' : 'Optional'}>
          <Select value={form.project_id} onChange={(e) => set('project_id', e.target.value)}>
            <option value="">Not for a project</option>
            {projects?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Wanted by" error={errors.due_date || (pastDate ? 'Pick today or a later day' : undefined)}>
          <Input type="date" value={form.due_date} min={workspaceToday()} onChange={(e) => set('due_date', e.target.value)} />
        </Field>
        <Field label="Time" hint={form.due_date ? 'Optional' : 'Set a date first'} error={errors.due_time}>
          <Input type="time" value={form.due_time} disabled={!form.due_date} onChange={(e) => set('due_time', e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <input ref={fileRef} type="file" multiple className="hidden" accept={ATTACH_ACCEPT}
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              e.target.value = '';
              const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
              if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} is over 15 MB.`);
              setFiles((prev) => [...prev, ...picked.filter((f) => f.size <= MAX_FILE_BYTES)]);
            }} />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-ink">Files <span className="font-normal text-subtle">· optional, up to 15 MB each</span></span>
            <Button size="sm" icon={<Upload size={14} />} onClick={() => fileRef.current?.click()}>Upload file</Button>
          </div>
          {!!files.length && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
                  <FileText size={14} className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.name}</span>
                  <span className="shrink-0 text-[11.5px] text-subtle tabular">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                  <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}
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

/* --------------------------------------------------------------- the tab */
export function TaskRequestsView() {
  const { user } = useAuth();
  const [asking, setAsking] = useState(false);
  const [rejecting, setRejecting] = useState<any>(null);

  const review = useQuery({
    queryKey: ['task-requests', 'review'],
    queryFn: () => api.get<any>('/task-requests', { box: 'review' }).then((r) => r.data),
  });
  const mine = useQuery({
    queryKey: ['task-requests', 'mine'],
    queryFn: () => api.get<any>('/task-requests', { box: 'mine', status: 'all' }).then((r) => r.data),
  });

  const waiting = review.data || [];
  const showReview = assignsWork(user?.role) || waiting.length > 0;
  const showMine = !assignsWork(user?.role) || (mine.data?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      {showReview && (
        <section>
          <SectionHead title="Waiting on you" count={waiting.length}
            blurb="Your team asking to take a task on. Approve it and it joins their tasks, with you signing off the work." />
          {review.isLoading ? <SkeletonRows />
            : !waiting.length ? (
              <Card><EmptyState compact icon={<Inbox size={18} />} title="Nothing to decide"
                message="Requests from your reports and project teams show up here." /></Card>
            ) : (
              <div className="space-y-3">
                {waiting.map((r: any) => <ReviewCard key={r.id} request={r} onReject={() => setRejecting(r)} />)}
              </div>
            )}
        </section>
      )}

      {showMine && (
        <section>
          <SectionHead title="My requests" count={mine.data?.filter((r: any) => r.status === 'pending').length}
            blurb="Tasks you have asked to take on, and what was decided."
            action={<Button variant="primary" size="sm" icon={<Send size={14} />} onClick={() => setAsking(true)}>Request a task</Button>} />
          {mine.isLoading ? <SkeletonRows />
            : !mine.data?.length ? (
              <Card><EmptyState compact icon={<Send size={18} />} title="No requests yet"
                message="Want a task of your own on the board, with a due date and reminders? Request it here. Quick personal reminders belong on your to-do list on My Day instead." /></Card>
            ) : (
              <Card className="divide-y divide-line overflow-hidden">
                {mine.data.map((r: any) => <MineRow key={r.id} request={r} />)}
              </Card>
            )}
        </section>
      )}

      {asking && <RequestTaskModal onClose={() => setAsking(false)} />}
      {rejecting && <RejectModal request={rejecting} onClose={() => setRejecting(null)} />}
    </div>
  );
}

function SectionHead({ title, count, blurb, action }: { title: string; count?: number; blurb: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">
          {title}{count ? <span className="ml-2 text-[13px] font-medium text-subtle tabular">{count}</span> : null}
        </h2>
        <p className="mt-0.5 text-[12.5px] text-subtle">{blurb}</p>
      </div>
      {action}
    </div>
  );
}

const SkeletonRows = () => (
  <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-16 rounded-xl bg-sunken animate-pulse" />)}</div>
);

const PRIORITY_TONE: Record<string, any> = { urgent: 'negative', high: 'warning', medium: 'neutral', low: 'neutral' };

function ReviewCard({ request: r, onReject }: { request: any; onReject: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const approve = useMutation({
    mutationFn: () => api.post<any>(`/task-requests/${r.id}/approve`, {}),
    onSuccess: () => {
      toast.success(`Approved. "${r.title}" is now on ${r.requester_name}'s tasks.`);
      invalidate(qc);
    },
    onError: (e: any) => { toast.error(e.message); invalidate(qc); },
  });
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={r.requester_name} url={r.requester_avatar} size={34} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-subtle">
            <span className="font-medium text-ink">{r.requester_name}</span>
            {r.requester_designation ? ` · ${r.requester_designation}` : ''} · {relative(r.created_at)}
          </p>
          <p className="mt-1 text-[14.5px] font-semibold text-ink break-words">{r.title}</p>
          {r.description && <p className="mt-1 whitespace-pre-line text-[13px] text-muted break-words">{r.description}</p>}
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-subtle">
            <Badge tone={PRIORITY_TONE[r.priority]} className="capitalize">{r.priority}</Badge>
            <span>{when(r)}</span>
            {r.project_name && <span>Project: {r.project_name}</span>}
          </p>
          {Number(r.attachment_count) > 0 && (
            <div className="mt-3"><AttachmentList entity="task_request" entityId={r.id} /></div>
          )}
        </div>
        <div className="flex w-full gap-2 sm:w-auto sm:flex-col">
          <Button variant="primary" icon={<Check size={15} />} loading={approve.isPending} onClick={() => approve.mutate()}
            className="flex-1 sm:flex-none">Approve</Button>
          <Button icon={<X size={15} />} onClick={onReject} disabled={approve.isPending} className="flex-1 sm:flex-none">Reject</Button>
        </div>
      </div>
    </Card>
  );
}

const STATUS_UI: Record<string, { label: string; tone: any }> = {
  pending: { label: 'Waiting for approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'positive' },
  rejected: { label: 'Not approved', tone: 'negative' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

function MineRow({ request: r }: { request: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const withdraw = useMutation({
    mutationFn: () => api.post(`/task-requests/${r.id}/withdraw`, {}),
    onSuccess: () => { toast.success('Request withdrawn.'); invalidate(qc); },
    onError: (e: any) => { toast.error(e.message); invalidate(qc); },
  });
  const ui = STATUS_UI[r.status] || STATUS_UI.pending;
  const count = Number(r.attachment_count) || 0;
  const [showFiles, setShowFiles] = useState(false);
  return (
    <div className="px-4 py-3.5">
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium text-ink break-words">{r.title}</span>
          <Badge tone={ui.tone} dot>{ui.label}</Badge>
        </p>
        <p className="mt-1 text-[12.5px] text-subtle">
          {when(r)}{r.project_name ? ` · ${r.project_name}` : ''} · asked {relative(r.created_at)}
        </p>
        <p className={cx('mt-1 text-[12.5px]', r.status === 'rejected' ? 'text-[var(--negative)]' : 'text-muted')}>
          {r.status === 'pending' && `With ${orList(r.approvers.map((a: any) => a.name))}`}
          {r.status === 'approved' && `Approved by ${r.decided_by_name} ${relative(r.decided_at)}`}
          {r.status === 'rejected' && `${r.decided_by_name}: ${r.decision_note}`}
        </p>
      </div>
      {(count > 0 || r.status === 'pending') && (
        <Button size="sm" variant="ghost" icon={<Paperclip size={14} />} onClick={() => setShowFiles((v) => !v)}>
          {count ? `Files (${count})` : 'Add files'}
        </Button>
      )}
      {r.status === 'pending' && (
        <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
          Withdraw
        </Button>
      )}
      {r.status === 'approved' && r.action_item_id && (
        <Button size="sm" onClick={() => navigate(`/action-items?open=${r.action_item_id}`)}>
          Open task
        </Button>
      )}
    </div>
    {showFiles && (
      <div className="mt-3">
        <AttachmentList entity="task_request" entityId={r.id}
          canUpload={r.status === 'pending'} canRemove={r.status === 'pending'} />
      </div>
    )}
    </div>
  );
}

function RejectModal({ request: r, onClose }: { request: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const reject = useMutation({
    mutationFn: () => api.post(`/task-requests/${r.id}/reject`, { note: note.trim() }),
    onSuccess: () => { toast.success(`${r.requester_name} has been told why.`); invalidate(qc); onClose(); },
    onError: (e: any) => { toast.error(e.message); invalidate(qc); },
  });
  return (
    <Modal open onClose={onClose} title="Reject this request?" subtitle={`"${r.title}" from ${r.requester_name}`} size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={reject.isPending} disabled={note.trim().length < 2} onClick={() => reject.mutate()}>
            Reject
          </Button>
        </>
      }>
      <Field label="Reason" required hint={`${r.requester_name} sees this`}>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus
          placeholder="Not this sprint; pick it up after the launch" />
      </Field>
    </Modal>
  );
}
