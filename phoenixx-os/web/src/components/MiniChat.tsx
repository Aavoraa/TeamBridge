import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, Maximize2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { time } from '../lib/format';
import { Avatar, Card, CardHeader, EmptyState, Skeleton, useToast, cx } from './ui';
import {
  ChannelIcon, Composer, DaySeparator, MessageBody, ReadOnlyNote,
  invalidateChat, isSameTurn, startsNewDay, useChatStream,
} from './chatKit';

/**
 * Chat on My Day.
 *
 * Not a link to chat - chat itself: pick a conversation, read it, reply to it,
 * without leaving the page you start your day on. It is the same API and the
 * same live stream as the full screen, so the two never disagree; what is cut
 * is the things you go to the full screen for (search, pins, member lists,
 * starting new conversations).
 *
 * The conversation it opens on is the one that most wants you: whatever has
 * unread, otherwise the company channel.
 */
export default function MiniChat({ className }: { className?: string } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const scroller = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useChatStream();

  const { data: channels, isLoading } = useQuery({
    queryKey: ['chat', 'channels'],
    queryFn: () => api.get('/chat/channels').then((r) => r.data),
    refetchInterval: 60_000,
  });

  /* Unread first, then the company channel: the panel opens on what matters. */
  const activeId = useMemo(() => {
    if (!channels?.length) return null;
    if (picked && channels.some((c: any) => c.id === picked)) return picked;
    const unread = channels.find((c: any) => c.unread > 0 && !c.muted);
    return (unread ?? channels.find((c: any) => c.kind === 'broadcast') ?? channels[0]).id;
  }, [channels, picked]);

  const { data: channel } = useQuery({
    queryKey: ['chat', 'channel', activeId],
    queryFn: () => api.get(`/chat/channels/${activeId}`).then((r) => r.data),
    enabled: !!activeId,
  });

  const { data: messages } = useQuery({
    queryKey: ['chat', 'messages', activeId],
    // A short tail: this is a place to catch up and reply, not to read history.
    queryFn: () => api.get(`/chat/channels/${activeId}/messages`, { limit: 15 }).then((r) => r.data),
    enabled: !!activeId,
  });

  const markRead = useMutation({
    mutationFn: () => api.post(`/chat/channels/${activeId}/read`),
    onSuccess: () => invalidateChat(qc),
  });

  const send = useMutation({
    mutationFn: (body: string) => api.post(`/chat/channels/${activeId}/messages`, { body }),
    onSuccess: () => invalidateChat(qc, activeId!),
    onError: (e: any) => toast.error(e.message),
  });

  /* Reading here counts as reading, the same as it does on the full screen. */
  const unread = channel?.unread ?? 0;
  useEffect(() => {
    if (activeId && unread > 0 && document.visibilityState === 'visible') markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, unread]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages?.length, activeId]);

  const unreadTotal = (channels ?? []).reduce((n: number, c: any) => n + (c.muted ? 0 : c.unread), 0);

  return (
    <Card className={cx('flex flex-col overflow-hidden', className || 'h-[440px]')}>
      <CardHeader
        title="Team chat"
        icon={<MessagesSquare size={16} />}
        subtitle={unreadTotal
          ? `${unreadTotal} unread message${unreadTotal === 1 ? '' : 's'}`
          : 'Your rooms and company announcements'}
        action={
          <Link to={activeId ? `/chat?channel=${activeId}` : '/chat'}
            className="flex items-center gap-1 text-[13px] text-[var(--brand)] hover:underline">
            <Maximize2 size={13} /> Open
          </Link>
        }
      />

      {isLoading ? (
        <div className="space-y-2 p-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : !channels?.length ? (
        <EmptyState compact title="No conversations yet"
          message="Join a project team and its room appears here." />
      ) : (
        <>
          {/* ------------------------------------------------- conversation */}
          <div className="flex gap-1.5 overflow-x-auto border-b border-line px-2.5 pb-2">
            {channels.map((c: any) => (
              <button key={c.id} onClick={() => setPicked(c.id)} title={c.label}
                className={cx('flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] cursor-pointer',
                  'transition-colors duration-150',
                  c.id === activeId
                    ? 'border-[color-mix(in_srgb,var(--brand)_35%,transparent)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                {c.kind === 'direct' && c.counterpart
                  ? <Avatar name={c.counterpart.name} url={c.counterpart.avatar_url} size={16} />
                  : <ChannelIcon channel={c} size={12} />}
                <span className="max-w-[110px] truncate">{c.label}</span>
                {c.unread > 0 && (
                  <span className={cx('rounded-full px-1 text-[10.5px] font-semibold tabular',
                    c.muted ? 'bg-sunken text-subtle' : 'bg-[var(--brand)] text-white')}>
                    {c.unread > 9 ? '9+' : c.unread}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ----------------------------------------------------- messages */}
          <div ref={scroller} className="flex-1 overflow-y-auto px-2.5 py-2">
            {!messages ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : !messages.length ? (
              <div className="grid h-full place-items-center">
                <EmptyState compact title="Nothing said yet"
                  message={channel?.kind === 'broadcast'
                    ? 'Announcements land here.'
                    : 'Be the first to say something.'} />
              </div>
            ) : (
              <ol>
                {messages.map((m: any, i: number) => (
                  <MiniMessage key={m.id} message={m} previous={messages[i - 1]} me={user} />
                ))}
              </ol>
            )}
          </div>

          {/* ----------------------------------------------------- composer */}
          {!channel ? <div className="border-t border-line p-2"><Skeleton className="h-9" /></div>
            : channel.can_post
              ? <Composer compact channel={channel} pending={send.isPending} onSend={(body) => send.mutate(body)} />
              : <ReadOnlyNote compact channel={channel} />}
        </>
      )}
    </Card>
  );
}

/** A tighter message row: no hover actions, no reply preview beyond one line. */
function MiniMessage({ message: m, previous, me }: { message: any; previous?: any; me: any }) {
  if (m.kind === 'system') {
    return (
      <>
        {startsNewDay(m, previous) && <DaySeparator iso={m.created_at} />}
        <li className="py-0.5 text-center text-[11px] text-subtle">{m.body}</li>
      </>
    );
  }

  const grouped = isSameTurn(m, previous);

  return (
    <>
      {startsNewDay(m, previous) && <DaySeparator iso={m.created_at} />}
      <li className={cx('flex gap-2', grouped ? 'py-px' : 'pt-1.5')}>
        <span className="w-6 shrink-0">
          {!grouped && <Avatar name={m.author_name} url={m.author_avatar} size={24} />}
        </span>
        <div className="min-w-0 flex-1">
          {!grouped && (
            <p className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-semibold text-ink">{m.author_name}</span>
              <span className="text-[10.5px] text-subtle">{time(m.created_at)}</span>
            </p>
          )}
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
            <MessageBody body={m.body} me={me} />
          </p>
        </div>
      </li>
    </>
  );
}
