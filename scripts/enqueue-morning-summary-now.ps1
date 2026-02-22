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

if (-not $env:REDIS_URL) {
  throw "REDIS_URL is not set"
}

@'
const { Queue } = require('bullmq');

async function main() {
  const redisUrl = process.env.REDIS_URL;
  const queue = new Queue('morning-summary-jobs', {
    connection: { url: redisUrl }
  });

  const job = await queue.add(
    'send-morning-summary-manual',
    { trigger: 'scheduled' },
    {
      jobId: `manual-morning-summary-${Date.now()}`,
      removeOnComplete: 10,
      removeOnFail: 10
    }
  );

  console.log(`Enqueued morning summary job: ${job.id}`);
  await queue.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
'@ | node -
