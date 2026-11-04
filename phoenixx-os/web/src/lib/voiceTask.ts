import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceToday } from './format';

/* ========================================================= SPEECH CAPTURE */
/**
 * The browser's own speech recognition (Chrome, Edge, Safari). Nothing leaves
 * for a paid service and there is no key to manage; Firefox simply has no mic
 * button. Indian English is the default because it hears local names - Adithya,
 * Cotton India - far better than en-US does.
 */
const Recognition: any = typeof window !== 'undefined'
  ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  : null;

export const speechSupported = !!Recognition;
export const voiceAssistantSupported = !!Recognition
  && typeof window !== 'undefined' && 'speechSynthesis' in window;

/* ================================================= ONE QUESTION, ONE ANSWER */
/**
 * The pieces a spoken conversation is built from: say a line, hear one reply.
 * Each returns a handle that can be stopped mid-flight, so the Stop button and
 * closing the form both cut the assistant off at once.
 */
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'en-IN')
    || voices.find((v) => /^en[-_]GB/i.test(v.lang))
    || voices.find((v) => /^en/i.test(v.lang));
}

export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-IN';
    u.rate = 1.05;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(guard); resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    // Chrome now and then never fires onend; never leave the assistant hanging.
    const guard = setTimeout(finish, 2500 + text.length * 90);
    synth.speak(u);
  });
}

export function stopSpeaking() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export type Listening = { result: Promise<string>; abort: () => void };

/**
 * Hear a single reply. Resolves with what was said ('' for silence); rejects
 * only when the microphone is refused, since then asking again is pointless.
 */
export function listenOnce(onInterim: (text: string) => void, lang = 'en-IN'): Listening {
  const r = new Recognition();
  r.lang = lang;
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 1;
  let text = '';
  let failure: string | null = null;
  const result = new Promise<string>((resolve, reject) => {
    r.onresult = (e: any) => {
      let finalPart = '';
      let live = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalPart += e.results[i][0].transcript;
        else live += e.results[i][0].transcript;
      }
      text = finalPart || text;
      onInterim((finalPart + live).trim());
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') failure = 'mic-blocked';
    };
    r.onend = () => (failure ? reject(new Error(failure)) : resolve(text.trim()));
  });
  try { r.start(); } catch { /* already started */ }
  return { result, abort: () => { try { r.abort(); } catch { /* gone */ } } };
}

export function useSpeech({ lang = 'en-IN', onFinal }: {
  lang?: string;
  onFinal: (text: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const rec = useRef<any>(null);
  const finalText = useRef('');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => () => rec.current?.abort(), []);

  const start = useCallback(() => {
    if (!Recognition || rec.current) return;
    const r = new Recognition();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    finalText.current = '';
    setInterim('');
    setError('');

    r.onresult = (e: any) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText.current += `${t} `;
        else live += t;
      }
      setInterim(`${finalText.current}${live}`.trim());
    };
    r.onerror = (e: any) => {
      setError(e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone access is blocked — allow it from the lock icon in the address bar'
        : e.error === 'no-speech' ? 'Didn’t hear anything — try again a little closer to the mic'
          : e.error === 'aborted' ? '' : `Voice input stopped (${e.error})`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const text = finalText.current.trim();
      if (text) onFinalRef.current(text);
    };

    rec.current = r;
    r.start();
    setListening(true);
  }, [lang]);

  const stop = useCallback(() => rec.current?.stop(), []);

  return { listening, interim, error, start, stop, supported: speechSupported };
}

/* ========================================================= TASK PARSING */
/**
 * Turns "Ask Adithya to send the August report to Cotton India by Friday 5pm,
 * high priority" into form fields. Deliberately plain rules rather than a model:
 * it is instant, free, and when it guesses wrong the form is right there to fix.
 * Anything it cannot place stays in the title, so nothing said is lost.
 */
export type Named = { id: string; name: string };

