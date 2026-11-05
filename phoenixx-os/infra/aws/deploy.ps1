<#
  Creates or updates TeamBridge on AWS, builds the app and ships it to the server.

    .\infra\aws\deploy.ps1 -Domain app.example.com -BudgetEmail you@example.com   # first time (and to change the stack)
    .\infra\aws\deploy.ps1 -Domain app.example.com -AppOnly   # only ship new code, leave the stack alone

  Run from the phoenixx-os folder. Needs the AWS CLI with an admin login (aws configure).
#>
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$Stack = 'teambridge',
  [string]$Region = 'ap-southeast-2',   # this AWS account only allows Sydney
  # Who gets the monthly cost alert, and at how many US dollars.
  [string]$BudgetEmail = '',
  [int]$MonthlyBudgetUsd = 10,
  [switch]$AppOnly
)
. "$PSScriptRoot\common.ps1"
Assert-Aws

if (-not $AppOnly) {
  # The region's default VPC and its subnets (the database wants two zones or more).
  $vpc = aws ec2 describe-vpcs --region $Region --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text
  if (-not $vpc -or $vpc -eq 'None') { throw "No default VPC in $Region. Create one in the VPC console (Actions - Create default VPC)." }
  $subnets = (aws ec2 describe-subnets --region $Region --filters "Name=vpc-id,Values=$vpc" "Name=default-for-az,Values=true" --query 'Subnets[].SubnetId' --output text) -split '\s+' | Where-Object { $_ }
  if ($subnets.Count -lt 2) { throw 'The default VPC needs subnets in at least two availability zones.' }

  Write-Host "Creating or updating the '$Stack' stack in $Region (the first run takes about 15 minutes, mostly the database)..."
  $params = @("DomainName=$Domain", "VpcId=$vpc", "SubnetIds=$($subnets -join ',')", "MonthlyBudgetUsd=$MonthlyBudgetUsd")
  if ($BudgetEmail) { $params += "BudgetEmail=$BudgetEmail" }
  $ErrorActionPreference = 'Continue'   # the CLI prints progress and "not found" notes on stderr
  # A stack whose first create failed must be deleted before it can be created again.
  $state = aws cloudformation describe-stacks --region $Region --stack-name $Stack --query 'Stacks[0].StackStatus' --output text 2>$null
  if ($state -eq 'ROLLBACK_COMPLETE') {
    Write-Host 'Removing the earlier failed attempt first...'
    aws cloudformation delete-stack --region $Region --stack-name $Stack
    aws cloudformation wait stack-delete-complete --region $Region --stack-name $Stack
  }
  aws cloudformation deploy --region $Region --stack-name $Stack `
    --template-file "$PSScriptRoot\teambridge.yaml" `
    --capabilities CAPABILITY_IAM `
    --no-fail-on-empty-changeset `
    --parameter-overrides @params
  if ($LASTEXITCODE -ne 0) { throw 'The stack did not deploy - see the Events tab of the stack in the CloudFormation console.' }
  $ErrorActionPreference = 'Stop'
}

$out = Get-StackOutputs $Stack $Region
Write-Host "Server $($out.InstanceId) at $($out.PublicIp)"

# ---- build: the web app, then one bundle with the server and the built pages
Push-Location $script:Root
try {
  # Only needed for the web build; the server installs its own packages on AWS.
  # Skipped when present so a running local dev server is left alone.
  if (-not (Test-Path 'node_modules')) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'The web build failed' }
  $sha = (git rev-parse --short HEAD).Trim()
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bundle = Join-Path $env:TEMP "teambridge-$stamp-$sha.tgz"
  tar -czf $bundle --exclude=server/node_modules --exclude=server/data --exclude=server/.env --exclude=server/tests `
    package.json package-lock.json server web/package.json web/dist
  if ($LASTEXITCODE -ne 0) { throw 'Packing the release failed' }
} finally { Pop-Location }

$key = "releases/teambridge-$stamp-$sha.tgz"
aws s3 cp $bundle "s3://$($out.ArtifactsBucket)/$key" --region $Region --only-show-errors
Remove-Item $bundle

Wait-ServerReady $out.InstanceId $Region
Write-Host 'Installing the release on the server...'
Invoke-OnServer $out.InstanceId $Region @("cloud-init status --wait > /dev/null; /opt/teambridge/bin/deploy.sh $key") 1200

Write-Host ''
Write-Host "Done. Release $sha is live on the server." -ForegroundColor Green
Write-Host "  DNS:     add an A record  $Domain  ->  $($out.PublicIp)   (HTTPS starts by itself once it resolves)"
Write-Host "  App:     $($out.AppUrl)"
Write-Host "  LiveKit: set the webhook to $($out.LiveKitWebhookUrl)"
