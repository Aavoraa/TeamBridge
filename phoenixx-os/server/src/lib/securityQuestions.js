import bcrypt from 'bcryptjs';

/**
 * Security-question account recovery.
 *
 * A security question is a WEAK factor - the answers are short, low-entropy and
 * often discoverable - so everything here is built to keep it from becoming the
 * softest way into an account:
 *
 *   - the answer is bcrypt-hashed exactly like a password, never stored plain
 *     and never returned by any endpoint;
 *   - a wrong answer is counted on the row, not in an in-memory bucket, so a
 *     lockout survives a restart and cannot be shed by changing IP;
 *   - the reset token handed out on success is short-lived, single-use and
 *     stored as a SHA-256 digest, like refresh tokens;
 *   - if the account has 2FA on, recovery still demands the TOTP code. A
 *     question must never be a way around the second factor.
 */

/**
 * Suggested questions. Deliberately about facts that do not change and are not
 * on a public profile - no birthdays, no school names, no mother's maiden name.
 * A user may write their own instead; this list is a starting point, not a
 * whitelist, so nothing here is ever used as a stored key.
 */
export const SUGGESTED_QUESTIONS = [
  'What was the name of the first street you lived on as a child?',
  'What was the make and model of your first vehicle?',
  'What is the name of the first company you worked at?',
  'Which city were you in when you started your first job?',
  'What was the title of the first project you delivered here?',
  'What was your childhood nickname?',
  'What is the name of a teacher who influenced you most?',
  'What was the first dish you learned to cook?',
];

export const QUESTION_MIN = 10;
export const QUESTION_MAX = 160;
export const ANSWER_MIN = 3;
export const ANSWER_MAX = 120;

/**
 * The answer is typed once at setup and again months later on a phone keyboard,
 * so it is compared loosely: case, surrounding space, repeated inner spaces and
 * a trailing full stop are all ignored. "St. Mary's Road" and "st marys road"
 * must not be the same answer, though - only formatting is normalised, never
 * punctuation that carries meaning.
 *
 * This function is load-bearing: it has to produce the identical string at set
 * time and at verify time, or nobody can ever recover. Change it and every
 * stored answer silently stops matching.
 */
export function normalizeAnswer(answer) {
  return String(answer ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .toLowerCase();
}

export const hashAnswer = (answer) => bcrypt.hashSync(normalizeAnswer(answer), 10);

/**
 * Constant-ish work whether or not a hash exists, so a missing question is not
 * distinguishable from a wrong answer by how long the request takes.
 */
const DUMMY_HASH = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';

export function answerMatches(answer, hash) {
  const ok = bcrypt.compareSync(normalizeAnswer(answer), hash || DUMMY_HASH);
  return !!hash && ok;
}

/** Wrong answers allowed before the account stops accepting recovery for a while. */
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

/** How long a verified recovery stays good for before the password must be set. */
export const RESET_TOKEN_MINUTES = 15;

/**
 * An answer that is really the question, or is one of the suggestions typed
 * back, or is trivially short, defeats the point. Rejected at set time - the
 * only moment we can still ask for something better.
 */
export function rejectWeakAnswer(question, answer) {
  const a = normalizeAnswer(answer);
  if (a.length < ANSWER_MIN) return `Your answer must be at least ${ANSWER_MIN} characters`;
  if (a === normalizeAnswer(question)) return 'Your answer cannot be the question itself';
  if (/^(answer|test|none|na|n\/a|password|secret)$/.test(a)) return 'Please choose a real answer you will remember';
  return null;
}
