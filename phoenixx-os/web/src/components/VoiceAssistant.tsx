import { useEffect, useRef, useState } from 'react';
import { Mic, Square, SkipForward, Volume2 } from 'lucide-react';
import {
  listenOnce, matchPeople, nearestPeople, parseVoiceTask, speak, stopSpeaking,
  type Listening, type Named,
} from '../lib/voiceTask';
import { clockTime, workspaceToday } from '../lib/format';
import { dueError } from '../pages/ActionItems';
import { Avatar, cx } from './ui';

/**
 * A spoken interview for a new action item: it asks, you answer, the form
 * fills in front of you. One field per question, so the answer to "who?" is
 * only ever a name and never has to be fished out of a sentence.
 *
 * Say "skip" on the optional questions, "back" to redo the last one, "cancel"
 * to stop. Everything it fills stays editable by hand, before and after.
 */
export type VoiceDraft = {
  title: string; owner_id: string; priority: string;
  due_date: string; due_time: string; description: string;
};

type Step = 'title' | 'person' | 'priority' | 'due' | 'description' | 'confirm';
const STEPS: Step[] = ['title', 'person', 'priority', 'due', 'description', 'confirm'];
const STEP_LABEL: Record<Step, string> = {
  title: 'Title', person: 'Assign to', priority: 'Priority', due: 'Deadline',
  description: 'Details', confirm: 'Confirm',
};

class Cancelled extends Error {}
class GoBack extends Error {}

const SKIP = /^(skip|skip it|next|nothing|none|no|nope|no thanks|not now|leave it)\.?$/i;
const CANCEL = /^(cancel|stop|exit|quit|close)( it| this)?\.?$/i;
const BACK = /^(go )?back\.?$|^previous( question)?\.?$/i;
const YES = /\b(yes|yeah|yep|yup|ya|haan|ha|correct|create( it)?|ok(ay)?|sure|go ahead|do it|confirm|done|perfect|right)\b/i;
const ORDINALS = ['first|one|1st|1', 'second|two|2nd|2', 'third|three|3rd|3', 'fourth|four|4th|4'];

