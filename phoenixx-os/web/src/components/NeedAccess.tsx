import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Card, EmptyState } from './ui';

/**
 * A page only for roles that can open it. The menu already hides what a role
 * cannot use; this covers a typed or bookmarked address, which would otherwise
 * open an empty page full of refused requests. The server refuses either way.
 */
export function NeedAccess({ module, children, marketingTeam }: { module: string; children: ReactNode; marketingTeam?: boolean }) {
  const auth = useAuth() as ReturnType<typeof useAuth> & { on_marketing_project?: boolean };
  const { can, user } = auth;
  // Marketing leads also open for the people on a marketing project's team.
  if (can(module, 'view') || (marketingTeam && auth.on_marketing_project)) return <>{children}</>;
  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <EmptyState icon={<Lock size={20} />} title="You don't have access to this page"
        message={`Your role${user?.role ? ` (${user.role.replace('_', ' ')})` : ''} can't open it. If you need it, ask the workspace owner to give your role access in Settings > Roles & access.`}
        action={<Link to="/" className="text-[13.5px] font-medium text-[var(--brand)] hover:underline">Go to the dashboard</Link>} />
    </Card>
  );
}
