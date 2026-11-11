import type { QueryClient } from '@tanstack/react-query';

/**
 * How often TeamBridge refreshes itself, in seconds - one table for the whole
 * app instead of a number in every screen.
 *
 * Kept efficient by three rules React Query already follows:
 *  - a screen only refreshes the data it is showing (nothing polls off-screen);
 *  - polling pauses while the browser tab or the app is in the background;
 *  - coming back to the tab refreshes anything older than its interval at once.
 * Saving something (a task, a request, a check-in) refreshes the affected lists
 * straight away, so these intervals only matter for changes other people make.
 */
export const REFRESH_SECONDS = {
  /** Notifications, chat and the counts on the menu: what someone is waiting for. */
  live: 10,
  /** Today's work: tasks, to-dos, requests, attendance, daily updates. */
  work: 15,
  /** Pages people read: dashboards, projects, CRM, approvals, finance lists. */
  pages: 30,
  /** Figures that move slowly: reports, performance, profitability. */
  reports: 60,
} as const;

export type RefreshKind = keyof typeof REFRESH_SECONDS;
export const refreshMs = (kind: RefreshKind) => REFRESH_SECONDS[kind] * 1000;

/** Which data refreshes on which schedule, by the first part of its query key. */
const SCHEDULE: Record<RefreshKind, string[]> = {
  live: ['notifications', 'chat', 'task-requests', 'join-requests'],
  work: [
    'home-counters', 'action-items', 'action-item', 'action-item-meta', 'todos', 'todo-plan', 'todo-schedule', 'my-updates',
    'team-updates', 'attendance', 'regularizations', 'leave-requests', 'deadlines', 'escalations',
    'project-updates', 'project-updates-feed', 'project-updates-to-file',
  ],
  pages: [
    'dashboard', 'projects', 'project', 'my-team', 'project-workload', 'team-workload', 'crm', 'client',
    'marketing-leads', 'marketing-lead', 'marketing-overview', 'marketing-attention', 'marketing-activity',
    'reimbursements', 'reimbursement', 'invoices', 'invoice', 'proposals', 'proposal', 'receivables',
    'meetings', 'meeting', 'ai-meetings', 'meeting-intel', 'team', 'join-invites', 'leave-balances',
  ],
  reports: ['reports', 'report', 'performance', 'scorecard', 'profitability', 'costs', 'kpis', 'marketing-reports', 'sop-adherence'],
};

export function applyRefreshSchedule(client: QueryClient) {
  for (const [kind, keys] of Object.entries(SCHEDULE) as [RefreshKind, string[]][]) {
    const ms = refreshMs(kind);
    for (const key of keys) {
      // Fresh for most of the interval, so opening a screen twice does not fetch twice.
      client.setQueryDefaults([key], { refetchInterval: ms, staleTime: Math.round(ms * 0.8) });
    }
  }
}
