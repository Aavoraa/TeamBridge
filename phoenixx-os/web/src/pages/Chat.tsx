import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare, Plus, Pin, PinOff, Reply, Trash2,
  PencilLine, Bell, BellOff, X, Info, CornerDownRight, ArrowDown,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, time, titleCase } from '../lib/format';
import {
  Avatar, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal,
  SearchInput, Skeleton, Textarea, useToast, cx,
} from '../components/ui';
import {
  ChannelIcon, Composer, DaySeparator, KIND_UI, MessageBody, ReadOnlyNote, SECTIONS,
  invalidateChat, isSameTurn, startsNewDay, useChatStream,
} from '../components/chatKit';

/**
 * Module B - the chat screen.
 *
 * One place to talk: the company announcement channel at the top, then a room
 * per project team, then group rooms and direct messages. Rooms are never
 * created here for a project - they arrive with the team - so the list is a
 * reflection of who you actually work with rather than another thing to curate.
 */

export default function Chat() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const { data: channels, isLoading, error, refetch } = useQuery({
    queryKey: ['chat', 'channels'],
    queryFn: () => api.get('/chat/channels').then((r) => r.data),
    // A backstop for a stream that never connected; the SSE feed does the work.
    refetchInterval: 60_000,
  });

  const activeId = params.get('channel') || channels?.[0]?.id || null;
  const setActive = (id: string) => {
    setParams((p) => { p.set('channel', id); return p; }, { replace: true });
    setShowMembers(false);
  };

  /* Live events: refresh the list, and the open thread if it is the one hit. */
  useChatStream();

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (channels ?? []).filter((c: any) => !q || c.label.toLowerCase().includes(q));
    return SECTIONS
      .map((section) => ({ section, rows: list.filter((c: any) => KIND_UI[c.kind]?.section === section) }))
      .filter((g) => g.rows.length);
  }, [channels, search]);

  return (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[480px] gap-4">
      {/* ------------------------------------------------------- channels */}
      <Card className={cx('w-full sm:w-[290px] shrink-0 flex flex-col overflow-hidden',
        activeId && 'hidden sm:flex')}>
        <div className="flex items-center gap-2 border-b border-line p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search conversations…" className="flex-1" />
          <Button variant="ghost" icon={<Plus size={16} />} onClick={() => setNewOpen(true)}
            aria-label="New conversation" />
        </div>

        <div className="flex-1 overflow-y-auto">
          {error ? <div className="p-3"><ErrorState error={error} retry={refetch} /></div>
            : isLoading ? <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11" />)}</div>
              : !grouped.length ? <EmptyState compact title="Nothing here" message="No conversation matches that." />
                : grouped.map((group) => (
                  <div key={group.section} className="py-2">
                    <p className="label-cap px-3 pb-1.5">{group.section}</p>
                    {group.rows.map((c: any) => (
                      <ChannelRow key={c.id} channel={c} active={c.id === activeId} onClick={() => setActive(c.id)} />
                    ))}
                  </div>
                ))}
        </div>
      </Card>

      {/* --------------------------------------------------------- thread */}
      <Card className={cx('flex-1 min-w-0 flex flex-col overflow-hidden', !activeId && 'hidden sm:flex')}>
        {!activeId ? (
          <div className="grid flex-1 place-items-center">
            <EmptyState icon={<MessageSquare size={20} />} title="Pick a conversation"
              message="Your project rooms and the company channel are on the left." />
          </div>
        ) : (
          <Thread key={activeId} channelId={activeId} me={user}
            onBack={() => setParams((p) => { p.delete('channel'); return p; }, { replace: true })}
            showMembers={showMembers} toggleMembers={() => setShowMembers((v) => !v)} />
        )}
      </Card>

      {newOpen && <NewConversationModal onClose={() => setNewOpen(false)} onCreated={setActive} />}
    </div>
  );
}

