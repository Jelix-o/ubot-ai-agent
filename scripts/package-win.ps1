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

if (Test-Path $bundleDir) {
  Remove-Item -LiteralPath $bundleDir -Recurse -Force
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
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
  "skills",
  "scripts",
  "package.json",
  "package-lock.json",
  "README.md",
  "COMMANDS.md",
  "RELEASE-v1.0.1.md",
  "V1.0.1-LOCAL-AUDIT.md",
  ".env.example",
  ".env.server-2022.example"
)

foreach ($item in $itemsToCopy) {
  $source = Join-Path $projectRoot $item
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination $bundleDir -Recurse -Force
  }
}

$configDir = Join-Path $bundleDir "config"
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

$groupsExample = @'
{
  "superAdminUserIds": [],
  "groups": []
}
'@
Set-Content -Path (Join-Path $configDir "groups.example.json") -Value $groupsExample -Encoding UTF8

$distDir = Join-Path $bundleDir "dist"
if (Test-Path $distDir) {
  Get-ChildItem -Path $distDir -Recurse -Filter *.test.js | Remove-Item -Force
}

$dataDir = Join-Path $bundleDir "data"
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dataDir "tts-cache") -Force | Out-Null

$conversationFile = Join-Path $dataDir "conversations.json"
if (-not (Test-Path $conversationFile)) {
  Set-Content -Path $conversationFile -Value "{`"conversations`": {}}" -Encoding UTF8
}

$runCmd = @'
@echo off
setlocal
cd /d %~dp0
if not exist config\groups.json copy config\groups.example.json config\groups.json >nul
node dist\index.js
'@
Set-Content -Path (Join-Path $bundleDir "run.cmd") -Value $runCmd -Encoding ASCII

$installCmd = @'
@echo off
setlocal
cd /d %~dp0
call npm ci --omit=dev
'@
Set-Content -Path (Join-Path $bundleDir "install-deps.cmd") -Value $installCmd -Encoding ASCII

Compress-Archive -Path (Join-Path $bundleDir "*") -DestinationPath $zipPath -Force

Write-Host "Package created:"
Write-Host "  Folder: $bundleDir"
Write-Host "  Zip:    $zipPath"
