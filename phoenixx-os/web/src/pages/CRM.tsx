import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Users2, Download, Upload, LayoutGrid, List, AlertTriangle, Filter, X,
  TrendingUp, PhoneCall, Building2, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBoardDnd, useKeyboardCardMove, type CardDrop } from '../lib/useBoardDnd';
import { money, relative, daysUntil } from '../lib/format';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Meter,
  Modal, PageHeader, SearchInput, Select, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR,
  Textarea, useToast, cx,
} from '../components/ui';

/** Module E — pipeline board plus a filterable client register. */
export default function CRM() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [view, setView] = useState<'board' | 'list'>('board');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [addStage, setAddStage] = useState('');   // stage the "+" was pressed in
  const [importOpen, setImportOpen] = useState(false);

  const filters = {
    status: params.get('status') || '',
    stage_id: params.get('stage_id') || '',
    owner_id: params.get('owner_id') || '',
    industry: params.get('industry') || '',
    retention_risk: params.get('retention_risk') || '',
    filter: params.get('filter') || '',
    // Set by the "N leads" link on the Clients page, to show just that client's
    // pipeline records.
    client_account_id: params.get('client_account_id') || '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const activeFilters = Object.values(filters).filter(Boolean).length;

  const { data: pipeline, isLoading: loadingBoard, error: boardError, refetch } = useQuery({
    queryKey: ['crm', 'pipeline'],
    queryFn: () => api.get('/crm/pipeline').then((r) => r.data),
    enabled: view === 'board' && !activeFilters && !search,
  });

  const listActive = view === 'list' || !!activeFilters || !!search;
  const { data: list, isLoading: loadingList } = useQuery({
    queryKey: ['crm', 'clients', filters, search],
    queryFn: () => api.get('/crm/clients', { ...filters, search, limit: 100 }).then((r) => r.data),
    enabled: listActive,
  });

  const { data: meta } = useQuery({
    queryKey: ['crm-meta'],
    queryFn: async () => {
      const [stages, directory, serviceLines] = await Promise.all([
        api.get('/settings/pipeline-stages').then((r) => r.data),
        api.get('/users/directory').then((r) => r.data),
        api.get('/settings/service-lines').then((r) => r.data),
      ]);
      return { stages, directory, serviceLines };
    },
    staleTime: 300_000,
  });

  const totals = useMemo(() => {
    if (!pipeline) return null;
    return {
      count: pipeline.reduce((a: number, s: any) => a + s.count, 0),
      value: pipeline.reduce((a: number, s: any) => a + s.value_minor, 0),
    };
  }, [pipeline]);

  return (
    <>
      <PageHeader
        title="CRM pipeline"
        subtitle={totals
          ? `${totals.count} in the pipeline · ${money(totals.value, { compact: true })} in flight`
          : 'Outreach through to retention'}
        actions={
          <>
            <div className="flex rounded-md border border-line-strong overflow-hidden">
              <button onClick={() => setView('board')} aria-label="Board view" aria-pressed={view === 'board'}
                className={cx('grid h-9 w-9 place-items-center cursor-pointer transition-colors duration-150',
                  view === 'board' ? 'bg-brand-soft text-[var(--brand)]' : 'text-subtle hover:bg-sunken')}>
                <LayoutGrid size={15} />
              </button>
              <button onClick={() => setView('list')} aria-label="List view" aria-pressed={view === 'list'}
                className={cx('grid h-9 w-9 place-items-center cursor-pointer border-l border-line transition-colors duration-150',
                  view === 'list' ? 'bg-brand-soft text-[var(--brand)]' : 'text-subtle hover:bg-sunken')}>
                <List size={15} />
              </button>
            </div>
            {can('crm', 'export') && (
              <Button icon={<Download size={15} />} onClick={() => api.download('/crm/clients/export', 'clients.csv')}>
                Export
              </Button>
            )}
            {can('crm', 'create') && (
              <>
                <Button icon={<Upload size={15} />} onClick={() => setImportOpen(true)}>Import</Button>
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New lead</Button>
              </>
            )}
          </>
        }
      />

      {/* ------------------------------------------------------- filter bar */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name, industry or city…"
            className="flex-1 min-w-[220px]" />
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Status" className="w-[128px]">
            <option value="">All statuses</option>
            <option value="lead">Leads</option>
            <option value="active">Active</option>
            <option value="churned">Churned</option>
            <option value="lost">Lost</option>
          </Select>
          <Select value={filters.owner_id} onChange={(e) => setFilter('owner_id', e.target.value)}
            aria-label="Owner" className="w-[140px]">
            <option value="">Any owner</option>
            {meta?.directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <Button size="sm" variant={filters.retention_risk ? 'danger' : 'secondary'}
            icon={<AlertTriangle size={14} />}
            onClick={() => setFilter('retention_risk', filters.retention_risk ? '' : 'true')}>
            At risk
          </Button>
          <Button size="sm" variant={filters.filter === 'no_next_action' ? 'accent' : 'secondary'}
            onClick={() => setFilter('filter', filters.filter === 'no_next_action' ? '' : 'no_next_action')}>
            No next action
          </Button>
          <Button size="sm" variant={filters.filter === 'follow_up_due' ? 'accent' : 'secondary'}
            icon={<PhoneCall size={14} />}
            onClick={() => setFilter('filter', filters.filter === 'follow_up_due' ? '' : 'follow_up_due')}>
            Follow-up due
          </Button>
          {(activeFilters > 0 || search) && (
            <Button size="sm" variant="ghost" icon={<X size={14} />}
              onClick={() => { setParams(new URLSearchParams(), { replace: true }); setSearch(''); }}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      {/* ---------------------------------------------------------- content */}
      {boardError ? <ErrorState error={boardError} retry={refetch} />
        : listActive ? (
          loadingList ? <Card><TableSkeleton /></Card> : <ClientList clients={list || []} />
        ) : loadingBoard ? (
          <div className="board-rail" style={{ height: 'clamp(24rem, calc(100dvh - 21rem), 56rem)' }}>
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-full shrink-0 basis-[300px]" />)}
          </div>
        ) : (
          <PipelineBoard
            stages={pipeline || []}
            serviceLines={meta?.serviceLines || []}
            onAdd={(stageId) => { setAddStage(stageId); setCreateOpen(true); }}
          />
        )}

      {createOpen && (
        <CreateClientModal
          meta={meta}
          stageId={addStage}
          onClose={() => { setCreateOpen(false); setAddStage(''); }}
        />
      )}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
    </>
  );
}

/* ==========================================================================
   Pipeline board — a Kanban rail with drag-and-drop across and within stages.

   Ordering is server-side (`clients.board_sort`, a fractional index), so a
   drop persists and everyone sees the same board. The mutation updates the
   cached pipeline first and only then talks to the API: a card that snaps
   back for 300ms while a round-trip completes feels broken.
   ========================================================================== */

/** Stages carry no colour of their own, so derive a stable one from position. */
const STAGE_HUES = ['#64748b', '#3b82f6', '#7c3aed', '#f59e0b', '#0f766e', '#15803d', '#be185d'];
const stageHue = (i: number, s: any) =>
  s.is_won ? 'var(--positive)' : s.is_lost ? 'var(--negative)' : STAGE_HUES[i % STAGE_HUES.length];

/** Deterministic label colour, so a service line looks the same on every card. */
const LABEL_HUES = ['#3b82f6', '#7c3aed', '#0f766e', '#f59e0b', '#be185d', '#0891b2', '#65a30d', '#e11d48'];
const labelHue = (s: string) =>
  LABEL_HUES[Math.abs([...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)) % LABEL_HUES.length];

function PipelineBoard({ stages, serviceLines, onAdd }: {
  stages: any[];
  serviceLines: any[];
  onAdd: (stageId: string) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('crm', 'edit');
  const canReorderStages = can('settings', 'edit');

  const [labelsOpen, setLabelsOpen] = useState(false);
  const slName = useMemo(
    () => Object.fromEntries((serviceLines || []).map((s: any) => [s.id, s.name])),
    [serviceLines],
  );

  /* ------------------------------------------------------------ mutations */
  const move = useMutation({
    mutationFn: (d: CardDrop) => api.post('/crm/pipeline/move', {
      client_id: d.id, stage_id: d.toListId, prev_id: d.prevId, next_id: d.nextId,
    }),
    onMutate: async (d: CardDrop) => {
      await qc.cancelQueries({ queryKey: ['crm', 'pipeline'] });
      const prev = qc.getQueryData<any[]>(['crm', 'pipeline']);
      qc.setQueryData<any[]>(['crm', 'pipeline'], (old) => old && applyMove(old, d));
      return { prev };
    },
    onError: (e: any, _d, ctx) => {
      if (ctx?.prev) qc.setQueryData(['crm', 'pipeline'], ctx.prev);
      toast.error(e.message || 'That move could not be saved.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });

  const reorderStages = useMutation({
    mutationFn: (order: string[]) => api.post('/settings/pipeline-stages/reorder', { order }),
    onMutate: async (order: string[]) => {
      await qc.cancelQueries({ queryKey: ['crm', 'pipeline'] });
      const prev = qc.getQueryData<any[]>(['crm', 'pipeline']);
      qc.setQueryData<any[]>(['crm', 'pipeline'], (old) =>
        old && order.map((id) => old.find((s) => s.id === id)).filter(Boolean));
      return { prev };
    },
    onError: (e: any, _o, ctx) => {
      if (ctx?.prev) qc.setQueryData(['crm', 'pipeline'], ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['crm-meta'] }),
  });

  /* ------------------------------------------------------------------ dnd */
  const { boardRef } = useBoardDnd({
    disabled: !canEdit,
    onCardDrop: (d) => {
      if (d.toListId === d.fromListId && d.prevId === null && d.nextId === null) return;
      move.mutate(d);
    },
    onListDrop: canReorderStages ? ({ order }) => reorderStages.mutate(order) : undefined,
  });

  const { grabbed, setGrabbed } = useKeyboardCardMove(
    useMemo(() => stages.map((s) => ({ id: s.id, cards: s.clients })), [stages]),
    (d) => move.mutate(d),
    canEdit,
  );

  const total = stages.reduce((a, s) => a + s.count, 0) || 1;

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[12px] text-subtle">
          {canEdit
            ? 'Drag a card to change its stage, or drop it higher to reprioritise.'
            : 'Read-only — you do not have permission to move cards.'}
        </p>
        <button
          onClick={() => setLabelsOpen((v) => !v)}
          className="text-[12px] text-subtle hover:text-ink transition-colors cursor-pointer shrink-0"
          aria-pressed={labelsOpen}
        >
          {labelsOpen ? 'Hide' : 'Show'} labels
        </button>
      </div>

      <div
        ref={boardRef}
        className="board-rail"
        style={{ height: 'clamp(24rem, calc(100dvh - 21rem), 56rem)' }}
        role="list"
        aria-label="Pipeline stages"
      >
        {stages.map((stage, i) => {
          const hue = stageHue(i, stage);
          return (
            <section
              key={stage.id}
              data-list={stage.id}
              role="listitem"
              className="board-col"
              style={{ ['--hue' as any]: hue }}
            >
              {/* --------------------------------------------------- header */}
              <header
                data-list-handle
                className="board-col-head"
                title={canReorderStages ? 'Drag to reorder this stage' : undefined}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: hue }} aria-hidden />
                  <h2 className="text-[12.5px] font-semibold text-ink truncate flex-1">{stage.name}</h2>
                  <span
                    className="text-[11px] font-semibold tabular px-1.5 py-px rounded-full shrink-0"
                    style={{ background: `color-mix(in srgb, ${hue} 16%, transparent)`, color: hue }}
                  >
                    {stage.count}
                  </span>
                  {canEdit && (
                    <button
                      data-no-drag
                      onClick={() => onAdd(stage.id)}
                      aria-label={`Add a lead to ${stage.name}`}
                      className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-raised hover:text-ink transition-colors cursor-pointer shrink-0"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-[11.5px] font-medium text-muted tabular shrink-0">
                    {money(stage.value_minor, { compact: true })}
                  </span>
                  <span className="h-[3px] flex-1 rounded-full bg-line overflow-hidden" aria-hidden>
                    <span
                      className="block h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${(stage.count / total) * 100}%`, background: hue }}
                    />
                  </span>
                  {stage.probability > 0 && (
                    <span className="text-[10.5px] text-subtle tabular shrink-0">{stage.probability}%</span>
                  )}
                </div>
              </header>

              {/* ---------------------------------------------------- cards */}
              <div className="board-col-body" data-cards={stage.id}>
                {stage.clients.length === 0 && (
                  <div
                    data-empty
                    className="rounded-lg border border-dashed border-line-strong py-6 text-center text-[12px] text-subtle"
                  >
                    Nothing here yet
                  </div>
                )}
                {stage.clients.map((c: any) => (
                  <PipelineCard
                    key={c.id}
                    client={c}
                    labelsOpen={labelsOpen}
                    slName={slName}
                    grabbed={grabbed === c.id}
                    canEdit={canEdit}
                    onOpen={() => navigate(`/crm/${c.id}`)}
                    onGrab={() => setGrabbed(grabbed === c.id ? null : c.id)}
                  />
                ))}
              </div>

              {/* ----------------------------------------------------- foot */}
              {canEdit && (
                <div className="board-col-foot">
                  <button
                    data-no-drag
                    onClick={() => onAdd(stage.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[12.5px] text-subtle
                               hover:bg-raised hover:text-ink transition-colors cursor-pointer min-h-[36px]"
                  >
                    <Plus size={14} /> Add a lead
                  </button>
                </div>
              )}
            </section>
          );
        })}
        <div data-board-end aria-hidden className="w-1 shrink-0" />
      </div>

      {grabbed && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 card px-4 py-2.5 shadow-[var(--shadow-lg)]
                     text-[12.5px] text-muted"
        >
          Moving <b className="text-ink">{findCard(stages, grabbed)?.name}</b> —{' '}
          <kbd className="mono text-[11px] text-[var(--brand)]">←→</kbd> stage ·{' '}
          <kbd className="mono text-[11px] text-[var(--brand)]">↑↓</kbd> position ·{' '}
          <kbd className="mono text-[11px] text-[var(--brand)]">Space</kbd> drop
        </div>
      )}
    </>
  );
}

const findCard = (stages: any[], id: string) =>
  stages.flatMap((s) => s.clients).find((c: any) => c.id === id);

/** Applies a drop to the cached pipeline so the card lands before the API answers. */
function applyMove(stages: any[], d: CardDrop): any[] {
  const card = findCard(stages, d.id);
  if (!card) return stages;
  return stages.map((s) => {
    // The card is pulled out of whichever stage actually holds it, not the one
    // the drag reported it left. A stale fromListId would otherwise leave the
    // original behind and the board would carry the same client twice until
    // the refetch landed.
    const held = s.clients.some((c: any) => c.id === d.id);
    if (!held && s.id !== d.toListId) return s;
    let clients = s.clients.filter((c: any) => c.id !== d.id);
    if (s.id === d.toListId) {
      const at = d.prevId
        ? clients.findIndex((c: any) => c.id === d.prevId) + 1
        : d.nextId ? Math.max(0, clients.findIndex((c: any) => c.id === d.nextId)) : clients.length;
      clients = [...clients.slice(0, at), { ...card, stage_id: s.id }, ...clients.slice(at)];
    }
    return {
      ...s,
      clients,
      count: clients.length,
      value_minor: clients.reduce((a: number, c: any) => a + (c.deal_value_minor || 0), 0),
    };
  });
}

/* ------------------------------------------------------------------- card */
function PipelineCard({ client: c, labelsOpen, slName, grabbed, canEdit, onOpen, onGrab }: {
  client: any;
  labelsOpen: boolean;
  slName: Record<string, string>;
  grabbed: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onGrab: () => void;
}) {
  const days = daysUntil(c.next_action_date);
  const overdue = days != null && days < 0;
  const soon = days != null && days >= 0 && days <= 2;

  const labels: { hue: string; text: string }[] = [];
  if (c.retention_risk === 1) labels.push({ hue: 'var(--negative)', text: 'At risk' });
  (c.service_lines || []).slice(0, 3).forEach((id: string) => {
    const name = slName[id];
    if (name) labels.push({ hue: labelHue(name), text: name });
  });

  const value = c.mrr_minor ? c.mrr_minor * 12 : c.deal_value_minor;
  const health = Math.round(c.health_score);
  const healthTone = health >= 65 ? 'var(--positive)' : health >= 45 ? 'var(--warning)' : 'var(--negative)';

  return (
    <article
      data-card={c.id}
      tabIndex={0}
      role="button"
      aria-label={`${c.name}, health ${health}${canEdit ? '. Press space to move this card.' : ''}`}
      className={cx('board-card group', grabbed && 'is-grabbed')}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onOpen(); }
        if (e.key === ' ' && canEdit) { e.preventDefault(); e.stopPropagation(); onGrab(); }
      }}
    >
      {labels.length > 0 && (
        <div className={cx('board-labels', labelsOpen && 'is-open')} aria-hidden>
          {labels.map((l, i) => (
            <span key={i} className="board-label" style={{ background: l.hue }} title={l.text}>
              <span>{l.text}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-start gap-1.5">
        <h3 className="flex-1 text-[13px] font-medium leading-snug text-ink line-clamp-2
                       group-hover:text-[var(--brand)] transition-colors">
          {c.name}
        </h3>
        {c.retention_risk === 1 && (
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--negative)]" aria-label="Retention risk" />
        )}
      </div>

      <p className="mt-0.5 text-[11.5px] text-subtle capitalize truncate">
        {c.industry || 'Uncategorised'}{c.city ? ` · ${c.city}` : ''}
      </p>

      {c.next_action ? (
        <p className={cx('mt-1.5 flex items-center gap-1 text-[11px] leading-snug truncate',
          overdue ? 'text-[var(--negative)] font-medium'
            : soon ? 'text-[var(--warning)] font-medium' : 'text-subtle')}>
          <PhoneCall size={10} className="shrink-0" />
          <span className="truncate">{c.next_action}</span>
          <span className="shrink-0">· {relative(c.next_action_date)}</span>
        </p>
      ) : (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-[var(--accent)]">
          <AlertTriangle size={10} className="shrink-0" /> No next action set
        </p>
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
        <span className="text-[12.5px] font-semibold text-ink tabular">
          {money(value, { compact: true })}
          {c.mrr_minor > 0 && <span className="text-[10px] font-normal text-subtle">/yr</span>}
        </span>

        <span className="ml-auto flex items-center gap-1" title={`Health score ${health}`}>
          <span className="h-1 w-8 rounded-full bg-line overflow-hidden" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${health}%`, background: healthTone }} />
          </span>
          <span className="text-[11px] font-semibold tabular" style={{ color: healthTone }}>{health}</span>
        </span>

        {c.owner_name && <Avatar name={c.owner_name} url={c.owner_avatar} size={20} />}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------- list */
function ClientList({ clients }: { clients: any[] }) {
  const navigate = useNavigate();

  if (!clients.length) {
    return (
      <Card>
        <EmptyState icon={<Users2 size={20} />} title="No clients match"
          message="Try a different filter or search term." />
      </Card>
    );
  }

  return (
    <Card>
      <Table>
        <THead>
          <tr>
            <TH>Client</TH>
            <TH width="120px">Stage</TH>
            <TH width="130px">Owner</TH>
            <TH align="right" width="110px">Value</TH>
            <TH width="180px">Next action</TH>
            <TH align="right" width="130px">Health</TH>
            <TH width="100px">Status</TH>
          </tr>
        </THead>
        <tbody>
          {clients.map((c) => {
            const nextDays = daysUntil(c.next_action_date);
            const overdue = nextDays != null && nextDays < 0;
            return (
              <TR key={c.id} onClick={() => navigate(`/crm/${c.id}`)}>
                <TD>
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Avatar name={c.name} size={26} />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink truncate">{c.name}</span>
                      <span className="block text-[12px] text-subtle capitalize truncate">
                        {c.industry || '—'}{c.city ? ` · ${c.city}` : ''}
                      </span>
                    </span>
                    {c.retention_risk === 1 && (
                      <AlertTriangle size={13} className="text-[var(--negative)] shrink-0" aria-label="At risk" />
                    )}
                  </span>
                </TD>
                <TD><span className="text-muted text-[13px]">{c.stage_name || '—'}</span></TD>
                <TD><span className="text-muted text-[13px] truncate block max-w-[120px]">{c.owner_name || '—'}</span></TD>
                <TD align="right">
                  <span className="tabular">{money(c.mrr_minor ? c.mrr_minor * 12 : c.deal_value_minor, { compact: true })}</span>
                  {c.mrr_minor > 0 && <span className="block text-[11px] text-subtle">retainer</span>}
                </TD>
                <TD>
                  {c.next_action ? (
                    <span className="block min-w-0">
                      <span className="block text-[12.5px] text-muted truncate">{c.next_action}</span>
                      <span className={cx('block text-[11.5px]', overdue ? 'text-[var(--negative)] font-medium' : 'text-subtle')}>
                        {relative(c.next_action_date)}
                      </span>
                    </span>
                  ) : <Badge tone="accent">not set</Badge>}
                </TD>
                <TD align="right">
                  <span className="flex items-center gap-2 justify-end">
                    <Meter value={c.health_score}
                      tone={c.health_score >= 65 ? 'positive' : c.health_score >= 45 ? 'warning' : 'negative'}
                      className="w-14" />
                    <span className="tabular w-7 text-right font-medium">{Math.round(c.health_score)}</span>
                  </span>
                </TD>
                <TD><StatusBadge status={c.status} /></TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

/* ----------------------------------------------------------------- create */
function CreateClientModal({ meta, stageId, onClose }: {
  meta: any; stageId?: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const stageName = meta?.stages?.find((s: any) => s.id === stageId)?.name;

  const [form, setForm] = useState({
    name: '', industry: '', city: '', state_code: '33', website: '', gstin: '',
    owner_id: user?.id || '', source: 'outreach', engagement_model: 'project',
    deal_value: '', next_action: '', next_action_date: '',
    service_lines: [] as string[], notes: '', client_account_id: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<any>(null);

  // Clients already on file. Picking one links the lead to that client and
  // fills in what is already known, so existing details are never retyped.
  const { data: accounts } = useQuery({
    queryKey: ['client-accounts', 'picker'],
    queryFn: () => api.get('/clients', { limit: 200 }).then((r) => r.data),
    staleTime: 300_000,
  });

  const pickAccount = (id: string) => {
    const a = (accounts || []).find((x: any) => x.id === id);
    if (!a) {
      setForm((f) => ({ ...f, client_account_id: '' }));
      return;
    }
    // Only fill blanks — anything already typed in this form wins.
    setForm((f) => ({
      ...f,
      client_account_id: id,
      name: f.name.trim() || a.name || '',
      industry: f.industry || a.industry || '',
      city: f.city || a.city || '',
      state_code: a.state_code || f.state_code,
      website: f.website || a.website || '',
      gstin: f.gstin || a.gstin || '',
      owner_id: f.owner_id || a.owner_id || '',
    }));
  };

  const create = useMutation({
    mutationFn: (force?: boolean) => api.post(`/crm/clients${force ? '?force=true' : ''}`, {
      name: form.name.trim(),
      stage_id: stageId || null,
      client_account_id: form.client_account_id || null,
      industry: form.industry || null,
      city: form.city || null,
      state_code: form.state_code || null,
      website: form.website || null,
      gstin: form.gstin || null,
      owner_id: form.owner_id || null,
      source: form.source,
      engagement_model: form.engagement_model,
      deal_value_minor: form.deal_value ? Math.round(Number(form.deal_value) * 100) : 0,
      next_action: form.next_action || null,
      next_action_date: form.next_action_date || null,
      service_lines: form.service_lines,
      notes: form.notes || null,
    }),
    onSuccess: (res: any) => {
      toast.success('Lead created.');
      qc.invalidateQueries({ queryKey: ['crm'] });
      onClose();
      navigate(`/crm/${res.data.id}`);
    },
    onError: (e: any) => {
      if (e.code === 'conflict' && e.details?.existing) { setDuplicate(e.details.existing); return; }
      setErrors(e.fieldErrors || {});
      toast.error(e.message);
    },
  });

  const set = (k: string, v: any) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const toggleServiceLine = (id: string) => {
    setForm((f) => ({
      ...f,
      service_lines: f.service_lines.includes(id)
        ? f.service_lines.filter((x) => x !== id)
        : [...f.service_lines, id],
    }));
  };

  return (
    <Modal open onClose={onClose} title={stageName ? `New lead in ${stageName}` : 'New lead'} size="lg"
      subtitle="Every lead needs an owner and a next action — that's what stops it going cold"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.name.trim().length < 2}
            onClick={() => create.mutate(false)}>Create lead</Button>
        </>
      }>
      {duplicate && (
        <div className="mb-4 rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft p-3">
          <p className="text-[13px] font-medium text-[var(--warning)]">This looks like a duplicate</p>
          <p className="text-[12.5px] text-muted mt-0.5">
            “{duplicate.name}” already exists with a matching name, domain or GSTIN.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" onClick={() => { onClose(); navigate(`/crm/${duplicate.id}`); }}>
              Open existing
            </Button>
            <Button size="sm" variant="accent" loading={create.isPending} onClick={() => create.mutate(true)}>
              Create anyway
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {(accounts?.length ?? 0) > 0 && (
          <Field label="Existing client"
            hint="Pick one to link this lead to a client already on file and reuse their details">
            <Select value={form.client_account_id} onChange={(e) => pickAccount(e.target.value)}>
              <option value="">New company — not a client yet</option>
              {accounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.city ? ` — ${a.city}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name" required error={errors.name} className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)}
              placeholder="Cotton India Textiles" autoFocus />
          </Field>
          <Field label="Industry" hint="Drives the relevancy score against your ideal client profile">
            <Input value={form.industry} onChange={(e) => set('industry', e.target.value)}
              placeholder="textiles" list="industries" />
            <datalist id="industries">
              {['construction', 'hospitality', 'textiles', 'ecommerce', 'hvac', 'financial advisory', 'retail', 'education', 'manufacturing', 'logistics']
                .map((i) => <option key={i} value={i} />)}
            </datalist>
          </Field>
          <Field label="City">
            <Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Coimbatore" />
          </Field>
          <Field label="Website">
            <Input value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://…" />
          </Field>
          <Field label="GSTIN" hint="Checked for duplicates and used on invoices">
            <Input value={form.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())}
              placeholder="33AABCC1234D1Z5" className="mono" maxLength={15} />
          </Field>
          <Field label="Owner" required>
            <Select value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              {meta?.directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={form.source} onChange={(e) => set('source', e.target.value)}>
              {['outreach', 'inbound', 'referral', 'linkedin', 'event', 'import'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Engagement model">
            <Select value={form.engagement_model} onChange={(e) => set('engagement_model', e.target.value)}>
              <option value="project">Project</option>
              <option value="retainer">Retainer</option>
              <option value="hybrid">Hybrid</option>
            </Select>
          </Field>
          <Field label="Expected deal value (₹)">
            <Input type="number" min={0} step={1000} value={form.deal_value}
              onChange={(e) => set('deal_value', e.target.value)} placeholder="250000" />
          </Field>
        </div>

        {meta?.serviceLines?.length > 0 && (
          <Field label="Service lines of interest">
            <div className="flex flex-wrap gap-2">
              {meta.serviceLines.map((sl: any) => (
                <button key={sl.id} type="button" onClick={() => toggleServiceLine(sl.id)}
                  className={cx('rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors duration-150 cursor-pointer',
                    form.service_lines.includes(sl.id)
                      ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                      : 'border-line text-muted hover:border-line-strong')}>
                  {sl.name}
                </button>
              ))}
            </div>
          </Field>
        )}

        <div className="rounded-lg border border-line bg-sunken p-3">
          <p className="text-[12.5px] font-medium text-ink mb-2.5">Next action</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
            <Field label="What happens next">
              <Input value={form.next_action} onChange={(e) => set('next_action', e.target.value)}
                placeholder="Intro call to qualify budget" />
            </Field>
            <Field label="By when">
              <Input type="date" value={form.next_action_date} onChange={(e) => set('next_action_date', e.target.value)} />
            </Field>
          </div>
          <p className="mt-1 text-[12px] text-subtle">
            Leads without a next action are flagged on the dashboard and to their owner daily.
          </p>
        </div>

        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2}
            placeholder="Context from the first conversation…" />
        </Field>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------- import */
function ImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post('/crm/clients/import', { csv, dry_run: dryRun }),
    onSuccess: (res: any, dryRun) => {
      setResult({ ...res.data, dry_run: dryRun });
      if (!dryRun) {
        toast.success(`${res.data.created} client(s) imported.`);
        qc.invalidateQueries({ queryKey: ['crm'] });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });

  const onFile = async (file?: File) => {
    if (!file) return;
    setCsv(await file.text());
    setResult(null);
  };

  return (
    <Modal open onClose={onClose} title="Import clients from CSV" size="lg"
      subtitle="Duplicates are detected on name, domain and GSTIN, and skipped"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button onClick={() => run.mutate(true)} loading={run.isPending} disabled={!csv.trim()}>
            Preview
          </Button>
          <Button variant="primary" onClick={() => run.mutate(false)} loading={run.isPending} disabled={!csv.trim()}>
            Import
          </Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="CSV file" hint="Columns: name, industry, city, state_code, website, gstin, source, engagement_model, mrr, deal_value, next_action, next_action_date, notes">
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])}
            className="block w-full text-[13px] text-muted file:mr-3 file:rounded-md file:border-0
                       file:bg-brand-soft file:px-3 file:py-2 file:text-[13px] file:font-medium
                       file:text-[var(--brand)] file:cursor-pointer cursor-pointer" />
        </Field>

        <Field label="Or paste CSV">
          <Textarea value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); }} rows={6}
            className="mono text-[12px]"
            placeholder={'name,industry,city,next_action,next_action_date\nAcme Textiles,textiles,Tiruppur,Intro call,2026-09-01'} />
        </Field>

        {result && (
          <div className={cx('rounded-lg border p-3',
            result.errors?.length ? 'border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft'
              : 'border-[color-mix(in_srgb,var(--positive)_30%,transparent)] bg-positive-soft')}>
            <p className="text-[13px] font-medium text-ink">
              {result.dry_run ? 'Preview' : 'Imported'}: {result.created} of {result.total_rows} rows
              {result.skipped > 0 && ` · ${result.skipped} duplicate(s) skipped`}
            </p>
            {result.duplicates?.length > 0 && (
              <ul className="mt-1.5 text-[12.5px] text-muted space-y-0.5 max-h-24 overflow-y-auto">
                {result.duplicates.map((d: any) => (
                  <li key={d.row}>Row {d.row}: “{d.name}” already exists</li>
                ))}
              </ul>
            )}
            {result.errors?.length > 0 && (
              <ul className="mt-1.5 text-[12.5px] text-[var(--warning)] space-y-0.5">
                {result.errors.map((e: any) => <li key={e.row}>Row {e.row}: {e.error}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
