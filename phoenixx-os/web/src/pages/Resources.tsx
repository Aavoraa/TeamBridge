import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Building2, ChevronDown, ChevronRight, FileText, FolderKanban, FolderOpen, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Tabs, cx } from '../components/ui';
import { ResourceLibrary, UploadModal, useResourceTargets } from '../components/Resources';

/**
 * Resources, arranged the way the work is: companies, and under each company
 * its own documents and a folder per project - a company usually has several.
 * "All documents" is the flat, filterable list across everything.
 */

type Project = { id: string; name: string; status: string; doc_count: number; last_doc_at: string | null };
type Company = {
  key: string; id: string | null; name: string; industry: string | null; has_company_folder: boolean;
  doc_count: number; total_docs: number; last_doc_at: string | null; projects: Project[];
};

const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

export default function Resources() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'all' ? 'all' : 'companies';
  const companyKey = params.get('company');

  const summary = useQuery({
    queryKey: ['resources', 'summary'],
    queryFn: () => api.get<any>('/resources/summary').then((r) => r.data),
  });
  const companies: Company[] = summary.data?.companies || [];
  const open = companyKey ? companies.find((c) => c.key === companyKey) : undefined;

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p);
  };

  return (
    <div>
      <PageHeader title="Resources"
        subtitle="Documents for each company and its projects. View them, download them, or download them as PDF."
        tabs={(
          <Tabs active={view} onChange={(id: string) => go({ view: id === 'all' ? 'all' : null, company: null })} tabs={[
            { id: 'companies', label: 'By company' },
            { id: 'all', label: 'All documents' },
          ]} />
        )} />

      {view === 'all' ? <ResourceLibrary />
        : open ? <CompanyFolders company={open} canAddCompanyDocs={!!summary.data?.can_add_client_docs} onBack={() => go({ company: null })} />
          : <CompanyList companies={companies} loading={summary.isLoading} onOpen={(key) => go({ company: key })} />}
    </div>
  );
}

