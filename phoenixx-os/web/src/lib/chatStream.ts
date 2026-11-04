import { request } from './api';

/**
 * Live chat delivery.
 *
 * The API runs as serverless functions, so there is no single long-lived
 * process to hold an open connection per tab. Instead the client asks
 * `/chat/events` what happened since the last cursor it saw - a short request
 * every few seconds while the tab is visible, and none while it is hidden.
 *
 * Delivery is an optimisation, never the source of truth: callers refetch on
 * each event, so a missed poll only delays a message rather than losing it.
 * Failures back off to 60s so a server that is down does not get hammered by
 * every open tab.
 */

export type ChatEvent =
  | { type: 'message'; channel_id: string; message: any }
  | { type: 'read'; channel_id: string; user_id: string; at: string };

type Handler = (event: ChatEvent) => void;

/** How often a visible tab checks for new chat activity. */
const POLL_MS = 15_000;

type EventsResponse = { data: { cursor: number; events: ChatEvent[] } };

export function openChatStream(onEvent: Handler): () => void {
  let stopped = false;
  let cursor: number | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(poll, ms);
  };

  const poll = async () => {
    if (stopped || inFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // resumes on focus
    inFlight = true;
    try {
      const path = cursor === null ? '/chat/events' : `/chat/events?after=${cursor}`;
      const res = await request<EventsResponse>(path);
      const first = cursor === null;
      cursor = res.data.cursor;
      failures = 0;
      if (!first) {
        for (const event of res.data.events) {
          try { onEvent(event); } catch { /* one bad handler is not worth a crash */ }
        }
      }
    } catch {
      failures += 1;
    } finally {
      inFlight = false;
    }
    schedule(failures ? Math.min(60_000, POLL_MS * 2 ** Math.min(failures, 2)) : POLL_MS);
  };

  // Coming back to the tab: catch up at once rather than waiting out the timer.
  const onVisible = () => {
    if (document.visibilityState === 'visible') schedule(0);
  };
  document.addEventListener('visibilitychange', onVisible);

  poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
