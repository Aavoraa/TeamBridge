/**
 * Due dates that carry a time of day.
 *
 * A task is due on a calendar day *in the workspace timezone*, and - since the
 * same-day workflow - optionally at a time on that day. Three columns hold it,
 * and each answers a different question:
 *
 *  - `due_date`  'YYYY-MM-DD', the workspace-local day. Every "due today",
 *                "due this week" and grouping query keys off this, exactly as
 *                it did before times existed, so nothing that already worked
 *                had to be rewritten around an instant.
 *  - `due_time`  'HH:MM' on the 24-hour clock, workspace-local, or NULL for a
 *                task that is simply due that day.
 *  - `due_at`    the UTC instant the two resolve to. This is the value the
 *                deadline ladder, the overdue test and every sort read, and it
 *                is always set whenever `due_date` is - a task with no time
 *                lands at the end of its day, which is what "due Tuesday" has
 *                always meant in practice.
 *
 * Keeping all three means an existing date-only task behaves precisely as it
 * used to (overdue once its day is out) while a timed one goes overdue at the
 * minute it says, with no query having to know which kind it is looking at.
 */

export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DUE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Falls back to the seeded tenant timezone when a caller has none to hand. */
export const DEFAULT_TZ = 'Asia/Kolkata';

/** Where a due date with no time lands: the last minute of its own day. */
export const END_OF_DAY = '23:59';

/** How long before a timed due date the "starting soon" reminder goes out. */
export const REMINDER_LEAD_MINUTES = 30;

const pad = (n) => String(n).padStart(2, '0');

/** Wall-clock fields of `date` as read in `tz`. */
function partsInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Minutes `tz` is ahead of UTC at `date` - +330 for Asia/Kolkata. */
function offsetMinutes(date, tz) {
  const p = partsInTz(date, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asIfUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000;
}

/**
 * A workspace-local wall clock to the instant it names.
 *
 * Read twice on purpose: the first offset is sampled at a guessed instant that
 * can sit on the wrong side of a daylight-saving change, the second at one that
 * is right to within the size of the change itself.
 */
export function localToUtc(dateStr, timeStr, tz = DEFAULT_TZ) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || END_OF_DAY).split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const first = naive - offsetMinutes(new Date(naive), tz) * 60_000;
  return new Date(naive - offsetMinutes(new Date(first), tz) * 60_000);
}

/** The stored instant for a due date, with or without a time on it. */
export const dueAtIso = (dateStr, timeStr, tz = DEFAULT_TZ) => (
  dateStr && DUE_DATE_RE.test(String(dateStr))
    ? localToUtc(dateStr, timeStr, tz).toISOString()
    : null
);

/** Today's date on the workspace clock - not the server's, and not UTC. */
export function todayInTz(tz = DEFAULT_TZ, now = new Date()) {
  const p = partsInTz(now, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The current time of day on the workspace clock, as 'HH:MM'. */
export function timeInTz(tz = DEFAULT_TZ, now = new Date()) {
  const p = partsInTz(now, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Whole calendar days from one instant to another, counted in `tz`. */
export function dayDiffInTz(from, to, tz = DEFAULT_TZ) {
  const a = todayInTz(tz, new Date(from));
  const b = todayInTz(tz, new Date(to));
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** '16:00' -> '4:00 PM'. The one place server-side copy renders a due time. */
export function formatDueTime(hhmm) {
  if (!hhmm || !DUE_TIME_RE.test(String(hhmm))) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "3 Sep 2026 · 4:00 PM" for notification copy. */
export function formatDue(dateStr, timeStr) {
  if (!dateStr) return 'no date';
  const t = formatDueTime(timeStr);
  return t ? `${dateStr} · ${t}` : dateStr;
}
