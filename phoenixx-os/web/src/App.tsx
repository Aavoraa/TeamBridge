import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './lib/auth';
import { isNative } from './lib/storage';
import Layout from './components/Layout';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AcceptInvite from './pages/AcceptInvite';
import JoinWorkspace from './pages/JoinWorkspace';
import Recover from './pages/Recover';
import PublicProposal from './pages/PublicProposal';
import { NeedAccess } from './components/NeedAccess';
import { usePhonePushLinks } from './lib/phonePush';
import Home from './pages/Home';

// Route-level code splitting keeps the first paint small on 4G (NFR performance).
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ActionItems = lazy(() => import('./pages/ActionItems'));
const Meetings = lazy(() => import('./pages/Meetings'));
const MeetingIntel = lazy(() => import('./pages/MeetingIntel'));
const AiMeetings = lazy(() => import('./pages/AiMeetings'));
const MeetingRoom = lazy(() => import('./pages/MeetingRoom'));
const Chat = lazy(() => import('./pages/Chat'));
const Deadlines = lazy(() => import('./pages/Deadlines'));
const CRM = lazy(() => import('./pages/CRM'));
const Clients = lazy(() => import('./pages/Clients'));
const ClientDetail = lazy(() => import('./pages/ClientDetail'));
const Proposals = lazy(() => import('./pages/Proposals'));
const Projects = lazy(() => import('./pages/Projects'));
const Resources = lazy(() => import('./pages/Resources'));
const Marketing = lazy(() => import('./pages/Marketing'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const Finance = lazy(() => import('./pages/Finance'));
const Reimbursements = lazy(() => import('./pages/Reimbursements'));
const HR = lazy(() => import('./pages/HR'));
const Team = lazy(() => import('./pages/Team'));
const OfficeCalendar = lazy(() => import('./pages/OfficeCalendar'));
const SOP = lazy(() => import('./pages/SOP'));
const SOPDetail = lazy(() => import('./pages/SOPDetail'));
const Reports = lazy(() => import('./pages/Reports'));
const ReportDetail = lazy(() => import('./pages/ReportDetail'));
const Settings = lazy(() => import('./pages/Settings'));
const Billing = lazy(() => import('./pages/Billing'));
const Admin = lazy(() => import('./pages/Admin'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));

/**
 * Mobile V2 — its own shell, its own four-tab navigation, deliberately not the
 * desktop screens shrunk down. It lives outside the <Layout> route below
 * because it replaces the sidebar and header entirely.
 */
const MobileApp = lazy(() => import('./mobile/MobileApp'));

function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-subtle">
        <Loader2 size={26} className="animate-spin" />
        <p className="text-sm">{label}…</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Signing you in" />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();
  usePhonePushLinks();

  return (
    <Routes>
      {/* -------------------------------------------------------- public */}
      <Route path="/p/:token" element={<PublicProposal />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/join/:token" element={<JoinWorkspace />} />
      <Route path="/recover" element={<Recover />} />
      <Route path="/login" element={loading ? <FullPageSpinner /> : user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={loading ? <FullPageSpinner /> : user ? <Navigate to="/" replace /> : <Signup />} />

      {/* --------------------------------------------------- mobile V2 */}
      {/* Browsable at /m on any device, which is how it is tested without one. */}
      <Route path="/m/*" element={(
        <RequireAuth>
          <Suspense fallback={<FullPageSpinner />}><MobileApp /></Suspense>
        </RequireAuth>
      )} />

      {/* Live meeting room: full screen, outside the CRM shell, so video gets the space. */}
      <Route path="/ai-meetings/room/:id" element={(
        <RequireAuth>
          <Suspense fallback={<FullPageSpinner />}><MeetingRoom /></Suspense>
        </RequireAuth>
      )} />

      {/* ----------------------------------------------------- protected */}
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        {/* Inside the installed app the mobile shell is the whole product. */}
        <Route index element={isNative ? <Navigate to="/m" replace /> : <Home />} />
        {/* The dashboard itself, for the installed app, where "/" is the phone home screen. */}
        <Route path="overview" element={<Home />} />
        <Route path="dashboard" element={<NeedAccess module="dashboard"><Suspense fallback={<FullPageSpinner />}><Dashboard /></Suspense></NeedAccess>} />
        <Route path="action-items" element={<NeedAccess module="action_items"><Suspense fallback={<FullPageSpinner />}><ActionItems /></Suspense></NeedAccess>} />
        <Route path="action-items/:id" element={<NeedAccess module="action_items"><Suspense fallback={<FullPageSpinner />}><ActionItems /></Suspense></NeedAccess>} />
        <Route path="meetings" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><Meetings /></Suspense></NeedAccess>} />
        <Route path="meetings/:id" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><Meetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings/schedule" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings/join" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings/upcoming" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings/history" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings/m/:id" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="ai-meetings/j/:token" element={<NeedAccess module="meetings"><Suspense fallback={<FullPageSpinner />}><AiMeetings /></Suspense></NeedAccess>} />
        <Route path="meeting-intel" element={<NeedAccess module="meeting_intelligence"><Suspense fallback={<FullPageSpinner />}><MeetingIntel /></Suspense></NeedAccess>} />
        <Route path="meeting-intel/:id" element={<NeedAccess module="meeting_intelligence"><Suspense fallback={<FullPageSpinner />}><MeetingIntel /></Suspense></NeedAccess>} />
        <Route path="deadlines" element={<NeedAccess module="deadlines"><Suspense fallback={<FullPageSpinner />}><Deadlines /></Suspense></NeedAccess>} />
        <Route path="chat" element={<NeedAccess module="chat"><Suspense fallback={<FullPageSpinner />}><Chat /></Suspense></NeedAccess>} />
        <Route path="clients" element={<NeedAccess module="crm"><Suspense fallback={<FullPageSpinner />}><Clients /></Suspense></NeedAccess>} />
        <Route path="crm" element={<NeedAccess module="crm"><Suspense fallback={<FullPageSpinner />}><CRM /></Suspense></NeedAccess>} />
        <Route path="crm/:id" element={<NeedAccess module="crm"><Suspense fallback={<FullPageSpinner />}><ClientDetail /></Suspense></NeedAccess>} />
        <Route path="proposals" element={<NeedAccess module="proposals"><Suspense fallback={<FullPageSpinner />}><Proposals /></Suspense></NeedAccess>} />
        <Route path="projects" element={<NeedAccess module="projects"><Suspense fallback={<FullPageSpinner />}><Projects /></Suspense></NeedAccess>} />
        <Route path="projects/:id" element={<NeedAccess module="projects"><Suspense fallback={<FullPageSpinner />}><Projects /></Suspense></NeedAccess>} />
        <Route path="resources" element={<Suspense fallback={<FullPageSpinner />}><Resources /></Suspense>} />
        <Route path="marketing" element={<NeedAccess module="crm" marketingTeam><Suspense fallback={<FullPageSpinner />}><Marketing /></Suspense></NeedAccess>} />
        <Route path="marketing/:projectId" element={<NeedAccess module="crm" marketingTeam><Suspense fallback={<FullPageSpinner />}><Marketing /></Suspense></NeedAccess>} />
        <Route path="proposals/:id" element={<NeedAccess module="proposals"><Suspense fallback={<FullPageSpinner />}><Proposals /></Suspense></NeedAccess>} />
        <Route path="invoices" element={<NeedAccess module="invoices"><Suspense fallback={<FullPageSpinner />}><Invoices /></Suspense></NeedAccess>} />
        <Route path="invoices/:id" element={<NeedAccess module="invoices"><Suspense fallback={<FullPageSpinner />}><InvoiceDetail /></Suspense></NeedAccess>} />
        <Route path="finance" element={<NeedAccess module="costs"><Suspense fallback={<FullPageSpinner />}><Finance /></Suspense></NeedAccess>} />
        {/* The Finance module's own views. Each left-nav entry lands on one of
            them, and the page falls back to "mine" for a role that cannot use
            the one asked for. */}
        <Route path="finance/reimbursements" element={<NeedAccess module="reimbursements"><Suspense fallback={<FullPageSpinner />}><Reimbursements /></Suspense></NeedAccess>} />
        <Route path="finance/reimbursements/:view" element={<NeedAccess module="reimbursements"><Suspense fallback={<FullPageSpinner />}><Reimbursements /></Suspense></NeedAccess>} />
        <Route path="hr" element={<NeedAccess module="hr_attendance"><Suspense fallback={<FullPageSpinner />}><HR /></Suspense></NeedAccess>} />
        <Route path="team" element={<NeedAccess module="employees"><Suspense fallback={<FullPageSpinner />}><Team /></Suspense></NeedAccess>} />
        <Route path="calendar" element={<Suspense fallback={<FullPageSpinner />}><OfficeCalendar /></Suspense>} />
        <Route path="sop" element={<NeedAccess module="sop"><Suspense fallback={<FullPageSpinner />}><SOP /></Suspense></NeedAccess>} />
        <Route path="sop/:id" element={<NeedAccess module="sop"><Suspense fallback={<FullPageSpinner />}><SOPDetail /></Suspense></NeedAccess>} />
        <Route path="reports" element={<NeedAccess module="reports"><Suspense fallback={<FullPageSpinner />}><Reports /></Suspense></NeedAccess>} />
        <Route path="reports/:id" element={<NeedAccess module="reports"><Suspense fallback={<FullPageSpinner />}><ReportDetail /></Suspense></NeedAccess>} />
        <Route path="notifications" element={<Suspense fallback={<FullPageSpinner />}><Notifications /></Suspense>} />
        <Route path="settings" element={<NeedAccess module="settings"><Suspense fallback={<FullPageSpinner />}><Settings /></Suspense></NeedAccess>} />
        <Route path="billing" element={<NeedAccess module="billing"><Suspense fallback={<FullPageSpinner />}><Billing /></Suspense></NeedAccess>} />
        <Route path="profile" element={<Suspense fallback={<FullPageSpinner />}><Profile /></Suspense>} />
        <Route path="admin" element={<Suspense fallback={<FullPageSpinner />}><Admin /></Suspense>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
