import { useEffect, useRef, useState } from 'react';

/**
 * Kanban drag-and-drop over Pointer Events, so one code path covers mouse, pen
 * and touch. HTML5 drag-and-drop is not an option: it has no touch support at
 * all, and moving a card is the primary gesture on this board.
 *
 * Mouse    drag arms after 5px of travel.
 * Touch    a 170ms long-press arms it; moving before that scrolls the list
 *          instead, so the board still scrolls normally on a phone.
 * Keyboard Space picks a card up, arrows move it, Space drops, Escape cancels.
 *
 * The drag itself is deliberately imperative — a placeholder element and a
 * cloned "flying" card, moved directly in the DOM. Driving 100 cards through
 * React state on every pointermove drops frames; React only re-renders once,
 * when the drop commits.
 *
 * Markup contract (data attributes, so the hook needs no refs into the tree):
 *   [data-board]            the horizontally scrolling board
 *   [data-list="<id>"]      one column
 *   [data-list-handle]      the grab area of a column header
 *   [data-cards="<id>"]     the scrollable card container inside a column
 *   [data-card="<id>"]      one card
 */

export type CardDrop = {
  id: string;
  toListId: string;
  fromListId: string;
  /** card immediately above the drop point, or null if dropped at the top */
  prevId: string | null;
  /** card immediately below it, or null if dropped at the bottom */
  nextId: string | null;
};

export type ListDrop = { id: string; order: string[] };

type Options = {
  onCardDrop: (d: CardDrop) => void;
  onListDrop?: (d: ListDrop) => void;
  /** Read-only boards (no edit permission) skip the whole thing. */
  disabled?: boolean;
};

const LONG_PRESS_MS = 170;
const MOUSE_THRESHOLD = 5;
const TOUCH_SLOP = 11;
const EDGE = 90;          // horizontal auto-scroll trigger zone
const EDGE_SPEED = 22;
const V_EDGE = 56;        // vertical auto-scroll inside a column
const V_SPEED = 14;

