# TeamBridge on AWS (Sydney, ap-southeast-2)

Everything runs in your AWS account:

| Part | What | Roughly per month* |
|---|---|---|
| App server | EC2 `t4g.micro`, 1 GB + 2 GB swap (Node app + web pages, HTTPS by Caddy) | ~$6 |
| Database | RDS PostgreSQL 17 `db.t4g.micro`, 20 GB, encrypted, daily backups kept 1 day (the Free plan limit; set DbBackupDays=7 after upgrading) | ~$15 |
| Fixed address | Elastic IP (public IPv4) | ~$4 |
| Storage | S3: recordings (private) + release bundles | a few cents to a few dollars |
| Secrets | Secrets Manager (5 secrets) | ~$2 |
| **Total** | | **~$27** |

\*Roughly, at on-demand Sydney prices (a few dollars a month above Mumbai; this account only allows Sydney). On the AWS Free plan this comes out of your credit
($100 lasts about 3.5 months); nothing is charged to your card on that plan.
A budget alert emails you when spending is forecast to pass your monthly limit
(default $10; it fires early while on credit, which is intended - it tells you
how fast the credit is going). If the team grows and pages slow down, deploy
with a `t4g.small` server (+~$6/month).
LiveKit (video), Gemini and Anthropic remain the outside services they are today.

Nothing has an open SSH port: the scripts reach the server through AWS Systems Manager.
The database password is generated and kept by AWS and is never shown to anyone.

## One-time preparation (you)

1. Install the AWS CLI, then open a new terminal:
   ```
   winget install -e --id Amazon.AWSCLI
   ```
2. In the AWS console: IAM - Users - Create user (e.g. `teambridge-admin`) - attach
   `AdministratorAccess` - open the user - Security credentials - Create access key
   (Command Line Interface). Then:
   ```
   aws configure
   ```
   Enter that key, region `ap-south-1`, output `json`.
3. Choose the subdomain (e.g. `app.yourcompany.com`).
4. Copy `server/team.example.json` to `team.json` in the phoenixx-os folder and fill in
   your workspace, owner and users (it is git-ignored).

## Go live (from the phoenixx-os folder, in PowerShell)

```powershell
.\infra\aws\deploy.ps1 -Domain app.yourcompany.com -BudgetEmail you@yourcompany.com   # creates everything (~15 min first time)
.\infra\aws\set-secrets.ps1                            # copies LiveKit/Gemini/Anthropic keys from server\.env
.\infra\aws\setup-team.ps1 -TeamFile .\team.json       # your workspace and users; prints each person's link
```

Then:
- DNS: add an **A record** for your subdomain pointing at the `PublicIp` the deploy prints.
  HTTPS turns on by itself within a minute or two of the record resolving.
- LiveKit Cloud - Settings - Webhooks: `https://<your subdomain>/api/v1/livekit/webhook`.
- Send each person their one-time link from the setup output.

## Every release afterwards

```powershell
.\infra\aws\deploy.ps1 -Domain app.yourcompany.com -AppOnly
```

The server keeps the last five releases.

## Good to know

- The database has deletion protection and is snapshotted if the stack is ever deleted;
  the recordings bucket is kept too.
- Stopping Vercel/Neon is up to you once the AWS site works.
