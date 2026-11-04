import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock, AlertTriangle, ArrowUpRight, Play, CheckCircle2, Receipt, ListChecks, PhoneCall, FileText, CalendarClock,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, relative, daysUntil, money } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Modal, PageHeader, Select,
  Stat, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs, Textarea, useToast, cx,
} from '../components/ui';

const SOURCE_ICONS: Record<string, any> = {
  action_item: ListChecks, invoice: Receipt, proposal: FileText, follow_up: PhoneCall, leave: CalendarClock,
};

/** Module B — the central deadline register and the escalation log it feeds. */
export default function Deadlines() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();

  const [tab, setTab] = useState(params.get('tab') || 'deadlines');
  const [sourceType, setSourceType] = useState('');
  const [mine, setMine] = useState(false);
  const [resolving, setResolving] = useState<any>(null);

  const deadlines = useQuery({
    queryKey: ['deadlines', sourceType, mine],
    queryFn: () => api.get('/notifications/deadlines', {
      source_type: sourceType, mine: mine ? 'true' : '', limit: 100,
    }),
    enabled: tab === 'deadlines',
  });

  const escalations = useQuery({
    queryKey: ['escalations', mine],
    queryFn: () => api.get('/notifications/escalations', { mine: mine ? 'true' : '', limit: 100 }),
    enabled: tab === 'escalations',
  });

  const runLadder = useMutation({
    mutationFn: () => api.post('/notifications/deadlines/run-ladder'),
    onSuccess: (res: any) => {
      toast.success(`Checked ${res.data.checked} deadlines, sent ${res.data.sent} reminder(s).`);
      qc.invalidateQueries({ queryKey: ['deadlines'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const setTabAndUrl = (id: string) => {
    setTab(id);
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
  };

  const rows = deadlines.data?.data || [];
  const summary = deadlines.data?.meta?.summary || {};
  const escRows = escalations.data?.data || [];

  const linkFor = (d: any) => ({
    action_item: `/action-items?open=${d.source_id}`,
    invoice: `/invoices/${d.source_id}`,
    follow_up: `/crm/${d.source_id}`,
    proposal: `/proposals?open=${d.source_id}`,
    leave: '/hr?tab=leave',
  }[d.source_type as string] || null);

  return (
    <>
      <PageHeader
        title="Deadlines & escalations"
        subtitle="Every dated commitment across the platform, with one reminder ladder"
        actions={
          <>
            <Button size="sm" variant={mine ? 'primary' : 'secondary'} onClick={() => setMine((m) => !m)}>
              {mine ? 'Mine only' : 'Everyone'}
            </Button>
            {can('settings', 'edit') && (
              <Button icon={<Play size={15} />} loading={runLadder.isPending} onClick={() => runLadder.mutate()}>
                Run reminder ladder
              </Button>
            )}
          </>
        }
        tabs={
          <Tabs active={tab} onChange={setTabAndUrl} tabs={[
            { id: 'deadlines', label: 'Deadlines', count: summary.total },
            { id: 'escalations', label: 'Escalations', count: escRows.length },
          ]} />
        }
      />

      {tab === 'deadlines' && (
        <>
          <div className="grid gap-3 grid-cols-3 mb-4">
            <Stat label="Overdue" value={summary.overdue ?? 0}
              tone={summary.overdue ? 'negative' : 'neutral'} icon={<AlertTriangle size={15} />} />
            <Stat label="Due today" value={summary.today ?? 0} icon={<Clock size={15} />} />
            <Stat label="Tracked" value={summary.total ?? 0} icon={<CalendarClock size={15} />} />
          </div>

          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <Select value={sourceType} onChange={(e) => setSourceType(e.target.value)}
                aria-label="Source" className="w-[170px]">
                <option value="">All sources</option>
                <option value="action_item">Action items</option>
                <option value="invoice">Invoices</option>
                <option value="follow_up">Follow-ups</option>
                <option value="proposal">Proposals</option>
                <option value="leave">Leave approvals</option>
              </Select>
              <p className="text-[12.5px] text-subtle ml-auto hidden sm:block">
                Ladder: 3 days before · 1 day before · on the day · then daily once overdue
              </p>
            </div>
          </Card>

          {deadlines.error ? <ErrorState error={deadlines.error} retry={deadlines.refetch} />
            : deadlines.isLoading ? <Card><TableSkeleton cols={5} /></Card>
              : !rows.length ? (
                <Card>
                  <EmptyState icon={<CheckCircle2 size={20} className="text-[var(--positive)]" />}
                    title="Nothing outstanding" message="No pending or breached deadlines match this filter." />
                </Card>
              ) : (
                <Card>
                  <Table>
                    <THead>
                      <tr>
                        <TH>What</TH>
                        <TH width="130px">Source</TH>
                        <TH width="140px">Owner</TH>
                        <TH width="140px">Due</TH>
                        <TH width="170px">Reminders sent</TH>
                        <TH width="110px">Status</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {rows.map((d: any) => {
                        const days = daysUntil(d.due_at);
                        const overdue = days != null && days < 0;
                        const Icon = SOURCE_ICONS[d.source_type] || Clock;
                        const link = linkFor(d);
                        return (
                          <TR key={d.id} onClick={link ? () => navigate(link) : undefined}>
                            <TD>
                              <span className="block font-medium text-ink">{d.title}</span>
                              {d.meta?.client && <span className="block text-[12px] text-subtle">{d.meta.client}</span>}
                            </TD>
                            <TD>
                              <span className="flex items-center gap-1.5 text-[13px] text-muted capitalize">
                                <Icon size={13} className="shrink-0" />
                                {d.source_type.replace('_', ' ')}
                              </span>
                            </TD>
                            <TD><span className="text-muted text-[13px] truncate block max-w-[130px]">{d.owner_name || '—'}</span></TD>
                            <TD>
                              <span className={cx('text-[13px]', overdue ? 'text-[var(--negative)] font-medium' : 'text-muted')}>
                                {overdue ? `${Math.abs(days!)}d overdue` : relative(d.due_at)}
                              </span>
                              {/* A deadline that named an hour says the hour; one
                                  that only named a day still only says the day. */}
                              <span className="block text-[11.5px] text-subtle">
                                {d.meta?.timed ? dateTime(d.due_at) : date(d.due_at)}
                              </span>
                            </TD>
                            <TD>
                              {d.ladder_sent?.length ? (
                                <span className="flex flex-wrap gap-1">
                                  {d.ladder_sent.slice(0, 4).map((r: string) => (
                                    <Badge key={r} tone={r.startsWith('overdue') ? 'negative' : 'neutral'}>{r}</Badge>
                                  ))}
                                  {d.ladder_sent.length > 4 && <Badge tone="neutral">+{d.ladder_sent.length - 4}</Badge>}
                                </span>
                              ) : <span className="text-subtle text-[13px]">none yet</span>}
                            </TD>
                            <TD><StatusBadge status={d.status} /></TD>
                          </TR>
                        );
                      })}
                    </tbody>
                  </Table>
                </Card>
              )}
        </>
      )}

      {tab === 'escalations' && (
        escalations.isLoading ? <Card><TableSkeleton cols={5} /></Card>
          : !escRows.length ? (
            <Card>
              <EmptyState icon={<CheckCircle2 size={20} className="text-[var(--positive)]" />}
                title="No escalations" message="Nothing has breached its escalation window." />
            </Card>
          ) : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH>What</TH>
                    <TH width="70px">Level</TH>
                    <TH width="140px">From</TH>
                    <TH width="140px">To</TH>
                    <TH>Reason</TH>
                    <TH width="130px">Raised</TH>
                    <TH width="130px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {escRows.map((e: any) => (
                    <TR key={e.id}>
                      <TD className="font-medium">
                        {e.item_title || e.invoice_number || e.client_name || e.source_type.replace('_', ' ')}
                      </TD>
                      <TD><Badge tone={e.level > 1 ? 'negative' : 'warning'}>L{e.level}</Badge></TD>
                      <TD><span className="text-muted text-[13px]">{e.from_name || '—'}</span></TD>
                      <TD><span className="text-muted text-[13px]">{e.to_name || '—'}</span></TD>
                      <TD><span className="text-muted text-[13px]">{e.reason}</span></TD>
                      <TD><span className="text-subtle text-[13px]">{relative(e.created_at)}</span></TD>
                      <TD>
                        {e.resolved_at ? <Badge tone="positive" dot>resolved</Badge>
                          : can('deadlines', 'approve') ? (
                            <Button size="sm" onClick={() => setResolving(e)}>Resolve</Button>
                          ) : <Badge tone="negative" dot>open</Badge>}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )
      )}

      {resolving && <ResolveModal escalation={resolving} onClose={() => setResolving(null)} />}
    </>
  );
}

function ResolveModal({ escalation, onClose }: { escalation: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');

  const resolve = useMutation({
    mutationFn: () => api.post(`/notifications/escalations/${escalation.id}/resolve`, { note: note || null }),
    onSuccess: () => {
      toast.success('Escalation resolved.');
      qc.invalidateQueries({ queryKey: ['escalations'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Resolve this escalation" size="sm"
      subtitle={escalation.reason}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={resolve.isPending} onClick={() => resolve.mutate()}>Resolve</Button>
        </>
      }>
      <Field label="What was done" hint="Appears in the monthly internal report">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Spoke to the client, revised the deadline to 28 Aug and reassigned to Rahul." autoFocus />
      </Field>
    </Modal>
  );
}
