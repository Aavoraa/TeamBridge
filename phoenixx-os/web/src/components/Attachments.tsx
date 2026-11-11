import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FileDown, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, ApiError, request } from '../lib/api';
import { saveAndOpen } from '../lib/nativeFiles';
import { relative } from '../lib/format';
import { Button, useToast } from './ui';

/**
 * Files on a record (a task request, a task). Anyone who can see the record
 * can view a file or download it as a PDF; the server decides who that is.
 */

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const ATTACH_ACCEPT = 'image/*,application/pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx';

const fileSize = (bytes: number) => (bytes >= 1_048_576
  ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Images, text and PDFs can come down as a PDF; other files only as they are. */
export const pdfConvertible = (mime = '', filename = '') => {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return mime === 'application/pdf' || /^image\/(png|jpe?g)$/i.test(mime) || /^text\/(plain|csv)$/i.test(mime)
    || ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'csv'].includes(ext);
};

/** Reads a file into the base64 body POST /files takes, and uploads it. */
export async function uploadAttachment(entity: string, entityId: string, file: File) {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  return api.post('/files', {
    entity, entity_id: entityId, filename: file.name,
    mime: file.type || 'application/octet-stream', content_base64: base64,
  });
}

/** Opens the file in a new tab (the system viewer on a device). */
async function viewFile(att: any) {
  const res = await request<Response>(att.url.replace('/api/v1', ''), { raw: true });
  if (!res.ok) throw new ApiError(res.status, 'view_failed', 'Could not open that file');
  const blob = await res.blob();
  if (await saveAndOpen(blob, att.filename)) return;
  const url = URL.createObjectURL(new Blob([blob], { type: att.mime || blob.type }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const pdfName = (filename: string) => `${filename.replace(/\.[^.]+$/, '') || 'attachment'}.pdf`;

export function AttachmentList({ entity, entityId, canUpload = false, canRemove = false, compact = false }: {
  entity: string; entityId: string; canUpload?: boolean; canRemove?: boolean; compact?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const key = ['attachments', entity, entityId];

  const { data: files = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<any[]>('/files/list', { entity, entity_id: entityId }).then((r) => r.data),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['task-requests'] });
    qc.invalidateQueries({ queryKey: ['action-items'] });
  };

  const upload = useMutation({
    mutationFn: async (picked: File[]) => { for (const f of picked) await uploadAttachment(entity, entityId, f); },
    onSuccess: () => { toast.success('File attached.'); refresh(); },
    onError: (e: any) => { toast.error(e.message); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/files/${id}`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.message),
  });

  const run = (p: Promise<any>) => p.catch((e: any) => toast.error(e.message));

  if (compact && !isLoading && !files.length && !canUpload) return null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="label-cap">Files{files.length ? ` · ${files.length}` : ''}</p>
        {canUpload && (
          <>
            <input ref={fileRef} type="file" multiple className="hidden" accept={ATTACH_ACCEPT}
              onChange={(e) => {
                const picked = Array.from(e.target.files || []);
                e.target.value = '';
                const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
                if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} is over 15 MB.`);
                const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES);
                if (ok.length) upload.mutate(ok);
              }} />
            <Button size="sm" icon={<Upload size={14} />} loading={upload.isPending}
              onClick={() => fileRef.current?.click()}>Upload file</Button>
          </>
        )}
      </div>

      {isLoading ? <div className="h-10 rounded-md bg-sunken animate-pulse" />
        : !files.length ? (
          <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-[13px] text-subtle">
            No files attached.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {files.map((f: any) => {
              const asPdf = pdfConvertible(f.mime, f.filename);
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
                  <Paperclip size={14} className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink" title={f.filename}>{f.filename}</span>
                    <span className="text-[11.5px] text-subtle">
                      {fileSize(Number(f.size_bytes) || 0)}{f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ''} · {relative(f.created_at)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" icon={<Eye size={14} />} onClick={() => run(viewFile(f))}>View</Button>
                    {asPdf ? (
                      <Button size="sm" variant="ghost" icon={<FileDown size={14} />}
                        onClick={() => run(api.download(`/files/${f.id}/pdf`, pdfName(f.filename)))}>PDF</Button>
                    ) : (
                      <Button size="sm" variant="ghost" icon={<Download size={14} />} title="This file type cannot be converted to PDF"
                        onClick={() => run(api.download(f.url.replace('/api/v1', ''), f.filename))}>Download</Button>
                    )}
                    {canRemove && (
                      <button onClick={() => remove.mutate(f.id)} aria-label={`Remove ${f.filename}`}
                        className="ml-1 text-subtle hover:text-[var(--negative)] cursor-pointer">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
