import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck, KeyRound, Smartphone, Monitor, Check, LogOut, ShieldQuestion } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative, titleCase } from '../lib/format';
import {
  SecurityQuestionFields, EMPTY_SECURITY_QUESTION, isSecurityQuestionComplete,
  type SecurityQuestionValue,
} from '../components/SecurityQuestion';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, PageHeader,
  Table, TD, TH, THead, TR, useToast, cx, Skeleton,
} from '../components/ui';

export default function Profile() {
  const { user, tenant, refresh } = useAuth();
  const toast = useToast();

  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [twofaOpen, setTwofaOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get('/auth/sessions').then((r) => r.data),
  });

  const securityQuestion = useQuery({
    queryKey: ['security-question'],
    queryFn: () => api.get('/auth/security-question').then((r) => r.data),
  });

  const saveProfile = useMutation({
    mutationFn: () => api.patch('/auth/me', { name: name.trim(), phone, whatsapp: phone }),
    onSuccess: async () => { toast.success('Profile updated.'); await refresh(); },
    onError: (e: any) => toast.error(e.message),
  });

  const disable2fa = useMutation({
    mutationFn: (password: string) => api.post('/auth/2fa/disable', { password }),
    onSuccess: async () => { toast.success('Two-factor authentication turned off.'); await refresh(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader title="Your profile" subtitle={`${user?.email} · ${tenant?.name}`} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-3">
              <Avatar name={user?.name} url={user?.avatar_url} size={52} />
              <div>
                <p className="text-[15px] font-semibold text-ink">{user?.name}</p>
                <p className="text-[13px] text-subtle">{user?.designation || titleCase(user?.role)}</p>
              </div>
            </div>

            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Mobile" hint="Used for WhatsApp alerts on deadlines and escalations">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
            </Field>
            <Field label="Email" hint="Contact an owner or HR to change this">
              <Input value={user?.email || ''} disabled />
            </Field>

            <Button variant="primary" loading={saveProfile.isPending}
              disabled={name.trim() === user?.name && phone === (user?.phone || '')}
              onClick={() => saveProfile.mutate()}>Save changes</Button>
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Security" icon={<ShieldCheck size={16} />} />
            <div className="p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-ink">Two-factor authentication</p>
                  <p className="text-[12.5px] text-subtle leading-snug mt-0.5">
                    A six-digit code from your authenticator app, on top of your password.
                    Recommended for everyone, expected for owners and finance.
                  </p>
                </div>
                {user?.twofa_enabled ? <Badge tone="positive" dot>on</Badge> : <Badge tone="warning" dot>off</Badge>}
              </div>

              {user?.twofa_enabled ? (
                <Button variant="ghost"
                  onClick={() => {
                    const pw = window.prompt('Enter your password to turn 2FA off');
                    if (pw) disable2fa.mutate(pw);
                  }}>
                  Turn off two-factor
                </Button>
              ) : (
                <Button icon={<Smartphone size={15} />} onClick={() => setTwofaOpen(true)}>
                  Set up two-factor
                </Button>
              )}

              <div className="border-t border-line pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-ink">Security question</p>
                    <p className="text-[12.5px] text-subtle leading-snug mt-0.5">
                      {securityQuestion.data?.configured
                        ? 'Answer it on the sign-in page to reset a forgotten password yourself.'
                        : 'Without one, a forgotten password means asking an owner or HR to reset it for you.'}
                    </p>
                  </div>
                  {securityQuestion.isLoading ? null
                    : securityQuestion.data?.configured
                      ? <Badge tone="positive" dot>set</Badge>
                      : <Badge tone="warning" dot>not set</Badge>}
                </div>

                {securityQuestion.data?.configured && (
                  <p className="mt-2 rounded-md border border-line bg-sunken px-2.5 py-2 text-[12.5px] text-muted leading-snug">
                    {securityQuestion.data.question}
                  </p>
                )}

                <Button className="mt-2.5" icon={<ShieldQuestion size={15} />}
                  onClick={() => setQuestionOpen(true)}>
                  {securityQuestion.data?.configured ? 'Change question' : 'Set a security question'}
                </Button>
              </div>

              <div className="border-t border-line pt-4">
                <p className="text-[13.5px] font-medium text-ink">Password</p>
                <p className="text-[12.5px] text-subtle mt-0.5 mb-2.5">
                  Changing it signs out every other session.
                </p>
                <Button icon={<KeyRound size={15} />} onClick={() => setPasswordOpen(true)}>Change password</Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Active sessions" subtitle="Where you are signed in" icon={<Monitor size={16} />} />
            {sessions.isLoading ? <div className="p-4"><Skeleton className="h-24" /></div>
              : !sessions.data?.length ? <EmptyState compact title="No other sessions" />
                : (
                  <Table>
                    <THead><tr><TH>Device</TH><TH width="130px">Signed in</TH><TH width="110px">Status</TH></tr></THead>
                    <tbody>
                      {sessions.data.map((s: any) => (
                        <TR key={s.id}>
                          <TD>
                            <span className="text-[12.5px] text-muted line-clamp-1">
                              {s.user_agent || 'Unknown device'}
                            </span>
                          </TD>
                          <TD><span className="text-subtle text-[12.5px]">{relative(s.created_at)}</span></TD>
                          <TD>
                            <Badge tone={s.revoked_at ? 'neutral' : 'positive'}>
                              {s.revoked_at ? 'signed out' : 'active'}
                            </Badge>
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                )}
          </Card>
        </div>
      </div>

      {twofaOpen && <TwoFactorModal onClose={() => setTwofaOpen(false)} />}
      {passwordOpen && <PasswordModal onClose={() => setPasswordOpen(false)} />}
      {questionOpen && (
        <SecurityQuestionModal
          current={securityQuestion.data?.question || ''}
          onClose={() => setQuestionOpen(false)}
          onSaved={() => securityQuestion.refetch()}
        />
      )}
    </>
  );
}

function TwoFactorModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { refresh } = useAuth();
  const [code, setCode] = useState('');

  const setup = useQuery({
    queryKey: ['2fa-setup'],
    queryFn: () => api.post('/auth/2fa/setup').then((r) => r.data),
  });

  const enable = useMutation({
    mutationFn: () => api.post('/auth/2fa/enable', { code }),
    onSuccess: async () => {
      toast.success('Two-factor authentication is on.');
      await refresh();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Set up two-factor authentication"
      subtitle="Scan the code, or paste the secret into your authenticator app"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={enable.isPending} disabled={code.length !== 6}
            onClick={() => enable.mutate()}>Turn on</Button>
        </>
      }>
      {setup.isLoading || !setup.data ? <Skeleton className="h-64" /> : (
        <div className="space-y-4">
          <ol className="space-y-3 text-[13.5px] text-muted">
            <li className="flex gap-2.5">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-soft text-[11px] font-semibold text-[var(--brand)]">1</span>
              Open your authenticator app (Google Authenticator, Authy, 1Password).
            </li>
            <li className="flex gap-2.5">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-soft text-[11px] font-semibold text-[var(--brand)]">2</span>
              Add an account and paste this secret:
            </li>
          </ol>

          <div className="rounded-lg bg-sunken p-3">
            <p className="mono text-[15px] tracking-[0.15em] text-ink select-all break-all">{setup.data.secret}</p>
            <button onClick={() => { navigator.clipboard?.writeText(setup.data.secret); toast.success('Copied.'); }}
              className="mt-1.5 text-[12px] text-[var(--brand)] hover:underline cursor-pointer">
              Copy secret
            </button>
          </div>

          <p className="text-[12.5px] text-subtle">
            Some apps accept a setup link instead:{' '}
            <span className="mono break-all text-[11.5px]">{setup.data.otpauth_url}</span>
          </p>

          <Field label="Enter the 6-digit code to confirm" required>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric" placeholder="000000"
              className="mono tracking-[0.35em] text-center text-base" autoFocus />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', { current_password: current, new_password: next }),
    onSuccess: (res: any) => { toast.success(res.data.message); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <Modal open onClose={onClose} title="Change your password" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={change.isPending}
            disabled={!current || next.length < 8 || mismatch}
            onClick={() => change.mutate()}>Change password</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Current password" required>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password" autoFocus />
        </Field>
        <Field label="New password" required hint="At least 8 characters">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password" required error={mismatch ? 'The passwords do not match' : undefined}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <p className="text-[12.5px] text-subtle">
          Every other session is signed out when the password changes.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Setting or changing the recovery question. The current password is asked for
 * here because the server requires it: a session somebody else got hold of must
 * not be able to plant an answer they know and the real owner does not.
 */
function SecurityQuestionModal({ current, onClose, onSaved }: {
  current: string; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState<SecurityQuestionValue>(
    current ? { ...EMPTY_SECURITY_QUESTION, question: current } : EMPTY_SECURITY_QUESTION,
  );
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => api.put('/auth/security-question', {
      question: value.question.trim(), answer: value.answer.trim(), password,
    }),
    onSuccess: () => {
      toast.success(current ? 'Security question updated.' : 'Security question set.');
      onSaved();
      onClose();
    },
    onError: (e: any) => { setErrors(e.fieldErrors || {}); toast.error(e.message); },
  });

  return (
    <Modal open onClose={onClose} size="sm"
      title={current ? 'Change your security question' : 'Set a security question'}
      subtitle="Used to reset your own password if you are ever locked out"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending}
            disabled={!password || !isSecurityQuestionComplete(value)}
            onClick={() => save.mutate()}>
            {current ? 'Update question' : 'Set question'}
          </Button>
        </>
      }>
      <div className="space-y-4">
        <SecurityQuestionFields value={value} onChange={(v) => { setValue(v); setErrors({}); }}
          errors={errors} />
        <Field label="Your current password" required error={errors.password}
          hint="Confirms it is really you changing this">
          <Input type="password" value={password} autoComplete="current-password"
            onChange={(e) => { setPassword(e.target.value); setErrors((x) => ({ ...x, password: '' })); }} />
        </Field>
      </div>
    </Modal>
  );
}
