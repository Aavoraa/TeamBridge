import { lazy, Suspense, useState } from 'react';
import { Mic, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';

// Loaded on first open: most sessions never use it.
const TaskAssistant = lazy(() => import('./TaskAssistant'));

/** These roles hand out work; everyone else on the team adds to their own list. The API holds the same rule. */
const ASSIGNING_ROLES = ['owner', 'manager', 'super_admin'];

/**
 * Voice-to-task: one control, on every screen of the website and the app. A
 * labelled pill on a wide screen; on a phone a microphone, which says what it
 * does without the label. Not for client logins.
 */
export default function VoiceTaskButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user || user.role === 'client') return null;
  const assigns = ASSIGNING_ROLES.includes(user.role);
  const label = assigns ? 'Assign by voice' : 'Add by voice';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={assigns ? 'Assign a task by voice' : 'Add a to-do by voice'} title={label}
        className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-brand-soft px-2.5 md:px-3.5 text-[13.5px] font-medium text-[var(--brand)] hover:brightness-[0.97] active:scale-95 transition cursor-pointer">
        <Mic size={19} className="md:hidden" />
        <Sparkles size={16} className="hidden md:block" />
        <span className="hidden md:inline">{label}</span>
      </button>
      {open && (
        <Suspense fallback={null}>
          <TaskAssistant open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
