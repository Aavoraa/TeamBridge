import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AREAS } from './AccessEditor';
import { Button, Select, useToast } from './ui';

/**
 * Team > person: areas opened to this one person on top of their role - say,
 * Clients & pipeline for the one employee who does business development. Only
 * the owner changes it; the server adds it to what the role allows, never less.
 */

const LEVELS = [
  { id: '', label: 'As their role' },
  { id: 'view', label: 'View', actions: ['view'] },
  { id: 'work', label: 'View, create & edit', actions: ['view', 'create', 'edit'] },
  { id: 'full', label: 'Everything', actions: ['view', 'create', 'edit', 'approve', 'delete', 'export'] },
];
const levelOf = (actions: string[] = []) => {
  if (!actions.length) return '';
  if (actions.includes('delete') || actions.includes('approve') || actions.includes('export')) return 'full';
  if (actions.includes('create') || actions.includes('edit')) return 'work';
  return 'view';
};
const describe = (actions: string[] = []) => (!actions.length ? 'No access'
  : actions.length === 6 ? 'Everything' : actions.map((a) => a[0].toUpperCase() + a.slice(1)).join(', '));

export function ExtraAccess({ person }: { person: any }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const access = person.access;
  const isOwner = user?.role === 'owner' || user?.role === 'super_admin';
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(Object.fromEntries(Object.entries(access?.extra || {}).map(([m, a]) => [m, levelOf(a as string[])])));
  }, [access]);

  const saved = useMemo(() => Object.fromEntries(Object.entries(access?.extra || {}).map(([m, a]) => [m, levelOf(a as string[])])), [access]);
  const dirty = JSON.stringify(Object.entries(draft).filter(([, v]) => v).sort()) !== JSON.stringify(Object.entries(saved).filter(([, v]) => v).sort());

  const save = useMutation({
    mutationFn: () => api.put(`/users/${person.id}/access`, {
      extra: Object.fromEntries(Object.entries(draft).filter(([, v]) => v)
        .map(([m, v]) => [m, LEVELS.find((l) => l.id === v)?.actions || []])),
    }),
    onSuccess: () => {
      toast.success(`${person.name}'s access is saved. It applies the next time they open or refresh TeamBridge.`);
      qc.invalidateQueries({ queryKey: ['team-member', person.id] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!access?.editable) return null;
  const extras = Object.keys(access.extra || {});
  if (!isOwner && !extras.length) return null;

  const items = AREAS.flatMap((g) => g.items).filter((it) => !it.fixed && access.role[it.id]);
  return (
    <div>
      <p className="label-cap mb-1 flex items-center gap-1.5"><KeyRound size={13} /> Extra access</p>
      <p className="mb-2.5 text-[12.5px] text-subtle">
        On top of what the {person.role} role allows. Use it for the odd person who needs more, like Clients &amp; pipeline
        for someone in business development.
      </p>

      {!isOwner ? (
        <ul className="space-y-1 text-[13px]">
          {extras.map((m) => (
            <li key={m} className="flex justify-between gap-3">
              <span className="text-ink">{items.find((i) => i.id === m)?.label || m}</span>
              <span className="text-muted">{describe(access.extra[m])}</span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="divide-y divide-line rounded-lg border border-line">
            {items.map((it) => {
              const fromRole = access.role[it.id] || [];
              const value = draft[it.id] || '';
              return (
                <div key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-ink">{it.label}</p>
                    <p className="text-[11.5px] text-subtle">Role gives: {describe(fromRole)}</p>
                  </div>
                  <Select value={value} onChange={(e) => setDraft((d) => ({ ...d, [it.id]: e.target.value }))}
                    aria-label={`Extra access to ${it.label}`} className="w-[170px]">
                    {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </Select>
                </div>
              );
            })}
          </div>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button size="sm" disabled={!dirty} onClick={() => setDraft(saved)}>Discard</Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save access</Button>
          </div>
        </>
      )}
    </div>
  );
}
