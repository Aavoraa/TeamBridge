import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Download, Eye, FileDown, FileText, FolderKanban, Image as ImageIcon, Trash2, Upload, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, SearchInput, Select, Textarea, useToast, cx,
} from './ui';
import { ATTACH_ACCEPT, MAX_FILE_BYTES, openFile, pdfConvertible } from './Attachments';

/**
 * Client and project documents: stored once, viewed, downloaded, or downloaded
 * as a PDF. Used as the Resources page and inside a client or a project, where
 * it is fixed to that client or project. Who sees what is decided by the API.
 */

export const CATEGORY_LABEL: Record<string, string> = {
  contract: 'Contract', brief: 'Brief', brand: 'Brand assets', design: 'Design',
  report: 'Report', invoice: 'Invoice', other: 'Other',
};

const fileSize = (bytes: number) => (bytes >= 1_048_576
  ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const pdfName = (filename: string) => `${filename.replace(/\.[^.]+$/, '') || 'document'}.pdf`;

async function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

type Fixed = { clientAccountId?: string; projectId?: string };

export function useResourceTargets() {
  return useQuery({
    queryKey: ['resources', 'targets'],
    queryFn: () => api.get<any>('/resources/targets').then((r) => r.data),
    staleTime: 60_000,
  });
}

/**
 * The list, with its filters and upload button. `bare` draws only the rows,
 * for a folder whose header carries its own title and upload button; `scope`
 * then pins it to the company's own documents or to project documents.
 */
export function ResourceLibrary({ clientAccountId, projectId, embedded = false, bare = false, scope: fixedScope }: Fixed & {
  embedded?: boolean; bare?: boolean; scope?: 'client' | 'project';
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: targets } = useResourceTargets();
  const [q, setQ] = useState('');
  const [client, setClient] = useState('');
  const [project, setProject] = useState('');
  const [category, setCategory] = useState('');
  const [scope, setScope] = useState<'' | 'client' | 'project'>('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);

  const params = {
    q: q.trim() || undefined,
    client_account_id: clientAccountId || client || undefined,
    project_id: projectId || project || undefined,
    category: category || undefined,
    scope: projectId ? undefined : fixedScope || scope || undefined,
  };
  const { data: docs = [], isLoading } = useQuery({
    queryKey: ['resources', 'list', params],
    queryFn: () => api.get<any[]>('/resources', params).then((r) => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/resources/${id}`),
    onSuccess: () => { toast.success('Document deleted.'); setDeleting(null); qc.invalidateQueries({ queryKey: ['resources'] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const projectOptions = useMemo(() => (targets?.projects || [])
    .filter((p: any) => !(clientAccountId || client) || p.client_account_id === (clientAccountId || client)), [targets, client, clientAccountId]);

  const canUploadHere = projectId ? true
    : clientAccountId ? (targets?.can_add_client_docs || projectOptions.length > 0)
      : !!(targets?.can_add_client_docs || targets?.projects?.length);

  const run = (p: Promise<any>) => p.catch((e: any) => toast.error(e.message));

  return (
    <div className="space-y-3">
      {!bare && <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search documents"
          className="min-w-0 flex-1 basis-56" />
        {!clientAccountId && !projectId && (
          <Select value={client} onChange={(e) => { setClient(e.target.value); setProject(''); }} className="w-auto max-w-[12rem]" aria-label="Client">
            <option value="">All clients</option>
            {(targets?.filter_clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
        {!projectId && (
          <Select value={project} onChange={(e) => setProject(e.target.value)} className="w-auto max-w-[12rem]" aria-label="Project">
            <option value="">All projects</option>
            {projectOptions.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto" aria-label="Type">
          <option value="">All types</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {!projectId && !project && (
          <Select value={scope} onChange={(e) => setScope(e.target.value as any)} className="w-auto" aria-label="Kept on">
            <option value="">Client and project</option>
            <option value="client">Client documents</option>
            <option value="project">Project documents</option>
          </Select>
        )}
        {canUploadHere && (
          <Button variant="primary" icon={<Upload size={15} />} onClick={() => setUploading(true)}>Upload</Button>
        )}
      </div>}

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-xl bg-sunken animate-pulse" />)}</div>
      ) : !docs.length && bare ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[13px] text-subtle">No documents yet.</p>
      ) : !docs.length ? (
        <Card>
          <EmptyState compact={embedded} icon={<FileText size={18} />}
            title={q || category || client || project || scope ? 'No documents match' : 'No documents yet'}
            message={canUploadHere ? 'Upload contracts, briefs, brand assets and reports so the team can find them here.'
              : 'Documents for your clients and projects show up here.'} />
        </Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {docs.map((d: any) => {
            const isImage = /^image\//.test(d.mime || '');
            return (
              <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sunken text-subtle">
                  {isImage ? <ImageIcon size={17} /> : <FileText size={17} />}
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-ink" title={d.title}>{d.title}</span>
                    <Badge tone="neutral">{CATEGORY_LABEL[d.category] || d.category}</Badge>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-subtle">
                    {d.project_id ? (
                      <span className="inline-flex items-center gap-1"><FolderKanban size={12} />{d.project_name}{d.client_name ? ` · ${d.client_name}` : ''}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1"><Building2 size={12} />{d.client_name}</span>
                    )}
                    <span>{d.filename} · {fileSize(Number(d.size_bytes) || 0)}</span>
                    <span>{d.uploaded_by_name || 'Someone'} · {relative(d.created_at)}</span>
                  </p>
                  {d.notes && <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{d.notes}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" icon={<Eye size={14} />}
                    onClick={() => run(openFile(`/resources/${d.id}/file`, d.filename, d.mime))}>View</Button>
                  <Button size="sm" variant="ghost" icon={<Download size={14} />}
                    onClick={() => run(api.download(`/resources/${d.id}/file`, d.filename, { download: 1 }))}>Download</Button>
                  {pdfConvertible(d.mime || '', d.filename) && (
                    <Button size="sm" variant="ghost" icon={<FileDown size={14} />}
                      onClick={() => run(api.download(`/resources/${d.id}/pdf`, pdfName(d.filename)))}>PDF</Button>
                  )}
                  {d.can_delete && (
                    <button onClick={() => setDeleting(d)} aria-label={`Delete ${d.title}`}
                      className="ml-1 p-1 text-subtle hover:text-[var(--negative)] cursor-pointer">
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {uploading && (
        <UploadModal targets={targets} fixed={{ clientAccountId, projectId }}
          initial={{ clientAccountId: clientAccountId || client, projectId: projectId || project }}
          onClose={() => setUploading(false)} />
      )}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting.id)}
        title="Delete this document?" confirmLabel="Delete" danger loading={remove.isPending}
        message={deleting ? `"${deleting.title}" will be removed for everyone.` : ''} />
    </div>
  );
}

export function UploadModal({ targets, fixed, initial, onClose }: {
  targets: any; fixed: Fixed; initial: Fixed; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const canClient = !!targets?.can_add_client_docs;
  const [kind, setKind] = useState<'client' | 'project'>(
    fixed.projectId || initial.projectId || !canClient ? 'project' : 'client',
  );
  const [clientId, setClientId] = useState(initial.clientAccountId || '');
  const [projectId, setProjectId] = useState(initial.projectId || '');
  const [category, setCategory] = useState('other');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const projects = (targets?.projects || [])
    .filter((p: any) => !fixed.clientAccountId || p.client_account_id === fixed.clientAccountId);
  const target = kind === 'client' ? { client_account_id: fixed.clientAccountId || clientId } : { project_id: fixed.projectId || projectId };
  const ready = files.length > 0 && Object.values(target)[0];

  const send = useMutation({
    mutationFn: async () => {
      for (const f of files) {
        await api.post('/resources', {
          ...target, category, notes: notes.trim() || null,
          title: files.length === 1 && title.trim() ? title.trim() : null,
          filename: f.name, mime: f.type || 'application/octet-stream', content_base64: await readBase64(f),
        });
      }
    },
    onSuccess: () => {
      toast.success(files.length === 1 ? 'Document uploaded.' : `${files.length} documents uploaded.`);
      qc.invalidateQueries({ queryKey: ['resources'] });
      onClose();
    },
    onError: (e: any) => { toast.error(e.message); qc.invalidateQueries({ queryKey: ['resources'] }); },
  });

  return (
    <Modal open onClose={onClose} title="Upload documents" subtitle="Anyone who can see the client or project can view and download them"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Upload size={15} />} loading={send.isPending} disabled={!ready}
            onClick={() => send.mutate()}>Upload{files.length > 1 ? ` ${files.length}` : ''}</Button>
        </>
      )}>
      <div className="space-y-4">
        {!fixed.projectId && canClient && (
          <div className="inline-flex rounded-lg border border-line p-0.5">
            {(['client', 'project'] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium cursor-pointer',
                  kind === k ? 'bg-[var(--brand)] text-white' : 'text-muted hover:text-ink')}>
                {k === 'client' ? 'For a client' : 'For a project'}
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {kind === 'client' && !fixed.clientAccountId && (
            <Field label="Client" required>
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a client</option>
                {(targets?.clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
          {kind === 'project' && !fixed.projectId && (
            <Field label="Project" required>
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Choose a project</option>
                {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.client_name ? ` · ${p.client_name}` : ''}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Type">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {files.length <= 1 && (
            <Field label="Title" hint="Optional. The file name is used if left blank" className="sm:col-span-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Signed contract 2026" />
            </Field>
          )}
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the team should know about it" />
          </Field>
        </div>

        <div>
          <input ref={fileRef} type="file" multiple className="hidden" accept={ATTACH_ACCEPT}
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              e.target.value = '';
              const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
              if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} is over 15 MB.`);
              setFiles((prev) => [...prev, ...picked.filter((f) => f.size <= MAX_FILE_BYTES)]);
            }} />
          <button onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-line px-4 py-5 text-center hover:bg-sunken cursor-pointer">
            <Upload size={18} className="text-subtle" />
            <span className="text-[13.5px] font-medium text-ink">Choose files</span>
            <span className="text-[12px] text-subtle">PDF, images, Word, Excel, PowerPoint, text · up to 15 MB each</span>
          </button>
          {!!files.length && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
                  <FileText size={14} className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.name}</span>
                  <span className="shrink-0 text-[11.5px] text-subtle tabular">{fileSize(f.size)}</span>
                  <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}
                    className="shrink-0 text-subtle hover:text-[var(--negative)] cursor-pointer"><X size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