export type VoiceParse = {
  title: string;
  owner_id?: string; owner_name?: string;
  client_id?: string; client_name?: string;
  category_id?: string; category_name?: string;
  priority?: string;
  due_date?: string;
  due_time?: string;
  recurrence?: string;
  estimate_minutes?: string;
  unmatchedPerson?: string;
  /** People it might mean, when it could not be sure enough to pick one. */
  candidates?: Named[];
  /** The name heard was the speaker's own - action items go to somebody else. */
  selfName?: string;
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MONTH_RE = `(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)`;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45,
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = (n: number) => String(n).padStart(2, '0');

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** The longest catalogue entry named in the text - by full name, else first name. */
function findNamed(text: string, list: Named[], { firstName = false } = {}) {
  let best: { item: Named; match: string } | null = null;
  const consider = (item: Named, phrase: string) => {
    if (phrase.length < 3) return;
    const m = text.match(new RegExp(`\\b${esc(phrase)}\\b`, 'i'));
    if (m && (!best || m[0].length > best.match.length)) best = { item, match: m[0] };
  };
  for (const item of list) {
    consider(item, item.name.trim());
    if (firstName) consider(item, item.name.trim().split(/\s+/)[0]);
  }
  return best as { item: Named; match: string } | null;
}

/**
 * Speech engines spell Indian names however they like - Ranjit / Ranjith,
 * Aditya / Adithya, Sreeja / Sreja. Fold the usual variations away before
 * comparing: aspirated consonants, doubled letters, long vowels.
 */
function soundKey(s: string) {
  return s.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/([kgcjtdpbs])h/g, '$1').replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/w/g, 'v').replace(/z/g, 's').replace(/(.)\1+/g, '$1').replace(/h$/, '');
}

