<#
  Copies your service keys (LiveKit, Gemini, Anthropic, OpenAI, email, WhatsApp,
  push) from server/.env into AWS Secrets Manager, then restarts the app so it
  picks them up. The keys go straight from your machine to your AWS account.

    .\infra\aws\set-secrets.ps1                    # reads server\.env
    .\infra\aws\set-secrets.ps1 -EnvFile path\to\production.env

  Database, login (JWT) and recording-storage settings are not copied: AWS
  creates and keeps those itself.
#>
param(
  [string]$EnvFile = "$PSScriptRoot\..\..\server\.env",
  [string]$Stack = 'teambridge',
  [string]$Region = 'ap-southeast-2'   # this AWS account only allows Sydney
)
. "$PSScriptRoot\common.ps1"
Assert-Aws
if (-not (Test-Path $EnvFile)) { throw "No env file at $EnvFile" }

$skip = '^(DATABASE_URL|PG_SCHEMA|PGLITE_DIR|JWT_.*|RECORDING_S3_.*|PORT|NODE_ENV|SERVE_WEB|WEB_DIST|WEB_BASE_URL|API_BASE_URL|SEED_ON_BOOT|TEST_.*)$'
$keys = [ordered]@{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { continue }
  $name = $Matches[1]; $value = $Matches[2].Trim()
  if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
  if ($name -match $skip -or -not $value) { continue }
  $keys[$name] = $value
}
if (-not $keys.Count) { throw 'No service keys found in the env file.' }
if ($keys['LIVEKIT_URL'] -and $keys['LIVEKIT_URL'] -notmatch '^wss://') { Write-Warning "LIVEKIT_URL is '$($keys['LIVEKIT_URL'])' - production needs your LiveKit Cloud wss:// address." }

# Merge into what is already stored, so a small file (say, only the email
# settings) adds to the keys instead of wiping the others.
$merged = [ordered]@{}
$current = aws secretsmanager get-secret-value --region $Region --secret-id teambridge/integrations --query SecretString --output text 2>$null
if ($LASTEXITCODE -eq 0 -and $current -and $current -ne 'None') {
  ($current | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $merged[$_.Name] = $_.Value }
}
foreach ($k in $keys.Keys) { $merged[$k] = $keys[$k] }

$tmp = New-TemporaryFile
try {
  # UTF-8 without a byte-order mark (Set-Content -Encoding utf8 adds one in Windows PowerShell).
  [IO.File]::WriteAllText($tmp, ($merged | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  aws secretsmanager put-secret-value --region $Region --secret-id teambridge/integrations --secret-string "file://$tmp" --output text --query Name | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Saving the secret failed' }
} finally { Remove-Item $tmp -Force }
Write-Host "Saved $($keys.Count) keys: $($keys.Keys -join ', ') ($($merged.Count) stored in total)" -ForegroundColor Green

$out = Get-StackOutputs $Stack $Region
Invoke-OnServer $out.InstanceId $Region @('if [ -e /opt/teambridge/current ]; then systemctl restart teambridge && sleep 4 && systemctl is-active teambridge; else echo "no release yet - the keys load on the first deploy"; fi') 120