export function useBoardDnd({ onCardDrop, onListDrop, disabled }: Options) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // Handlers change identity on every render (they close over query data), so
  // keep them in a ref and let the listener read the current one.
  const cbs = useRef({ onCardDrop, onListDrop });
  cbs.current = { onCardDrop, onListDrop };

  useEffect(() => {
    const board: HTMLDivElement | null = boardRef.current;
    if (!board || disabled) return;
    const rail = board;   // non-null alias, so the closures below need no guard

    let type: 'card' | 'list' | null = null;
    let el: HTMLElement | null = null;      // the source element
    let id = '';
    let fromListId = '';
    let fly: HTMLElement | null = null;     // the clone under the pointer
    let ph: HTMLElement | null = null;      // the gap it will land in
    let cont: HTMLElement | null = null;    // current card container
    let started = false;
    let armed = false;
    let moved = false;
    let sx = 0, sy = 0, x = 0, y = 0, dx = 0, dy = 0;
    let timer: number | undefined;
    let raf = 0;
    // A drop animates for ~170ms before React is told about it. Until that has
    // landed the board still carries the drag's own nodes, so the settle is
    // held here: whoever gets there first — the transition, the guard timer or
    // the next gesture — runs it, and it runs exactly once.
    let settle: (() => void) | null = null;
    let settleTimer: number | undefined;

    /**
     * Nothing the drag injects may outlive it. React never rendered the clone
     * or the gap, so React will never take them away either: one left behind
     * reads as a duplicate card sitting in the column. Sweep by class rather
     * than by reference, so a node orphaned by an earlier gesture goes too.
     */
    const sweep = () => {
      document.querySelectorAll('.dnd-fly').forEach((n) => n.remove());
      rail.querySelectorAll('.dnd-gap, .dnd-gap-list').forEach((n) => n.remove());
    };

    const reset = () => {
      window.clearTimeout(timer);
      window.clearTimeout(settleTimer);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      settle = null;
      sweep();
      if (el) { el.classList.remove('is-dragged'); el.style.display = ''; }
      rail.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
      document.body.classList.remove('is-dragging');
      type = null; el = null; fly = null; ph = null; cont = null;
      started = false; armed = false;
      setDragging(false);
    };

    function begin() {
      if (started || !el) return;
      window.clearTimeout(timer);
      started = true;
      setDragging(true);

      const r = el.getBoundingClientRect();
      dx = sx - r.left;
      dy = sy - r.top;

      const clone = el.cloneNode(true) as HTMLElement;
      clone.classList.add('dnd-fly');
      clone.classList.remove('is-dragged');
      clone.style.width = `${r.width}px`;
      if (type === 'list') clone.style.height = `${r.height}px`;
      clone.querySelectorAll('[tabindex],[id]').forEach((n) => {
        n.removeAttribute('tabindex'); n.removeAttribute('id');
      });
      document.body.appendChild(clone);
      fly = clone;

      const gap = document.createElement('div');
      gap.className = type === 'card' ? 'dnd-gap' : 'dnd-gap-list';
      gap.style.height = `${r.height}px`;
      if (type === 'list') gap.style.width = `${r.width}px`;
      el.parentNode!.insertBefore(gap, el);
      ph = gap;

      if (type === 'card') {
        el.classList.add('is-dragged');
        cont = el.closest<HTMLElement>('[data-cards]');
      } else {
        el.style.display = 'none';
      }

      document.body.classList.add('is-dragging');
      paint();
      raf = requestAnimationFrame(loop);
    }

    function paint() {
      if (!fly) return;
      const tilt = type === 'card' ? 'rotate(3deg)' : 'rotate(1.5deg)';
      fly.style.transform = `translate3d(${x - dx}px, ${y - dy}px, 0) ${tilt} scale(1.02)`;
    }

    /** The card container under the pointer, falling back to the nearest
     *  column horizontally so a drop below a short column still lands. */
    function containerAt(px: number, py: number): HTMLElement | null {
      const hit = document.elementFromPoint(px, py) as HTMLElement | null;
      const direct = hit?.closest<HTMLElement>('[data-cards]');
      if (direct) return direct;

      let best: HTMLElement | null = null;
      let bestD = Infinity;
      rail.querySelectorAll<HTMLElement>('[data-list]').forEach((l) => {
        const r = l.getBoundingClientRect();
        if (py < r.top - 40 || py > r.bottom + 60) return;
        const d = px < r.left ? r.left - px : px > r.right ? px - r.right : 0;
        if (d < bestD) { bestD = d; best = l; }
      });
      return bestD < 140 && best ? (best as HTMLElement).querySelector<HTMLElement>('[data-cards]') : null;
    }

    /** First card whose midpoint sits below the pointer — insert before it. */
    function nextSiblingAt(container: HTMLElement, py: number): Element | null {
      for (const kid of Array.from(container.children)) {
        if (kid === ph || kid.classList.contains('is-dragged') || !kid.hasAttribute('data-card')) continue;
        const r = kid.getBoundingClientRect();
        if (py < r.top + r.height / 2) return kid;
      }
      return null;
    }

    function overCard() {
      const c = containerAt(x, y);
      if (!c) return;
      if (c !== cont) {
        cont = c;
        rail.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
        c.closest('[data-list]')?.classList.add('is-drop-target');
        // The "nothing here yet" placeholder is React's node, so it is hidden
        // with CSS, never removed: detaching it behind React's back makes the
        // next commit throw on removeChild and takes the whole page down.
      }
      const after = nextSiblingAt(c, y);
      if (after) { if (after !== ph) c.insertBefore(ph!, after); }
      else if (c.lastElementChild !== ph) c.appendChild(ph!);
    }

    function overList() {
      const lists = Array.from(rail.querySelectorAll<HTMLElement>('[data-list]')).filter((l) => l !== el);
      let after: HTMLElement | null = null;
      for (const l of lists) {
        const r = l.getBoundingClientRect();
        if (x < r.left + r.width / 2) { after = l; break; }
      }
      if (after) { if (after !== ph!.nextSibling) rail.insertBefore(ph!, after); }
      else rail.insertBefore(ph!, rail.querySelector('[data-board-end]'));
    }

    function loop() {
      if (!started) return;
      const br = rail.getBoundingClientRect();
      if (x < br.left + EDGE) rail.scrollLeft -= EDGE_SPEED * (1 - (x - br.left) / EDGE);
      else if (x > br.right - EDGE) rail.scrollLeft += EDGE_SPEED * (1 - (br.right - x) / EDGE);

      if (type === 'card' && cont) {
        const cr = cont.getBoundingClientRect();
        if (y < cr.top + V_EDGE) cont.scrollTop -= V_SPEED * (1 - (y - cr.top) / V_EDGE);
        else if (y > cr.bottom - V_EDGE) cont.scrollTop += V_SPEED * (1 - (cr.bottom - y) / V_EDGE);
      }
      raf = requestAnimationFrame(loop);
    }

    function onMove(e: PointerEvent) {
      if (!el) return;
      x = e.clientX; y = e.clientY;
      const dist = Math.hypot(x - sx, y - sy);

      if (!started) {
        if (!armed) {                       // touch, still inside the long-press window
          if (dist > TOUCH_SLOP) reset();   // it is a scroll — hand the gesture back
          return;
        }
        if (dist < MOUSE_THRESHOLD) return;
        begin();
      }
      e.preventDefault();
      moved = true;
      paint();
      type === 'card' ? overCard() : overList();
    }

    function onUp() {
      if (!started) { reset(); return; }

      let commit: (() => void) | null = null;

      if (type === 'card') {
        const container = ph!.parentElement!;
        const toListId = container.getAttribute('data-cards') || '';
        const kids = Array.from(container.children);
        const at = kids.indexOf(ph!);
        let prevId: string | null = null;
        let nextId: string | null = null;
        kids.forEach((kid, i) => {
          if (!kid.hasAttribute('data-card') || kid.classList.contains('is-dragged')) return;
          const cid = kid.getAttribute('data-card');
          if (i < at) prevId = cid;
          else if (nextId === null) nextId = cid;
        });
        const payload: CardDrop = { id, toListId, fromListId, prevId, nextId };
        commit = () => cbs.current.onCardDrop(payload);
      } else {
        const src = el;
        const order = Array.from(rail.children)
          .map((n) => (n === ph ? id : n.hasAttribute('data-list') && n !== src ? n.getAttribute('data-list') : null))
          .filter(Boolean) as string[];
        commit = () => cbs.current.onListDrop?.({ id, order });
      }

      // Settle the clone into the gap, then let React take over.
      const r = ph!.getBoundingClientRect();
      const f = fly!;
      f.style.transition = 'transform 170ms cubic-bezier(.2,.9,.3,1)';
      f.style.transform = `translate3d(${r.left}px, ${r.top}px, 0) rotate(0deg) scale(1)`;

      const drop = commit;
      commit = null;
      settle = () => { settle = null; reset(); drop!(); };

      // transitionend bubbles, and the clone is a whole card: a label or the
      // health meter finishing its own transition must not pass for the card
      // having landed.
      const onEnd = (e: TransitionEvent) => {
        if (e.target !== f) return;
        f.removeEventListener('transitionend', onEnd);
        settle?.();
      };
      f.addEventListener('transitionend', onEnd);
      settleTimer = window.setTimeout(() => settle?.(), 230);
      started = false;
    }

    function onDown(e: PointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Grabbing again while the last drop is still animating: land that one
      // first. Otherwise its pending settle tears down this drag's clone and
      // gap instead of its own, and both are orphaned on the board.
      settle?.();
      const target = e.target as HTMLElement;
      if (target.closest('button, a, input, select, textarea, [data-no-drag]')) return;

      const card = target.closest<HTMLElement>('[data-card]');
      const handle = target.closest<HTMLElement>('[data-list-handle]');
      if (!card && !handle) return;

      type = card ? 'card' : 'list';
      el = card || handle!.closest<HTMLElement>('[data-list]');
      if (!el) return;
      id = (card ? card.getAttribute('data-card') : el.getAttribute('data-list')) || '';
      fromListId = card ? card.closest<HTMLElement>('[data-cards]')?.getAttribute('data-cards') || '' : '';

      sx = x = e.clientX;
      sy = y = e.clientY;
      started = false;
      moved = false;
      armed = e.pointerType !== 'touch';

      if (e.pointerType === 'touch') {
        timer = window.setTimeout(() => {
          armed = true;
          navigator.vibrate?.(12);
          begin();
        }, LONG_PRESS_MS);
      }

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    // A click fired by the same gesture that just dragged must not also open
    // the card, so swallow it in the capture phase.
    const onClick = (e: MouseEvent) => {
      if (!moved) return;
      e.preventDefault();
      e.stopPropagation();
      moved = false;
    };

    // Touch scrolling is blocked only once a drag is genuinely running.
    const onTouchMove = (e: TouchEvent) => { if (started) e.preventDefault(); };

    rail.addEventListener('pointerdown', onDown);
    rail.addEventListener('click', onClick, true);
    document.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
      rail.removeEventListener('pointerdown', onDown);
      rail.removeEventListener('click', onClick, true);
      document.removeEventListener('touchmove', onTouchMove);
      reset();
    };
  }, [disabled]);

  return { boardRef, dragging };
}

