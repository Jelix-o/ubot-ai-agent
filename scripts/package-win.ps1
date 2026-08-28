param(
  [string]$OutputRoot = "release"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
$packageName = $packageJson.name
$packageVersion = $packageJson.version

$releaseRoot = Join-Path $projectRoot $OutputRoot
$bundleName = "$packageName-$packageVersion-win"
$bundleDir = Join-Path $releaseRoot $bundleName
$zipPath = Join-Path $releaseRoot "$bundleName.zip"
$checksumPath = "$zipPath.sha256"
$verifyDir = $null

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $getFileHash = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($null -ne $getFileHash) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
  }

  # Some stripped-down Windows PowerShell installations omit Get-FileHash.
  # SHA256.Create is available in supported .NET runtimes and keeps the
  # published .sha256 format identical across those hosts.
  $stream = [System.IO.File]::OpenRead($LiteralPath)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

if (Test-Path $bundleDir) {
  Remove-Item -LiteralPath $bundleDir -Recurse -Force
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

if (Test-Path $checksumPath) {
  Remove-Item -LiteralPath $checksumPath -Force
}

New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null

Push-Location $projectRoot
try {
  npm run build
} finally {
  Pop-Location
}

$itemsToCopy = @(
  "dist",
  "scripts/configure-v3-network.mjs",
  "scripts/deploy-linux-release.sh",
  "scripts/normalize-dotenv-bom.mjs",
  "scripts/migrate-v3-state.mjs",
  "scripts/verify-release-source.mjs",
  "package.json",
  "package-lock.json",
  "README.md",
  "COMMANDS.md",
  "RELEASE-v$packageVersion.md",
  ".env.example",
  ".env.server-2022.example",
  "deploy/nginx/bot.9958.uk.conf",
  "deploy/nginx/preview.9958.uk.conf",
  "deploy/nginx/ubot-preview-static.conf",
  "deploy/systemd/ubot-ingress.service.template",
  "deploy/systemd/ubot-worker.service.template",
  "deploy/systemd/ubot-admin.service.template",
  "deploy/systemd/ubot.target.template",
  "deploy/systemd/ubot-maintenance.service.template",
  "deploy/systemd/ubot-maintenance.timer.template",
  "docs/OPERATIONS-v3.md",
  "docs/ADMIN-RECOVERY-v3.md",
  "docs/MIGRATION-v3.md",
  "docs/ROLLBACK-v3.md",
  "assets/huixian-profile.json"
)

foreach ($item in $itemsToCopy) {
  $source = Join-Path $projectRoot $item
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required release path not found: $item"
  }
  $destination = Join-Path $bundleDir $item
  $destinationParent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

$distDir = Join-Path $bundleDir "dist"
if (Test-Path $distDir) {
  Get-ChildItem -Path $distDir -Recurse -Filter *.test.js | Remove-Item -Force
}

$runCmd = @'
@echo off
setlocal
cd /d %~dp0
set "NODE_ENV=production"
if not exist data mkdir data
if not exist data\logs mkdir data\logs
if "%BOT_ROLE%"=="legacy" (
  node dist\index.js
  exit /b %errorlevel%
)
set "ROLE=%BOT_ROLE%"
if "%ROLE%"=="" set "ROLE=ingress,worker,admin"
for %%r in (%ROLE%) do (
  start "ubot-%%r" cmd /c "set BOT_ROLE=%%r&& node dist\index.js >> data\logs\%%r.log 2>&1"
)
echo UBot processes launched: %ROLE%
echo Logs: data\logs\<role>.log
echo NODE_ENV=production; run the V3 state migration before the first start.
echo Set BOT_ROLE=legacy to run the legacy single-process mode.
endlocal
'@
Set-Content -Path (Join-Path $bundleDir "run.cmd") -Value $runCmd -Encoding ASCII

$installCmd = @'
@echo off
setlocal
cd /d %~dp0
call npm ci --omit=dev
'@
Set-Content -Path (Join-Path $bundleDir "install-deps.cmd") -Value $installCmd -Encoding ASCII

Push-Location $projectRoot
try {
  node scripts/verify-release-source.mjs $bundleDir
} finally {
  Pop-Location
}

$archiveInputs = Get-ChildItem -LiteralPath $bundleDir -Force
Compress-Archive -Path $archiveInputs.FullName -DestinationPath $zipPath -Force
$hash = Get-Sha256Hex -LiteralPath $zipPath
$assetName = Split-Path -Leaf $zipPath
Set-Content -LiteralPath $checksumPath -Value "$hash *$assetName" -Encoding ASCII -NoNewline

# Validate the archive itself, then prove a clean extracted release can install
# only production dependencies.  This catches accidental bundle omissions that
# source-tree checks cannot see.
$verifyDir = Join-Path $releaseRoot ".verify-$packageVersion-win-$PID"
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $verifyDir -Force
  Push-Location $projectRoot
  try {
    node scripts/verify-release-source.mjs $verifyDir
  } finally {
    Pop-Location
  }
  Push-Location $verifyDir
  try {
    npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "Production dependency installation verification failed." }
  } finally {
    Pop-Location
  }
} finally {
  if ($verifyDir -and (Test-Path -LiteralPath $verifyDir)) {
    Remove-Item -LiteralPath $verifyDir -Recurse -Force
  }
}

Write-Host "Package created:"
Write-Host "  Folder: $bundleDir"
Write-Host "  Zip:    $zipPath"
Write-Host "  SHA256: $checksumPath"
