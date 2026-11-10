import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle, ArrowRight, CheckCircle2, Keyboard, Mic, Pencil, RotateCcw, Sparkles, Square, Users2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseVoiceTask, useSpeech } from '../lib/voiceTask';
import { clockTime, date as fmtDate, workspaceToday } from '../lib/format';
import { isNative } from '../lib/storage';
import { dueError } from '../pages/ActionItems';
import { Avatar, Button, Field, Input, Modal, Select, Textarea, cx } from './ui';

/**
 * AI Task Assistant: say (or type) what needs doing, check the draft, create.
 *
 *   listen / type  ->  interpret  ->  confirm (editable)  ->  create  ->  done
 *
 * Interpretation runs on the server (Claude, structured JSON) when the
 * workspace has it switched on, and on the built-in rule parser otherwise.
 * Either way the result is only a draft: the person is chosen from the people
 * this user may assign to, nothing is created until "Confirm & Create Task",
 * and the server checks the role and the assignee again on create.
 *
 * Owners and managers assign work to their people. Everyone else is in "personal"
 * mode: same voice and same draft, but it becomes their own private to-do on My
 * Day, because an action item is only ever handed to somebody else.
 */

type Person = { id: string; name: string; designation?: string | null; avatar_url?: string | null };
type Draft = {
  title: string; description: string; owner_id: string;
  priority: string; due_date: string; due_time: string;
};
type Phase = 'compose' | 'interpreting' | 'confirm' | 'creating' | 'done';

const EXAMPLES = [
  'Create a task for Priya to complete pending client confirmation emails.',
  'Assign a high-priority task to Rahul to prepare the project report by tomorrow.',
  'Ask Divya to follow up with the ABC client on Friday.',
];

const PERSONAL_EXAMPLES = [
  'Remind me to call the client tomorrow at 3 pm.',
  'I need to send the monthly report by Friday, high priority.',
  'Follow up on the invoice next Monday.',
];

/** A to-do has three levels where a task has four. */
const TODO_PRIORITY: Record<string, string> = { low: 'low', medium: 'normal', high: 'high', urgent: 'high' };

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const EMPTY: Draft = { title: '', description: '', owner_id: '', priority: 'medium', due_date: '', due_time: '' };

/**
 * The rule parser keeps everything it could not place in the title, which for
 * conversational speech includes the framing: "Hey, create a new task for
 * Priya. She should finish the mails" -> "Finish the mails". Only that framing
 * is removed; the words describing the work are kept as said.
 */