/**
 * Keyboard equivalent of the same gesture. Kept separate because it works on
 * the data, not the DOM: arrows recompute neighbours from the current board
 * and hand back the identical CardDrop payload.
 */
export function useKeyboardCardMove<T extends { id: string }>(
  lists: { id: string; cards: T[] }[],
  onCardDrop: (d: CardDrop) => void,
  enabled = true,
) {
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const ref = useRef({ lists, onCardDrop });
  ref.current = { lists, onCardDrop };

  useEffect(() => {
    if (!grabbed || !enabled) return;

    const onKey = (e: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'Escape'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();

      const { lists: ls, onCardDrop: drop } = ref.current;
      const li = ls.findIndex((l) => l.cards.some((c) => c.id === grabbed));
      if (li < 0) { setGrabbed(null); return; }
      const list = ls[li];
      const ci = list.cards.findIndex((c) => c.id === grabbed);

      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { setGrabbed(null); return; }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const to = ls[li + (e.key === 'ArrowRight' ? 1 : -1)];
        if (!to) return;
        const last = to.cards[to.cards.length - 1];
        drop({ id: grabbed, toListId: to.id, fromListId: list.id, prevId: last?.id ?? null, nextId: null });
      } else {
        const rest = list.cards.filter((c) => c.id !== grabbed);
        const target = ci + (e.key === 'ArrowDown' ? 1 : -1);
        if (target < 0 || target >= list.cards.length) return;
        drop({
          id: grabbed,
          toListId: list.id,
          fromListId: list.id,
          prevId: target > 0 ? rest[target - 1]?.id ?? null : null,
          nextId: rest[target]?.id ?? null,
        });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [grabbed, enabled]);

  // Keep focus on the card as it moves between re-renders.
  useEffect(() => {
    if (!grabbed) return;
    const el = document.querySelector<HTMLElement>(`[data-card="${grabbed}"]`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [grabbed, lists]);

  return { grabbed, setGrabbed };
}
