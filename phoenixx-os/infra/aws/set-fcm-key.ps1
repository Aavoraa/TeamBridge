<#
  Turns on phone notifications on the live server: stores your Firebase
  service-account key in AWS Secrets Manager (as FCM_SERVICE_ACCOUNT) and
  restarts the app. The key goes straight from this machine to your AWS
  account; delete the downloaded file afterwards.

    .\infra\aws\set-fcm-key.ps1 -KeyFile "$HOME\Downloads\teambridge-firebase-adminsdk.json"
#>
param(
  [Parameter(Mandatory = $true)][string]$KeyFile,
  [string]$Stack = 'teambridge',
  [string]$Region = 'ap-southeast-2'
)
if (-not (Test-Path $KeyFile)) { throw "No file at $KeyFile" }
$json = Get-Content $KeyFile -Raw | ConvertFrom-Json
if (-not $json.project_id -or -not $json.client_email -or -not $json.private_key) {
  throw 'That is not a Firebase service-account key. In Firebase: Project settings > Service accounts > Generate new private key.'
}

# One line, so it fits an env file: the JSON, base64-encoded (the server reads either form).
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $KeyFile)))
$tmp = New-TemporaryFile
try {
  [IO.File]::WriteAllText($tmp, "FCM_SERVICE_ACCOUNT=$b64`n", (New-Object Text.UTF8Encoding $false))
  & "$PSScriptRoot\set-secrets.ps1" -EnvFile $tmp -Stack $Stack -Region $Region
} finally { Remove-Item $tmp -Force }
Write-Host "Phone notifications are on for Firebase project '$($json.project_id)'." -ForegroundColor Green
