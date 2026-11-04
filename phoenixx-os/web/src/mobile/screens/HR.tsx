/**
 * Attendance / HR.
 *
 * Check in and check out are the reason this tab exists, so they are the first
 * thing under the thumb and never more than one tap. Everything below is the
 * handful of HR things people look up on a phone: hours so far, leave balance,
 * recent requests, and whatever is waiting on them to approve.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarPlus, CheckCircle2, Clock, History, LogIn, LogOut, ShieldCheck,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { announceCheckIn } from '../../components/TodoReminders';
import { date as fmtDate, time as fmtTime } from '../../lib/format';
import { useToast } from '../../components/ui';
import { HOME_KEY, useHomeFeed } from '../MobileApp';
import {
  Empty, List, Loading, MButton, MField, Pill, Row, Screen, Section, Sheet, inputClass,
} from '../ui';

const LEAVE_KEY = ['m', 'leave'];

/** Worked time so far, from the check-in stamp — recomputed on render, not stored. */
function workedHours(checkIn?: string | null, checkOut?: string | null): string {
  if (!checkIn) return '—';
  const end = checkOut ? new Date(checkOut) : new Date();
  const mins = Math.max(0, Math.round((end.getTime() - new Date(checkIn).getTime()) / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** '3h 05m' of earlier sessions plus the running one. */
function addMinutes(prior: number | null | undefined, running: string): string {
  const [h, m] = running.match(/\d+/g)?.map(Number) || [0, 0];
  const mins = Number(prior || 0) + h * 60 + m;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

export default function MobileHR() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useHomeFeed();
  const [leaveOpen, setLeaveOpen] = useState(false);

  const leave = useQuery({
    queryKey: LEAVE_KEY,
    queryFn: async () => {
      const [balances, requests] = await Promise.all([
        api.get('/hr/leave/balances').then((r) => r.data).catch(() => []),
        api.get('/hr/leave/requests', { mine: 'true' }).then((r) => r.data).catch(() => []),
      ]);
      return { balances, requests };
    },
    staleTime: 60_000,
  });

  const punch = useMutation({
    mutationFn: (dir: 'in' | 'out') =>
      api.post(`/hr/attendance/check-${dir}`, { source: 'mobile' }),
    onSuccess: (res: any, dir) => {
      if (dir === 'out') toast.success('Checked out.');
      else if (res?.data?.status === 'pending_approval' || res?.data?.checked_in_again) toast.info(res.data.message || 'Sent to HR for review.');
      else toast.success(res?.data?.message || 'Checked in.');
      if (dir === 'in' && !res?.data?.checked_in_again && !res?.data?.already_checked_in) announceCheckIn();
      qc.invalidateQueries({ queryKey: HOME_KEY });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Loading label="Loading attendance" />;

  const att = data?.attendance;
  const checkedIn = !!att?.check_in_at;
  const checkedOut = !!att?.check_out_at;
  const approvals = data?.pending_approvals || {};
  const pending = Number(approvals.leave || 0) + Number(approvals.regularizations || 0);

  return (
    <>
      <Screen title="Attendance" subtitle={fmtDate(new Date().toISOString(), 'long')}>

        {/* ------------------------------------------------ punch card */}
        {/* The owner and the HR / Finance management logins are not on the register. */}
        {!['owner', 'hr', 'finance'].includes(user?.role || '') && (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="label-cap">Status</p>
              <p className={`mt-0.5 text-[17px] font-semibold ${
                checkedOut ? 'text-subtle' : checkedIn ? 'text-positive' : 'text-ink'
              }`}>
                {checkedOut ? 'Checked out' : checkedIn ? 'Checked in' : 'Not checked in'}
              </p>
            </div>
            <div className="text-right">
              <p className="label-cap">Hours</p>
              <p className="mt-0.5 text-[17px] font-semibold tabular-nums text-ink">
                {att?.session_started_at
                  // A later session: the earlier ones are already in work_minutes.
                  ? (checkedOut ? att.work_hours_label : addMinutes(att.work_minutes, workedHours(att.session_started_at, null)))
                  : workedHours(att?.check_in_at, att?.check_out_at)}
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[13px]">
            <div>
              <p className="text-subtle">In</p>
              <p className="font-medium tabular-nums text-ink">
                {att?.check_in_at ? fmtTime(att.check_in_at) : '—'}
              </p>
            </div>
            <div>
              <p className="text-subtle">Out</p>
              <p className="font-medium tabular-nums text-ink">
                {att?.check_out_at ? fmtTime(att.check_out_at) : '—'}
              </p>
            </div>
          </div>

          <div className="mt-4">
            {!checkedIn && (
              <MButton variant="positive" full icon={<LogIn size={18} />}
                loading={punch.isPending} onClick={() => punch.mutate('in')}>
                Check in
              </MButton>
            )}
            {checkedIn && !checkedOut && (
              <MButton variant="negative" full icon={<LogOut size={18} />}
                loading={punch.isPending} onClick={() => punch.mutate('out')}>
                Check out
              </MButton>
            )}
            {checkedOut && (
              <MButton full icon={<LogIn size={18} />}
                loading={punch.isPending} onClick={() => punch.mutate('in')}>
                Check in again
              </MButton>
            )}
            {checkedOut && (
              <p className="mt-2 text-center text-[13px] text-subtle">
                Back from a permission? Your hours carry on. Corrections go through a regularisation request.
              </p>
            )}
          </div>
        </div>
        )}

        {/* ------------------------------------------------ quick actions */}
        <div className="grid grid-cols-2 gap-3">
          <MButton full icon={<CalendarPlus size={17} />} onClick={() => setLeaveOpen(true)}>
            Request leave
          </MButton>
          <MButton full icon={<History size={17} />}
            onClick={() => { window.location.href = '/hr'; }}>
            History
          </MButton>
        </div>

        {/* ------------------------------------------------ approvals */}
        {pending > 0 && (
          <Section title="Waiting on you">
            <List>
              {Number(approvals.leave) > 0 && (
                <Row leading={<ShieldCheck size={18} className="text-warning" />}
                  title="Leave requests" meta="Approve or decline on the web app"
                  right={String(approvals.leave)} tone="warning" />
              )}
              {Number(approvals.regularizations) > 0 && (
                <Row leading={<Clock size={18} className="text-warning" />}
                  title="Attendance corrections" meta="Approve or decline on the web app"
                  right={String(approvals.regularizations)} tone="warning" />
              )}
            </List>
          </Section>
        )}

        {/* ------------------------------------------------ leave balance */}
        <Section title="Leave balance">
          {leave.isLoading ? <Loading label="Loading leave" /> : (
            <List empty={<Empty title="No leave types set up" />}>
              {(leave.data?.balances || []).map((b: any) => (
                <Row key={b.leave_type_id}
                  title={b.name}
                  meta={`${Number(b.used || 0)} used of ${Number(b.entitled || 0)}${
                    b.carried ? ` · ${b.carried} carried` : ''}`}
                  right={`${Number(b.available || 0)} left`}
                  tone={Number(b.available || 0) > 0 ? 'positive' : 'neutral'} />
              ))}
            </List>
          )}
        </Section>

        {/* ------------------------------------------------ my requests */}
        {(leave.data?.requests || []).length > 0 && (
          <Section title="My requests">
            <List>
              {((leave.data?.requests || []) as any[]).slice(0, 6).map((r) => (
                <Row key={r.id}
                  title={r.leave_type_name || 'Leave'}
                  meta={`${fmtDate(r.from_date, 'day')} → ${fmtDate(r.to_date, 'day')}`}
                  right={(
                    <Pill tone={
                      r.status === 'approved' ? 'positive'
                        : r.status === 'rejected' ? 'negative' : 'warning'
                    }>
                      {r.status}
                    </Pill>
                  )} />
              ))}
            </List>
          </Section>
        )}

        <p className="px-1 pb-2 text-[12px] leading-relaxed text-subtle">
          Signed in as {user?.email}. Payroll, performance reviews and hiring stay on the web app.
        </p>
      </Screen>

      <LeaveSheet open={leaveOpen} onClose={() => setLeaveOpen(false)} />
    </>
  );
}

function LeaveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState('');

  const types = useQuery({
    queryKey: ['m', 'leave-types'],
    queryFn: () => api.get('/hr/leave/types').then((r) => r.data),
    enabled: open,
    staleTime: 300_000,
  });

  const submit = useMutation({
    mutationFn: () => api.post('/hr/leave/requests', {
      leave_type_id: typeId || types.data?.[0]?.id,
      from_date: from,
      to_date: to,
      reason: reason.trim(),
    }),
    onSuccess: () => {
      toast.success('Leave requested.');
      qc.invalidateQueries({ queryKey: LEAVE_KEY });
      qc.invalidateQueries({ queryKey: HOME_KEY });
      setReason('');
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const ready = reason.trim().length >= 3 && (typeId || types.data?.[0]?.id) && from <= to;

  return (
    <Sheet
      open={open} onClose={onClose} title="Request leave"
      footer={(
        <MButton variant="primary" full loading={submit.isPending}
          disabled={!ready} onClick={() => submit.mutate()}>
          Send request
        </MButton>
      )}
    >
      <MField label="Type">
        <select className={inputClass} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {(types.data || []).map((t: any) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </MField>

      <div className="grid grid-cols-2 gap-3">
        <MField label="From">
          <input type="date" className={inputClass} value={from}
            onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />
        </MField>
        <MField label="To">
          <input type="date" className={inputClass} value={to} min={from}
            onChange={(e) => setTo(e.target.value)} />
        </MField>
      </div>

      <MField label="Reason">
        <textarea className={`${inputClass} min-h-[88px] py-2.5`} value={reason}
          placeholder="Family function in Coimbatore"
          onChange={(e) => setReason(e.target.value)} />
      </MField>

      <p className="flex items-start gap-2 text-[12px] leading-relaxed text-subtle">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        It goes to your reporting manager for approval and shows up under My requests straight away.
      </p>
    </Sheet>
  );
}
