# Phoenixx OS — mobile

React Native (Expo) client over the same `/api/v1` contract the web app uses.

## Scope

The app is deliberately narrow. The PRD asks for the six highest-frequency actions
on a phone, and that is what it does:

| Action | Tab |
|---|---|
| Attendance check-in / out (geo-tagged when allowed) | Today |
| Condensed traction dashboard (H5) | Today |
| Quick-add an action item | Work |
| Log a follow-up with its next action | Follow-ups |
| Approve leave and attendance regularizations | Approvals |
| Read alerts from the deadline engine | Alerts |

Everything else — invoicing, reporting, SOP authoring, settings — stays in the web
app. A phone is not where anyone wants to build an invoice.

## Running it

```bash
npm install
npm start
```

Then press `a` for Android or `i` for iOS, or scan the QR code with Expo Go.

The API URL is `expo.extra.apiBaseUrl` in `app.json`. It defaults to
`http://10.0.2.2:4010`, which is how the Android emulator reaches the host
machine. Adjust it for your setup:

| Target | Value |
|---|---|
| Android emulator | `http://10.0.2.2:4010` |
| iOS simulator | `http://localhost:4010` |
| Physical device | `http://<your-lan-ip>:4010` |

Sign in with any seeded account, e.g. `priya@phoenixxit.com` / `Phoenixx@2026`.
Which tabs appear depends on the role — approvals only show for managers and HR.

## Offline behaviour (AR5)

Writes go through `writeOrQueue()`. It calls the API first; on a **network**
failure it saves the operation to a local outbox with a device-generated id. A
validation or permission failure is a real answer and is surfaced immediately
rather than queued.

`POST /sync/queue` replays the outbox. The device id makes a retried flush
idempotent — the same operation can never apply twice.

Conflicts are last-write-wins **and reported**. If an offline edit overwrites a
newer server version, the response says so and the app tells the user. Silently
discarding someone's work is worse than an awkward message.

A banner shows the pending count on every screen, with a "sync now" action, and
signing out with unsynced changes asks first.

## Status

The code is complete and typed, and it consumes endpoints that are covered by the
API test suite. **It has not been run on a simulator or device** — there is no
Android or iOS toolchain in the environment where it was written. Expect the
usual first-run friction of an unrun Expo app (dependency version alignment via
`npx expo install --fix`, and icon assets to add).

## Structure

```
mobile/
├── App.tsx              Tab navigation, role-aware
└── src/
    ├── api.ts           API client, token refresh, offline outbox
    ├── auth.tsx         Session context and queue state
    ├── theme.ts         The web app's tokens, light and dark
    ├── components.tsx   Card, Button, Badge, Stat, EmptyState, banners
    └── screens/         One per tab, plus login
```
