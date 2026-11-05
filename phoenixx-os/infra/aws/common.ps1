# Shared helpers for the TeamBridge AWS scripts. Dot-source it: . "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Stop'
$script:Root = Resolve-Path "$PSScriptRoot\..\.."   # the phoenixx-os folder
# Server output can contain non-ASCII (e.g. arrows in logs); without UTF-8 the AWS CLI
# fails with "'charmap' codec can't encode character".
$env:PYTHONUTF8 = '1'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Assert-Aws {
  # The AWS CLI writes progress and "not found yet" notes to stderr; Windows PowerShell 5.1
  # turns those into terminating errors under 'Stop', so the AWS helpers use 'Continue'
  # and check $LASTEXITCODE / results instead.
  $ErrorActionPreference = 'Continue'
  if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'The AWS CLI is not installed. Run: winget install -e --id Amazon.AWSCLI  (then open a new terminal)'
  }
  $id = aws sts get-caller-identity --output json 2>$null | ConvertFrom-Json
  if (-not $id) { throw 'The AWS CLI has no login. Run: aws configure  (region ap-south-1)' }
  Write-Host "AWS account $($id.Account) as $($id.Arn)" -ForegroundColor DarkGray
}

function Get-StackOutputs([string]$Stack, [string]$Region) {
  $outs = aws cloudformation describe-stacks --stack-name $Stack --region $Region --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json
  $map = @{}
  foreach ($o in $outs) { $map[$o.OutputKey] = $o.OutputValue }
  return $map
}

# Runs shell commands on the server through Systems Manager and prints what they printed.
function Invoke-OnServer([string]$InstanceId, [string]$Region, [string[]]$Commands, [int]$TimeoutSeconds = 900) {
  $ErrorActionPreference = 'Continue'
  $tmp = New-TemporaryFile
  @{
    InstanceIds = @($InstanceId)
    DocumentName = 'AWS-RunShellScript'
    TimeoutSeconds = 60
    Parameters = @{ commands = $Commands; executionTimeout = @("$TimeoutSeconds") }
  } | ConvertTo-Json -Depth 5 | Set-Content -Path $tmp -Encoding ascii
  $cmdId = aws ssm send-command --region $Region --cli-input-json "file://$tmp" --query Command.CommandId --output text
  Remove-Item $tmp
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds + 60)
  # Read status and output as plain text: server logs can hold characters that
  # Windows PowerShell's JSON parser rejects.
  $inv = @('--region', $Region, '--command-id', $cmdId, '--instance-id', $InstanceId, '--output', 'text')
  do {
    Start-Sleep -Seconds 5
    $status = aws ssm get-command-invocation @inv --query Status 2>$null
  } while ((-not $status -or $status -in @('Pending', 'InProgress', 'Delayed')) -and (Get-Date) -lt $deadline)
  $stdout = (aws ssm get-command-invocation @inv --query StandardOutputContent 2>$null) -join "`n"
  if ($stdout.Trim()) { Write-Host $stdout }
  if ($status -ne 'Success') {
    $stderr = (aws ssm get-command-invocation @inv --query StandardErrorContent 2>$null) -join "`n"
    if ($stderr.Trim()) { Write-Host $stderr -ForegroundColor Yellow }
    throw "The command on the server ended as: $status"
  }
}

function Wait-ServerReady([string]$InstanceId, [string]$Region) {
  $ErrorActionPreference = 'Continue'
  Write-Host 'Waiting for the server to come online in Systems Manager...'
  for ($i = 0; $i -lt 60; $i++) {
    $ping = aws ssm describe-instance-information --region $Region --filters "Key=InstanceIds,Values=$InstanceId" --query 'InstanceInformationList[0].PingStatus' --output text 2>$null
    if ($ping -eq 'Online') { return }
    Start-Sleep -Seconds 10
  }
  throw 'The server did not come online in Systems Manager within 10 minutes.'
}