/* ------------------------------------------------------------ list row */
function ChannelRow({ channel: c, active, onClick }: { channel: any; active: boolean; onClick: () => void }) {
  const preview = c.last_message
    ? `${c.last_message.kind === 'system' ? '' : `${c.last_message.author_name?.split(' ')[0]}: `}${c.last_message.body}`
    : 'No messages yet';

  return (
    <button onClick={onClick}
      className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 cursor-pointer',
        active ? 'bg-brand-soft' : 'hover:bg-sunken')}>
      {c.kind === 'direct' && c.counterpart
        ? <Avatar name={c.counterpart.name} url={c.counterpart.avatar_url} size={28} />
        : (
          <span className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-md',
            active ? 'text-[var(--brand)]' : 'bg-sunken text-subtle')}>
            <ChannelIcon channel={c} />
          </span>
        )}

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cx('truncate text-[13.5px]', c.unread ? 'font-semibold text-ink' : 'font-medium text-muted')}>
            {c.label}
          </span>
          {c.muted && <BellOff size={11} className="shrink-0 text-subtle" aria-label="Muted" />}
        </span>
        <span className="block truncate text-[11.5px] text-subtle">{preview}</span>
      </span>

      {c.unread > 0 && (
        <span className={cx('shrink-0 rounded-full px-1.5 py-px text-[11px] font-semibold tabular',
          c.muted ? 'bg-sunken text-subtle' : 'bg-[var(--brand)] text-white')}>
          {c.unread > 99 ? '99+' : c.unread}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------- thread */
function Thread({ channelId, me, onBack, showMembers, toggleMembers }: {
  channelId: string; me: any; onBack: () => void; showMembers: boolean; toggleMembers: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [older, setOlder] = useState<any[]>([]);
  const [atBottom, setAtBottom] = useState(true);

  const { data: channel } = useQuery({
    queryKey: ['chat', 'channel', channelId],
    queryFn: () => api.get(`/chat/channels/${channelId}`).then((r) => r.data),
  });

  const { data: page, isLoading } = useQuery({
    queryKey: ['chat', 'messages', channelId],
    queryFn: () => api.get(`/chat/channels/${channelId}/messages`, { limit: 40 }),
  });

  const messages = useMemo(() => [...older, ...(page?.data ?? [])], [older, page]);

  const markRead = useMutation({
    mutationFn: () => api.post(`/chat/channels/${channelId}/read`),
    onSuccess: () => invalidateChat(qc),
  });

  /* Reading is what happens when a message is on screen and the tab is yours. */
  const unread = channel?.unread ?? 0;
  useEffect(() => {
    if (unread > 0 && document.visibilityState === 'visible') markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, unread]);

  /* Stay pinned to the newest message unless the reader has scrolled away. */
  useEffect(() => {
    if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, atBottom]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);

  const loadOlder = async () => {
    const cursor = before ?? page?.meta?.oldest;
    if (!cursor) return;
    const res = await api.get(`/chat/channels/${channelId}/messages`, { limit: 40, before: cursor });
    setOlder((prev) => [...res.data, ...prev]);
    setBefore(res.meta?.oldest ?? null);
    if (!res.meta?.has_more) setBefore(null);
  };

  const send = useMutation({
    mutationFn: (body: string) => api.post(`/chat/channels/${channelId}/messages`, {
      body, reply_to_id: replyTo?.id ?? null,
    }),
    onSuccess: () => {
      setReplyTo(null);
      setAtBottom(true);
      invalidateChat(qc, channelId);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const edit = useMutation({
    mutationFn: ({ id, body }: any) => api.patch(`/chat/messages/${id}`, { body }),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['chat', 'messages', channelId] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/chat/messages/${id}`),
    onSuccess: () => {
      setDeleting(null);
      setOlder((prev) => prev.filter((m) => m.id !== deleting?.id));
      qc.invalidateQueries({ queryKey: ['chat', 'messages', channelId] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const pin = useMutation({
    mutationFn: (id: string) => api.post(`/chat/messages/${id}/pin`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chat', 'messages', channelId] });
      qc.invalidateQueries({ queryKey: ['chat', 'channel', channelId] });
    },
  });

  const mute = useMutation({
    mutationFn: (muted: boolean) => api.patch(`/chat/channels/${channelId}/settings`, { muted }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chat', 'channel', channelId] });
      qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
    },
  });

  if (!channel) return <div className="flex-1 space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;

  const hasMore = page?.meta?.has_more || before;

  return (
    <>
      {/* ---------------------------------------------------------- head */}
      <header className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <Button variant="ghost" className="sm:hidden" icon={<X size={16} />} onClick={onBack} aria-label="Back" />
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-sunken text-muted">
          <ChannelIcon channel={channel} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">{channel.label}</p>
          <p className="truncate text-[12px] text-subtle">
            {channel.kind === 'project' && channel.client_name && `${channel.client_name} · `}
            {channel.kind === 'direct'
              ? channel.counterpart?.designation || 'Direct message'
              : `${channel.members.length} member${channel.members.length === 1 ? '' : 's'}${channel.topic ? ` · ${channel.topic}` : ''}`}
          </p>
        </div>
        <Button variant="ghost" icon={channel.muted ? <BellOff size={15} /> : <Bell size={15} />}
          onClick={() => mute.mutate(!channel.muted)} aria-label={channel.muted ? 'Unmute' : 'Mute'} />
        {channel.kind !== 'direct' && (
          <Button variant="ghost" icon={<Info size={15} />} onClick={toggleMembers} aria-label="Members" />
        )}
      </header>

      {channel.pinned?.length > 0 && !showMembers && (
        <div className="border-b border-line bg-sunken px-3 py-2">
          <p className="label-cap mb-1 flex items-center gap-1.5"><Pin size={11} /> Pinned</p>
          <ul className="space-y-1">
            {channel.pinned.map((m: any) => (
              <li key={m.id} className="truncate text-[12.5px] text-muted">
                <span className="text-subtle">{m.author_name?.split(' ')[0]}:</span> {m.body}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------------ messages */}
        <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto px-3 py-3">
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : !messages.length ? (
            <div className="grid h-full place-items-center">
              <EmptyState compact icon={<MessageSquare size={18} />} title="No messages yet"
                message={channel.kind === 'broadcast'
                  ? 'Announcements posted here reach everyone in the workspace.'
                  : 'Say something to get it started.'} />
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="mb-3 text-center">
                  <Button size="sm" onClick={loadOlder}>Load earlier messages</Button>
                </div>
              )}
              <ol className="space-y-0.5">
                {messages.map((m: any, i: number) => (
                  <MessageRow key={m.id} message={m} previous={messages[i - 1]} me={me}
                    canModerate={channel.my_role === 'owner'}
                    onReply={() => setReplyTo(m)} onEdit={() => setEditing(m)}
                    onDelete={() => setDeleting(m)} onPin={() => pin.mutate(m.id)} />
                ))}
              </ol>
            </>
          )}

          {!atBottom && messages.length > 0 && (
            <button onClick={() => { setAtBottom(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }}
              className="sticky bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line
                         bg-raised px-3 py-1.5 text-[12px] text-muted shadow-[var(--shadow-lg)] cursor-pointer">
              <ArrowDown size={13} /> Jump to latest
            </button>
          )}
        </div>

        {showMembers && channel.kind !== 'direct' && <MembersPanel channel={channel} />}
      </div>

      {/* ------------------------------------------------------ composer */}
      {channel.can_post ? (
        <Composer channel={channel} replyTo={replyTo} clearReply={() => setReplyTo(null)}
          pending={send.isPending} onSend={(body) => send.mutate(body)} />
      ) : <ReadOnlyNote channel={channel} />}

      {editing && (
        <EditModal message={editing} pending={edit.isPending} onClose={() => setEditing(null)}
          onSave={(body) => edit.mutate({ id: editing.id, body })} />
      )}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger confirmLabel="Delete"
        loading={remove.isPending} onConfirm={() => remove.mutate(deleting.id)}
        title="Delete this message?" message="It disappears for everyone. This cannot be undone." />
    </>
  );
}

/* ---------------------------------------------------------- one message */
function MessageRow({ message: m, previous, me, canModerate, onReply, onEdit, onDelete, onPin }: {
  message: any; previous?: any; me: any; canModerate: boolean;
  onReply: () => void; onEdit: () => void; onDelete: () => void; onPin: () => void;
}) {
  const newDay = startsNewDay(m, previous);

  if (m.kind === 'system') {
    return (
      <>
        {newDay && <DaySeparator iso={m.created_at} />}
        <li className="py-1 text-center text-[11.5px] text-subtle">{m.body}</li>
      </>
    );
  }

  // Consecutive lines from one person in the same few minutes read as one turn,
  // so only the first of them carries an avatar and a name.
  const grouped = isSameTurn(m, previous);
  const mine = m.author_id === me?.id;

  return (
    <>
      {newDay && <DaySeparator iso={m.created_at} />}
      <li className={cx('group relative flex gap-2.5 rounded-md px-1.5 hover:bg-sunken', grouped ? 'py-0.5' : 'pt-2 pb-0.5')}>
        <span className="w-8 shrink-0">
          {!grouped && <Avatar name={m.author_name} url={m.author_avatar} size={30} />}
        </span>

        <div className="min-w-0 flex-1">
          {!grouped && (
            <p className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold text-ink">{m.author_name}</span>
              <span className="text-[11px] text-subtle" title={dateTime(m.created_at)}>{time(m.created_at)}</span>
              {m.pinned_at && <Pin size={10} className="text-[var(--accent)]" aria-label="Pinned" />}
            </p>
          )}

          {m.reply_to_id && m.reply_body && (
            <p className="mb-0.5 flex items-center gap-1 truncate text-[11.5px] text-subtle">
              <CornerDownRight size={11} className="shrink-0" />
              <span className="font-medium">{m.reply_author_name}</span>
              <span className="truncate">{m.reply_body}</span>
            </p>
          )}

          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">
            <MessageBody body={m.body} me={me} />
            {m.edited_at && <span className="ml-1.5 text-[11px] text-subtle">(edited)</span>}
          </p>
        </div>

        <span className="absolute right-2 top-1 hidden items-center gap-0.5 rounded-md border border-line bg-raised
                         px-0.5 shadow-[var(--shadow-sm)] group-hover:flex">
          <IconAction label="Reply" onClick={onReply}><Reply size={13} /></IconAction>
          <IconAction label={m.pinned_at ? 'Unpin' : 'Pin'} onClick={onPin}>
            {m.pinned_at ? <PinOff size={13} /> : <Pin size={13} />}
          </IconAction>
          {mine && <IconAction label="Edit" onClick={onEdit}><PencilLine size={13} /></IconAction>}
          {(mine || canModerate) && <IconAction label="Delete" onClick={onDelete}><Trash2 size={13} /></IconAction>}
        </span>
      </li>
    </>
  );
}

const IconAction = ({ label, onClick, children }: { label: string; onClick: () => void; children: any }) => (
  <button onClick={onClick} aria-label={label} title={label}
    className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-sunken hover:text-ink cursor-pointer">
    {children}
  </button>
);

/* ---------------------------------------------------------------- panels */
function MembersPanel({ channel }: { channel: any }) {
  return (
    <aside className="hidden w-[230px] shrink-0 overflow-y-auto border-l border-line p-3 lg:block">
      <p className="label-cap mb-2">
        {channel.kind === 'project' ? 'Delivery team' : 'Members'} ({channel.members.length})
      </p>
      <ul className="space-y-1.5">
        {channel.members.map((m: any) => (
          <li key={m.user_id} className="flex items-center gap-2">
            <Avatar name={m.name} url={m.avatar_url} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-ink">{m.name}</span>
              <span className="block truncate text-[11px] text-subtle">
                {m.project_seat ? titleCase(m.project_seat) : m.designation || titleCase(m.org_role)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {channel.kind === 'project' && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-subtle">
          Membership follows the project team. Add or remove people on the project itself.
        </p>
      )}
    </aside>
  );
}

function EditModal({ message, pending, onClose, onSave }: {
  message: any; pending: boolean; onClose: () => void; onSave: (body: string) => void;
}) {
  const [body, setBody] = useState(message.body);
  return (
    <Modal open onClose={onClose} title="Edit message" size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} disabled={!body.trim()} onClick={() => onSave(body.trim())}>
            Save
          </Button>
        </>
      }>
      <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
    </Modal>
  );
}

/* ------------------------------------------------------ new conversation */
function NewConversationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const { data: directory } = useQuery({
    queryKey: ['users-directory'],
    queryFn: () => api.get('/users/directory').then((r) => r.data),
    staleTime: 300_000,
  });

  const people = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (directory ?? []).filter((u: any) =>
      !q || [u.name, u.designation, u.email].some((v: string) => v?.toLowerCase().includes(q)));
  }, [directory, search]);

  const start = useMutation({
    mutationFn: () => (mode === 'direct'
      ? api.post('/chat/direct', { user_id: picked[0] })
      : api.post('/chat/channels', { name: name.trim(), member_ids: picked })),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
      onCreated(res.data.id);
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = (id: string) => setPicked((prev) => {
    if (mode === 'direct') return prev[0] === id ? [] : [id];
    return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
  });

  const ready = mode === 'direct' ? picked.length === 1 : name.trim().length >= 2;

  return (
    <Modal open onClose={onClose} title="New conversation" size="md"
      subtitle="Project rooms appear on their own when you join a team"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={start.isPending} disabled={!ready} onClick={() => start.mutate()}>
            {mode === 'direct' ? 'Open conversation' : 'Create group'}
          </Button>
        </>
      }>
      <div className="space-y-3">
        <div className="flex gap-1 rounded-md bg-sunken p-1">
          {(['direct', 'group'] as const).map((m) => (
            <button key={m} onClick={() => { setMode(m); setPicked([]); }}
              className={cx('flex-1 rounded px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer',
                mode === m ? 'bg-raised text-ink shadow-[var(--shadow-sm)]' : 'text-subtle hover:text-ink')}>
              {m === 'direct' ? 'Direct message' : 'Group'}
            </button>
          ))}
        </div>

        {mode === 'group' && (
          <Field label="Group name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Design guild" autoFocus />
          </Field>
        )}

        <SearchInput value={search} onChange={setSearch} placeholder="Search people…" />

        <div className="max-h-[38vh] divide-y divide-[var(--line)] overflow-y-auto rounded-lg border border-line">
          {!people.length ? <EmptyState compact title="Nobody matches" /> : people.map((u: any) => (
            <label key={u.id} className={cx('flex cursor-pointer items-center gap-3 p-2.5', picked.includes(u.id) && 'bg-sunken')}>
              <input type={mode === 'direct' ? 'radio' : 'checkbox'} checked={picked.includes(u.id)}
                onChange={() => toggle(u.id)} className="h-4 w-4 accent-[var(--brand)] cursor-pointer" />
              <Avatar name={u.name} url={u.avatar_url} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-ink">{u.name}</span>
                <span className="block truncate text-[12px] text-subtle">{u.designation || titleCase(u.role)}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === 'group' && picked.length > 0 && (
          <p className="text-[12px] text-subtle">{picked.length} person{picked.length === 1 ? '' : 's'} invited.</p>
        )}
      </div>
    </Modal>
  );
}