export function tidyTitle(raw: string) {
  let t = raw.replace(/\s+/g, ' ').trim();
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  // A sentence that is only the request itself ("Hey, create a new task.") goes.
  const framing = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|please)\b[,!.\s]*)*(?:can you |could you |please )?(?:create|make|add|set up|assign|give)\b(?: me)?(?: an?| one)?(?: new)?(?: (?:high|low|medium|normal|urgent)[- ]priority)?(?: task| action item| job)?\b[^.!?]*[.!?]?$/i;
  if (sentences.length > 1 && framing.test(sentences[0]) && sentences[0].split(' ').length <= 8) sentences.shift();
  t = sentences.join(' ');
  t = t
    .replace(/^(?:(?:hey|hi|hello|ok(?:ay)?|so|please)\b[,!.\s]*)+/i, '')
    .replace(/^(?:can you |could you )?(?:create|make|add|assign|give)\b(?: me)?(?: an?| one)?(?: new)?(?: (?:high|low|medium|normal|urgent)[- ]priority)?(?: task| action item)?\b(?: (?:for|to))?\s*(?:to\s+)?/i, '')
    .replace(/^(?:ask|tell|get|have)\s+(?:him|her|them)\s+to\s+/i, '')
    .replace(/^(?:she|he|they)\s+(?:should|needs to|need to|has to|have to|must|will|is to)\s+/i, '')
    .replace(/^(?:remind me|i need|i have|i want|i should)\s+(?:to|about)\s+/i, '')
    .replace(/^to\s+/i, '')
    .replace(/[.!?,\s]+$/, '')
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** Priority as people say it, including "high-priority" and "it's urgent". Empty when not said. */
export function spokenPriority(text: string) {
  const m = text.match(/\b(urgent|high|medium|normal|low)[- ]priority\b|\bpriority\s+(?:is\s+|of\s+)?(urgent|high|medium|normal|low)\b/i);
  const word = (m?.[1] || m?.[2] || '').toLowerCase();
  if (word) return word === 'normal' ? 'medium' : word;
  if (/\b(urgent(?:ly)?|asap|as soon as possible|immediately)\b/i.test(text)) return 'urgent';
  return '';
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export default function TaskAssistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [phase, setPhase] = useState<Phase>('compose');
  const [command, setCommand] = useState('');
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [heard, setHeard] = useState('');
  const [choices, setChoices] = useState<Person[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<any>(null);
  // One key per confirm screen: a double click, or a retry after a dropped
  // response, replays the first create instead of making a second task.
  const createKey = useRef(newKey());

  const peopleQ = useQuery({
    queryKey: ['assistant', 'people'],
    queryFn: () => api.get<{ people: Person[]; ai: boolean }>('/assistant/task/people').then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  });
  const people = peopleQ.data?.people || [];
  const aiOn = !!peopleQ.data?.ai;
  const personal = (peopleQ.data as any)?.mode === 'personal';

  const speech = useSpeech({ onFinal: (text) => setCommand(text) });

  // Opening fresh every time: nothing half-done carries over.
  useEffect(() => {
    if (!open) return;
    setPhase('compose'); setCommand(''); setTyping(!speech.supported); setDraft(EMPTY);
    setEditing(false); setHeard(''); setChoices([]); setNotice(''); setError(''); setCreated(null);
    createKey.current = newKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => { speech.stop(); onClose(); };

  // ---------------------------------------------------------- interpret
  const fromRules = (text: string) => {
    const parsed = parseVoiceTask(text, {
      people: people.map((p) => ({ id: p.id, name: p.name })), clients: [], categories: [], selfId: user?.id,
    });
    const owner = parsed.owner_id ? people.find((p) => p.id === parsed.owner_id) : undefined;
    // A name it heard but could not place is the person, not part of the work.
    const stray = parsed.unmatchedPerson || parsed.selfName;
    if (stray) {
      const who = stray.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      parsed.title = parsed.title
        .replace(new RegExp(`^(?:ask|tell|get|have|remind|let)\\s+${who}\\s+(?:to\\s+)?`, 'i'), '')
        .replace(new RegExp(`\\b(?:for|to)\\s+${who}\\b\\s*(?:to\\s+)?`, 'i'), '');
    }
    const cands = (parsed.candidates || []).map((c) => people.find((p) => p.id === c.id)).filter(Boolean) as Person[];
    return {
      draft: {
        ...EMPTY,
        title: tidyTitle(parsed.title),
        owner_id: owner?.id || '',
        priority: parsed.priority || spokenPriority(text) || 'medium',
        due_date: parsed.due_date || '',
        due_time: parsed.due_time || '',
      },
      heard: owner?.name || parsed.unmatchedPerson || parsed.selfName || '',
      matches: owner ? [owner] : cands,
      selfNamed: !!parsed.selfName,
    };
  };

  const interpret = async (text: string) => {
    const said = text.trim();
    if (said.length < 3) { setError('Say or type what needs to be done first.'); return; }
    if (peopleQ.isLoading) { setError('Still getting ready. Try again in a moment.'); return; }
    if (!people.length && !personal) {
      setError(peopleQ.isError ? 'Could not load your team. Check your connection and try again.'
        : 'There is nobody you can assign tasks to yet. People need to report to you (or you need to be the owner).');
      return;
    }
    setError(''); setNotice(''); setPhase('interpreting');

    let next: Draft; let who = ''; let matches: Person[] = [];
    try {
      const res = await api.post<any>('/assistant/task/interpret', { text: said });
      const out = res.data;
      if (out.engine === 'ai') {
        if (!out.understood) {
          setPhase('compose');
          setError(out.clarification || 'I could not find a task in that. Try something like “Ask Priya to send the report by Friday”.');
          return;
        }
        next = { ...EMPTY, ...out.draft, priority: out.draft.priority || 'medium', owner_id: '' };
        who = out.person.heard || '';
        matches = out.person.matches || [];
      } else {
        const r = fromRules(said);
        next = r.draft; who = r.heard; matches = r.matches;
        if (aiOn) setNotice('AI interpretation is unavailable right now, so this was read with the built-in parser. Check the details.');
        if (r.selfNamed && !personal) { setPhase('compose'); setError('Tasks are handed to someone else. Name the person this is for.'); return; }
      }
    } catch (e: any) {
      setPhase('compose');
      setError(e instanceof ApiError && e.status !== 0
        ? e.message : 'Network problem: the command was not sent. Check your connection and try again.');
      return;
    }

    if (!next.title) { setPhase('compose'); setError('I could not tell what the task is. Try saying it again in one sentence.'); return; }
    if (personal) {
      // A to-do is one line, so anything extra the speaker said stays in it.
      next.title = (next.description ? `${next.title}: ${next.description}` : next.title).slice(0, 200);
      next.description = '';
      who = ''; matches = [];
    }
    if (matches.length === 1) next.owner_id = matches[0].id;
    setHeard(who);
    setChoices(matches.length > 1 ? matches : []);
    setDraft(next);
    setEditing(false);
    createKey.current = newKey();
    setPhase('confirm');
  };

  // ------------------------------------------------------------- create
  const owner = people.find((p) => p.id === draft.owner_id);
  const problem = useMemo(() => {
    if (draft.title.trim().length < 2) return 'Add a task title.';
    if (!personal && !draft.owner_id) return choices.length > 1 ? `Choose which ${heard || 'person'} you mean.` : 'Choose who this task is for.';
    return dueError(draft.due_date, draft.due_time);
  }, [draft, choices, heard, personal]);

  const create = async () => {
    if (problem || phase === 'creating') return;
    setPhase('creating'); setError('');
    try {
      const res = personal ? await api.post<any>('/todos', {
        title: draft.title.trim(),
        todo_date: draft.due_date || workspaceToday(),
        due_time: draft.due_date ? (draft.due_time || null) : null,
        priority: TODO_PRIORITY[draft.priority] || 'normal',
      }, { idempotencyKey: createKey.current }) : await api.post<any>('/action-items', {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        owner_id: draft.owner_id,
        priority: draft.priority,
        due_date: draft.due_date || null,
        due_time: draft.due_date ? (draft.due_time || null) : null,
        source_type: 'voice_assistant',
      }, { idempotencyKey: createKey.current });
      setCreated(res.data);
      setPhase('done');
      qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('todos') });
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
    } catch (e: any) {
      setPhase('confirm');
      setError(e instanceof ApiError && e.status !== 0
        ? `The task was not created: ${e.message}`
        : 'Network problem: the task may not have been created. Try again; it will not be duplicated.');
    }
  };

  const restart = () => {
    setPhase('compose'); setCommand(''); setDraft(EMPTY); setError(''); setNotice('');
    setHeard(''); setChoices([]); setCreated(null); createKey.current = newKey();
  };

  // --------------------------------------------------------------- view
  const footer = phase === 'confirm' || phase === 'creating' ? (
    <>
      <Button variant="ghost" onClick={close} disabled={phase === 'creating'}>Cancel</Button>
      {!editing && (
        <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)} disabled={phase === 'creating'}>Edit details</Button>
      )}
      <Button variant="primary" icon={<CheckCircle2 size={15} />} onClick={create}
        loading={phase === 'creating'} disabled={!!problem}>
        {personal ? 'Add to my to-dos' : <>Confirm &amp; Create Task</>}
      </Button>
    </>
  ) : phase === 'done' ? (
    <>
      <Button icon={<RotateCcw size={14} />} onClick={restart}>Create another</Button>
      <Button variant="primary" icon={<ArrowRight size={15} />}
        onClick={() => {
          close();
          if (personal) navigate(isNative || pathname.startsWith('/m') ? '/m/today' : '/');
          else navigate(`/action-items?open=${created?.id}`);
        }}>
        {personal ? 'View my day' : 'Open task'}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={close}>Cancel</Button>
      <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => interpret(command)}
        loading={phase === 'interpreting'} disabled={speech.listening || command.trim().length < 3}>
        {phase === 'interpreting' ? 'Reading your request…' : 'Create draft'}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={close} size="md" footer={footer}
      title={personal ? 'Add by voice' : 'AI Task Assistant'}
      subtitle={phase === 'confirm' || phase === 'creating' ? (personal ? 'Check the details, then add it to your list' : 'Check the details, then create the task')
        : phase === 'done' ? undefined : (personal ? 'What do you need to do?' : 'Tell me what needs to be done…')}>
      {(phase === 'compose' || phase === 'interpreting') && (
        <Compose
          speech={speech} typing={typing} setTyping={setTyping}
          command={command} setCommand={setCommand}
          busy={phase === 'interpreting'} error={error} aiOn={aiOn}
          examples={personal ? PERSONAL_EXAMPLES : EXAMPLES}
          onSubmit={() => interpret(command)}
        />
      )}

      {(phase === 'confirm' || phase === 'creating') && (
        <div className="space-y-4">
          {notice && <Note tone="info">{notice}</Note>}
          {error && <Note tone="error">{error}</Note>}

          {choices.length > 1 && !draft.owner_id && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft p-3">
              <p className="text-[13px] font-medium text-ink flex items-center gap-1.5">
                <Users2 size={14} /> More than one person matches “{heard}”. Which one?
              </p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {choices.map((p) => (
                  <button key={p.id} type="button" onClick={() => setDraft((d) => ({ ...d, owner_id: p.id }))}
                    className="flex items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-2 text-left hover:border-[var(--brand)] cursor-pointer transition-colors">
                    <Avatar name={p.name} url={p.avatar_url} size={26} />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-ink truncate">{p.name}</span>
                      {p.designation && <span className="block text-[11.5px] text-subtle truncate">{p.designation}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {!personal && heard && !choices.length && !draft.owner_id && (
            <Note tone="warning">
              “{heard}” is not someone you can assign tasks to. Choose the person below.
            </Note>
          )}
          {!personal && !heard && !draft.owner_id && <Note tone="warning">No one was named. Choose who this task is for.</Note>}

          {editing ? (
            <div className="space-y-3">
              <Field label="Task title" required>
                <Input value={draft.title} maxLength={240} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </Field>
              {!personal && (
                <>
                  <Field label="Description">
                    <Textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </Field>
                  <AssigneeSelect people={people} value={draft.owner_id} onChange={(id) => setDraft({ ...draft, owner_id: id })} />
                </>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Priority">
                  <Select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                </Field>
                <Field label="Due date">
                  <Input type="date" value={draft.due_date} onChange={(e) => setDraft({ ...draft, due_date: e.target.value, due_time: e.target.value ? draft.due_time : '' })} />
                </Field>
                <Field label="Due time">
                  <Input type="time" value={draft.due_time} disabled={!draft.due_date} onChange={(e) => setDraft({ ...draft, due_time: e.target.value })} />
                </Field>
              </div>
            </div>
          ) : (
            <dl className="rounded-lg border border-line divide-y divide-line">
              <Row label="Task title"><span className="font-medium text-ink">{draft.title}</span></Row>
              {!personal && <Row label="Description">{draft.description || <Muted>None given</Muted>}</Row>}
              {!personal && <Row label="Assigned to">
                {owner ? (
                  <span className="flex items-center gap-2"><Avatar name={owner.name} url={owner.avatar_url} size={22} />{owner.name}</span>
                ) : (
                  <div className="w-full max-w-[260px]">
                    <AssigneeSelect bare people={people} value={draft.owner_id} onChange={(id) => setDraft({ ...draft, owner_id: id })} />
                  </div>
                )}
              </Row>}
              <Row label="Priority">{PRIORITIES.find((p) => p.value === draft.priority)?.label || 'Normal'}</Row>
              <Row label="Due date">
                {draft.due_date
                  ? `${fmtDate(draft.due_date)}${draft.due_time ? `, ${clockTime(draft.due_time)}` : ''}`
                  : <Muted>{personal ? 'Today' : 'Not set'}</Muted>}
              </Row>
              {personal
                ? <Row label="Where"><Muted>Your private list on My Day. Only you can see it.</Muted></Row>
                : <Row label="Assigned by">{user?.name} <span className="text-subtle capitalize">({user?.role?.replace('_', ' ')})</span></Row>}
            </dl>
          )}
          {problem && (personal || draft.owner_id) && <p className="text-[12.5px] text-[var(--negative)]">{problem}</p>}
        </div>
      )}

      {phase === 'done' && created && (
        <div className="py-4 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-positive-soft text-[var(--positive)]">
            <CheckCircle2 size={26} />
          </div>
          <p className="mt-3 text-[15px] font-semibold text-ink">{personal ? 'Added to your to-dos' : 'Task created'}</p>
          <p className="mt-1 text-[13.5px] text-muted">
            {personal
              ? <>“{created.title}” is on your list for {fmtDate(created.todo_date)}{created.due_time ? `, ${clockTime(created.due_time)}` : ''}.</>
              : <>“{created.title}” is assigned to {created.owner_name || owner?.name}. They have been notified.</>}
          </p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- pieces
function Compose({ speech, typing, setTyping, command, setCommand, busy, error, aiOn, examples, onSubmit }: {
  speech: ReturnType<typeof useSpeech>; typing: boolean; setTyping: (v: boolean) => void;
  command: string; setCommand: (v: string) => void; busy: boolean; error: string; aiOn: boolean;
  examples: string[]; onSubmit: () => void;
}) {
  const live = speech.listening ? speech.interim : command;
  return (
    <div className="space-y-4">
      {!typing && (
        <div className="flex flex-col items-center pt-2">
          <button type="button" onClick={speech.listening ? speech.stop : speech.start} disabled={busy}
            aria-label={speech.listening ? 'Stop listening' : 'Start listening'}
            className={cx(
              'relative grid h-20 w-20 place-items-center rounded-full transition-colors duration-200 cursor-pointer',
              'disabled:opacity-50 disabled:cursor-default',
              speech.listening ? 'bg-[var(--brand)] text-[var(--brand-contrast)]' : 'bg-brand-soft text-[var(--brand)] hover:brightness-95',
            )}>
            {speech.listening && (
              <>
                <span className="absolute inset-0 rounded-full bg-[var(--brand)] opacity-30 animate-ping" />
                <span className="absolute -inset-2 rounded-full border-2 border-[var(--brand)] opacity-40 animate-pulse" />
              </>
            )}
            {speech.listening ? <Square size={24} className="relative" /> : <Mic size={30} className="relative" />}
          </button>
          <p className="mt-3 text-[13px] text-muted">
            {speech.listening ? 'Listening… tap to stop' : command ? 'Tap to record again' : 'Tap to start speaking'}
          </p>
          <div className="mt-2 flex gap-2">
            {speech.listening
              ? <Button size="sm" icon={<Square size={13} />} onClick={speech.stop}>Stop</Button>
              : <Button size="sm" variant="ghost" icon={<Mic size={13} />} onClick={speech.start} disabled={busy}>Start</Button>}
          </div>
        </div>
      )}

      {typing ? (
        <Field label="Type your request" hint="One sentence: who, what, and by when if there is a deadline.">
          <Textarea rows={3} autoFocus value={command} disabled={busy}
            placeholder="Ask Priya to complete the pending client confirmation emails by Friday"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }} />
        </Field>
      ) : (
        <div className={cx('min-h-[64px] rounded-lg border px-3.5 py-3 text-[14px] leading-relaxed',
          live ? 'border-line bg-sunken text-ink' : 'border-dashed border-line text-subtle')} aria-live="polite">
          {live || 'Your words will appear here as you speak.'}
          {!speech.listening && command && (
            <button type="button" onClick={() => setTyping(true)} className="ml-2 text-[12.5px] text-[var(--brand)] hover:underline cursor-pointer">Edit</button>
          )}
        </div>
      )}

      {speech.error && <Note tone="error">{speech.error}</Note>}
      {error && <Note tone="error">{error}</Note>}

      <div className="flex items-center justify-between gap-2">
        {speech.supported ? (
          <button type="button" onClick={() => { speech.stop(); setTyping(!typing); }}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink cursor-pointer">
            {typing ? <><Mic size={13} /> Use the microphone</> : <><Keyboard size={13} /> Type instead</>}
          </button>
        ) : <span className="text-[12.5px] text-subtle">Voice input needs Chrome, Edge or Safari.</span>}
        <span className="text-[11.5px] text-subtle">{aiOn ? 'AI interpretation on' : 'Built-in interpretation'}</span>
      </div>

      {!command && !speech.listening && (
        <div>
          <p className="label-cap mb-1.5">Try saying</p>
          <ul className="space-y-1">
            {examples.map((x) => (
              <li key={x}>
                <button type="button" onClick={() => { setTyping(true); setCommand(x); }}
                  className="w-full text-left text-[13px] text-muted hover:text-ink rounded px-2 py-1 -mx-2 hover:bg-sunken cursor-pointer">
                  “{x}”
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AssigneeSelect({ people, value, onChange, bare }: {
  people: Person[]; value: string; onChange: (id: string) => void; bare?: boolean;
}) {
  const select = (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Assigned to">
      <option value="">Choose a person…</option>
      {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` · ${p.designation}` : ''}</option>)}
    </Select>
  );
  return bare ? select : <Field label="Assigned to" required>{select}</Field>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <dt className="text-[12px] text-subtle sm:w-28 shrink-0">{label}</dt>
      <dd className="text-[13.5px] text-ink min-w-0 break-words">{children}</dd>
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-subtle">{children}</span>;

function Note({ tone, children }: { tone: 'info' | 'warning' | 'error'; children: React.ReactNode }) {
  const cls = tone === 'error' ? 'bg-negative-soft text-[var(--negative)]'
    : tone === 'warning' ? 'bg-warning-soft text-[var(--warning)]' : 'bg-info-soft text-[var(--info)]';
  return (
    <p className={cx('flex items-start gap-2 rounded-md px-3 py-2 text-[13px]', cls)} role={tone === 'error' ? 'alert' : undefined}>
      <AlertCircle size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
