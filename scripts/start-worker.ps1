param(
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }

  $parts = $line -split "=", 2
  if ($parts.Count -ne 2) {
    return
  }

  $name = $parts[0].Trim()
  $value = $parts[1]
  Set-Item -Path ("Env:" + $name) -Value $value
}

& npm.cmd run start:worker
