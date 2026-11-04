/**
 * The bottom sheet, kept in its own module.
 *
 * Both ui.tsx and chrome.tsx need it, and chrome.tsx is imported *by* ui.tsx for
 * the app-bar buttons — leaving Sheet in ui.tsx made those two import each
 * other. This file imports nothing local, so the cycle cannot re-form.
 */
import { ReactNode, useEffect } from 'react';

/** Bottom sheet. Rises from the thumb rather than dropping from the top. */
export function Sheet({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode;
}) {
  // Android's hardware back closes the sheet before it leaves the screen —
  // lib/native.ts dispatches this and honours preventDefault as "handled".
  useEffect(() => {
    if (!open) return undefined;
    const onBack = (e: Event) => { e.preventDefault(); onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('phoenixx:back', onBack);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('phoenixx:back', onBack);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose}
        className="absolute inset-0 bg-[rgb(15_23_42/0.45)]" />
      <div className="relative max-h-[88vh] overflow-y-auto rounded-t-2xl border-t border-line bg-raised
                      pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-lg)]">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-raised px-4 py-3">
          <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose}
            className="min-h-[40px] px-2 text-[14px] font-medium text-subtle active:text-ink">Close</button>
        </div>
        <div className="px-4 py-4 space-y-4">{children}</div>
        {footer && <div className="sticky bottom-0 border-t border-line bg-raised px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
