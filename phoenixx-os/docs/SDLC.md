# Software development lifecycle

How a change to Phoenixx OS goes from an idea to something running at
`app.phoenixxedu.com` and on a phone. Written to be followed, not admired — so
where the current process has a gap, the gap is stated rather than papered over.

Companion documents: [`WORKFLOWS.md`](WORKFLOWS.md) (what the software does),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (how it is built),
[`DEPLOY.md`](DEPLOY.md) (hosting), [`PRD-COVERAGE.md`](PRD-COVERAGE.md)
(traceability back to the requirements).

---

## 1. Repository layout

One repository, three deployable things.

```
task-management/                  ← repo root (forwarding scripts only)
├── render.yaml                   ← must stay at the root; Render looks nowhere else
├── .github/workflows/mobile.yml  ← Android + iOS build
├── phoenixx-os-requirements.md   ← the PRD; the source of truth for scope
├── phoenixx-os/                  ← the product
│   ├── server/   Node + Express API, SQLite, job runner, tests
│   ├── web/      React + TypeScript + Tailwind (the whole UI)
│   ├── mobile/   React Native (Expo) — the six highest-frequency actions
│   └── docs/     these documents
└── phoenixx-os-mobile/           ← Capacitor shell wrapping phoenixx-os/web
```

The root `package.json` is a container: every script forwards into
`phoenixx-os/` so `npm run dev` works from either directory. `phoenixx-os/`
is an npm workspace over `server` and `web`, which is why one `npm install`
at that level is enough.

**The web app is built once and shipped twice** — served by the API in
production (`SERVE_WEB=true`) and bundled into the Capacitor shell for the
stores. A UI change therefore has two release paths, and they are not on the
same cadence (§8).

---

## 2. Environments

| | Where | Data | Notes |
|---|---|---|---|
| **Local** | `localhost:4010` API, `localhost:5173` web | Seeded SQLite file | Vite proxies `/api` to the API |
| **CI** | GitHub-hosted runners | None | Builds mobile artifacts only today (§6) |
| **Production** | Render → `app.phoenixxedu.com` | SQLite, snapshotted to Supabase Storage | Free tier, single instance |

There is **no staging environment.** With one production instance and no
disk, the honest way to describe the current model is: verify locally, deploy
to production, watch. Section 9 covers what to do when that goes wrong.

> **Port note.** 4000 and 5173 may already be taken by another project on this
> machine. The API defaults to 4010; override with `PORT`, and let Vite pick its
> own port if 5173 is busy.

---

## 3. The change loop

```
PRD / request
     │
     ▼
 branch from main
     │
     ▼
 change server ─┬─► add or update tests ─► npm test
                │
 change web ────┴─► npm run typecheck ──► verify in the running app
     │
     ▼
 commit ──► push ──► merge to main ──► Render auto-deploys
                                   └──► mobile workflow builds artifacts
```

**Before writing code**, find the requirement. `phoenixx-os-requirements.md` is
the source of truth for scope and `PRD-COVERAGE.md` maps every requirement to
where it was built. A change that is not in either is a scope change — record it
in `PRD-COVERAGE.md` in the same commit, including a deliberate deviation.

**Where code goes.** The layering is load-bearing and worth preserving:

| Layer | Rule |
|---|---|
| `routes/*.routes.js` | HTTP shape only — validate with zod, call a service, return |
| `services/*.js` | Business rules. Anything a test should assert lives here |
| `db/index.js` | Every query goes through the repository layer, which injects `tenant_id` |
| `middleware/` | Auth, RBAC, idempotency, audit — cross-cutting, never per-route |
| `web/src/pages` | One page per route; data through React Query, never bare `fetch` |

Two rules that exist because breaking them caused real bugs:

- **Never hand-write `tenant_id = ?` in a route.** The repository layer does it.
  A route that does its own scoping is a tenant-isolation leak waiting to happen.
- **Never schedule a reminder outside the deadline engine.** Register the date
  with `upsertDeadline` — see [`WORKFLOWS.md`](WORKFLOWS.md) §3.

**Schema changes.** The schema lives in one file, `server/src/db/schema.sql`
(71 tables). There is no migration runner: schema changes are applied by editing
that file and re-seeding (`npm run reset`). That is fine while production data is
demo data and is **the first thing that has to change before real client data
lands** — see §10.