function spokenDate(iso: string) {
  if (iso === workspaceToday()) return 'today';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function priorityFrom(text: string) {
  const t = text.toLowerCase();
  if (/urgent|emergency|asap|immediate|critical|top/.test(t)) return 'urgent';
  if (/\bhigh\b|\bhi\b|important|hai\b/.test(t)) return 'high';
  if (/\blow\b|\blo\b|\blaw\b|not urgent|whenever/.test(t)) return 'low';
  if (/medium|normal|mid|regular|average|moderate|meeting/.test(t) || SKIP.test(t)) return 'medium';
  return '';
}

export function VoiceAssistant({ getPeople, selfId, put, onCreate, onEnd }: {
  getPeople: () => Named[];
  selfId?: string;
  /** Write answers into the form as they arrive. */
  put: (patch: Partial<VoiceDraft>) => void;
  /** Everything checked - create it. */
  onCreate: (draft: VoiceDraft) => void;
  onEnd: () => void;
}) {
  const [step, setStep] = useState<Step>('title');
  const [phase, setPhase] = useState<'speaking' | 'listening' | 'thinking'>('speaking');
  const [question, setQuestion] = useState('');
  const [interim, setInterim] = useState('');
  const [choices, setChoices] = useState<Named[]>([]);
  const [lastHeard, setLastHeard] = useState('');

  const tokRef = useRef({ dead: false });
  const listening = useRef<Listening | null>(null);
  // A tap on a "did you mean" chip or the Skip button answers the question
  // without anyone having to speak.
  const tapAnswer = useRef<((v: string) => void) | null>(null);

  const answerByTap = (v: string) => {
    listening.current?.abort();
    stopSpeaking();
    tapAnswer.current?.(v);
  };

  const stop = () => {
    tokRef.current.dead = true;
    stopSpeaking();
    listening.current?.abort();
    tapAnswer.current?.('cancel');
    onEnd();
  };

  useEffect(() => {
    // One token per run: a remount (React's dev double-mount included) kills
    // the old conversation instead of letting two talk over each other.
    const tok = { dead: false };
    tokRef.current = tok;
    script(tok)().catch(() => {}).finally(() => { if (!tok.dead) onEnd(); });
    return () => { tok.dead = true; stopSpeaking(); listening.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function script(tok: { dead: boolean }) {

  /* ------------------------------------------------------------ talking */
  async function say(line: string) {
    if (tok.dead) throw new Cancelled();
    setQuestion(line);
    setPhase('speaking');
    await speak(line);
    if (tok.dead) throw new Cancelled();
  }

  /** Ask, then wait for a spoken or tapped reply. Silence is asked again, twice. */
  async function ask(line: string, { allowBack = true } = {}): Promise<string> {
    await say(line);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tok.dead) throw new Cancelled();
      setPhase('listening');
      setInterim('');
      const tapped = new Promise<string>((resolve) => { tapAnswer.current = resolve; });
      const heard = listenOnce(setInterim);
      listening.current = heard;
      let text: string;
      try {
        text = await Promise.race([heard.result, tapped]);
      } catch {
        await say('Your microphone is blocked. Allow it from the lock icon in the address bar, then try again.')
          .catch(() => {});
        throw new Cancelled();
      } finally {
        heard.abort();
        listening.current = null;
        tapAnswer.current = null;
      }
      if (tok.dead) throw new Cancelled();
      text = text.trim();
      if (!text) {
        if (attempt < 2) { await say(attempt === 0 ? 'Sorry, I didn’t catch that.' : 'Still there? ' + line); continue; }
        await say('I’ll stop here. Finish the rest on screen, or tap the mic to start again.');
        throw new Cancelled();
      }
      setLastHeard(text);
      setPhase('thinking');
      if (CANCEL.test(text)) {
        await say('Okay, stopped. What I filled in is still on screen.');
        throw new Cancelled();
      }
      if (allowBack && BACK.test(text)) throw new GoBack();
      return text;
    }
    throw new Cancelled();
  }

  /* ------------------------------------------------------------ the script */
  async function run() {
    const d: VoiceDraft = { title: '', owner_id: '', priority: 'medium', due_date: '', due_time: '', description: '' };
    let ownerName = '';
    let i = 0;
    let backToConfirm = false;
    const people = () => getPeople().filter((p) => p.id !== selfId);

    while (i < STEPS.length) {
      const s = STEPS[i];
      setStep(s);
      setChoices([]);
      try {
        if (s === 'title') {
          let line = 'What’s the title of the task?';
          for (;;) {
            const a = await ask(line, { allowBack: false });
            const title = a.replace(/^(the )?(title|task)( is|:)?\s+/i, '').replace(/[.\s]+$/, '');
            if (title.length >= 2) {
              d.title = title.charAt(0).toUpperCase() + title.slice(1);
              put({ title: d.title });
              break;
            }
            line = 'That was a bit short. What’s the task?';
          }
        }

        if (s === 'person') {
          let line = 'Who should I assign it to?';
          let options: Named[] = [];
          let found: Named | null = null;
          for (let tries = 0; tries < 4 && !found; tries++) {
            setChoices(options);
            const a = await ask(line);
            if (a.startsWith('pick:')) { found = getPeople().find((p) => p.id === a.slice(5)) || null; break; }

            // Answering a "did you mean" - by name, or "the first one".
            if (options.length) {
              const ord = ORDINALS.findIndex((o) => new RegExp(`\\b(${o})\\b`, 'i').test(a));
              if (ord >= 0 && options[ord]) { found = options[ord]; break; }
              const among = matchPeople(a, options);
              if (among[0] && (!among[1] || among[1].score < among[0].score)) { found = among[0].item; break; }
            }

            const spoken = a.replace(/^(assign (it )?to|give (it )?to|to|for|it'?s|its)\s+/i, '');
            const hits = matchPeople(spoken, getPeople());
            const others = hits.filter((h) => h.item.id !== selfId);
            const self = hits.find((h) => h.item.id === selfId);
            const top = others[0];
            if (top && (!others[1] || others[1].score < top.score) && (!self || self.score < top.score)) {
              found = top.item; break;
            }
            if (others.length > 1) {
              options = others.slice(0, 4).map((h) => h.item);
              line = `Did you mean ${options.map((o) => o.name).join(', or ')}?`;
            } else if (self) {
              options = nearestPeople(spoken, people());
              line = 'That sounds like you. Action items go to someone else; your own to-dos go on My Day. Who should do it?';
            } else {
              options = nearestPeople(spoken, people());
              line = options.length
                ? `I couldn’t find ${spoken}. Did you mean ${options.map((o) => o.name).join(', or ')}?`
                : `I couldn’t find ${spoken} in the team. Please say the name again, or pick on screen.`;
            }
          }
          if (found) {
            d.owner_id = found.id;
            ownerName = found.name;
            put({ owner_id: found.id });
          }
        }

        if (s === 'priority') {
          let line = 'What priority? Urgent, high, medium, or low.';
          for (let tries = 0; tries < 3; tries++) {
            const a = await ask(line);
            const p = priorityFrom(a);
            if (p) { d.priority = p; put({ priority: p }); break; }
            line = 'Please say urgent, high, medium, or low.';
          }
        }

        if (s === 'due') {
          let line = 'When is it due? For example, tomorrow 5 PM. Or say no deadline.';
          for (let tries = 0; tries < 4; tries++) {
            const a = await ask(line);
            if (SKIP.test(a) || /no (deadline|due date|date)|any ?time|whenever/i.test(a)) {
              d.due_date = ''; d.due_time = ''; put({ due_date: '', due_time: '' });
              break;
            }
            const p = parseVoiceTask(a, { people: [], clients: [], categories: [] });
            const date = p.due_date || d.due_date;
            let time = p.due_time || (p.due_date ? '' : d.due_time);
            if (!date) { line = 'I didn’t get a date. Try something like Friday, tomorrow, or the 20th.'; continue; }
            if (date === workspaceToday() && !time) {
              const t = await ask('What time today?');
              time = parseVoiceTask(/\d|noon|evening|morning|afternoon/i.test(t) && !/\b(at|by)\b/i.test(t) ? `at ${t}` : t,
                { people: [], clients: [], categories: [] }).due_time || '';
            }
            const problem = dueError(date, time);
            d.due_date = date; d.due_time = time;
            put({ due_date: date, due_time: time });
            if (problem) { line = `${problem.replace(/ — /g, '. ')}. When is it due?`; continue; }
            break;
          }
        }

        if (s === 'description') {
          const a = await ask('Any details to add? Say skip if not.');
          if (!SKIP.test(a)) { d.description = a.charAt(0).toUpperCase() + a.slice(1); put({ description: d.description }); }
        }

        if (s === 'confirm') {
          const missing = [
            d.title.trim().length < 2 && 'a title',
            !d.owner_id && 'who it goes to',
            dueError(d.due_date, d.due_time) && 'a valid deadline',
          ].filter(Boolean) as string[];
          if (missing.length) {
            await say(`I still need ${missing.join(' and ')}. Fill that in on screen, then press Create item.`);
            return;
          }
          const when = d.due_date
            ? `due ${spokenDate(d.due_date)}${d.due_time ? ` at ${clockTime(d.due_time)}` : ''}`
            : 'no deadline';
          let line = `${d.title}. For ${ownerName}. ${d.priority} priority, ${when}. Shall I create it?`;
          for (;;) {
            const a = await ask(line);
            const change = a.match(/\b(title|name|task|person|assign\w*|who|owner|priority|deadline|due|date|time|when|details?|description)\b/i);
            if (change && /change|edit|fix|wrong|update|redo|not|different/i.test(a)) {
              const w = change[1].toLowerCase();
              const target: Step = /title|task/.test(w) ? 'title'
                : /name|person|assign|who|owner/.test(w) ? 'person'
                  : /priority/.test(w) ? 'priority'
                    : /detail|description/.test(w) ? 'description' : 'due';
              i = STEPS.indexOf(target) - 1;
              backToConfirm = true;
              break;
            }
            if (YES.test(a) && !/\b(no|don'?t|not)\b/i.test(a)) {
              await say('Creating it now.');
              onCreate({ ...d });
              return;
            }
            if (/^\s*(no|nope|not yet|wait|hold on)\b/i.test(a)) {
              await say('Okay, I haven’t created it. Edit anything on screen, then press Create item.');
              return;
            }
            line = 'Say yes to create it, or say change, then the title, person, priority, or deadline.';
          }
        }
        i = backToConfirm && STEPS[i] !== 'confirm' ? STEPS.indexOf('confirm') : i + 1;
        if (STEPS[i] === 'confirm') backToConfirm = false;
      } catch (e) {
        if (e instanceof GoBack) { i = Math.max(0, i - 1); backToConfirm = false; continue; }
        throw e;
      }
    }
  }

  return run;
  }

  /* ------------------------------------------------------------ screen */
  const at = STEPS.indexOf(step);
  const optional = step === 'description';

  return (
    <div className="rounded-lg border border-[var(--brand)] bg-brand-soft p-3" aria-live="polite">
      <div className="flex items-center gap-1.5 mb-2.5">
        {STEPS.map((s, k) => (
          <span key={s} title={STEP_LABEL[s]}
            className={cx('h-1.5 flex-1 rounded-full transition-colors duration-200',
              k < at ? 'bg-[var(--brand)]' : k === at ? 'bg-[var(--brand)] opacity-60' : 'bg-line-strong')} />
        ))}
      </div>

      <div className="flex items-start gap-3">
        <span className={cx('relative grid h-10 w-10 shrink-0 place-items-center rounded-full',
          phase === 'listening' ? 'bg-[var(--negative)] text-[var(--negative-contrast)]'
            : 'bg-[var(--brand)] text-[var(--brand-contrast)]')}>
          {phase === 'listening' && (
            <span className="absolute inset-0 rounded-full bg-[var(--negative)] opacity-40 animate-ping" aria-hidden />
          )}
          {phase === 'listening' ? <Mic size={18} className="relative" /> : <Volume2 size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="label-cap">
            {STEP_LABEL[step]} · {phase === 'speaking' ? 'asking' : phase === 'listening' ? 'listening' : 'got it'}
          </p>
          <p className="mt-0.5 text-[14.5px] font-medium text-ink">{question}</p>
          <p className="mt-1 min-h-[18px] text-[12.5px] text-muted">
            {phase === 'listening' ? (interim ? `“${interim}”` : 'Speak now…')
              : lastHeard ? <><span className="text-subtle">Heard:</span> “{lastHeard}”</> : null}
          </p>
        </div>
      </div>

      {!!choices.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <button key={c.id} type="button" onClick={() => answerByTap(`pick:${c.id}`)}
              className="flex items-center gap-1.5 rounded-full border border-line-strong bg-raised py-0.5 pl-0.5 pr-2.5
                         text-[12.5px] text-ink cursor-pointer transition-colors duration-150
                         hover:border-[var(--brand)]">
              <Avatar name={c.name} size={20} />{c.name}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2 border-t border-[color-mix(in_srgb,var(--brand)_20%,transparent)] pt-2.5">
        <p className="text-[12px] text-subtle">Say “back”, “skip” or “cancel” any time</p>
        <div className="ml-auto flex gap-1.5">
          {(optional || step === 'priority') && phase === 'listening' && (
            <button type="button" onClick={() => answerByTap('skip')}
              className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-raised px-2 text-[12.5px]
                         text-muted cursor-pointer hover:text-ink">
              <SkipForward size={12} />Skip
            </button>
          )}
          <button type="button" onClick={stop}
            className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-raised px-2 text-[12.5px]
                       text-muted cursor-pointer hover:text-[var(--negative)]">
            <Square size={11} />Stop
          </button>
        </div>
      </div>
    </div>
  );
}
