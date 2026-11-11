-- =====================================================================
-- Phoenixx OS - multi-tenant schema (PRD 5.4 / AR8: multi-tenant day one)
-- Dialect: SQLite (node:sqlite). Written to stay close to PostgreSQL so
-- the production target (PRD 5.2) is a mechanical port:
--   TEXT id  -> uuid,  INTEGER money -> bigint (minor units, AR6),
--   TEXT json-> jsonb, tenant scoping -> Postgres RLS policies.
-- Every tenant-owned table carries tenant_id (AR1) and deleted_at (AR7).
-- All timestamps are UTC ISO-8601 strings (AR6).
-- =====================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- PLATFORM
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,               -- starter | growth | scale
  name TEXT NOT NULL,
  band_min_users INTEGER NOT NULL DEFAULT 1,
  band_max_users INTEGER NOT NULL,
  price_monthly_minor INTEGER NOT NULL,
  price_yearly_minor INTEGER NOT NULL,
  addon_user_monthly_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  features TEXT NOT NULL DEFAULT '{}',     -- feature flags (S2)
  limits TEXT NOT NULL DEFAULT '{}',       -- clients / storage_mb / wa_credits
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                      -- percent | amount | free_months
  value INTEGER NOT NULL,
  duration_months INTEGER,
  max_redemptions INTEGER,
  redeemed INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  legal_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency TEXT NOT NULL DEFAULT 'INR',
  locale TEXT NOT NULL DEFAULT 'en-IN',
  number_format TEXT NOT NULL DEFAULT 'indian',   -- indian (lakh/crore) | international
  logo_url TEXT,
  brand_primary TEXT NOT NULL DEFAULT '#1E40AF',
  brand_accent TEXT NOT NULL DEFAULT '#F59E0B',
  gstin TEXT,
  pan TEXT,
  state_code TEXT DEFAULT '33',            -- Tamil Nadu; drives CGST/SGST vs IGST
  address TEXT,
  city TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  invoice_scheme TEXT NOT NULL DEFAULT '{prefix}/{fy}/{seq:4}',
  proposal_prefix TEXT NOT NULL DEFAULT 'PRO',
  fy_start_month INTEGER NOT NULL DEFAULT 4,      -- April (India)
  -- The workspace working day. Every employee inherits these unless HR has
  -- given them their own; all three are workspace-local wall clock, never UTC.
  work_start TEXT NOT NULL DEFAULT '09:30',       -- HH:MM
  work_end TEXT NOT NULL DEFAULT '18:30',         -- HH:MM
  late_grace_minutes INTEGER NOT NULL DEFAULT 10, -- checked in within this is still on time
  week_off_days TEXT NOT NULL DEFAULT '[0]',      -- JSON weekday numbers, 0 = Sunday
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',   -- active | suspended | cancelled
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL,                    -- trial|active|past_due|suspended|cancelled (S5)
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  seats INTEGER NOT NULL DEFAULT 0,
  coupon_id TEXT REFERENCES coupons(id),
  gateway TEXT,                            -- razorpay | stripe
  gateway_ref TEXT,
  trial_ends_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  grace_days INTEGER NOT NULL DEFAULT 7,
  cancel_at TEXT,
  cancelled_at TEXT,
  data_export_until TEXT,                  -- S5: 90 days post-cancellation
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  number TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL,                    -- draft|due|paid|failed
  period_start TEXT, period_end TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,     -- dunning (S4)
  paid_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_feature_flags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  flag_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, flag_key)
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  active_from TEXT, active_to TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- IDENTITY
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),   -- NULL only for platform super admins
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  whatsapp TEXT,
  role TEXT NOT NULL,                      -- super_admin|owner|manager|employee|finance|hr|client
  custom_role_id TEXT,
  designation TEXT,
  service_line_id TEXT,
  manager_id TEXT REFERENCES users(id),
  client_id TEXT,                          -- for portal users (role=client)
  employment_type TEXT DEFAULT 'full_time',
  -- HR's pre-noted working time for this person. NULL means "whatever the
  -- workspace says", so a tenant-wide change still reaches everyone who has
  -- never been given a schedule of their own.
  work_start TEXT,                         -- HH:MM, workspace-local
  work_end TEXT,                           -- HH:MM, workspace-local
  grace_minutes INTEGER,                   -- overrides the workspace grace
  date_of_joining TEXT,
  monthly_cost_minor INTEGER NOT NULL DEFAULT 0,   -- C5 -> feeds cost module
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | invited | disabled
  twofa_enabled INTEGER NOT NULL DEFAULT 0,
  twofa_secret TEXT,
  notification_prefs TEXT NOT NULL DEFAULT '{}',   -- B2 per-user x per-event channels
  locale TEXT DEFAULT 'en-IN',
  last_login_at TEXT,
  invite_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_email ON users(tenant_id, email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_users_tenant ON users(tenant_id);

-- People who created their account from a personal invitation. They are not
-- users until an owner approves: kept apart so a pending applicant never gets
-- role notifications, counts against seats, or can sign in.
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  requested_role TEXT NOT NULL,            -- manager|employee|finance|hr
  designation TEXT,
  department TEXT,
  password_hash TEXT NOT NULL,
  security_question TEXT,
  security_answer_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  user_id TEXT REFERENCES users(id),       -- the account created on approval
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_join_requests_tenant ON join_requests(tenant_id, status);

-- A personal invitation the owner sends to one email address. Its link lets
-- that person create their own account (name, role, password), which then
-- waits in join_requests for the owner's approval. One use per link.
CREATE TABLE IF NOT EXISTS join_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  name TEXT,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',     -- sent|used|revoked
  invited_by TEXT REFERENCES users(id),
  request_id TEXT,                         -- the join request it turned into
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_join_invites_token ON join_invites(token);
CREATE INDEX IF NOT EXISTS ix_join_invites_tenant ON join_invites(tenant_id, status);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  base_role TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '{}',  -- {"module": ["view","create",...]}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor_id TEXT,
  actor_name TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,                    -- create|update|delete|approve|reject|login|export
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs(tenant_id, entity, entity_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  response_json TEXT,
  status_code INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key, endpoint)
);

-- ---------------------------------------------------------------- TENANT CONFIG
CREATE TABLE IF NOT EXISTS service_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  color TEXT DEFAULT '#3B82F6',
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sl_tenant ON service_lines(tenant_id);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  is_lost INTEGER NOT NULL DEFAULT 0,
  sla_days INTEGER,                        -- stage velocity target (E6 conversion)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS reason_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  category TEXT NOT NULL,                  -- retention_risk | churn | score_adjust | grievance
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, category, code)
);

CREATE TABLE IF NOT EXISTS action_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,                      -- Outreach Pitch|Follow-up|Grievance|Internal|Custom
  code TEXT NOT NULL,
  escalation_days INTEGER NOT NULL DEFAULT 3,   -- A4 configurable per category
  color TEXT DEFAULT '#64748B',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

