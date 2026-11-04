import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Megaphone, Hash, MessageSquare, Users2, Send, Loader2, CornerDownRight, X } from 'lucide-react';
import { openChatStream } from '../lib/chatStream';
import { date } from '../lib/format';
import { Avatar, Button, Textarea, cx } from './ui';

/**
 * The pieces of chat that both surfaces need: the full page at /chat and the
 * panel on My Day. Sharing them is the point - a message must look and behave
 * the same wherever it is read, and the composer's @mention handling is not
 * something to write twice.
 */

export const KIND_UI: Record<string, { icon: any; section: string; label: string }> = {
  broadcast: { icon: Megaphone, section: 'Company', label: 'Announcement' },
  project: { icon: Hash, section: 'Project teams', label: 'Project room' },
  group: { icon: Users2, section: 'Groups', label: 'Group' },
  direct: { icon: MessageSquare, section: 'Direct messages', label: 'Direct message' },
};
export const SECTIONS = ['Company', 'Project teams', 'Groups', 'Direct messages'];

export function ChannelIcon({ channel, size = 15, className }: { channel: any; size?: number; className?: string }) {
  const Icon = KIND_UI[channel?.kind]?.icon || Hash;
  return <Icon size={size} className={className} aria-hidden />;
}

/**
 * Keeps every open chat view current. Each surface calls this, so a message
 * that arrives while you are on My Day lands there without a refresh.
 */
export function useChatStream(extra?: (event: any) => void) {
  const qc = useQueryClient();
  const handler = useRef(extra);
  handler.current = extra;

  useEffect(() => openChatStream((event) => {
    invalidateChat(qc, event.type === 'message' ? event.channel_id : undefined);
    handler.current?.(event);
  }), [qc]);
}

/** One place that knows which caches a chat write invalidates. */
export function invalidateChat(qc: QueryClient, channelId?: string) {
  qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
  qc.invalidateQueries({ queryKey: ['home-counters'] });
  qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
  if (channelId) {
    qc.invalidateQueries({ queryKey: ['chat', 'messages', channelId] });
    qc.invalidateQueries({ queryKey: ['chat', 'channel', channelId] });
  }
}

/** Highlights @names, and highlights yours harder - that is the point of them. */
export function MessageBody({ body, me }: { body: string; me: any }) {
  const mine = [me?.name, me?.name?.split(' ')[0], me?.email?.split('@')[0]]
    .filter(Boolean).map((s: string) => s.toLowerCase());
  const parts = body.split(/(@[\w.'-]+(?:\s[A-Z][\w.'-]+)?)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (!part.startsWith('@')) return <span key={i}>{part}</span>;
        const isMe = mine.includes(part.slice(1).toLowerCase());
        return (
          <span key={i} className={cx('rounded px-1 font-medium',
            isMe ? 'bg-accent-soft text-[var(--accent)]' : 'text-[var(--brand)]')}>
            {part}
          </span>
        );
      })}
    </>
  );
}

export function DaySeparator({ iso }: { iso: string }) {
  const day = new Date(iso).toDateString();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : date(iso, 'long');

  return (
    <li className="my-2 flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--line)]" />
      <span className="text-[11px] font-medium text-subtle">{label}</span>
      <span className="h-px flex-1 bg-[var(--line)]" />
    </li>
  );
}

/** True when two messages should read as one turn rather than two. */
export const isSameTurn = (m: any, previous?: any) => !!previous
  && previous.author_id === m.author_id && previous.kind === 'text' && m.kind === 'text'
  && new Date(m.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60_000
  && new Date(previous.created_at).toDateString() === new Date(m.created_at).toDateString();

export const startsNewDay = (m: any, previous?: any) => !previous
  || new Date(previous.created_at).toDateString() !== new Date(m.created_at).toDateString();

/* --------------------------------------------------------------- composer */
export function Composer({ channel, replyTo, clearReply, pending, onSend, compact }: {
  channel: any; replyTo?: any; clearReply?: () => void;
  pending: boolean; onSend: (body: string) => void; compact?: boolean;
}) {
  const [body, setBody] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return (channel.members ?? []).filter((m: any) => m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [channel.members, mentionQuery]);

  const submit = () => {
    const text = body.trim();
    if (!text || pending) return;
    onSend(text);
    setBody('');
    setMentionQuery(null);
  };

  /** Tracks the @word being typed at the caret, so completion is contextual. */
  const onChange = (value: string) => {
    setBody(value);
    const upToCaret = value.slice(0, inputRef.current?.selectionStart ?? value.length);
    const match = /@([\w.'-]*)$/.exec(upToCaret);
    setMentionQuery(match ? match[1] : null);
  };

  const complete = (name: string) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const head = body.slice(0, caret).replace(/@([\w.'-]*)$/, `@${name} `);
    setBody(head + body.slice(caret));
    setMentionQuery(null);
    el?.focus();
  };

  return (
    <div className={cx('border-t border-line', compact ? 'p-2' : 'p-2.5')}>
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-sunken px-2.5 py-1.5">
          <CornerDownRight size={13} className="shrink-0 text-subtle" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
            <span className="font-medium">{replyTo.author_name}</span> {replyTo.body}
          </span>
          <button onClick={clearReply} aria-label="Cancel reply" className="cursor-pointer text-subtle hover:text-ink">
            <X size={14} />
          </button>
        </div>
      )}

      {channel.kind === 'broadcast' && (
        <p className={cx('mb-2 flex items-center gap-1.5 rounded-md bg-accent-soft px-2.5 py-1.5 text-[var(--accent)]',
          compact ? 'text-[11.5px]' : 'text-[12px]')}>
          <Megaphone size={13} className="shrink-0" />
          {compact
            ? 'Goes to everyone in the workspace.'
            : 'This goes to everyone in the workspace and lands in their notifications.'}
        </p>
      )}

      <div className="relative">
        {candidates.length > 0 && (
          <ul className="absolute bottom-full left-0 z-10 mb-1 w-[260px] overflow-hidden rounded-lg border border-line
                         bg-raised shadow-[var(--shadow-lg)]">
            {candidates.map((m: any) => (
              <li key={m.user_id}>
                <button onClick={() => complete(m.name)}
                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-sunken">
                  <Avatar name={m.name} url={m.avatar_url} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{m.name}</span>
                  {m.project_seat && <span className="text-[11px] text-subtle">{m.project_seat}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            rows={1}
            value={body}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              if (e.key === 'Escape') setMentionQuery(null);
            }}
            placeholder={channel.kind === 'broadcast'
              ? 'Write an announcement…'
              : compact ? `Message ${channel.label}…` : `Message ${channel.label}…  (@ to mention, Enter to send)`}
            className={cx('flex-1 resize-y', compact ? 'max-h-28 min-h-[36px] text-[13px]' : 'max-h-40 min-h-[38px]')}
          />
          <Button variant="primary" size={compact ? 'sm' : 'md'}
            icon={pending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            disabled={!body.trim() || pending} onClick={submit} aria-label="Send" />
        </div>
      </div>
    </div>
  );
}

/** The line shown instead of a composer when this person may not post here. */
export function ReadOnlyNote({ channel, compact }: { channel: any; compact?: boolean }) {
  return (
    <p className={cx('border-t border-line px-4 py-3 text-subtle', compact ? 'text-[11.5px]' : 'text-[12.5px]')}>
      {channel.archived_at
        ? 'This conversation is archived. It is kept for the record but nobody can post here.'
        : 'Only owners, managers and HR post company announcements. You will see everything posted here.'}
    </p>
  );
}
