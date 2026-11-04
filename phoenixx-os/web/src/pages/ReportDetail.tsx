import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileDown, Send, Check, Download, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Modal, PageHeader, Select, Skeleton,
  StatusBadge, Stat, Table, TD, TH, THead, TR, useToast, cx,
} from '../components/ui';

/** A generated report, rendered from the payload the API produced. */
export default function ReportDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const { data: report, isLoading, error, refetch } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.get(`/reports/${id}`).then((r) => r.data),
  });

  const approve = useMutation({
    mutationFn: () => api.post(`/reports/${id}/approve`),
    onSuccess: () => {
      toast.success('Approved. It can now be dispatched.');
      qc.invalidateQueries({ queryKey: ['report', id] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !report) return <ReportSkeleton />;

  const p = report.payload || {};
  const isClientReport = report.kind === 'client_monthly';

  return (
    <>
      <button onClick={() => navigate('/reports')}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-subtle hover:text-ink transition-colors cursor-pointer no-print">
        <ArrowLeft size={14} /> Back to reports
      </button>

      <PageHeader
        title={report.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={report.status} />
            <Badge tone={isClientReport ? 'accent' : 'neutral'}>{titleCase(report.kind)}</Badge>
            <span className="text-subtle">
              {report.period_start === report.period_end
                ? date(report.period_start)
                : `${date(report.period_start, 'day')} – ${date(report.period_end)}`}
            </span>
            <span className="text-subtle">· generated {dateTime(report.generated_at)}</span>
          </span>
        }
        actions={
          <>
            <Button icon={<Printer size={15} />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileDown size={15} />} onClick={() => api.openPdf(`/reports/${id}/pdf`)}>PDF</Button>
            {can('reports', 'export') && (
              <Button icon={<Download size={15} />}
                onClick={() => api.download(`/reports/${id}/csv`, `${report.kind}-${report.period_start}.csv`)}>
                CSV
              </Button>
            )}
            {can('reports', 'approve') && report.status === 'generated' && (
              <Button icon={<Check size={15} />} loading={approve.isPending} onClick={() => approve.mutate()}>
                Approve
              </Button>
            )}
            {can('reports', 'approve') && report.status !== 'dispatched' && (
              <Button variant="primary" icon={<Send size={15} />} onClick={() => setDispatchOpen(true)}>
                Dispatch
              </Button>
            )}
          </>
        }
      />

      {isClientReport ? <ClientReportBody payload={p} clientName={report.client_name} /> : <InternalReportBody payload={p} />}

      {dispatchOpen && <DispatchModal reportId={id!} isClient={isClientReport} onClose={() => setDispatchOpen(false)} />}
    </>
  );
}

/* ---------------------------------------------------------------- bodies */
function InternalReportBody({ payload }: { payload: any }) {
  if (!payload.sections?.length) {
    return <Card><EmptyState title="Empty report" message="This report generated with no content." /></Card>;
  }
  return (
    <div className="space-y-5">
      {payload.sections.map((s: any, i: number) => (
        <Card key={i}>
          <CardHeader title={s.heading} />

          {s.stats?.length > 0 && (
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 p-4">
              {s.stats.map((st: any, j: number) => (
                <Stat key={j} label={st.label} value={st.value} />
              ))}
            </div>
          )}

          {s.text && (
            <p className="px-4 py-3.5 text-[13.5px] text-muted leading-relaxed">{s.text}</p>
          )}

          {s.rows?.length > 0 && s.columns?.length > 0 && (
            <Table>
              <THead>
                <tr>
                  {s.columns.map((c: any) => (
                    <TH key={c.key} align={c.align === 'right' ? 'right' : 'left'}
                      width={c.width ? `${c.width}%` : undefined}>{c.label}</TH>
                  ))}
                </tr>
              </THead>
              <tbody>
                {s.rows.map((row: any, j: number) => (
                  <tr key={j} className="border-b border-line last:border-0">
                    {s.columns.map((c: any) => (
                      <TD key={c.key} align={c.align === 'right' ? 'right' : 'left'}
                        className={c.strong ? 'font-medium' : ''}>
                        {row[c.key] ?? '—'}
                      </TD>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {s.rows?.length === 0 && !s.stats?.length && !s.text && (
            <EmptyState compact title="Nothing to report" message="No records in this section for the period." />
          )}
        </Card>
      ))}
    </div>
  );
}

function ClientReportBody({ payload, clientName }: { payload: any; clientName?: string }) {
  const { tenant } = useAuth();
  return (
    <div className="space-y-5">
      <Card>
        <div className="border-b border-line px-5 py-4" style={{ borderTop: `3px solid ${tenant?.brand_primary}` }}>
          <p className="label-cap">{tenant?.name}</p>
          <h2 className="mt-1 text-[19px] font-semibold text-ink">{clientName} · {payload.period_label}</h2>
          {payload.summary && <p className="mt-1.5 text-[13.5px] text-muted leading-relaxed">{payload.summary}</p>}
        </div>

        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 p-4">
          <Stat label="Work delivered" value={payload.delivered_count} />
          <Stat label="Completion" value={`${payload.completion_pct}%`}
            tone={payload.completion_pct >= 90 ? 'positive' : 'warning'} />
          <Stat label="Review meetings" value={payload.meetings} />
          <Stat label="Invoiced" value={new Intl.NumberFormat('en-IN', {
            style: 'currency', currency: tenant?.currency || 'INR', maximumFractionDigits: 0,
          }).format((payload.invoiced_minor || 0) / 100)} />
        </div>
      </Card>

      {payload.delivered?.length > 0 && (
        <Card>
          <CardHeader title="Work delivered this month" subtitle={`${payload.delivered.length} deliverables completed`} />
          <Table>
            <THead>
              <tr><TH>Deliverable</TH><TH width="180px">Category</TH><TH width="150px" align="right">Completed</TH></tr>
            </THead>
            <tbody>
              {payload.delivered.map((d: any, i: number) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <TD className="font-medium">{d.title}</TD>
                  <TD><span className="text-muted text-[13px]">{d.category || '—'}</span></TD>
                  <TD align="right"><span className="text-muted text-[13px]">{date(d.completed_at)}</span></TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {payload.metrics?.length > 0 && (
        <Card>
          <CardHeader title="Key metrics" />
          <Table>
            <THead>
              <tr><TH>Metric</TH><TH align="right" width="140px">Target</TH><TH align="right" width="140px">Actual</TH></tr>
            </THead>
            <tbody>
              {payload.metrics.map((m: any, i: number) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <TD className="font-medium">{m.name}</TD>
                  <TD align="right"><span className="text-subtle">{m.target ?? '—'}</span></TD>
                  <TD align="right" className="font-medium">{m.actual ?? '—'}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {payload.next_month?.length > 0 && (
        <Card>
          <CardHeader title="Plan for next month" />
          <ul className="p-4 space-y-2">
            {payload.next_month.map((n: any, i: number) => (
              <li key={i} className="flex items-start gap-2.5 text-[13.5px] text-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: tenant?.brand_accent }} aria-hidden />
                {n.title}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function DispatchModal({ reportId, isClient, onClose }: {
  reportId: string; isClient: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [channels, setChannels] = useState<string[]>(['in_app', 'email']);
  const [recipients, setRecipients] = useState<string[]>([]);

  const { data: directory } = useQuery({
    queryKey: ['directory'],
    queryFn: () => api.get('/users/directory').then((r) => r.data),
    staleTime: 300_000,
  });

  const dispatch = useMutation({
    mutationFn: () => api.post(`/reports/${reportId}/dispatch`, { channels, recipients }),
    onSuccess: () => {
      toast.success('Dispatched. The PDF has been rendered and delivery logged.');
      qc.invalidateQueries({ queryKey: ['report', reportId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) =>
    setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  return (
    <Modal open onClose={onClose} title="Dispatch this report"
      subtitle={isClient
        ? 'A branded PDF is rendered and delivery is tracked'
        : 'Sent through the notification channels you pick'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={dispatch.isPending} disabled={!channels.length}
            onClick={() => dispatch.mutate()}>Dispatch</Button>
        </>
      }>
      <div className="space-y-4">
        <div>
          <p className="text-[13px] font-medium text-muted mb-2">Channels</p>
          <div className="flex flex-wrap gap-2">
            {['in_app', 'email', 'whatsapp', 'teams'].map((c) => (
              <button key={c} type="button" onClick={() => toggle(channels, setChannels, c)}
                className={cx('rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors duration-150 cursor-pointer',
                  channels.includes(c)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                {c.replace('_', '-')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[13px] font-medium text-muted mb-2">
            Recipients <span className="text-subtle font-normal">— leave empty to send to owners and managers</span>
          </p>
          <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
            {directory?.map((u: any) => (
              <button key={u.id} type="button" onClick={() => toggle(recipients, setRecipients, u.id)}
                className={cx('rounded-full border px-2.5 py-1 text-[12.5px] transition-colors duration-150 cursor-pointer',
                  recipients.includes(u.id)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                {u.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ReportSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-4 w-32 mb-4" />
      <Skeleton className="h-8 w-80 mb-2" />
      <Skeleton className="h-4 w-64 mb-5" />
      <Skeleton className="h-40 mb-5" />
      <Skeleton className="h-64" />
    </div>
  );
}