---

## 4. Branching and commits

- `main` is the deploy branch. Render auto-deploys every push to it.
- Work on a branch off `main`; merge when tests pass and the change has been
  seen working.
- `mobile-capacitor` also triggers the mobile build workflow, for iterating on
  the native shell without touching `main`.

Commit messages should say what changed and why. The current history is not a
good model for this — `test`, `test2`, `comit1` are real commits on `main` and
tell a future reader nothing. Prefer the older entries in the same history:
*"Fix the seeder crashing every cold start on an empty database"* is the standard.

Never commit: `.env`, real secrets, `node_modules`, build output, the SQLite
file, or signing keystores. `render.yaml` uses `generateValue` and `sync: false`
for exactly this reason — production secrets are set in the Render dashboard and
never in the repository.

---

## 5. Testing

```bash
npm test          # from phoenixx-os/ — 244 tests, 55 suites, ~20s
```

Node's built-in test runner, no framework. Each suite builds its own SQLite
database and runs with the job runner disabled, so tests are independent and
order does not matter.

| Suite | Covers |
|---|---|
| `api.test.js` | Auth, RBAC, tenant isolation, idempotency, audit trail, mobile sync |
| `invoicing.test.js`, `numbering.test.js`, `gst.test.js` | Money: totals, CGST/SGST split, sequence integrity |
| `scoring.test.js`, `clients.test.js`, `pipeline.test.js` | Client scores and the CRM lifecycle |
| `billing.test.js` | Subscription plans and gateway wiring |
| `chat.test.js`, `projectTeams.test.js`, `recovery.test.js` | SSE chat, project membership, password recovery |
| `snapshot.test.js` | Slot alternation, corrupt-slot fallback, failed-upload safety |

**What to test.** The PRD asks for ≥70% line coverage on scoring, invoicing and
billing logic; those sit at 100/100/100/94%. The rule that keeps it there: a
business rule belongs in a service, and a service change ships with a test. The
uncovered billing lines are the live Razorpay and Stripe HTTP calls, which need
real gateway credentials.

**Front end.** There are no automated front-end tests. The gate is
`npm --workspace web run typecheck` plus running the app. Note that
`npm run build` uses `tsc -b --noCheck` — **the production build does not type
check**, so a type error will build and deploy cleanly. `typecheck` is the real
gate and must be run deliberately.

**Manual verification.** For anything touching a workflow in
[`WORKFLOWS.md`](WORKFLOWS.md), run it: `npm run seed`, sign in as the affected
role, and force the relevant job from the admin console rather than waiting for
its schedule. The PRD-coverage document's "Verified by running it" list is the
standing regression script for a release.

---

## 6. Continuous integration

`.github/workflows/mobile.yml` runs on pushes to `main` and `mobile-capacitor`
(when `phoenixx-os/web/**` or `phoenixx-os-mobile/**` changed), on PRs to `main`,
and on demand.

- **Android** — Ubuntu runner, JDK 17. Builds a debug APK; with the four
  `ANDROID_KEYSTORE_*` secrets present, builds a signed `.aab` and `.apk`
  instead. Signing material is deleted with `if: always()` so it never lingers
  on the runner.
- **iOS** — macOS runner, unsigned archive. This is a compile check that every
  Capacitor plugin resolves through SPM. It proves the project builds; it cannot
  produce an installable app without an Apple Developer membership, a
  distribution certificate and a provisioning profile.
- `VITE_API_URL` is **baked into the bundle at build time** and defaults to
  `https://app.phoenixxedu.com`. It cannot be changed after the build — pointing
  an app at a different API means rebuilding.

**The gap: CI does not run `npm test`.** The 244 tests are a local gate only,
and nothing stops a red build reaching `main` or production. Adding a job that
runs `npm ci && npm test` on every PR is the single highest-value change to this
pipeline, and is cheap — the suite is 20 seconds. Until it exists, running the
tests before merging is a human responsibility.

---

## 7. Releasing the web app

Merging to `main` is the release. Render then:

1. `npm ci --include=dev && npm run build` in `phoenixx-os/`
   (`--include=dev` because `NODE_ENV=production` would otherwise omit
   typescript, vite and tailwind, which the build needs)
