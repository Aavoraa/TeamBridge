import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, TableSkeleton, useToast, cx } from './ui';

/**
 * Settings > Roles: what each role can do, in the words of the menu.
 *
 * The owner picks a role and ticks, per area, whether it can view, create,
 * edit, approve, delete and export. Saved, the server enforces it on every
 * request and the menu is drawn from the same map - so nobody sees a menu item
 * they cannot open. Owners always have everything; clients keep their portal.
 * Within what a role can see, employees still only see their own records and
 * managers their team's.
 */

type Access = Record<string, string[]>;

const ACTIONS = [
  { id: 'view', label: 'View' }, { id: 'create', label: 'Create' }, { id: 'edit', label: 'Edit' },
  { id: 'approve', label: 'Approve' }, { id: 'delete', label: 'Delete' }, { id: 'export', label: 'Export' },
];

const ROLES = [
  { id: 'manager', label: 'Manager' }, { id: 'employee', label: 'Employee' },
  { id: 'finance', label: 'Finance' }, { id: 'hr', label: 'HR' },
];

/** Every area, named and grouped the way the menu shows it. */
export const AREAS: { section: string; items: { id: string; label: string; hint: string; fixed?: string }[] }[] = [
  {
    section: 'Work',
    items: [
      { id: 'action_items', label: 'Tasks', hint: 'Action items, task requests, daily updates' },
      { id: 'deadlines', label: 'Deadlines', hint: 'Deadline tracker and escalations' },
      { id: 'projects', label: 'Projects & teams', hint: 'Projects, team seats, project updates' },
      { id: 'meetings', label: 'Meetings', hint: 'Schedule, join, history, minutes (MOM)' },
      { id: 'meeting_intelligence', label: 'AI meeting intelligence', hint: 'Recordings, summaries, task approvals' },
      { id: 'chat', label: 'Chat', hint: 'Team and project chat' },
      { id: 'notifications', label: 'Notifications', hint: 'The bell', fixed: 'Always on for everyone' },
    ],
  },
  {
    section: 'Clients & sales',
    items: [
      { id: 'crm', label: 'Clients & pipeline', hint: 'Clients, pipeline, marketing leads' },
      { id: 'proposals', label: 'Proposals', hint: 'Proposals and quotes' },
    ],
  },
  {
    section: 'Finance',
    items: [
      { id: 'invoices', label: 'Invoices', hint: 'Raising and tracking invoices' },
      { id: 'costs', label: 'Cost & profit', hint: 'Costs and the cost & profit page' },
      { id: 'profitability', label: 'Profitability', hint: 'Profit by client and project' },
      { id: 'reimbursements', label: 'Reimbursements', hint: 'Own claims; Approve = first approval for their team' },
      { id: 'reimbursement_finance', label: 'Reimbursement finance desk', hint: 'Finance review and payment of claims' },
      { id: 'billing', label: 'Billing & plan', hint: 'TeamBridge subscription and seats' },
    ],
  },
  {
    section: 'People',
    items: [
      { id: 'hr_attendance', label: 'Attendance', hint: 'Check-in; Approve = approve team attendance' },
      { id: 'hr_leave', label: 'Leave', hint: 'Apply; Approve = decide team leave' },
      { id: 'hr_performance', label: 'Performance', hint: 'Reviews and ratings' },
      { id: 'hr_hiring', label: 'Hiring', hint: 'Openings and candidates' },
      { id: 'employees', label: 'Team directory', hint: 'Team page, reporting structure' },
      { id: 'users', label: 'User accounts', hint: 'Adding, changing and removing logins' },
    ],
  },
  {
    section: 'Reports & knowledge',
    items: [
      { id: 'reports', label: 'Reports', hint: 'Client and internal reports' },
      { id: 'dashboard', label: 'Traction dashboard', hint: 'Company dashboard' },
      { id: 'sop', label: 'SOP library', hint: 'SOPs and checklists' },
      { id: 'kpi', label: 'KPIs', hint: 'KPI library and targets' },
    ],
  },
  {
    section: 'Administration',
    items: [
      { id: 'settings', label: 'Workspace settings', hint: 'Settings pages' },
      { id: 'audit', label: 'Audit log', hint: 'Who changed what' },
    ],
  },
];

const same = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x) => b.includes(x));

