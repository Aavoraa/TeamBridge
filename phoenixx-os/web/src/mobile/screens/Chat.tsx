/**
 * Team Chat — recent conversations, then one thread at a time.
 *
 * Two views in one route: the list at /m/chat, a thread at /m/chat/:channelId.
 * Keeping them on separate URLs is what makes Android's back button behave —
 * back from a thread returns to the list rather than leaving the app.
 *
 * Direct messages, group channels and the company-wide broadcast all arrive
 * from the same /chat/channels call; `kind` is what separates them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Megaphone, MessagesSquare, Search, Send, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { avatarColor, initials, relative, time as fmtTime } from '../../lib/format';
import { useToast } from '../../components/ui';
import { Empty, ErrorNote, List, Loading, Row, Screen, inputClass } from '../ui';

const CHANNELS_KEY = ['m', 'channels'];

export default function MobileChat() {
  const { channelId } = useParams();
  return channelId ? <Thread channelId={channelId} /> : <ChannelList />;
}

/* ----------------------------------------------------------------- list */

function ChannelList() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: () => api.get('/chat/channels').then((r) => r.data),
    refetchInterval: 20_000,
  });

  const channels = useMemo(() => {
    const list: any[] = data || [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => (c.label || c.name || '').toLowerCase().includes(q)
      || (c.last_message?.body || '').toLowerCase().includes(q));
  }, [data, search]);

  if (isLoading) return <Loading label="Loading chats" />;
  if (error) return <div className="p-4"><ErrorNote error={error} retry={refetch} /></div>;

  const unreadTotal = (data || []).reduce((n: number, c: any) => n + (c.muted ? 0 : c.unread), 0);
  // Already ordered by last_message_at server-side; anything that has never had
  // a message is not "recent" in any useful sense.
  const recent = (data || []).filter((c: any) => c.last_message).slice(0, 8);

  return (
    <Screen
      title="Chat"
      subtitle={unreadTotal > 0 ? `${unreadTotal} unread` : 'All caught up'}
    >
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          className={`${inputClass} pl-9`} value={search} type="search"
          placeholder="Search conversations"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Recent: the handful you actually go back to, one tap from the top of
          the screen. Hidden while searching, when the list below is the answer. */}
      {!search && recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="label-cap px-0.5">Recent</h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
            {recent.map((c: any) => (
              <button
                key={c.id} type="button" onClick={() => nav(`/m/chat/${c.id}`)}
                className="flex w-[64px] shrink-0 flex-col items-center gap-1.5 active:scale-95
                           transition-transform duration-100"
              >
                <span className="relative">
                  <ChannelAvatar channel={c} />
                  {!c.muted && c.unread > 0 && (
                    <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-[var(--negative)]
                                     px-1 text-center text-[10px] font-bold leading-[17px] text-white">
                      {c.unread > 9 ? '9+' : c.unread}
                    </span>
                  )}
                </span>
                <span className="w-full truncate text-center text-[11px] leading-tight text-subtle">
                  {(c.label || c.name || '').split(' ')[0]}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!search && <h2 className="label-cap px-0.5">All conversations</h2>}

      <List empty={<Empty icon={<MessagesSquare size={22} />} title="No conversations"
        message={search ? 'Nothing matches that search.' : 'Channels you belong to appear here.'} />}>
        {channels.map((c) => (
          <Row
            key={c.id}
            onClick={() => nav(`/m/chat/${c.id}`)}
            leading={<ChannelAvatar channel={c} />}
            title={(
              <span className="flex items-center gap-1.5">
                <span className="truncate">{c.label || c.name}</span>
                {c.kind === 'broadcast' && <Megaphone size={13} className="shrink-0 text-subtle" />}
              </span>
            )}
            meta={c.last_message
              ? `${c.last_message.author_name ? `${c.last_message.author_name.split(' ')[0]}: ` : ''}${c.last_message.body}`
              : 'No messages yet'}
            right={(
              <span className="flex flex-col items-end gap-1">
                <span className="text-[11.5px] text-subtle">
                  {c.last_message?.created_at ? relative(c.last_message.created_at) : ''}
                </span>
                {!c.muted && c.unread > 0 && (
                  <span className="min-w-[20px] rounded-full bg-[var(--brand)] px-1.5 text-center
                                   text-[11px] font-bold leading-[19px] text-white">
                    {c.unread > 99 ? '99+' : c.unread}
                  </span>
                )}
              </span>
            )}
          />
        ))}
      </List>
    </Screen>
  );
}

function ChannelAvatar({ channel }: { channel: any }) {
  const name = channel.label || channel.name || '?';
  if (channel.kind === 'broadcast') {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Megaphone size={17} />
      </span>
    );
  }
  if (channel.kind !== 'direct') {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
        <Users size={17} />
      </span>
    );
  }
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
      style={{ background: avatarColor(name) }}
    >
      {initials(name)}
    </span>
  );
}