2. `npm start` — one Node process serving the API, the built web app, the SSE
   chat stream, the job runner and generated PDFs
3. Health check at `/api/v1/health`

**Constraints that come with the current hosting**, all detailed in
`DEPLOY.md` and commented in `render.yaml`:

- **One instance, and it must stay one.** The SQLite file, the SSE fan-out and
  the job runner are all in-process. Two instances would overwrite each other's
  snapshots and double-run every scheduled job.
- **The free tier sleeps after ~15 minutes idle** and destroys the container
  filesystem with it. Data survives because the database is snapshotted to
  Supabase Storage every 5 minutes and on `SIGTERM`, and restored on boot. A
  kill without `SIGTERM` loses up to `SNAPSHOT_INTERVAL_MINUTES` of writes.
- **Production refuses to start with the development JWT secrets.** That is
  deliberate.

Post-deploy check, in order: health endpoint responds → sign in → the screen you
changed → `job_runs` has recent rows.

---

## 8. Releasing the mobile apps

Different cadence from the web, and the difference matters: a web fix is live on
merge, the same fix in an installed app needs a store release.

```
web change ──► merge to main ──► CI builds APK/AAB/archive ──► download artifact
                                                                     │
                                                          sideload  ─┴─ store submission
```

1. Merge the change (the shell wraps `phoenixx-os/web`, so most mobile changes
   are web changes).
2. The workflow builds; artifacts hang off the run's summary page for 30 days.
3. Locally, `npm run mobile:sync` rebuilds the web bundle and syncs it into the
   native projects; `mobile:android` / `mobile:ios` open them in Android Studio
   and Xcode.
4. For a store build, add the signing secrets and submit the `.aab`.

Version the shell in `phoenixx-os-mobile` and keep the built artifact's name
tied to it — `PhoenixxOS-v3.2-debug.apk` in that directory is the current
sideloadable build.

---

## 9. When a release goes wrong

- **Roll back** by reverting the commit on `main` and letting Render redeploy.
  There is no blue/green and no instant rollback button on the free plan.
- **A revert does not undo a schema change.** Because schema changes are applied
  by editing `schema.sql`, reverting the code can leave a database whose shape no
  longer matches it. Treat schema changes as one-way until §10 is done.
- **The database** is recoverable from the most recent Supabase snapshot, minus
  up to 5 minutes of writes. The snapshot service alternates two slots so a bad
  write cannot clobber the good copy, and falls back to the older slot if the
  newest is not a valid SQLite file.
- **Silent failures** — a workflow that stopped without an error — are covered by
  the table at the end of [`WORKFLOWS.md`](WORKFLOWS.md).

---

## 10. Known process gaps

Not a wishlist; these are the things that will hurt, roughly in the order they
will hurt.

| Gap | Consequence | Fix |
|---|---|---|
| **CI does not run the tests** | A red build can reach production | Add `npm ci && npm test` to a PR workflow (~20s) |
| **No migration runner** | Schema changes need a re-seed; not viable once real client data exists | A numbered-migration table before the first real tenant |
| **`build` uses `--noCheck`** | Type errors deploy cleanly | Run `typecheck` in CI, or drop `--noCheck` |
| **No staging environment** | Production is where changes are first seen live | A second Render free service off a `staging` branch |
| **No error tracking or uptime alerting** | Failures are noticed by users first | Structured logs already exist; ship them somewhere |
| **Single instance, in-process everything** | No horizontal scale, no zero-downtime deploy | Postgres + BullMQ + object storage — the migration path for each is in `ARCHITECTURE.md` §12 |
| **No linter or formatter** | Style drifts between files | ESLint + Prettier, one config at `phoenixx-os/` |

---

## 11. Definition of done

A change is done when all of these are true:

- [ ] The requirement it serves is identified, and `PRD-COVERAGE.md` reflects
      the change if scope moved
- [ ] Business rules live in a service, not a route
- [ ] `npm test` passes; new business logic ships with a test
- [ ] `npm --workspace web run typecheck` is clean
- [ ] The affected screen or workflow was run, not just compiled
- [ ] Anything with a date registers with the deadline engine
- [ ] No new secret, `.env`, or generated artifact is committed
- [ ] If behaviour changed, the relevant document here changed with it
