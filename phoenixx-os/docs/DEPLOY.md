# Deploying Phoenixx OS to Vercel

On Vercel the product is three things:

| Piece | What serves it |
|---|---|
| The React web app | Vercel's CDN, built from `web/` into `web/dist` |
| The API (`/api/*`) | One serverless function, [`api/index.mjs`](../api/index.mjs), running the same Express app as `npm start` |
| Data, uploaded files, generated PDFs | PostgreSQL (Neon or Supabase) |

Same origin for the web app and the API, so there is no CORS to configure.
Everything is wired in [`vercel.json`](../vercel.json).

---

## 1. Create the database

Either works; both have free tiers.

- **Neon** — neon.tech → New project (region: Singapore / `ap-southeast-1` is
  closest to India) → copy the **pooled** connection string (its host contains
  `-pooler`).
- **Supabase** — New project → Project Settings → Database → Connection string →
  **Transaction pooler** (port `6543`).

Use the pooled string: every serverless instance opens its own connections, and
the pooler is what keeps that within the database's limit.

The schema is created automatically on the first request. To start with the
demo workspace instead of an empty database, seed it once from your machine:

```bash
cd phoenixx-os/server
DATABASE_URL="postgres://..." npm run seed
```

(PowerShell: `$env:DATABASE_URL="postgres://..."; npm run seed`.)

## 2. Create the Vercel project

1. Push the repo to GitHub.
2. Vercel → **Add New → Project** → import the repo.
3. **Root Directory: `phoenixx-os`** — this matters; the repo root is only a
   container folder.
4. Framework preset: **Other**. Leave build/install/output settings alone;
   `vercel.json` sets them.
5. Add the environment variables below, then **Deploy**.

| Variable | Value |
|---|---|
| `DATABASE_URL` | The pooled connection string from step 1 |
| `JWT_ACCESS_SECRET` | 32+ random characters. The API refuses to start without it |
| `JWT_REFRESH_SECRET` | 32+ different random characters |
| `CRON_SECRET` | 32+ random characters; protects the background-jobs endpoint |
| `WEB_BASE_URL` | Optional until a custom domain is attached; defaults to the project's production `*.vercel.app` address. Invite and proposal links are built from it |
| `API_BASE_URL` | Same value as `WEB_BASE_URL` |
| `ANTHROPIC_API_KEY` | Optional. AI reading of commands in the AI Task Assistant (falls back to the built-in parser), required for AI Meeting Intelligence analysis, and for the AI company profile made from a client's website (`COMPANY_PROFILE_MODEL` overrides the model) |
| `OPENAI_API_KEY` | Optional. Speech-to-text for meeting recordings in AI Meeting Intelligence; without it only transcript files can be uploaded |
| `GEMINI_API_KEY`, `TRANSCRIBE_PROVIDER=gemini` | Optional. Google Gemini for speech-to-text instead of OpenAI. Use a billing-enabled key: free-tier data may be used by Google |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Optional. Live video for AI Meetings (LiveKit Cloud project → Settings → Keys). Without them meetings can be scheduled but not joined |
| `RECORDING_S3_BUCKET`, `RECORDING_S3_REGION`, `RECORDING_S3_ACCESS_KEY_ID`, `RECORDING_S3_SECRET_ACCESS_KEY` | Optional. Where AI Meeting recordings go (see below). Without them meetings run without recording |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional, for browser pop-ups (`npx web-push generate-vapid-keys`) |
| `WHATSAPP_*`, `SMTP_*`, `EMAIL_PROVIDER` … | Optional, as in [`.env.example`](../.env.example) |

Generate a secret:

```bash
node -e "console.log(crypto.randomBytes(32).toString('hex'))"
```

## 3. Background jobs (Hobby plan)

Deadline alerts, reminders, digests and recurring invoices run from
`/api/v1/cron/tick`. Each call runs whatever is due and records it in the
database, so calling it often is safe — a job never runs twice.

The Hobby plan only allows Vercel Cron once a day (`vercel.json` registers one
daily call as a safety net). For the jobs to run on time, point a free external
scheduler at it every 5 minutes, e.g. **cron-job.org**:

- URL: `https://<your-app>.vercel.app/api/v1/cron/tick`
- Method: GET
- Header: `Authorization: Bearer <CRON_SECRET>`
- Schedule: every 5 minutes

On the Pro plan, replace both with a Vercel Cron entry of `*/5 * * * *`.

### LiveKit webhook

In LiveKit Cloud → Settings → Webhooks, add `https://<your-app>.vercel.app/api/v1/livekit/webhook`
and choose the same API key as `LIVEKIT_API_KEY`. The server verifies the
signature; unsigned calls get 401. The webhook marks meetings live and ended
and records who attended and for how long.

### Recording storage (AWS S3)

1. Create a bucket in the region closest to your LiveKit Cloud project. Leave
   **Block all public access** on.
2. Create an IAM user for it with only this policy (replace the bucket name):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
       "Resource": "arn:aws:s3:::YOUR-BUCKET/meetings/*"
     }]
   }
   ```
3. Create an access key for that user and set the four `RECORDING_S3_*` variables.
4. To play recordings in the browser, add a CORS rule on the bucket allowing
   `GET` from your app's address.

The keys are sent to LiveKit with each recording request, because LiveKit's
recorder uploads the files itself. Recording also needs `GEMINI_API_KEY` or `OPENAI_API_KEY` for
transcripts and `ANTHROPIC_API_KEY` for the summary and proposed tasks.

## 4. Check it

- `https://<your-app>.vercel.app/api/v1/health` → `{"status":"ok"}`
- Sign in (with the demo seed: `arun@phoenixxit.com` / `Phoenixx@2026`).
- Call the cron URL with the header once and expect `{"data":{"ran":[...]}}`.

---

## Things that behave differently on serverless

- **Chat** is near-live rather than instant: an open tab checks for new
  messages every 15 seconds (and immediately when you switch back to it), and
  stops checking while hidden. Sending a message shows it straight away.
- **Uploads are limited to about 3 MB per file.** Vercel caps a request body
  at 4.5 MB and files are sent base64-encoded.
- **Cold starts.** After a quiet spell the first request takes a second or two
  longer while a function instance starts.
- **Rate limiting** is per function instance, so it is looser than on a single
  server.

## Mobile builds

Set `VITE_API_URL` in `phoenixx-os-mobile/.env` to the Vercel address (or the
custom domain once attached) and rebuild. Installed builds keep talking to
whatever address they were built with.

## Custom domain

Vercel → Project → Settings → Domains → add the domain and create the DNS record
it shows. Then set `WEB_BASE_URL` and `API_BASE_URL` to it and redeploy.

## Running it anywhere else

`npm start` (or the [`Dockerfile`](../Dockerfile)) still runs the whole product
as one long-lived process with the in-process job timer. Give it the same
`DATABASE_URL`.
