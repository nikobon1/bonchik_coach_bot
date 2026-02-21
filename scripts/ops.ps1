param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('health', 'queue-health', 'failed', 'dlq', 'requeue')]
  [string]$Action,

  [string]$BaseUrl,
  [string]$AdminApiKey,
  [string]$JobId,
  [int]$Limit = 20
)

$resolvedBaseUrl = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } elseif ($env:APP_URL) { $env:APP_URL.TrimEnd('/') } else { $null }
$resolvedAdminKey = if ($AdminApiKey) { $AdminApiKey } elseif ($env:ADMIN_API_KEY) { $env:ADMIN_API_KEY } else { $null }

if (-not $resolvedBaseUrl) {
  throw 'Base URL is required. Pass -BaseUrl or set APP_URL.'
}

function Invoke-AdminGet {
  param([string]$Path)

  if (-not $resolvedAdminKey) {
    throw 'ADMIN_API_KEY is required. Pass -AdminApiKey or set ADMIN_API_KEY.'
  }

  Invoke-RestMethod -Method GET -Uri "$resolvedBaseUrl$Path" -Headers @{ 'x-admin-key' = $resolvedAdminKey }
}

function Invoke-AdminPost {
  param([string]$Path)

  if (-not $resolvedAdminKey) {
    throw 'ADMIN_API_KEY is required. Pass -AdminApiKey or set ADMIN_API_KEY.'
  }

  Invoke-RestMethod -Method POST -Uri "$resolvedBaseUrl$Path" -Headers @{ 'x-admin-key' = $resolvedAdminKey }
}

switch ($Action) {
  'health' {
    Invoke-RestMethod -Method GET -Uri "$resolvedBaseUrl/health"
    break
  }
  'queue-health' {
    Invoke-AdminGet '/admin/queue/health'
    break
  }
  'failed' {
    Invoke-AdminGet "/admin/queue/failed?limit=$Limit"
    break
  }
  'dlq' {
    Invoke-AdminGet "/admin/queue/dlq?limit=$Limit"
    break
  }
  'requeue' {
    if (-not $JobId) {
      throw 'Job ID is required for requeue action. Pass -JobId <id>.'
    }

    Write-Host "Requeueing DLQ job '$JobId' on $resolvedBaseUrl" -ForegroundColor Yellow
    Invoke-AdminPost "/admin/queue/dlq/requeue/$JobId"
    break
  }
}