export function AccessEditor() {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();
  const [role, setRole] = useState('employee');
  const [draft, setDraft] = useState<Access | null>(null);
  const [resetting, setResetting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['role-access'],
    queryFn: () => api.get<any>('/settings/access').then((r) => r.data),
    // A refetch would reset the checkboxes under someone's hands.
    staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const current: Access | undefined = data?.roles?.[role]?.access;
  const defaults: Access | undefined = data?.roles?.[role]?.defaults;
  useEffect(() => { if (current) setDraft(structuredClone(current)); }, [current, role]);

  const changes = useMemo(() => (draft && current
    ? Object.keys(draft).filter((m) => !same(draft[m], current[m])).length : 0), [draft, current]);

  const save = useMutation({
    mutationFn: () => api.put(`/settings/access/${role}`, { permissions: draft }),
    onSuccess: () => {
      toast.success(`${ROLES.find((r) => r.id === role)?.label} access saved. It applies the next time they open or refresh TeamBridge.`);
      qc.invalidateQueries({ queryKey: ['role-access'] });
      void refresh();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const reset = useMutation({
    mutationFn: () => api.del(`/settings/access/${role}`),
    onSuccess: () => { toast.success('Back to the built-in access.'); setResetting(false); qc.invalidateQueries({ queryKey: ['role-access'] }); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !data || !draft || !current) return <Card><TableSkeleton cols={7} /></Card>;
  const canEdit = !!data.can_edit;
  const info = data.roles[role];

  const toggle = (m: string, a: string) => setDraft((d) => {
    if (!d) return d;
    const has = d[m]?.includes(a);
    let next = has ? d[m].filter((x) => x !== a) : [...(d[m] || []), a];
    if (a === 'view' && has) next = []; // no view, nothing else
    if (!has && a !== 'view' && !next.includes('view')) next = ['view', ...next];
    return { ...d, [m]: ACTIONS.map((x) => x.id).filter((x) => next.includes(x)) };
  });
  const setRow = (m: string, level: 'none' | 'view' | 'all') => setDraft((d) => d && ({
    ...d, [m]: level === 'none' ? [] : level === 'view' ? ['view'] : ACTIONS.map((x) => x.id),
  }));

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--brand)]" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
            Choose what each role can do. The menu shows people only what their role can open, and the server refuses
            the rest. <strong className="text-ink">Owners</strong> always have full access. Within what a role can see,
            employees still only see their own records and managers their team's.
          </p>
        </div>
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {ROLES.map((r) => {
          const ri = data.roles[r.id];
          return (
            <button key={r.id} type="button" onClick={() => setRole(r.id)}
              className={cx('inline-flex min-h-[36px] items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-colors cursor-pointer',
                role === r.id ? 'bg-brand-soft text-[var(--brand)]' : 'bg-sunken text-muted hover:text-ink')}>
              {r.label}
              <span className="text-[11.5px] font-normal text-subtle tabular">{ri.people}</span>
              {ri.customised_at && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" title="Changed from the built-in access" />}
            </button>
          );
        })}
        <span className="flex-1" />
        <span className="text-[12.5px] text-subtle">
          {info.customised_at ? `Customised ${date(info.customised_at)}` : 'Built-in access'}
        </span>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-sunken">
                <th className="sticky left-0 z-10 bg-sunken px-4 py-2.5 text-left text-[12px] font-medium text-subtle">Area</th>
                {ACTIONS.map((a) => <th key={a.id} className="w-[76px] px-1 py-2.5 text-center text-[12px] font-medium text-subtle">{a.label}</th>)}
                {canEdit && <th className="w-[150px] px-3 py-2.5 text-right text-[12px] font-medium text-subtle">Quick set</th>}
              </tr>
            </thead>
            <tbody>
              {AREAS.map((group) => (
                <FragmentRows key={group.section} title={group.section} span={ACTIONS.length + (canEdit ? 2 : 1)}>
                  {group.items.filter((it) => draft[it.id]).map((it) => {
                    const changed = !same(draft[it.id], current[it.id]);
                    const offDefault = !same(draft[it.id], defaults?.[it.id]);
                    return (
                      <tr key={it.id} className={cx('border-t border-line', changed && 'bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]')}>
                        <td className="sticky left-0 z-10 bg-raised px-4 py-2.5">
                          <span className="flex items-center gap-2">
                            <span className="font-medium text-ink">{it.label}</span>
                            {changed ? <Badge tone="accent">Unsaved</Badge> : offDefault ? <Badge tone="neutral">Changed</Badge> : null}
                          </span>
                          <span className="block text-[12px] text-subtle">{it.fixed || it.hint}</span>
                        </td>
                        {ACTIONS.map((a) => {
                          const on = draft[it.id]?.includes(a.id);
                          return (
                            <td key={a.id} className="px-1 py-2.5 text-center">
                              <input type="checkbox" checked={!!on} disabled={!canEdit || !!it.fixed}
                                onChange={() => toggle(it.id, a.id)}
                                aria-label={`${ROLES.find((r) => r.id === role)?.label}: ${a.label} ${it.label}`}
                                className="h-4 w-4 cursor-pointer accent-[var(--brand)] disabled:cursor-default" />
                            </td>
                          );
                        })}
                        {canEdit && (
                          <td className="px-3 py-2.5 text-right">
                            {!it.fixed && (
                              <span className="inline-flex gap-1 text-[12px]">
                                {(['none', 'view', 'all'] as const).map((lvl) => (
                                  <button key={lvl} type="button" onClick={() => setRow(it.id, lvl)}
                                    className="rounded px-1.5 py-0.5 text-subtle hover:bg-sunken hover:text-ink cursor-pointer">
                                    {lvl === 'none' ? 'None' : lvl === 'view' ? 'View' : 'All'}
                                  </button>
                                ))}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </FragmentRows>
              ))}
            </tbody>
          </table>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            {info.customised_at && (
              <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setResetting(true)}>Reset to built-in</Button>
            )}
            <span className="flex-1" />
            {changes > 0 && <span className="text-[12.5px] text-subtle">{changes} area{changes === 1 ? '' : 's'} changed</span>}
            <Button disabled={!changes} onClick={() => setDraft(structuredClone(current))}>Discard</Button>
            <Button variant="primary" disabled={!changes} loading={save.isPending} onClick={() => save.mutate()}>Save access</Button>
          </div>
        ) : (
          <p className="border-t border-line px-4 py-3 text-[12.5px] text-subtle">Only the workspace owner can change access.</p>
        )}
      </Card>

      <ConfirmDialog open={resetting} onClose={() => setResetting(false)} onConfirm={() => reset.mutate()} loading={reset.isPending}
        title={`Reset ${ROLES.find((r) => r.id === role)?.label} access?`} confirmLabel="Reset"
        message="Every area goes back to TeamBridge's built-in access for this role." />
    </>
  );
}

function FragmentRows({ title, span, children }: { title: string; span: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="border-t border-line">
        <td colSpan={span} className="bg-surface px-4 pb-1.5 pt-4 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-subtle">{title}</td>
      </tr>
      {children}
    </>
  );
}
