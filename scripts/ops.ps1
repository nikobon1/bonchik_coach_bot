param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('health', 'queue-health', 'failed', 'dlq', 'reports', 'requeue', 'analytics', 'analytics-summary', 'analytics-daily')]
  [string]$Action,

  [string]$BaseUrl,
  [string]$AdminApiKey,
  [string]$JobId,
  [int]$ChatId,
  [int]$Limit = 20,
  [int]$Days = 14
)

function Get-DotEnvValue {
  param([string]$Key)

  $envPath = Join-Path (Get-Location) '.env'
  if (-not (Test-Path $envPath)) {
    return $null
  }

  $prefix = "$Key="
  $line = Get-Content $envPath | Where-Object { $_.StartsWith($prefix) } | Select-Object -First 1
  if (-not $line) {
    return $null
  }

  $value = $line.Substring($prefix.Length).Trim()
  if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
    return $value.Substring(1, $value.Length - 2)
  }

  return $value
}

$resolvedBaseUrl = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } elseif ($env:APP_URL) { $env:APP_URL.TrimEnd('/') } elseif (Get-DotEnvValue 'APP_URL') { (Get-DotEnvValue 'APP_URL').TrimEnd('/') } else { $null }
$resolvedAdminKey = if ($AdminApiKey) { $AdminApiKey } elseif ($env:ADMIN_API_KEY) { $env:ADMIN_API_KEY } elseif (Get-DotEnvValue 'ADMIN_API_KEY') { Get-DotEnvValue 'ADMIN_API_KEY' } else { $null }

if (-not $resolvedBaseUrl) {
  throw 'Base URL is required. Pass -BaseUrl or set APP_URL (env or .env).'
}

function Invoke-AdminGet {
  param([string]$Path)

  if (-not $resolvedAdminKey) {
    throw 'ADMIN_API_KEY is required. Pass -AdminApiKey or set ADMIN_API_KEY (env or .env).'
  }

  Invoke-RestMethod -Method GET -Uri "$resolvedBaseUrl$Path" -Headers @{ 'x-admin-key' = $resolvedAdminKey }
}

function Invoke-AdminPost {
  param([string]$Path)

  if (-not $resolvedAdminKey) {
    throw 'ADMIN_API_KEY is required. Pass -AdminApiKey or set ADMIN_API_KEY (env or .env).'
  }

  Invoke-RestMethod -Method POST -Uri "$resolvedBaseUrl$Path" -Headers @{ 'x-admin-key' = $resolvedAdminKey }
}

function Write-AnalyticsSummary {
  param($Response)

  if (-not $Response -or -not $Response.ok) {
    throw 'Analytics summary request failed.'
  }

  $feedback = $Response.summary.feedback
  $modeRecommendation = $Response.summary.modeRecommendation

  Write-Output ("ok={0}" -f $Response.ok)
  Write-Output ("feedback: started={0}, completed={1}, cancelled={2}, dropped={3}" -f $feedback.started, $feedback.completed, $feedback.cancelled, $feedback.dropped)
  Write-Output ("modeRecommendation: started={0}, completed={1}, cancelled={2}, dropped={3}" -f $modeRecommendation.started, $modeRecommendation.completed, $modeRecommendation.cancelled, $modeRecommendation.dropped)
  Write-Output ("timestamp={0}" -f $Response.timestamp)
}

function Write-AnalyticsDaily {
  param($Response)

  if (-not $Response -or -not $Response.ok) {
    throw 'Analytics daily request failed.'
  }

  Write-Output ("ok={0}; days={1}; timezone={2}" -f $Response.ok, $Response.days, $Response.timezone)

  $rows = @()
  foreach ($day in @($Response.daily)) {
    $rows += [pscustomobject]@{
      date = $day.date
      feedback_started = $day.summary.feedback.started
      feedback_done = $day.summary.feedback.completed
      feedback_cancel = $day.summary.feedback.cancelled
      mode_started = $day.summary.modeRecommendation.started
      mode_done = $day.summary.modeRecommendation.completed
      mode_cancel = $day.summary.modeRecommendation.cancelled
    }
  }

  if ($rows.Count -eq 0) {
    Write-Output 'No daily rows.'
  } else {
    ($rows | Format-Table -AutoSize | Out-String).TrimEnd()
  }

  Write-Output ("rawRows={0}; timelinePoints={1}; timestamp={2}" -f @($Response.rows).Count, @($Response.daily).Count, $Response.timestamp)
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
  'reports' {
    if (-not $ChatId) {
      throw 'Chat ID is required for reports action. Pass -ChatId <id>.'
    }

    Invoke-AdminGet "/admin/reports/$ChatId?limit=$Limit"
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
  'analytics' {
    Invoke-AdminGet '/admin/analytics/telegram-flows'
    break
  }
  'analytics-summary' {
    $response = Invoke-AdminGet '/admin/analytics/telegram-flows/summary'
    Write-AnalyticsSummary $response
    break
  }
  'analytics-daily' {
    $response = Invoke-AdminGet "/admin/analytics/telegram-flows/daily?days=$Days"
    Write-AnalyticsDaily $response
    break
  }
}