/**
 * One-off data migrations that have already run, by key.
 *
 * Most repairs in db/index.js are naturally self-limiting - they carry a WHERE
 * clause that stops matching once they have done their work. A few are not:
 * correcting a default that people are then free to change back means the
 * repair has to know it has already happened, or it would undo their choice on
 * the next restart. Those record themselves here.
 */
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- MODULE A
CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  ref TEXT,
  title TEXT NOT NULL,
  description TEXT,
  owner_id TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  client_id TEXT,
  project_id TEXT,
  category_id TEXT REFERENCES action_categories(id),
  priority TEXT NOT NULL DEFAULT 'medium', -- low|medium|high|urgent
  status TEXT NOT NULL DEFAULT 'open',     -- open|in_progress|blocked|done|cancelled
  -- The due date is three columns, not one: the workspace-local day, the
  -- optional workspace-local time on it, and the UTC instant the two resolve
  -- to. See lib/dueTime.js for why every one of them earns its place.
  due_date TEXT,                           -- YYYY-MM-DD, workspace-local
  due_time TEXT,                           -- HH:MM 24h, workspace-local, or NULL
  due_at TEXT,                             -- UTC instant; end of day when untimed
  started_at TEXT,
  completed_at TEXT,
  -- Done is the assignee's word; validated is the creator's. NULL until the
  -- item is first marked done, then pending|validated|changes_requested.
  validation_status TEXT,
  completed_by TEXT REFERENCES users(id),
  validated_by TEXT REFERENCES users(id),
  validated_at TEXT,
  validation_note TEXT,
  rework_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  recurrence TEXT,                         -- none|daily|weekly|monthly (A3)
  recurrence_until TEXT,
  recurrence_parent_id TEXT,
  source_type TEXT,                        -- mom|sop|invoice|lead|manual|advance_planner
  source_id TEXT,                          -- for advance_planner: the todo_tasks row
  source_plan_id TEXT,                     -- for advance_planner: the todo_submissions row
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  sop_id TEXT,
  estimate_minutes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_ai_tenant_status ON action_items(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS ix_ai_owner ON action_items(tenant_id, owner_id, status);
CREATE INDEX IF NOT EXISTS ix_ai_updated ON action_items(tenant_id, updated_at);
-- ix_ai_due_at, over the new due_at column, is created in db/index.js instead:
-- this file runs before the additive ALTERs, so on an existing database the
-- column it indexes does not exist yet.



CREATE TABLE IF NOT EXISTS action_watchers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (action_item_id, user_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  agenda TEXT,
  client_id TEXT,
  project_id TEXT,
  organizer_id TEXT REFERENCES users(id),
  scheduled_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  location TEXT,
  meeting_link TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|completed|cancelled
  mom_summary TEXT,
  mom_locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_meet_tenant_time ON meetings(tenant_id, scheduled_at);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  user_id TEXT REFERENCES users(id),
  contact_id TEXT,
  external_name TEXT,
  attended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mom_points (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  kind TEXT NOT NULL DEFAULT 'note',       -- note|decision|action|risk
  text TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  due_date TEXT,
  action_item_id TEXT,                     -- A2 one-tap conversion
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_comments_entity ON comments(tenant_id, entity, entity_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  kind TEXT DEFAULT 'file',                -- file | voice_note (A6)
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_att_entity ON attachments(tenant_id, entity, entity_id);

-- --------------------------------------------------------- MODULE B: CHAT
-- Conversations. A channel is one of four kinds and the kind decides who is in
-- it and who may post:
--   broadcast - one per tenant, everybody is a member, only admins post
--   project   - mirrors a project's delivery team; membership is derived
--   group     - an ad-hoc room someone created and invited people to
--   direct    - a two-person conversation, keyed by the sorted pair of ids
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL DEFAULT 'group',      -- broadcast|project|group|direct
  name TEXT,
  topic TEXT,
  project_id TEXT REFERENCES projects(id),
  dm_key TEXT,                             -- "<userA>:<userB>", ids sorted
  post_policy TEXT NOT NULL DEFAULT 'members',  -- members|admins
  created_by TEXT REFERENCES users(id),
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_channel_project ON channels(tenant_id, project_id) WHERE project_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_channel_dm ON channels(tenant_id, dm_key) WHERE dm_key IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_channel_broadcast ON channels(tenant_id, kind) WHERE kind = 'broadcast' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_channel_tenant ON channels(tenant_id, last_message_at DESC);

-- `last_read_at` is the whole unread story: no per-message read receipts, so a
-- badge is one COUNT against an indexed range rather than a join per message.
CREATE TABLE IF NOT EXISTS channel_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',     -- owner|member
  last_read_at TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chanmem_once ON channel_members(channel_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_chanmem_user ON channel_members(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  author_id TEXT REFERENCES users(id),     -- NULL for system messages
  kind TEXT NOT NULL DEFAULT 'text',       -- text|system
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',     -- user ids resolved at post time
  reply_to_id TEXT REFERENCES messages(id),
  pinned_at TEXT,
  pinned_by TEXT REFERENCES users(id),
  edited_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_msg_channel ON messages(tenant_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_msg_pinned ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;

-- ---------------------------------------------------------------- MODULE B
CREATE TABLE IF NOT EXISTS deadlines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  source_type TEXT NOT NULL,               -- action_item|invoice|proposal|leave|deliverable|follow_up
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  escalate_to_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|met|breached|cancelled
  severity TEXT NOT NULL DEFAULT 'normal',
  ladder_sent TEXT NOT NULL DEFAULT '[]',  -- B3: ["t-3d","t-1d","due","overdue"]
  escalation_days INTEGER NOT NULL DEFAULT 3,
  resolved_at TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS ix_dl_due ON deadlines(tenant_id, status, due_at);

CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_key TEXT NOT NULL,
  channel TEXT NOT NULL,                   -- whatsapp|email|teams|in_app|push
  subject TEXT,
  body TEXT NOT NULL,                      -- {{placeholders}}
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, event_key, channel)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  event_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|sent|delivered|failed|read
  provider TEXT,
  provider_ref TEXT,
  error TEXT,
  dedupe_key TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif_dedupe ON notifications(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  from_user_id TEXT REFERENCES users(id),
  to_user_id TEXT REFERENCES users(id),
  reason TEXT,
  sla_hours INTEGER,
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_esc_tenant ON escalations(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',       -- AR3
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

-- ---------------------------------------------------------------- MODULE C
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  check_in_at TEXT,
  check_out_at TEXT,
  in_lat REAL, in_lng REAL, in_accuracy REAL,
  out_lat REAL, out_lng REAL,
  source TEXT NOT NULL DEFAULT 'web',      -- web|mobile|auto|regularized
  -- present|pending_approval|not_approved|absent|half_day|wfh|leave|holiday|weekoff
  status TEXT NOT NULL DEFAULT 'present',
  work_minutes INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  -- The schedule as it stood the moment this person checked in. Snapshotted
  -- rather than joined: HR editing someone's hours in October must not rewrite
  -- whether they were late in September.
  scheduled_start TEXT,                    -- HH:MM, workspace-local
  scheduled_end TEXT,                      -- HH:MM, workspace-local
  -- HR's ruling on a late arrival. Untouched for anyone who arrived on time.
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, work_date)
);
CREATE INDEX IF NOT EXISTS ix_att_date ON attendance(tenant_id, work_date);
CREATE INDEX IF NOT EXISTS ix_att_status ON attendance(tenant_id, status, work_date);

/**
 * Every change an attendance row has ever seen, append-only.
 *
 * The row itself only knows where it ended up; this says how it got there -
 * who checked in, when HR ruled and why, which missing checkout was corrected
 * by hand. Attendance decides pay and performance scores, so "who changed this
 * and when" cannot be a thing the system forgets.
 */
CREATE TABLE IF NOT EXISTS attendance_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  attendance_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  event TEXT NOT NULL,                     -- checked_in|checked_out|approved|rejected|corrected
  actor_id TEXT REFERENCES users(id),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_att_ev ON attendance_events(tenant_id, attendance_id, created_at);
CREATE INDEX IF NOT EXISTS ix_att_ev_day ON attendance_events(tenant_id, user_id, work_date);

/**
 * Company-wide non-working days. One row per date per tenant; adding one marks
 * that day a holiday for every employee at once, which is the whole point -
 * nobody should have to mark Onam absent for forty people.
 */
CREATE TABLE IF NOT EXISTS holidays (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  holiday_date TEXT NOT NULL,              -- YYYY-MM-DD, workspace-local
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'company_holiday',  -- company_holiday|restricted
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, holiday_date)
);
CREATE INDEX IF NOT EXISTS ix_holiday_date ON holidays(tenant_id, holiday_date);

/**
 * The office internet connections a check-in counts as "at work" from.
 *
 * Matched on the public address the request reaches the server from - the one
 * network fact the server observes itself and the browser cannot write. The
 * Wi-Fi name is a label for HR: no browser exposes it, so it proves nothing.
 * Private LAN ranges (192.168.x.x and friends) are refused on input, because
 * the server never sees them and every home router hands them out.
 */
CREATE TABLE IF NOT EXISTS approved_networks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  network_name TEXT NOT NULL,
  ssid TEXT,                               -- label only, never verified
  public_ip TEXT NOT NULL,                 -- an address or CIDR range, IPv4 or IPv6
  verification_method TEXT NOT NULL DEFAULT 'public_ip',
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_approved_networks ON approved_networks(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS attendance_regularizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  requested_in TEXT, requested_out TEXT,
  requested_status TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  approver_id TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_types (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  annual_quota REAL NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  color TEXT DEFAULT '#3B82F6',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  entitled REAL NOT NULL DEFAULT 0,
  used REAL NOT NULL DEFAULT 0,
  carried REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  kind TEXT NOT NULL DEFAULT 'leave',      -- leave | permission (hourly)
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  from_time TEXT, to_time TEXT,            -- for hourly permissions (C2)
  days REAL NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approver_id TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_leave_tenant ON leave_requests(tenant_id, status, from_date);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  period_month TEXT NOT NULL,              -- YYYY-MM
  items_assigned INTEGER NOT NULL DEFAULT 0,
  items_completed INTEGER NOT NULL DEFAULT 0,
  items_on_time INTEGER NOT NULL DEFAULT 0,
  completion_pct REAL NOT NULL DEFAULT 0,
  attendance_pct REAL NOT NULL DEFAULT 0,
  kpi_score REAL NOT NULL DEFAULT 0,
  manager_rating REAL,
  overall_score REAL,
  strengths TEXT,
  improvements TEXT,
  reviewer_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|submitted|acknowledged
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, period_month)
);

CREATE TABLE IF NOT EXISTS performance_kpi_scores (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES performance_reviews(id),
  kpi_id TEXT NOT NULL,
  kpi_name TEXT NOT NULL,
  target_value REAL,
  actual_value REAL,
  achievement_pct REAL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_openings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  service_line_id TEXT,
  department TEXT,
  qualification TEXT,                      -- C4 qualification standards
  skills TEXT NOT NULL DEFAULT '[]',
  experience_min_years REAL NOT NULL DEFAULT 0,
  experience_max_years REAL,
  headcount INTEGER NOT NULL DEFAULT 1,
  filled INTEGER NOT NULL DEFAULT 0,
  salary_min_minor INTEGER, salary_max_minor INTEGER,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- open|on_hold|closed
  hiring_manager_id TEXT REFERENCES users(id),
  target_close_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_opening_id TEXT REFERENCES job_openings(id),
  name TEXT NOT NULL,
  email TEXT, phone TEXT,
  source TEXT,
  experience_years REAL,
  current_ctc_minor INTEGER, expected_ctc_minor INTEGER,
  stage TEXT NOT NULL DEFAULT 'sourced',   -- sourced|screened|interview|offer|hired|rejected
  rating REAL,
  resume_path TEXT,
  notes TEXT,
  rejected_reason TEXT,
  stage_changed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_cand_tenant ON candidates(tenant_id, stage);

CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  round TEXT NOT NULL,
  interviewer_id TEXT REFERENCES users(id),
  scheduled_at TEXT,
  feedback TEXT,
  score REAL,
  recommendation TEXT,                     -- proceed|hold|reject
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- MODULE D
CREATE TABLE IF NOT EXISTS sops (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  code TEXT,
  service_line_id TEXT,
  workflow TEXT NOT NULL,                  -- D1 workflow taxonomy
  summary TEXT,
  owner_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|published|archived
  current_version INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  requires_ack INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sop_tenant ON sops(tenant_id, service_line_id, workflow);

CREATE TABLE IF NOT EXISTS sop_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sop_id TEXT NOT NULL REFERENCES sops(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',        -- rich text (markdown)
  checklist TEXT NOT NULL DEFAULT '[]',    -- [{id,text,required}]
  change_note TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (sop_id, version)
);

CREATE TABLE IF NOT EXISTS sop_acknowledgements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sop_id TEXT NOT NULL REFERENCES sops(id),
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  acknowledged_at TEXT NOT NULL,
  UNIQUE (sop_id, version, user_id)
);

CREATE TABLE IF NOT EXISTS sop_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sop_id TEXT NOT NULL REFERENCES sops(id),
  version INTEGER NOT NULL,
  entity TEXT, entity_id TEXT,             -- e.g. client onboarding run
  user_id TEXT REFERENCES users(id),
  checklist_state TEXT NOT NULL DEFAULT '{}',
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  adherence_pct REAL NOT NULL DEFAULT 0,   -- D4
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_soprun_tenant ON sop_runs(tenant_id, sop_id);

CREATE TABLE IF NOT EXISTS kpis (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'kpi',        -- kpi | kra
  description TEXT,
  applies_role TEXT,                       -- D3 per role
  service_line_id TEXT,                    -- D3 per service line
  unit TEXT DEFAULT 'number',              -- number|percent|currency|ratio
  source TEXT,                             -- metric source key (auto-computable)
  formula TEXT,
  target_value REAL,
  direction TEXT NOT NULL DEFAULT 'higher',-- higher | lower
  cadence TEXT NOT NULL DEFAULT 'monthly',
  weight REAL NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ---------------------------------------------------------------- MODULE E
--
-- Two tables, deliberately. `client_accounts` is the client master: the people
-- you actually do business with, entered and managed on the Clients page and
-- kept whether or not any sales activity is running. `clients` below is the CRM
-- pipeline record - a lead/opportunity that lives on the board and carries a
-- stage, a deal value and a next action.
--
-- A lead points at an account through clients.client_account_id when it belongs
-- to a client already on file, which is how saved client details get reused for
-- lead and campaign work instead of being retyped. The link is optional: a lead
-- for a company you have never worked with does not need an account first.
--
-- The pipeline table keeps the name `clients` because projects, invoices,
-- proposals, contacts and activities all carry a client_id foreign key to it
-- across 112 query sites; renaming it is a migration in its own right and is
-- not what makes these two things separate.
CREATE TABLE IF NOT EXISTS client_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  legal_name TEXT,
  industry TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | inactive | archived
  owner_id TEXT REFERENCES users(id),      -- account manager
  -- Primary point of contact. Richer contact lists still belong on the lead
  -- record via the contacts table; this is the one person you call by default.
  contact_name TEXT,
  contact_designation TEXT,
  email TEXT,
  phone TEXT,
  whatsapp TEXT,
  website TEXT,
  -- Billing identity, so an invoice can be raised straight from the account.
  gstin TEXT, pan TEXT,
  address TEXT, city TEXT, state TEXT, state_code TEXT, country TEXT DEFAULT 'India',
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_client_accounts_tenant ON client_accounts(tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_client_accounts_name ON client_accounts(tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_client_accounts_owner ON client_accounts(tenant_id, owner_id);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  legal_name TEXT,
  industry TEXT,                           -- E2 category tag
  -- The client this lead belongs to, when it is one already on file. Optional:
  -- a lead for a company you have never worked with stands on its own.
  client_account_id TEXT REFERENCES client_accounts(id),
  stage_id TEXT REFERENCES pipeline_stages(id),
  status TEXT NOT NULL DEFAULT 'lead',     -- lead|active|churned|lost
  owner_id TEXT REFERENCES users(id),
  source TEXT,
  website TEXT,
  gstin TEXT, pan TEXT,
  address TEXT, city TEXT, state TEXT, state_code TEXT, country TEXT DEFAULT 'India',
  currency TEXT NOT NULL DEFAULT 'INR',
  service_lines TEXT NOT NULL DEFAULT '[]',
  engagement_model TEXT DEFAULT 'project', -- retainer|project|hybrid
  mrr_minor INTEGER NOT NULL DEFAULT 0,
  deal_value_minor INTEGER NOT NULL DEFAULT 0,
  next_action TEXT,                        -- E4 mandatory next action
  next_action_date TEXT,
  next_action_owner_id TEXT,
  conversion_score REAL NOT NULL DEFAULT 0,
  risk_score REAL NOT NULL DEFAULT 0,
  relevancy_score REAL NOT NULL DEFAULT 0,
  retention_score REAL NOT NULL DEFAULT 0,
  health_score REAL NOT NULL DEFAULT 0,
  scores_updated_at TEXT,
  retention_risk INTEGER NOT NULL DEFAULT 0,
  retention_reason_code_id TEXT REFERENCES reason_codes(id),   -- E7 structured only
  retention_reason_note TEXT,
  scope_total INTEGER NOT NULL DEFAULT 0,
  scope_delivered INTEGER NOT NULL DEFAULT 0,
  satisfaction REAL,
  onboarded_at TEXT,
  renewal_date TEXT,
  churned_at TEXT,
  churn_reason_code_id TEXT REFERENCES reason_codes(id),
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  stage_entered_at TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_clients_tenant ON clients(tenant_id, status, stage_id);
CREATE INDEX IF NOT EXISTS ix_clients_owner ON clients(tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS ix_clients_next ON clients(tenant_id, next_action_date);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  designation TEXT,
  email TEXT, phone TEXT, whatsapp TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  consent_whatsapp INTEGER NOT NULL DEFAULT 0,   -- NFR privacy: consent text
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_contacts_client ON contacts(tenant_id, client_id);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  contact_id TEXT,
  type TEXT NOT NULL,                      -- call|whatsapp|email|meeting|note|proposal|invoice|stage_change|grievance
  direction TEXT DEFAULT 'outbound',
  subject TEXT,
  body TEXT,
  outcome TEXT,                            -- connected|no_response|positive|negative
  occurred_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  duration_minutes INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_act_client ON activities(tenant_id, client_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS stage_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  from_stage_id TEXT, to_stage_id TEXT,
  from_stage TEXT, to_stage TEXT,
  days_in_previous REAL,
  changed_by TEXT REFERENCES users(id),
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  service_line_id TEXT,
  sections TEXT NOT NULL DEFAULT '[]',     -- [{heading, body}]
  default_items TEXT NOT NULL DEFAULT '[]',
  terms TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  number TEXT NOT NULL,
  title TEXT NOT NULL,
  service_line_id TEXT,
  template_id TEXT,
  owner_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|sent|viewed|accepted|rejected|expired
  currency TEXT NOT NULL DEFAULT 'INR',
  sections TEXT NOT NULL DEFAULT '[]',
  terms TEXT,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 18,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT,
  share_token TEXT UNIQUE,                 -- E5 share link
  sent_at TEXT,
  first_viewed_at TEXT,
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  accepted_by_name TEXT,
  accepted_ip TEXT,
  rejected_at TEXT, rejected_reason TEXT,
  pdf_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS ix_prop_tenant ON proposals(tenant_id, status);

CREATE TABLE IF NOT EXISTS proposal_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  description TEXT NOT NULL,
  detail TEXT,
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT DEFAULT 'nos',
  rate_minor INTEGER NOT NULL DEFAULT 0,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS client_score_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  snapshot_date TEXT NOT NULL,
  conversion REAL, risk REAL, relevancy REAL, retention REAL, health REAL,
  breakdown TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, client_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS score_adjustments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  score_type TEXT NOT NULL,                -- conversion|risk|relevancy|retention
  delta REAL NOT NULL,
  reason_code_id TEXT NOT NULL REFERENCES reason_codes(id),   -- E6 reason codes
  note TEXT,
  user_id TEXT REFERENCES users(id),
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- MODULE F
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  code TEXT,
  service_line_id TEXT,
  model TEXT NOT NULL DEFAULT 'project',   -- retainer|project|hybrid
  status TEXT NOT NULL DEFAULT 'active',   -- planned|active|on_hold|completed|cancelled
  start_date TEXT, end_date TEXT,
  budget_minor INTEGER NOT NULL DEFAULT 0,
  manager_id TEXT REFERENCES users(id),
  lead_id TEXT REFERENCES users(id),
  scope_total INTEGER NOT NULL DEFAULT 0,      -- E7 active vs delivered scope
  scope_delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_proj_tenant ON projects(tenant_id, client_id);

-- F0: the delivery team behind a project. `projects.manager_id` / `lead_id`
-- mirror the member holding that seat so list views stay a single query, but
-- this table is the source of truth for who is on the team and in what seat.
CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  seat TEXT NOT NULL DEFAULT 'member',     -- manager|lead|senior|member|junior|reviewer|observer
  responsibility TEXT,                     -- what this person owns on the project
  allocation_pct INTEGER NOT NULL DEFAULT 0,   -- share of their week, feeds workload
  billable INTEGER NOT NULL DEFAULT 1,
  start_date TEXT, end_date TEXT,
  notes TEXT,
  added_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pmember_once ON project_members(project_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_pmember_project ON project_members(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS ix_pmember_user ON project_members(tenant_id, user_id);

-- F1: guarantees gap-free, collision-free invoice numbers per tenant+FY
CREATE TABLE IF NOT EXISTS invoice_counters (
  tenant_id TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'invoice',
  fy TEXT NOT NULL,
  prefix TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, doc_type, fy, prefix)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  project_id TEXT REFERENCES projects(id),
  number TEXT NOT NULL,
  seq INTEGER NOT NULL,
  fy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|sent|partially_paid|paid|overdue|written_off
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  place_of_supply TEXT,
  supply_state_code TEXT,
  is_interstate INTEGER NOT NULL DEFAULT 0,
  is_export INTEGER NOT NULL DEFAULT 0,
  reverse_charge INTEGER NOT NULL DEFAULT 0,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  taxable_minor INTEGER NOT NULL DEFAULT 0,
  cgst_minor INTEGER NOT NULL DEFAULT 0,
  sgst_minor INTEGER NOT NULL DEFAULT 0,
  igst_minor INTEGER NOT NULL DEFAULT 0,
  round_off_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  paid_minor INTEGER NOT NULL DEFAULT 0,
  balance_minor INTEGER NOT NULL DEFAULT 0,
  notes TEXT, terms TEXT,
  pdf_path TEXT,
  recurring_id TEXT,
  sent_at TEXT,
  paid_at TEXT,
  written_off_at TEXT,
  written_off_reason TEXT,
  created_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS ix_inv_tenant ON invoices(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS ix_inv_client ON invoices(tenant_id, client_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  hsn_sac TEXT,                            -- F1 HSN/SAC
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT DEFAULT 'nos',
  rate_minor INTEGER NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  taxable_minor INTEGER NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18,
  cgst_minor INTEGER NOT NULL DEFAULT 0,
  sgst_minor INTEGER NOT NULL DEFAULT 0,
  igst_minor INTEGER NOT NULL DEFAULT 0,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  service_line_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_invitem ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  client_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  method TEXT,                             -- upi|neft|cheque|card|cash|razorpay
  reference TEXT,
  notes TEXT,
  recorded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_pay_inv ON payments(tenant_id, invoice_id);

CREATE TABLE IF NOT EXISTS credit_notes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  client_id TEXT NOT NULL,
  number TEXT NOT NULL,
  seq INTEGER NOT NULL,
  fy TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS recurring_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  project_id TEXT,
  title TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  day_of_month INTEGER NOT NULL DEFAULT 1,
  next_run_date TEXT NOT NULL,
  payment_terms_days INTEGER NOT NULL DEFAULT 15,
  template TEXT NOT NULL DEFAULT '{}',     -- items snapshot
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  runs_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS costs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  category TEXT NOT NULL,                  -- hr|tools|rent|maintenance|misc|marketing
  label TEXT NOT NULL,
  vendor TEXT,
  amount_minor INTEGER NOT NULL,
  period_month TEXT NOT NULL,              -- YYYY-MM
  client_id TEXT,
  project_id TEXT,
  service_line_id TEXT,
  user_id TEXT,                            -- for HR cost rows
  recurring INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  recorded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_cost_tenant ON costs(tenant_id, period_month, category);

-- ---------------------------------------------------------------- MODULE G
CREATE TABLE IF NOT EXISTS report_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- daily|weekly|monthly|client_monthly|custom
  module TEXT,
  metrics TEXT NOT NULL DEFAULT '[]',
  filters TEXT NOT NULL DEFAULT '{}',
  schedule TEXT,                           -- daily@08:00 / weekly@mon-09:00 / monthly@1-09:00
  channels TEXT NOT NULL DEFAULT '["in_app"]',
  recipients TEXT NOT NULL DEFAULT '[]',   -- user ids / roles
  client_scope TEXT,                       -- all | client id
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS report_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  definition_id TEXT REFERENCES report_definitions(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  client_id TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated', -- generated|approved|dispatched|failed
  payload TEXT NOT NULL DEFAULT '{}',
  pdf_path TEXT,
  approved_by TEXT,
  approved_at TEXT,
  dispatched_at TEXT,
  dispatch_status TEXT,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rr_tenant ON report_runs(tenant_id, kind, generated_at DESC);

-- ---------------------------------------------------------------- MODULE H
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value_num REAL NOT NULL DEFAULT 0,
  dims TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, snapshot_date, metric_key, dims)
);
CREATE INDEX IF NOT EXISTS ix_ms_tenant ON metric_snapshots(tenant_id, metric_key, snapshot_date);

CREATE TABLE IF NOT EXISTS improvement_flags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  flag_key TEXT NOT NULL,                  -- H3 auto-surfaced weak points
  severity TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  detail TEXT,
  entity TEXT, entity_id TEXT,
  metric_value REAL,
  drill_path TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- open|acknowledged|resolved
  acknowledged_by TEXT,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_if_tenant ON improvement_flags(tenant_id, status, severity);

-- ---------------------------------------------------------------- JOBS
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL,
  tenant_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobruns ON job_runs(job_key, started_at DESC);

-- ------------------------------------------------ MY DAY: PERSONAL TO-DOS
-- A private daily to-do list. Deliberately its own table rather than a flavour
-- of action_items: company work is assigned, escalated, reported on and visible
-- to managers, whereas these are the person's own reminders. Every read path
-- filters on user_id and no permission widens that - not even owner.
CREATE TABLE IF NOT EXISTS personal_todos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  todo_date TEXT NOT NULL,                 -- YYYY-MM-DD, the day it belongs to
  due_time TEXT,                           -- HH:MM, optional
  priority TEXT NOT NULL DEFAULT 'normal', -- low|normal|high
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|completed
  sort REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_todo_user_day ON personal_todos(tenant_id, user_id, todo_date, status);

-- ------------------------------------------ MODULE I: EXPENSE REIMBURSEMENT
-- What an employee spent on the company's behalf, and its journey to being
-- paid back:  draft -> submitted -> manager approval -> finance review
--                   -> approved -> paid,  with rejection possible at either
-- approval gate. `status` names where the request currently sits; the full
-- trail lives in reimbursement_events so nothing about a money decision is
-- reconstructed from timestamps alone.
CREATE TABLE IF NOT EXISTS expense_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT,
  requires_receipt INTEGER NOT NULL DEFAULT 1,
  cap_minor INTEGER,                       -- soft per-claim ceiling, warns only
  color TEXT DEFAULT '#3B82F6',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS reimbursements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  number TEXT,                             -- REIMB-0001, assigned on submit
  user_id TEXT NOT NULL REFERENCES users(id),
  category_id TEXT REFERENCES expense_categories(id),
  expense_date TEXT NOT NULL,              -- YYYY-MM-DD, when the money went out
  amount_minor INTEGER NOT NULL,           -- claimed, minor units (AR6)
  description TEXT NOT NULL,
  merchant TEXT,
  client_id TEXT,                          -- optional: billable back to a client
  project_id TEXT,
  payment_mode TEXT,                       -- cash|card|upi|netbanking|other
  status TEXT NOT NULL DEFAULT 'draft',
  -- draft|submitted|manager_approved|approved|paid|rejected|cancelled
  submitted_at TEXT,
  manager_id TEXT REFERENCES users(id),    -- who owes the first decision
  manager_decision TEXT,                   -- approved|rejected
  manager_decided_at TEXT,
  manager_decided_by TEXT REFERENCES users(id),
  manager_note TEXT,
  finance_decision TEXT,                   -- approved|rejected
  finance_decided_at TEXT,
  finance_decided_by TEXT REFERENCES users(id),
  finance_note TEXT,
  approved_minor INTEGER,                  -- finance may settle a lower amount
  rejection_reason TEXT,
  paid_at TEXT,
  paid_by TEXT REFERENCES users(id),
  paid_minor INTEGER,
  payment_method TEXT,                     -- bank_transfer|upi|cash|payroll|other
  payment_reference TEXT,
  payment_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_reimb_tenant ON reimbursements(tenant_id, status, expense_date);
CREATE INDEX IF NOT EXISTS ix_reimb_user ON reimbursements(tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS ix_reimb_manager ON reimbursements(tenant_id, manager_id, status);

CREATE TABLE IF NOT EXISTS reimbursement_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reimbursement_id TEXT NOT NULL REFERENCES reimbursements(id),
  actor_id TEXT REFERENCES users(id),
  actor_name TEXT,
  action TEXT NOT NULL,                    -- created|updated|submitted|manager_approved|...
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  meta TEXT,                               -- json
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reimb_event ON reimbursement_events(tenant_id, reimbursement_id, created_at);

CREATE TABLE IF NOT EXISTS reimbursement_counters (
  tenant_id TEXT NOT NULL,
  year TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, year)
);

-- ------------------------------------------- ACTION ITEMS: TEAM ASSIGNMENT
-- `action_items.owner_id` stays the one person accountable for the task - the
-- deadline ladder and every escalation target read it, and exactly one name
-- has to answer for a due date. This table holds the *rest* of the team when a
-- task is worked by several people, so the effective assignee list is
-- `owner_id` plus these rows. Deliberately additive: no existing task needs a
-- backfill, and the accountable person cannot drift out of step with itself.
--
-- Rows are hard-deleted like action_watchers: who was assigned when is already
-- in the audit trail, and a soft delete would fight the UNIQUE constraint when
-- somebody is taken off a task and put back on it.
CREATE TABLE IF NOT EXISTS action_assignees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (action_item_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_aassignee_user ON action_assignees(tenant_id, user_id);

-- ---------------------------------------------- ACTION ITEMS: DAILY UPDATES
-- One update per person per task per day, editable until the day is out. The
-- six fields are the standup answered in writing: what moved, what is moving,
-- what has not started, what is in the way, what happens next, and anything
-- else. `status_at_update` freezes the task status as it stood when the update
-- was written, so a progress history still reads correctly after the task has
-- since been closed.
CREATE TABLE IF NOT EXISTS action_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  update_date TEXT NOT NULL,               -- YYYY-MM-DD, the day being reported
  completed_today TEXT,
  in_progress TEXT,
  pending TEXT,
  blockers TEXT,
  next_action TEXT,
  remarks TEXT,
  progress_pct INTEGER,                    -- 0-100, the person's own estimate
  hours_spent REAL,
  status_at_update TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, action_item_id, user_id, update_date)
);
CREATE INDEX IF NOT EXISTS ix_aupdate_day ON action_updates(tenant_id, update_date);
CREATE INDEX IF NOT EXISTS ix_aupdate_user ON action_updates(tenant_id, user_id, update_date);
CREATE INDEX IF NOT EXISTS ix_aupdate_item ON action_updates(tenant_id, action_item_id, update_date);

-- ------------------------------------------------- ACTION ITEMS: VALIDATION
-- Done is what the assignee says; validated is what the person who raised the
-- task says. This table is the ledger of that second conversation: every
-- submission, approval, rejection and reopen, in order, with who and when.
--
-- Append-only on purpose - it is the answer to "why is this task still open in
-- November when it was marked done in September", and an editable history
-- cannot answer that. The current state lives in denormalised columns on
-- action_items (validation_status and friends) so the list can filter on it
-- without a correlated subquery per row.
CREATE TABLE IF NOT EXISTS action_validations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  -- submitted | validated | changes_requested | reopened | withdrawn
  event TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  note TEXT,
  -- Which round of work this event belongs to: 1 is the first submission, 2
  -- the resubmission after the first rejection, and so on.
  round INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_avalidation_item ON action_validations(tenant_id, action_item_id, created_at);

-- --------------------------------------------------- PROJECTS: OWNERSHIP
-- Who the project answers to. Separate from `project_members` on purpose: an
-- owner is oversight, not a delivery seat - they carry no allocation, and a
-- manager can be the project manager on the team *and* one of its owners.
-- Every live project keeps at least one; the API refuses to remove the last.
-- Only workspace Owners and Managers may hold it.
CREATE TABLE IF NOT EXISTS project_owners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  added_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_powner_once ON project_owners(project_id, user_id);
CREATE INDEX IF NOT EXISTS ix_powner_user ON project_owners(tenant_id, user_id);

-- ----------------------------------------------- PROJECTS: DAILY UPDATES
-- The project-level standup, filed by the manager and the lead and read by
-- the owners. One row per person per project per day, upserted, exactly like
-- action_updates one level down. `progress_pct` is the filer's own estimate;
-- the task-completion figure it is shown against is computed, never stored.
CREATE TABLE IF NOT EXISTS project_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  update_date TEXT NOT NULL,               -- YYYY-MM-DD, the day being reported
  seat TEXT,                               -- manager|lead at the time of filing
  todays_work TEXT,
  completed_today TEXT,
  tomorrow_plan TEXT,
  progress_pct INTEGER,                    -- 0-100, self-reported
  has_blocker INTEGER NOT NULL DEFAULT 0,
  blocker_type TEXT,                       -- technical|client|resource|dependency|other
  blocker_description TEXT,
  help_required TEXT,
  estimated_delay_days INTEGER,
  status TEXT NOT NULL DEFAULT 'on_track', -- on_track|at_risk|blocked
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, project_id, user_id, update_date)
);
CREATE INDEX IF NOT EXISTS ix_pupdate_day ON project_updates(tenant_id, update_date);
CREATE INDEX IF NOT EXISTS ix_pupdate_project ON project_updates(tenant_id, project_id, update_date);

-- ====================================================== MARKETING: LEADS
-- Marketing leads live in their own table, attached to a marketing project
-- (projects.kind = 'marketing'), separate from the CRM's sales pipeline. A
-- lead is entered once: the ⭐ Progressive view, "My leads", "Follow-up today"
-- and the rest are filters over these rows, never copies. A lead that is won
-- can be converted into a CRM client (converted_client_id); a lead that is
-- given up on is marked dead and recorded in dead_leads.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  company_name TEXT NOT NULL,
  contact_name TEXT,
  designation TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  location TEXT,
  industry TEXT,
  source TEXT,                             -- email|linkedin|website|referral|campaign|cold_call|event|other
  assigned_to TEXT REFERENCES users(id),
  -- new|contacted|interested|qualified|proposal|negotiation|won|dead
  status TEXT NOT NULL DEFAULT 'new',
  temperature TEXT NOT NULL DEFAULT 'cold', -- cold|warm|hot
  -- ⭐ is an attention flag that can sit on any open status, not a status.
  is_progressive INTEGER NOT NULL DEFAULT 0,
  progressive_priority TEXT,               -- critical|high|normal
  progressive_reasons TEXT NOT NULL DEFAULT '[]',
  progressive_note TEXT,
  progressive_since TEXT,
  expected_value_minor INTEGER NOT NULL DEFAULT 0,
  expected_close_date TEXT,
  next_action TEXT,
  next_followup_date TEXT,                 -- YYYY-MM-DD, workspace-local
  last_activity_at TEXT,
  last_outcome TEXT,                       -- latest daily-update outcome, feeds health
  owner_action_required INTEGER NOT NULL DEFAULT 0,
  owner_action_text TEXT,
  owner_action_due TEXT,
  owner_action_priority TEXT,
  owner_action_raised_by TEXT REFERENCES users(id),
  owner_action_raised_at TEXT,
  notes TEXT,
  converted_client_id TEXT REFERENCES clients(id),
  won_at TEXT,
  dead_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_leads_project ON leads(tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS ix_leads_assignee ON leads(tenant_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS ix_leads_followup ON leads(tenant_id, next_followup_date);

-- Every single thing that happens to a lead, in order: created, status moved,
-- reassigned, called, emailed, met, starred, unstarred, marked dead, revived.
-- Append-only - it is the lead's timeline and the source of every report.
CREATE TABLE IF NOT EXISTS lead_activities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  project_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  description TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lact_lead ON lead_activities(tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_lact_project ON lead_activities(tenant_id, project_id, created_at DESC);

-- The short daily update on a lead. One per person per lead per day, upserted.
CREATE TABLE IF NOT EXISTS lead_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  update_date TEXT NOT NULL,
  outcome TEXT NOT NULL,                   -- no_response|follow_up_done|interested|meeting_done|proposal_sent|negotiation|converted|other
  progress_note TEXT,
  next_action TEXT,
  next_followup_date TEXT,
  owner_action_required INTEGER NOT NULL DEFAULT 0,
  owner_action_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, lead_id, user_id, update_date)
);
CREATE INDEX IF NOT EXISTS ix_lupd_project ON lead_updates(tenant_id, project_id, update_date);

-- ⭐ added, removed, priority changed, converted, died. Never edited.
CREATE TABLE IF NOT EXISTS progressive_lead_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  action TEXT NOT NULL,                    -- enabled|disabled|priority_changed|converted|dead
  reason TEXT,
  priority TEXT,
  changed_by TEXT REFERENCES users(id),
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_plh_lead ON progressive_lead_history(tenant_id, lead_id, changed_at);

-- Leads given up on, with why. The lead row stays (status 'dead') so its
-- timeline survives; this is the register of deaths, with a snapshot of the
-- lead as it stood. Reviving a lead stamps revived_at rather than deleting.
CREATE TABLE IF NOT EXISTS dead_leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  project_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_note TEXT,
  status_at_death TEXT NOT NULL,
  was_progressive INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL DEFAULT '{}',
  marked_by TEXT REFERENCES users(id),
  marked_at TEXT NOT NULL,
  revived_at TEXT,
  revived_by TEXT REFERENCES users(id),
  revive_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_dead_project ON dead_leads(tenant_id, project_id, marked_at DESC);

-- ------------------------------------------------- TOMORROW'S TO-DO
-- The plan each person files for their next working day. One row per person
-- per target day (the unique key stops a second active plan). The schedule
-- clock creates the row itself when it has to record OVERDUE, so "who missed"
-- is a query over this table rather than an absence. `reporting_person_id` is
-- copied in when the plan is filed: reassigning someone's manager routes their
-- next plan to the new person without rewriting old ones.
CREATE TABLE IF NOT EXISTS todo_submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reporting_person_id TEXT REFERENCES users(id),
  todo_date TEXT NOT NULL,                 -- YYYY-MM-DD, the working day the plan is for
  plan_date TEXT NOT NULL,                 -- YYYY-MM-DD, the day it was due to be filed
  status TEXT NOT NULL DEFAULT 'DRAFT',    -- DRAFT|SUBMITTED|UNDER_REVIEW|APPROVED|CHANGES_REQUESTED|LATE|OVERDUE|MISSED
  deadline_at TEXT,                        -- UTC instant of the deadline it was held to
  submitted_at TEXT,
  minutes_late INTEGER,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, todo_date)
);
CREATE INDEX IF NOT EXISTS ix_todo_sub_day ON todo_submissions(tenant_id, todo_date, status);
CREATE INDEX IF NOT EXISTS ix_todo_sub_reviewer ON todo_submissions(tenant_id, reporting_person_id, todo_date);

-- The lines of a plan. Replaced as a set on every save: nothing else points at
-- a task row, and "the plan as it was submitted" is what the reviewer reads.
CREATE TABLE IF NOT EXISTS todo_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  submission_id TEXT NOT NULL REFERENCES todo_submissions(id),
  task TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  client_id TEXT REFERENCES client_accounts(id),
  priority TEXT NOT NULL DEFAULT 'medium', -- high|medium|low
  expected_time TEXT,                      -- HH:MM, workspace-local, on the planned day
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_todo_tasks_sub ON todo_tasks(submission_id, sort);

-- The conversation on a plan: comments, plus one row per review decision so
-- the employee sees why it was approved or sent back, in order.
CREATE TABLE IF NOT EXISTS todo_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  submission_id TEXT NOT NULL REFERENCES todo_submissions(id),
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'comment',    -- comment|submitted|approved|changes_requested
  body TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_todo_comments_sub ON todo_comments(submission_id, created_at);

-- Browser pop-ups: one row per browser a person has switched them on in. The
-- endpoint is the browser's own address for this site, so it is unique: when
-- someone else signs in on the same browser the row moves to them.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_push_user ON push_subscriptions(user_id);

-- Phones running the app: one Firebase token per install. The token names the
-- install, so whoever signed in on it last owns it; signing out removes it.
-- What each built-in role may do in this workspace, as the owner set it in
-- Settings > Roles: the whole module -> actions map for the role. No row means
-- the built-in template (middleware/rbac.js ROLE_TEMPLATES) applies.
CREATE TABLE IF NOT EXISTS role_access (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL,                       -- manager|employee|finance|hr
  permissions TEXT NOT NULL,                -- JSON { module: [actions] }
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, role)
);

CREATE TABLE IF NOT EXISTS native_push_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_native_push_user ON native_push_devices(user_id);

-- ---------------------------------------------------------------- CHAT DELIVERY
-- Live chat events, kept a day or two so every server instance can deliver
-- them. On a serverless host there is no single process to hold an in-memory
-- event bus, so clients ask for what happened after the last `seq` they saw.
CREATE TABLE IF NOT EXISTS chat_events (
  seq BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event TEXT NOT NULL,                     -- message | read
  payload TEXT NOT NULL,                   -- JSON, without member_ids
  member_ids TEXT,                         -- JSON array: who may receive it
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chat_events_tenant ON chat_events(tenant_id, seq);

-- ---------------------------------------------------------------- JOB SCHEDULE
-- When each background job last started. Kept in the database, not in memory,
-- because on a serverless host each cron call may land on a fresh instance;
-- it is also how two overlapping calls agree on which one runs a job.
CREATE TABLE IF NOT EXISTS job_schedule (
  job_key TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- FILE STORE
-- Generated PDFs and uploaded attachments. In the database rather than on disk
-- because a serverless host has no disk that outlives a request; access rules
-- stay in the routes that serve them (attachments / pdf_path lookups).
CREATE TABLE IF NOT EXISTS stored_files (
  path TEXT PRIMARY KEY,                   -- documents/... | attachments/<tenant_id>/...
  mime TEXT,
  size_bytes INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- AI MEETING INTELLIGENCE
-- A recording or transcript an Owner or Manager uploaded for analysis. Tasks
-- are only ever PROPOSED here (ai_meeting_items); each becomes a real action
-- item only when a reviewer approves it.
CREATE TABLE IF NOT EXISTS ai_meetings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  meeting_date TEXT,                       -- YYYY-MM-DD; relative deadlines resolve against it
  project_id TEXT REFERENCES projects(id),
  client_id TEXT REFERENCES clients(id),
  department TEXT,
  description TEXT,
  source_kind TEXT NOT NULL,               -- recording | transcript
  file_name TEXT,
  file_mime TEXT,
  file_size INTEGER,
  file_sha256 TEXT,                        -- duplicate-upload warning
  duration_seconds REAL,
  consent_by TEXT NOT NULL REFERENCES users(id),
  consent_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading', -- uploading|queued|transcribing|analyzing|review|completed|failed
  failed_stage TEXT,                       -- transcribing|extracting|analyzing
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,                        -- one worker at a time per meeting
  parts_expected INTEGER NOT NULL DEFAULT 1,
  transcript_json TEXT,                    -- [{i, start, end, speaker, text}] - the original, kept for verification
  summary_json TEXT,
  extras_json TEXT,                        -- unassigned / unclear deadlines / pending decisions / issues / follow-ups
  speakers_json TEXT,                      -- {label: user_id} set by the reviewer
  analysis_model TEXT,
  audio_purged_at TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_aim_tenant ON ai_meetings(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS ix_aim_status ON ai_meetings(status, lease_until);
CREATE INDEX IF NOT EXISTS ix_aim_hash ON ai_meetings(tenant_id, file_sha256);

-- The uploaded bytes, in parts (an audio recording is split into ~10-minute
-- pieces in the browser; a transcript document is one part). The bytes live
-- in stored_files and are deleted once transcribed.
CREATE TABLE IF NOT EXISTS ai_meeting_parts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meeting_id TEXT NOT NULL REFERENCES ai_meetings(id),
  part_index INTEGER NOT NULL,
  offset_seconds REAL NOT NULL DEFAULT 0,
  mime TEXT NOT NULL,
  size_expected INTEGER NOT NULL,
  size_received INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  segments_json TEXT,                      -- this part's transcript, offsets applied
  transcribed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (meeting_id, part_index)
);

-- One proposed task. Never an action item until approved.
CREATE TABLE IF NOT EXISTS ai_meeting_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meeting_id TEXT NOT NULL REFERENCES ai_meetings(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  assignee_name TEXT,                      -- as spoken; never trusted on its own
  assignee_speaker TEXT,                   -- "I'll do it" from a speaker label
  assignee_user_id TEXT REFERENCES users(id),
  assignee_status TEXT NOT NULL,           -- matched|ambiguous|not_found|unassigned|out_of_scope|speaker_unmapped
  candidates_json TEXT,                    -- the people an ambiguous name could mean
  assigned_by_name TEXT,
  acceptance TEXT NOT NULL DEFAULT 'unclear', -- accepted|not_confirmed|declined|unclear
  deadline_text TEXT,                      -- as said ("by Friday")
  due_date TEXT,
  due_time TEXT,
  deadline_status TEXT NOT NULL,           -- none|resolved|ambiguous|needs_meeting_date
  priority TEXT,
  related_text TEXT,
  project_id TEXT REFERENCES projects(id),
  client_id TEXT REFERENCES clients(id),
  evidence_json TEXT,                      -- {segments:[i...], quote}
  start_seconds REAL,
  confidence TEXT NOT NULL DEFAULT 'medium', -- high|medium|low
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|approving|approved|rejected|cancelled_in_meeting
  reviewer_edited INTEGER NOT NULL DEFAULT 0,
  action_item_id TEXT REFERENCES action_items(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aimi_meeting ON ai_meeting_items(meeting_id, idx);
CREATE INDEX IF NOT EXISTS ix_aimi_status ON ai_meeting_items(tenant_id, status);

-- The shared office calendar: events anyone in the workspace can add and edit
-- (outings, trainings, deadlines, celebrations). Dates and times are
-- workspace-local wall clock, like holidays.
CREATE TABLE IF NOT EXISTS office_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  category TEXT NOT NULL DEFAULT 'event',  -- event|deadline|training|celebration|reminder|other
  all_day INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,                -- YYYY-MM-DD
  end_date TEXT NOT NULL,                  -- YYYY-MM-DD, same as start for one day
  start_time TEXT,                         -- HH:MM when not all day
  end_time TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_office_events_range ON office_events(tenant_id, start_date, end_date);

-- A follow-up meeting the AI found in a transcript. With a date it is booked
-- straight onto the calendar (meeting_id); without one it waits here as a
-- suggestion. One row per follow-up; a re-analysis never books twice.
CREATE TABLE IF NOT EXISTS ai_meeting_followups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  ai_meeting_id TEXT NOT NULL REFERENCES ai_meetings(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT,
  when_text TEXT,                          -- as said ("next Tuesday at 3")
  date TEXT,                               -- YYYY-MM-DD, workspace calendar
  time TEXT,                               -- HH:MM
  time_assumed INTEGER NOT NULL DEFAULT 0, -- a date was said but no time
  duration_minutes INTEGER,
  invitee_ids TEXT,                        -- JSON user ids
  evidence_json TEXT,
  confidence TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL,                    -- scheduled|needs_date|in_past|cancelled_in_meeting|not_scheduled
  reason TEXT,                             -- why it was not booked
  meeting_id TEXT REFERENCES meetings(id), -- the calendar meeting it became
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aimf_meeting ON ai_meeting_followups(ai_meeting_id, idx);

-- The last line of defence against a double approval: one proposed meeting
-- task can become at most one action item, whatever races ahead of this.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_meeting_task
  ON action_items(tenant_id, source_id) WHERE source_type = 'meeting_ai';

-- ---------------------------------------------------------------- AI MEETINGS: LIVE ROOMS
-- Consent given at the pre-join screen of a meeting that allows recording or
-- transcription. One row per person per join, kept as the record.
CREATE TABLE IF NOT EXISTS meeting_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  recording INTEGER NOT NULL DEFAULT 0,      -- agreed to be recorded
  transcription INTEGER NOT NULL DEFAULT 0,  -- agreed to be transcribed
  ip TEXT,
  user_agent TEXT,
  given_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mconsent ON meeting_consents(meeting_id, user_id);

-- Who was actually in the room and for how long, from LiveKit's signed
-- webhooks. One row per connection (a reconnect is a new connection).
CREATE TABLE IF NOT EXISTS meeting_participation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  user_id TEXT REFERENCES users(id),
  participant_sid TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  UNIQUE (meeting_id, participant_sid)
);
CREATE INDEX IF NOT EXISTS ix_mpart_user ON meeting_participation(meeting_id, user_id);

-- Files LiveKit Egress wrote to object storage for a live meeting: the video
-- recording (kind 'video') and one audio file per microphone track (kind
-- 'audio_track', for a transcript where every line has a known speaker).
-- Audio files are deleted once transcribed; videos stay until someone deletes them.
CREATE TABLE IF NOT EXISTS meeting_recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  kind TEXT NOT NULL,                        -- video | audio_track
  egress_id TEXT,
  track_sid TEXT,
  participant_identity TEXT,
  user_id TEXT REFERENCES users(id),
  speaker_name TEXT,
  s3_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting',   -- starting | active | complete | failed
  error TEXT,
  file_started_at TEXT,
  file_ended_at TEXT,
  duration_seconds REAL,
  size_bytes INTEGER,
  started_by TEXT REFERENCES users(id),
  purged_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mrec_meeting ON meeting_recordings(meeting_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mrec_egress ON meeting_recordings(egress_id) WHERE egress_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mrec_track ON meeting_recordings(meeting_id, track_sid) WHERE track_sid IS NOT NULL;

-- ------------------------------------------------------------ TASK REQUESTS
-- A task someone asks to take on themselves. Employees do not assign work, so
-- a task for their own list goes to their reporting manager, and to the lead
-- and manager of the project it is for, and the first of them to decide wins.
-- Approval creates an ordinary action item owned by the requester and raised
-- by the approver, who then signs off the finished work. `approver_ids` is the
-- list as it stood when the request was made, so a later org change does not
-- move a request already waiting on someone.
CREATE TABLE IF NOT EXISTS task_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requester_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  project_id TEXT REFERENCES projects(id),
  priority TEXT NOT NULL DEFAULT 'medium',  -- low|medium|high|urgent
  due_date TEXT,
  due_time TEXT,
  approver_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of user ids
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|withdrawn
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  action_item_id TEXT REFERENCES action_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_taskreq_requester ON task_requests(tenant_id, requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_taskreq_status ON task_requests(tenant_id, status, created_at DESC);

-- AI company profile of a client, read from its website (services/companyProfile.js).
-- One per client; changing the website re-queues it. The two-page PDF is in stored_files.
CREATE TABLE IF NOT EXISTS client_website_profiles (
  client_account_id TEXT PRIMARY KEY REFERENCES client_accounts(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  website TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued|analyzing|ready|failed
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  profile TEXT,                             -- JSON from the AI
  pdf_path TEXT,
  model TEXT,
  requested_by TEXT REFERENCES users(id),
  generated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cwp_status ON client_website_profiles(status, updated_at);

-- Documents kept for a client or a project (routes/resources.routes.js): one of
-- client_account_id / project_id is set. Bytes are in stored_files under
-- resources/<tenant>/, served only through the resources routes.
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  client_account_id TEXT REFERENCES client_accounts(id),
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',  -- contract|brief|brand|design|report|invoice|other
  notes TEXT,
  filename TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_resources_client ON resources(tenant_id, client_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_resources_project ON resources(tenant_id, project_id, created_at DESC);