/* --------------------------------------------------------------- thread */

function Thread({ channelId }: { channelId: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: channel } = useQuery({
    queryKey: ['m', 'channel', channelId],
    queryFn: () => api.get(`/chat/channels/${channelId}`).then((r) => r.data),
    // Seeded from the list when we arrived by tapping, fetched when the thread
    // was opened cold from a link or a reload.
    initialData: () => (qc.getQueryData(CHANNELS_KEY) as any[] | undefined)
      ?.find((c) => c.id === channelId),
    staleTime: 60_000,
  });

  const messagesKey = ['m', 'messages', channelId];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: messagesKey,
    queryFn: () => api.get(`/chat/channels/${channelId}/messages`, { limit: 40 }).then((r) => r.data),
    refetchInterval: 8_000,
  });

  // Marking read on open is what clears the tab badge; the list is refetched so
  // the count disappears from both places at once.
  useEffect(() => {
    api.post(`/chat/channels/${channelId}/read`)
      .then(() => qc.invalidateQueries({ queryKey: CHANNELS_KEY }))
      .catch(() => { /* a failed read receipt is not worth interrupting anyone */ });
  }, [channelId, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [data]);

  // Android back leaves the thread rather than the app.
  useEffect(() => {
    const onBack = (e: Event) => { e.preventDefault(); nav('/m/chat'); };
    window.addEventListener('phoenixx:back', onBack);
    return () => window.removeEventListener('phoenixx:back', onBack);
  }, [nav]);

  const send = useMutation({
    mutationFn: (body: string) => api.post(`/chat/channels/${channelId}/messages`, { body }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: messagesKey });
      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const submit = () => {
    const body = draft.trim();
    if (body) send.mutate(body);
  };

  const messages: any[] = data || [];
  // Announcement channels are read-only for everyone but the broadcasters.
  const canPost = channel?.can_post !== false;

  return (
    <div className="flex min-h-screen flex-col pb-[calc(58px+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-raised/95 px-2 py-2 backdrop-blur">
        <button type="button" onClick={() => nav('/m/chat')} aria-label="Back to conversations"
          className="flex h-11 w-11 items-center justify-center rounded-full text-ink active:bg-sunken">
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold leading-tight text-ink">
            {channel?.label || channel?.name || 'Conversation'}
          </h1>
          {channel?.member_count > 0 && (
            <p className="text-[12px] text-subtle">{channel.member_count} members</p>
          )}
        </div>
      </header>

      <div className="flex-1 space-y-2 px-3 py-3">
        {isLoading && <Loading label="Loading messages" />}
        {error && <ErrorNote error={error} retry={refetch} />}
        {!isLoading && !error && messages.length === 0 && (
          <Empty icon={<MessagesSquare size={22} />} title="No messages yet"
            message="Say something to get this started." />
        )}
        {messages.map((m) => <Bubble key={m.id} message={m} mine={m.author_id === user?.id} />)}
        <div ref={bottomRef} />
      </div>

      {!canPost ? (
        <div className="sticky bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 border-t border-line
                        bg-raised px-4 py-3 text-center text-[12.5px] text-subtle">
          Only broadcasters can post in this channel.
        </div>
      ) : (
      <div className="sticky bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 flex items-end gap-2
                      border-t border-line bg-raised px-3 py-2">
        <textarea
          rows={1} value={draft} placeholder="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          className={`${inputClass} max-h-32 min-h-[44px] resize-none py-2.5`}
        />
        <button
          type="button" onClick={submit} aria-label="Send message"
          disabled={!draft.trim() || send.isPending}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--brand)]
                     text-white disabled:opacity-40"
        >
          <Send size={18} />
        </button>
      </div>
      )}
    </div>
  );
}

function Bubble({ message, mine }: { message: any; mine: boolean }) {
  if (message.kind === 'system') {
    return (
      <p className="py-1 text-center text-[12px] text-subtle">{message.body}</p>
    );
  }
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[82%] rounded-2xl px-3 py-2 ${
        mine ? 'bg-[var(--brand)] text-white' : 'card'
      }`}>
        {!mine && (
          <p className="mb-0.5 text-[11.5px] font-semibold text-subtle">{message.author_name}</p>
        )}
        <p className={`whitespace-pre-wrap break-words text-[14.5px] leading-snug ${mine ? 'text-white' : 'text-ink'}`}>
          {message.body}
        </p>
        <p className={`mt-1 text-right text-[10.5px] ${mine ? 'text-white/70' : 'text-subtle'}`}>
          {fmtTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}