/* ------------------------------------------------------------ companies */
function CompanyList({ companies, loading, onOpen }: { companies: Company[]; loading: boolean; onOpen: (key: string) => void }) {
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(false);
  const { data: targets } = useResourceTargets();
  const canUpload = !!(targets?.can_add_client_docs || targets?.projects?.length);
  const uploadButton = canUpload && (
    <Button variant="primary" icon={<Upload size={15} />} onClick={() => setUploading(true)}>Upload document</Button>
  );
  const modal = uploading && <UploadModal targets={targets} fixed={{}} initial={{}} onClose={() => setUploading(false)} />;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return companies;
    return companies.filter((c) => c.name.toLowerCase().includes(needle)
      || c.projects.some((p) => p.name.toLowerCase().includes(needle)));
  }, [companies, q]);

  if (loading) {
    return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-32 rounded-xl bg-sunken animate-pulse" />)}</div>;
  }
  if (!companies.length) {
    return (
      <>
        <Card><EmptyState icon={<FolderOpen size={20} />} title="No companies yet" action={uploadButton || undefined}
          message="Companies you work with, and the projects you are on, appear here with their documents." /></Card>
        {modal}
      </>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Find a company or project" className="min-w-0 max-w-md flex-1 basis-60" />
        {uploadButton}
      </div>
      {modal}
      {!shown.length ? <p className="text-[13px] text-subtle">No company or project matches “{q}”.</p> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((c) => (
            <button key={c.key} onClick={() => onOpen(c.key)}
              className="card group flex flex-col gap-3 p-4 text-left transition hover:border-[var(--brand)] cursor-pointer">
              <span className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-sunken text-[var(--brand)]"><Building2 size={19} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold text-ink">{c.name}</span>
                  <span className="text-[12.5px] text-subtle">
                    {c.projects.length} project{c.projects.length === 1 ? '' : 's'} · {docs(c.total_docs)}
                  </span>
                </span>
                <ChevronRight size={17} className="mt-1 shrink-0 text-subtle group-hover:text-[var(--brand)]" />
              </span>
              {!!c.projects.length && (
                <span className="flex flex-wrap gap-1.5">
                  {c.projects.slice(0, 4).map((p) => (
                    <span key={p.id} className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-sunken px-2 py-0.5 text-[11.5px] text-muted">
                      <FolderKanban size={11} className="shrink-0" /><span className="truncate">{p.name}</span>
                    </span>
                  ))}
                  {c.projects.length > 4 && <span className="text-[11.5px] text-subtle">+{c.projects.length - 4} more</span>}
                </span>
              )}
              {c.last_doc_at && <span className="text-[11.5px] text-subtle">Last added {relative(c.last_doc_at)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------- a company's folders */
function CompanyFolders({ company: c, canAddCompanyDocs, onBack }: { company: Company; canAddCompanyDocs: boolean; onBack: () => void }) {
  const { data: targets } = useResourceTargets();
  const [upload, setUpload] = useState<null | { clientAccountId?: string; projectId?: string }>(null);
  // With a handful of projects every folder starts open; with many, they start closed.
  const [openIds, setOpenIds] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(c.projects.map((p) => [p.id, c.projects.length <= 3 || p.doc_count > 0 && c.projects.length <= 6]))
  ));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={onBack}>All companies</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-lg bg-sunken text-[var(--brand)]"><Building2 size={21} /></span>
        <div className="min-w-0">
          <h2 className="truncate text-[18px] font-semibold text-ink">{c.name}</h2>
          <p className="text-[12.5px] text-subtle">
            {c.industry ? `${c.industry} · ` : ''}{c.projects.length} project{c.projects.length === 1 ? '' : 's'} · {docs(c.total_docs)}
          </p>
        </div>
      </div>

      {c.has_company_folder && c.id && (
        <Folder icon={<Building2 size={16} />} title="Company documents" count={c.doc_count}
          hint="Contracts, agreements and brand material for the whole company"
          open onToggle={undefined}
          action={canAddCompanyDocs ? () => setUpload({ clientAccountId: c.id! }) : undefined}>
          <ResourceLibrary clientAccountId={c.id} scope="client" bare />
        </Folder>
      )}

      <div>
        <p className="label-cap mb-2">Projects</p>
        {!c.projects.length ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] text-subtle">
            No projects for {c.name} yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {c.projects.map((p) => (
              <Folder key={p.id} icon={<FolderKanban size={16} />} title={p.name} count={p.doc_count}
                badge={p.status !== 'active' ? p.status.replace('_', ' ') : undefined}
                open={!!openIds[p.id]} onToggle={() => setOpenIds((o) => ({ ...o, [p.id]: !o[p.id] }))}
                action={() => setUpload({ projectId: p.id })}>
                <ResourceLibrary projectId={p.id} bare />
              </Folder>
            ))}
          </div>
        )}
      </div>

      {upload && <UploadModal targets={targets} fixed={upload} initial={upload} onClose={() => setUpload(null)} />}
    </div>
  );
}

function Folder({ icon, title, count, hint, badge, open, onToggle, action, children }: {
  icon: React.ReactNode; title: string; count: number; hint?: string; badge?: string;
  open: boolean; onToggle?: () => void; action?: () => void; children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button onClick={onToggle} disabled={!onToggle}
          className={cx('flex min-w-0 flex-1 items-center gap-2.5 text-left', onToggle && 'cursor-pointer')}>
          {onToggle && (open ? <ChevronDown size={16} className="shrink-0 text-subtle" /> : <ChevronRight size={16} className="shrink-0 text-subtle" />)}
          <span className="shrink-0 text-[var(--brand)]">{icon}</span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{title}</span>
              <span className="inline-flex items-center gap-1 text-[12px] text-subtle"><FileText size={12} />{count}</span>
              {badge && <Badge tone="neutral" className="capitalize">{badge}</Badge>}
            </span>
            {hint && <span className="block text-[12px] text-subtle">{hint}</span>}
          </span>
        </button>
        {action && <Button size="sm" icon={<Upload size={14} />} onClick={action}>Upload</Button>}
      </div>
      {open && <div className="border-t border-line p-3">{children}</div>}
    </Card>
  );
}
