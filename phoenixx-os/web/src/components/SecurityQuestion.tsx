import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Field, Input, Select } from './ui';

/**
 * The question/answer pair, shared by every place an account is set up: signup,
 * invitation acceptance and the profile page. One component because the copy and
 * the matching rules have to agree in all three — somebody who sets an answer on
 * the invite form has to be able to type it again on the recovery page months
 * later and be told the same thing about how it will be compared.
 */

const CUSTOM = '__custom__';

export type SecurityQuestionValue = { question: string; answer: string };

export const EMPTY_SECURITY_QUESTION: SecurityQuestionValue = { question: '', answer: '' };

/** Mirrors normalizeAnswer() on the server, so the hint below is never a lie. */
export const answersMatchLoosely = (a: string, b: string) =>
  a.trim().replace(/\s+/g, ' ').replace(/\.+$/, '').toLowerCase()
  === b.trim().replace(/\s+/g, ' ').replace(/\.+$/, '').toLowerCase();

export const isSecurityQuestionComplete = (v: SecurityQuestionValue) =>
  v.question.trim().length >= 10 && v.answer.trim().length >= 3;

export function SecurityQuestionFields({
  value, onChange, errors = {}, autoFocus, questionLabel = 'Security question',
  answerLabel = 'Your answer',
}: {
  value: SecurityQuestionValue;
  onChange: (v: SecurityQuestionValue) => void;
  errors?: Record<string, string>;
  autoFocus?: boolean;
  questionLabel?: string;
  answerLabel?: string;
}) {
  const { data } = useQuery({
    queryKey: ['security-questions'],
    queryFn: () => api.get('/auth/security-questions').then((r) => r.data.questions as string[]),
    staleTime: Infinity,
  });

  const suggestions = data || [];
  const [custom, setCustom] = useState(false);

  // A question already set — on the profile page — may not be one of ours.
  useEffect(() => {
    if (value.question && suggestions.length && !suggestions.includes(value.question)) setCustom(true);
  }, [value.question, suggestions]);

  return (
    <>
      <Field label={questionLabel} required error={errors.question || errors.security_question}>
        <Select
          value={custom ? CUSTOM : value.question}
          autoFocus={autoFocus}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
              onChange({ ...value, question: '' });
            } else {
              setCustom(false);
              onChange({ ...value, question: e.target.value });
            }
          }}
        >
          <option value="" disabled>Choose a question…</option>
          {suggestions.map((q) => <option key={q} value={q}>{q}</option>)}
          <option value={CUSTOM}>Write my own question…</option>
        </Select>
      </Field>

      {custom && (
        <Field label="Your question" required
          hint="Something only you can answer, and that will not change">
          <Input value={value.question} maxLength={160}
            placeholder="What was the name of my first pet?"
            onChange={(e) => onChange({ ...value, question: e.target.value })} />
        </Field>
      )}

      <Field label={answerLabel} required error={errors.answer || errors.security_answer}
        hint="Capitals, extra spaces and a full stop at the end are ignored when you answer it later.">
        <Input value={value.answer} maxLength={120} autoComplete="off" spellCheck={false}
          placeholder="Your answer"
          onChange={(e) => onChange({ ...value, answer: e.target.value })} />
      </Field>
    </>
  );
}
