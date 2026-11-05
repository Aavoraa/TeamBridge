<#
  One-time: turns the empty AWS database into your workspace with your people,
  and prints each person's one-time link to set their own password.

    .\infra\aws\setup-team.ps1 -TeamFile .\team.json

  The team file is checked on your machine first (see server\team.example.json),
  copied to the server through the private artifacts bucket, used once and
  deleted. It refuses to run on a database that already has a workspace.
#>
param(
  [Parameter(Mandatory = $true)][string]$TeamFile,
  [string]$Stack = 'teambridge',
  [string]$Region = 'ap-southeast-2'   # this AWS account only allows Sydney
)
. "$PSScriptRoot\common.ps1"
Assert-Aws
if (-not (Test-Path $TeamFile)) { throw "No team file at $TeamFile" }
$TeamFile = (Resolve-Path $TeamFile).Path   # before Push-Location changes the folder

Push-Location "$script:Root\server"
try {
  node src/bootstrap.js $TeamFile --dry-run
  if ($LASTEXITCODE -ne 0) { throw 'Fix the team file and run again.' }
} finally { Pop-Location }

$out = Get-StackOutputs $Stack $Region
$key = "setup/team-$(Get-Date -Format 'yyyyMMddHHmmss').json"
aws s3 cp $TeamFile "s3://$($out.ArtifactsBucket)/$key" --region $Region --only-show-errors
Invoke-OnServer $out.InstanceId $Region @("/opt/teambridge/bin/bootstrap.sh $key") 300
Write-Host 'Send each person their own link. The owner can resend any of them later from Team.' -ForegroundColor Green