function lev(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// Words a fuzzy match must never land on, however close they sound to a name.
const NOT_NAMES = new Set(('the and for with this that task item today tomorrow report send call make '
  + 'take have need should please update project client meeting monday tuesday wednesday thursday '
  + 'friday saturday sunday morning evening priority urgent high low medium every daily weekly monthly '
  + 'regarding about deadline deadlines review check email follow before after hours minutes').split(' '));

export type PersonHit = { item: Named; match: string; score: number };

/**
 * Every person the sentence could mean, best first. Full name beats first name
 * beats a sounds-like match; a tie between two people is left for a human.
 */
export function matchPeople(text: string, list: Named[]): PersonHit[] {
  const words = [...text.matchAll(/[A-Za-z]+/g)].map((m) => ({ w: m[0], i: m.index! }));
  const best = new Map<string, PersonHit>();
  const offer = (hit: PersonHit) => {
    const had = best.get(hit.item.id);
    if (!had || hit.score > had.score) best.set(hit.item.id, hit);
  };
  for (const item of list) {
    const parts = item.name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const keys = parts.map(soundKey);
    for (let k = 0; k < words.length; k++) {
      const span = (n: number) => text.slice(words[k].i, words[k + n - 1].i + words[k + n - 1].w.length);
      // Full name, spelt as stored or near enough.
      if (parts.length > 1 && k + parts.length <= words.length) {
        const said = words.slice(k, k + parts.length).map((x) => soundKey(x.w));
        if (said.every((s, j) => s === keys[j] || (s.length >= 4 && lev(s, keys[j]) <= 1))) {
          offer({ item, match: span(parts.length), score: 4 });
        }
      }
      const w = words[k].w;
      if (w.length < 3 || NOT_NAMES.has(w.toLowerCase())) continue;
      const sk = soundKey(w);
      parts.forEach((part, j) => {
        const isFirst = j === 0;
        if (w.toLowerCase() === part.toLowerCase()) offer({ item, match: w, score: isFirst ? 3 : 2.5 });
        else if (sk === keys[j] && sk.length >= 3) offer({ item, match: w, score: isFirst ? 2.5 : 2 });
        else if (sk.length >= 4 && lev(sk, keys[j]) <= (sk.length >= 7 ? 2 : 1)) {
          offer({ item, match: w, score: isFirst ? 1.5 : 1 });
        }
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** For "Did you mean…" when nothing matched outright: the closest-sounding names. */
export function nearestPeople(word: string, list: Named[], n = 3) {
  const sk = soundKey(word);
  return list
    .map((item) => ({
      item,
      d: Math.min(...item.name.split(/\s+/).map((p) => lev(sk, soundKey(p)) / Math.max(sk.length, 1))),
    }))
    .filter((x) => x.d <= 0.5)
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.item);
}

function toTime(hRaw: string, mRaw: string | undefined, ampm: string | undefined) {
  let h = Number(NUMBER_WORDS[hRaw.toLowerCase()] ?? hRaw);
  const m = mRaw ? Number(mRaw) : 0;
  if (Number.isNaN(h) || h > 23 || m > 59) return '';
  const mer = ampm?.replace(/\./g, '').toLowerCase();
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  // A bare "by 5" in an office means the afternoon, not before dawn.
  if (!mer && h >= 1 && h <= 7) h += 12;
  return `${pad(h)}:${pad(m)}`;
}

export function parseVoiceTask(raw: string, ctx: {
  people: Named[]; clients: Named[]; categories: Named[]; selfId?: string;
}): VoiceParse {
  let t = ` ${raw.replace(/\s+/g, ' ').trim()} `;
  const out: VoiceParse = { title: '' };
  const cut = (re: RegExp) => { t = t.replace(re, ' '); };
  const today = workspaceToday();

  // ---------------------------------------------------------------- priority
  const pr = t.match(/\b(?:(?:it'?s|make it|mark it|set)\s+)?(?:as\s+)?(urgent|high|medium|normal|low)\s+priority\b|\bpriority\s+(?:is\s+)?(urgent|high|medium|normal|low)\b|\b(urgent(?:ly)?|asap|as soon as possible|immediately)\b/i);
  if (pr) {
    const word = (pr[1] || pr[2] || 'urgent').toLowerCase();
    out.priority = word === 'normal' ? 'medium' : word.startsWith('urgent') || pr[3] ? 'urgent' : word;
    cut(new RegExp(`[,.]?\\s*${esc(pr[0])}`, 'i'));
  }

  // -------------------------------------------------------------- recurrence
  const rc = t.match(/\b(every\s*day|daily|every\s+week(?:day)?|weekly|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|every\s+month|monthly)\b/i);
  if (rc) {
    const w = rc[1].toLowerCase();
    out.recurrence = /day$|daily|weekday/.test(w) && !/(mon|tues|wednes|thurs|fri|satur|sun)day/.test(w) ? 'daily'
      : /month/.test(w) ? 'monthly' : 'weekly';
    cut(new RegExp(`[,.]?\\s*(?:and\\s+)?(?:repeat\\s+)?${esc(rc[0])}`, 'i'));
  }

  // -------------------------------------------------------------- estimate
  const es = t.match(/\b(?:(?:it\s+)?(?:will\s+)?(?:takes?|need?s?|estimate[ds]?(?:\s+at)?|effort(?:\s+of)?)\s+(?:about\s+|around\s+)?)?(half an hour|an hour|(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|ten|fifteen|twenty|thirty|forty five|forty)\s*(hours?|hrs?|minutes?|mins?))\b/i);
  if (es && /takes?|need|estimate|effort|hour|min/i.test(es[0])) {
    let mins = 0;
    if (/half an hour/i.test(es[1])) mins = 30;
    else if (/^an hour/i.test(es[1])) mins = 60;
    else {
      const n = Number(NUMBER_WORDS[es[2].toLowerCase()] ?? es[2]);
      mins = /^h/i.test(es[3]) ? Math.round(n * 60) : Math.round(n);
    }
    if (mins > 0) { out.estimate_minutes = String(mins); cut(new RegExp(`[,.]?\\s*${esc(es[0])}`, 'i')); }
  }

  // -------------------------------------------------------------- due time
  const PREP = '(?:by|at|before|around|till|until|due)?\\s*';
  const tm = t.match(new RegExp(`\\b${PREP}(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?|o'?clock)(?=\\W)`, 'i'))
    || t.match(/\b(?:by|at|before|around)\s+(\d{1,2})[:.](\d{2})\b()/i)
    || t.match(/\b(?:by|at|before)\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|days?|weeks?|hours?|mins?|minutes?|\/|-|(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))()/i);
  if (tm) {
    const time = toTime(tm[1], tm[2], /o'?clock/i.test(tm[3] || '') ? undefined : tm[3]);
    if (time) { out.due_time = time; cut(new RegExp(`[,.]?\\s*${esc(tm[0])}`, 'i')); }
  }
  if (!out.due_time) {
    const named = t.match(/\b(?:by|before|at|in the|this)?\s*(noon|midday|lunch(?:time)?|end of (?:the )?day|eod|close of business|cob|this evening|evening|tonight|this morning|morning|afternoon)\b/i);
    if (named) {
      const w = named[1].toLowerCase();
      out.due_time = /noon|midday|lunch/.test(w) ? '12:00' : /morning/.test(w) ? '10:00'
        : /afternoon/.test(w) ? '15:00' : /tonight/.test(w) ? '20:00' : '18:00';
      if (/tonight|this evening|this morning|end of (the )?day|eod|close of business|cob/.test(w)) out.due_date = today;
      cut(new RegExp(`[,.]?\\s*${esc(named[0])}`, 'i'));
    }
  }

  // -------------------------------------------------------------- due date
  const DP = '(?:due\\s+|by\\s+|on\\s+|before\\s+|for\\s+)?';
  const dateRules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [new RegExp(`\\b${DP}(?:the\\s+)?day after tomorrow\\b`, 'i'), () => addDays(today, 2)],
    [new RegExp(`\\b${DP}tomorrow\\b`, 'i'), () => addDays(today, 1)],
    [new RegExp(`\\b${DP}today\\b`, 'i'), () => today],
    [new RegExp(`\\b${DP}(?:in|within)\\s+(\\d+|one|two|three|four|five|six|seven|ten)\\s+(days?|weeks?)\\b`, 'i'),
      (m) => addDays(today, Number(NUMBER_WORDS[m[1].toLowerCase()] ?? m[1]) * (/week/i.test(m[2]) ? 7 : 1))],
    [new RegExp(`\\b${DP}(?:the\\s+)?end of (?:the |this )?week\\b`, 'i'),
      () => addDays(today, (5 - weekdayOf(today) + 7) % 7)],
    [new RegExp(`\\b${DP}(?:the\\s+)?end of (?:the |this )?month\\b`, 'i'), () => {
      const d = new Date(`${today}T00:00:00Z`);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    }],
    [new RegExp(`\\b${DP}next week\\b`, 'i'), () => addDays(today, 7)],
    [new RegExp(`\\b${DP}(this\\s+|next\\s+|coming\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i'), (m) => {
      const target = WEEKDAYS.indexOf(m[2].toLowerCase());
      // "Friday" and "next Friday" both mean the coming one; saying it on a
      // Friday means a week out, never today.
      return addDays(today, (target - weekdayOf(today) + 7) % 7 || 7);
    }],
    // "15th August", "15 of Aug"
    [new RegExp(`\\b${DP}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i'),
      (m) => monthDay(Number(m[1]), m[2])],
    // "August 15th"
    [new RegExp(`\\b${DP}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), (m) => monthDay(Number(m[2]), m[1])],
    // "15/10" - day first, as written in India
    [new RegExp(`\\b${DP}(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\b`, 'i'), (m) => {
      const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4);
      const iso = `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
      return !m[3] && iso < today ? `${Number(y) + 1}${iso.slice(4)}` : iso;
    }],
    // "on the 20th"
    [new RegExp(`\\b(?:due\\s+|by\\s+|on\\s+|before\\s+)(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b`, 'i'), (m) => {
      const day = Number(m[1]);
      let iso = `${today.slice(0, 8)}${pad(day)}`;
      if (iso < today) {
        const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 1);
        iso = `${d.toISOString().slice(0, 8)}${pad(day)}`;
      }
      return iso;
    }],
  ];
  function monthDay(day: number, monthWord: string) {
    const mi = MONTHS.findIndex((mo) => mo.startsWith(monthWord.toLowerCase().slice(0, 3)));
    const y = Number(today.slice(0, 4));
    const iso = `${y}-${pad(mi + 1)}-${pad(day)}`;
    return iso < today ? `${y + 1}-${pad(mi + 1)}-${pad(day)}` : iso;
  }
  for (const [re, fn] of dateRules) {
    const m = t.match(re);
    if (!m) continue;
    const iso = fn(m);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso))) {
      out.due_date = iso;
      cut(new RegExp(`[,.]?\\s*${esc(m[0])}`, 'i'));
      break;
    }
  }
  // A time with no day said means the next time that hour comes round.
  if (out.due_time && !out.due_date) out.due_date = today;

  // -------------------------------------------------------------- assignee
  const hits = matchPeople(t, ctx.people);
  const others = hits.filter((h) => h.item.id !== ctx.selfId);
  const selfHit = hits.find((h) => h.item.id === ctx.selfId);
  const top = others[0];
  // Sure enough to pick: a clear winner that beats any other person outright,
  // and is at least as strong a match as the speaker's own name.
  const clear = top && (!others[1] || others[1].score < top.score)
    && (!selfHit || selfHit.score < top.score);
  const dropName = (match: string) => {
    // "assign to X", "ask X to", "task for X", "X should" - drop the
    // instruction around the name, keep the work itself.
    cut(new RegExp(`\\b(?:(?:an?\\s+)?task\\s+for|(?:please\\s+)?(?:assign(?:ed)?|give|hand|allot)\\s+(?:this|it|the task)?\\s*to|ask|tell|remind|get|have|for|with|owner(?:\\s+is)?|assignee(?:\\s+is)?)?\\s*${esc(match)}\\b(?:\\s+(?:to|should|needs? to|has to|must|will|can you|please))?`, 'i'));
  };
  if (clear) {
    out.owner_id = top.item.id;
    out.owner_name = top.item.name;
    dropName(top.match);
  } else {
    if (selfHit && (!top || selfHit.score >= top.score)) out.selfName = selfHit.match;
    if (others.length) {
      out.candidates = others.slice(0, 4).map((h) => h.item);
      dropName((selfHit && out.selfName ? selfHit : others[0]).match);
    } else {
      const loose = t.match(/\b(?:(?:an?\s+)?task\s+for|assign(?:ed)?\s+(?:this\s+|it\s+)?to|ask|tell|remind|for)\s+([A-Za-z]{3,})/i);
      if (loose && !NOT_NAMES.has(loose[1].toLowerCase())) {
        if (!out.selfName) out.unmatchedPerson = loose[1];
        const near = nearestPeople(loose[1], ctx.people.filter((p) => p.id !== ctx.selfId));
        if (near.length) out.candidates = near;
      }
      if (selfHit) dropName(selfHit.match);
    }
  }

  // -------------------------------------------------------- client, category
  // Left in the title - "send the report to Cotton India" still reads as said.
  const client = findNamed(t, ctx.clients);
  if (client) { out.client_id = client.item.id; out.client_name = client.item.name; }
  const cat = findNamed(t, ctx.categories);
  if (cat) { out.category_id = cat.item.id; out.category_name = cat.item.name; }

  // ---------------------------------------------------------------- title
  let title = t
    .replace(/\b(?:create|add|new|make)\s+(?:an?\s+)?(?:action item|task)\s*(?:to|for)?\b/gi, ' ')
    .replace(/\b(?:please|kindly|can you|could you)\b/gi, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .replace(/^(?:an?\s+)?task\b\s*(?:is\s+)?/i, '')
    .replace(/^(?:to|and|that|regarding|about|on)\s+/i, '')
    .replace(/\s+(?:and|by|on|at|to|for|with|due)$/i, '');
  if (!title) title = raw.trim();
  out.title = title.charAt(0).toUpperCase() + title.slice(1);
  return out;
}
