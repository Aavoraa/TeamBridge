import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Send, MessageSquare, Mail, Monitor, Users2, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative, titleCase } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader,
  Select, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Tabs, Textarea, useToast, cx,
} from '../components/ui';

const CHANNEL_ICONS: Record<string, any> = {
  in_app: Monitor, email: Mail, whatsapp: MessageSquare, teams: Users2, push: Bell,
};

export default function Notifications() {
  const [tab, setTab] = useState('inbox');
  const { can } = useAuth();

  const tabs = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'preferences', label: 'My preferences' },
    ...(can('settings', 'view') ? [{ id: 'templates', label: 'Templates' }, { id: 'log', label: 'Delivery log' }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="One alert engine across WhatsApp, email, Teams and in-app"
        tabs={<Tabs active={tab} onChange={setTab} tabs={tabs} />}
      />
      {tab === 'inbox' && <InboxTab />}
      {tab === 'preferences' && <PreferencesTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'log' && <LogTab />}
    </>
  );
}

/* ================================================================= INBOX */
function InboxTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['notifications', 'inbox', unreadOnly],
    queryFn: () => api.get('/notifications', { unread: unreadOnly ? 'true' : '', limit: 60 }),
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const open = async (n: any) => {
    if (!n.read_at) await api.post(`/notifications/${n.id}/read`).catch(() => {});
    qc.invalidateQueries({ queryKey: ['notifications'] });
    if (n.link) navigate(n.link);
  };

  if (error) return <ErrorState error={error} retry={refetch} />;

  const items = data?.data || [];
  const unread = data?.meta?.unread || 0;

  return (
    <Card>
      <CardHeader title="Your notifications" subtitle={`${unread} unread`}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant={unreadOnly ? 'primary' : 'secondary'} onClick={() => setUnreadOnly((u) => !u)}>
              Unread only
            </Button>
            {unread > 0 && (
              <Button size="sm" icon={<Check size={14} />} loading={markAll.isPending}
                onClick={() => markAll.mutate()}>Mark all read</Button>
            )}
          </div>
        } />

      {isLoading ? <TableSkeleton rows={8} cols={2} />
        : !items.length ? (
          <EmptyState icon={<Bell size={20} />} title="Nothing here"
            message="Alerts about due work, escalations, payments and reports land in this inbox." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {items.map((n: any) => (
              <li key={n.id}>
                <button onClick={() => open(n)}
                  className={cx('w-full text-left px-4 py-3 row-hover cursor-pointer flex gap-3',
                    !n.read_at && 'bg-brand-soft/40')}>
                  <span className="mt-0.5 shrink-0">
                    <Bell size={15} className={n.event_key.includes('overdue') || n.event_key.includes('escalation')
                      ? 'text-[var(--negative)]' : 'text-subtle'} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-ink">{n.title}</span>
                    {n.body && <span className="block text-[12.5px] text-muted leading-snug mt-0.5">{n.body}</span>}
                    <span className="mt-1 flex items-center gap-2 text-[11.5px] text-subtle">
                      <span className="mono">{n.event_key}</span>
                      <span>· {relative(n.created_at)}</span>
                    </span>
                  </span>
                  {!n.read_at && <span className="mt-1.5 h-2 w-2 rounded-full bg-[var(--brand)] shrink-0" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

/* =========================================================== PREFERENCES */
function PreferencesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [prefs, setPrefs] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: async () => {
      const res = await api.get('/notifications/preferences');
      return res.data;
    },
  });

  const save = useMutation({
    mutationFn: (body: any) => api.put('/notifications/preferences', body),
    onSuccess: () => { toast.success('Preferences saved.'); qc.invalidateQueries({ queryKey: ['notification-preferences'] }); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !data) return <Card><TableSkeleton rows={6} cols={4} /></Card>;

  const current = prefs ?? data.preferences ?? {};
  const channels = data.channels.filter((c: string) => c !== 'push');

  const globalOn = (ch: string) => current.channels?.[ch] !== false;
  const eventValue = (ev: string, ch: string) => current.events?.[ev]?.[ch] ?? globalOn(ch);

  const setGlobal = (ch: string, on: boolean) => {
    const next = { ...current, channels: { ...(current.channels || {}), [ch]: on } };
    setPrefs(next);
    save.mutate(next);
  };

  const setEvent = (ev: string, ch: string, on: boolean) => {
    const next = {
      ...current,
      events: { ...(current.events || {}), [ev]: { ...(current.events?.[ev] || {}), [ch]: on } },
    };
    setPrefs(next);
    save.mutate(next);
  };

  return (
    <>
      <Card className="mb-4">
        <CardHeader title="Default channels" subtitle="Applied to every alert unless you override it below" />
        <div className="flex flex-wrap gap-3 p-4">
          {channels.map((ch: string) => {
            const Icon = CHANNEL_ICONS[ch] || Bell;
            return (
              <button key={ch} onClick={() => setGlobal(ch, !globalOn(ch))}
                className={cx('flex items-center gap-2.5 rounded-lg border px-4 py-2.5 transition-colors duration-150 cursor-pointer',
                  globalOn(ch)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-subtle hover:border-line-strong')}>
                <Icon size={16} />
                <span className="text-[13.5px] font-medium capitalize">{ch.replace('_', '-')}</span>
                {globalOn(ch) && <Check size={14} />}
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="Per-event overrides"
          subtitle="Turn a channel off for a specific event without silencing it everywhere" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-sunken">
              <tr>
                <th className="label-cap px-3 py-2 text-left border-b border-line min-w-[220px]">Event</th>
                {channels.map((ch: string) => (
                  <th key={ch} className="label-cap px-3 py-2 text-center border-b border-line min-w-[90px]">
                    {ch.replace('_', '-')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.map((ev: string) => (
                <tr key={ev} className="row-hover">
                  <td className="px-3 py-2 border-b border-line">
                    <span className="block text-[13px] text-ink">{titleCase(ev.split('.')[1] || ev)}</span>
                    <span className="mono block text-[11px] text-subtle">{ev}</span>
                  </td>
                  {channels.map((ch: string) => (
                    <td key={ch} className="px-3 py-2 border-b border-line text-center">
                      <input type="checkbox" checked={eventValue(ev, ch)}
                        onChange={(e) => setEvent(ev, ch, e.target.checked)}
                        aria-label={`${ev} via ${ch}`}
                        className="h-4 w-4 rounded border-line-strong cursor-pointer accent-[var(--brand)]" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/* ============================================================= TEMPLATES */
function TemplatesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [editing, setEditing] = useState<any>(null);
  const [channel, setChannel] = useState('whatsapp');

  const { data, isLoading } = useQuery({
    queryKey: ['notification-templates'],
    queryFn: () => api.get('/notifications/templates').then((r) => r.data),
  });

  const test = useMutation({
    mutationFn: ({ event_key, channel: ch }: any) => api.post('/notifications/test', { event_key, channel: ch }),
    onSuccess: () => toast.success('Sample sent to you on that channel.'),
    onError: (e: any) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: ({ event_key, channel: ch }: any) => api.del(`/notifications/templates/${event_key}/${ch}`),
    onSuccess: () => { toast.success('Reverted to the default wording.'); qc.invalidateQueries({ queryKey: ['notification-templates'] }); },
  });

  const rows = (data || []).filter((t: any) => t.channel === channel);

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel" className="w-[160px]">
            {['whatsapp', 'email', 'in_app', 'teams'].map((c) => (
              <option key={c} value={c}>{titleCase(c.replace('_', '-'))}</option>
            ))}
          </Select>
          <p className="text-[12.5px] text-subtle ml-2">
            Placeholders use <span className="mono">{'{{name}}'}</span> — for example{' '}
            <span className="mono">{'{{title}}'}</span>, <span className="mono">{'{{due_date}}'}</span>,{' '}
            <span className="mono">{'{{user.name}}'}</span>.
          </p>
        </div>
      </Card>

      {isLoading ? <Card><TableSkeleton cols={4} /></Card> : (
        <Card>
          <Table>
            <THead>
              <tr><TH width="210px">Event</TH><TH>Message</TH><TH width="110px">Source</TH><TH width="180px" /></tr>
            </THead>
            <tbody>
              {rows.map((t: any) => (
                <TR key={`${t.event_key}:${t.channel}`}>
                  <TD>
                    <span className="mono block text-[12px] text-ink">{t.event_key}</span>
                  </TD>
                  <TD>
                    {t.subject && <span className="block text-[13px] font-medium text-ink">{t.subject}</span>}
                    <span className="block text-[12.5px] text-muted leading-snug">{t.body}</span>
                  </TD>
                  <TD>
                    <Badge tone={t.customized ? 'brand' : 'neutral'}>{t.customized ? 'custom' : 'default'}</Badge>
                  </TD>
                  <TD>
                    <span className="flex gap-1.5 justify-end">
                      <Button size="sm" icon={<Send size={12} />} loading={test.isPending}
                        onClick={() => test.mutate({ event_key: t.event_key, channel: t.channel })}>Test</Button>
                      {can('settings', 'edit') && (
                        <>
                          <Button size="sm" onClick={() => setEditing(t)}>Edit</Button>
                          {t.customized && (
                            <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />}
                              onClick={() => reset.mutate({ event_key: t.event_key, channel: t.channel })}
                              aria-label="Revert to default" />
                          )}
                        </>
                      )}
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {editing && <TemplateModal template={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TemplateModal({ template, onClose }: { template: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject || '');
  const [body, setBody] = useState(template.body || '');

  const save = useMutation({
    mutationFn: () => api.put('/notifications/templates', {
      event_key: template.event_key, channel: template.channel,
      subject: subject || null, body,
    }),
    onSuccess: () => {
      toast.success('Template saved for this workspace.');
      qc.invalidateQueries({ queryKey: ['notification-templates'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const placeholders = [...new Set(
    `${template.subject || ''} ${template.body}`.match(/\{\{\s*[\w.]+\s*\}\}/g) || [],
  )];

  return (
    <Modal open onClose={onClose} title="Edit notification template"
      subtitle={`${template.event_key} · ${template.channel.replace('_', '-')}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!body.trim()}
            onClick={() => save.mutate()}>Save template</Button>
        </>
      }>
      <div className="space-y-4">
        {template.channel !== 'whatsapp' && (
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        )}
        <Field label="Message" required>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
        </Field>
        {placeholders.length > 0 && (
          <div className="rounded-lg bg-sunken p-3">
            <p className="label-cap mb-1.5">Available placeholders</p>
            <div className="flex flex-wrap gap-1.5">
              {placeholders.map((p) => (
                <button key={p} type="button" onClick={() => setBody((b: string) => `${b}${p}`)}
                  className="mono rounded border border-line bg-raised px-1.5 py-0.5 text-[11.5px] text-muted
                             hover:border-line-strong transition-colors cursor-pointer">
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* =================================================================== LOG */
function LogTab() {
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['notification-log', channel, status, page],
    queryFn: () => api.get('/notifications/log', { channel, status, page, limit: 50 }),
  });

  const rows = data?.data || [];
  const meta = data?.meta || {};

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Select value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }}
            aria-label="Channel" className="w-[150px]">
            <option value="">All channels</option>
            {['in_app', 'email', 'whatsapp', 'teams'].map((c) => (
              <option key={c} value={c}>{titleCase(c.replace('_', '-'))}</option>
            ))}
          </Select>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            aria-label="Status" className="w-[140px]">
            <option value="">All statuses</option>
            {['queued', 'sent', 'delivered', 'failed', 'read'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          {meta.stats && (
            <div className="ml-auto flex flex-wrap gap-2">
              {meta.stats.filter((s: any) => s.status === 'failed').map((s: any) => (
                <Badge key={s.channel} tone="negative">{s.channel}: {s.n} failed</Badge>
              ))}
            </div>
          )}
        </div>
      </Card>

      {isLoading ? <Card><TableSkeleton cols={6} /></Card>
        : !rows.length ? <Card><EmptyState icon={<Bell size={20} />} title="No deliveries match" /></Card>
          : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH width="160px">When</TH>
                    <TH width="150px">To</TH>
                    <TH width="110px">Channel</TH>
                    <TH>Message</TH>
                    <TH width="110px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {rows.map((n: any) => {
                    const Icon = CHANNEL_ICONS[n.channel] || Bell;
                    return (
                      <TR key={n.id}>
                        <TD><span className="text-muted text-[12.5px]">{dateTime(n.created_at)}</span></TD>
                        <TD><span className="text-ink text-[13px]">{n.user_name || '—'}</span></TD>
                        <TD>
                          <span className="flex items-center gap-1.5 text-[13px] text-muted">
                            <Icon size={13} /> {n.channel.replace('_', '-')}
                          </span>
                        </TD>
                        <TD>
                          <span className="block text-[13px] text-ink truncate max-w-[380px]">{n.title}</span>
                          {n.error && <span className="block text-[11.5px] text-[var(--negative)]">{n.error}</span>}
                        </TD>
                        <TD>
                          <Badge tone={n.status === 'failed' ? 'negative'
                            : ['delivered', 'read', 'sent'].includes(n.status) ? 'positive' : 'warning'}>
                            {n.status}
                          </Badge>
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
              {meta.pages > 1 && (
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                  <span className="text-[13px] text-subtle">Page {meta.page} of {meta.pages} · {meta.total} deliveries</span>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button size="sm" disabled={!meta.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </Card>
          )}
    </>
  );
}
