param(
  [string]$OutputRoot = "release"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-NodeExecutablePath {
  param([Parameter(Mandatory = $true)][string]$Candidate)

  if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
    return (Resolve-Path -LiteralPath $Candidate).Path
  }

  $command = Get-Command $Candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $command -and $command.Path) {
    return $command.Path
  }

  return $null
}

function Get-NodeMajorVersion {
  param([Parameter(Mandatory = $true)][string]$NodePath)

  # Do not pipe native output through Select-Object before reading
  # $LASTEXITCODE: Windows PowerShell can report a pipeline-side failure even
  # when the Node executable produced a valid version line.
  $versionLines = @(& $NodePath --version 2>$null)
  $nodeExitCode = $LASTEXITCODE
  $version = $versionLines | Select-Object -First 1
  if ($nodeExitCode -ne 0 -or $null -eq $version) {
    return $null
  }

  $match = [regex]::Match($version.ToString().Trim(), "^v(?<major>\d+)\.")
  if (-not $match.Success) {
    return $null
  }

  return [int]$match.Groups["major"].Value
}

function Find-PairedNpmCli {
  param([Parameter(Mandatory = $true)][string]$NodePath)

  $nodeDirectory = Split-Path -Parent $NodePath
  $candidates = @(
    (Join-Path $nodeDirectory "node_modules\npm\bin\npm-cli.js"),
    (Join-Path $nodeDirectory "..\lib\node_modules\npm\bin\npm-cli.js")
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Get-UbotNodeRuntime {
  param([Parameter(Mandatory = $true)][string]$Candidate)

  $nodePath = Get-NodeExecutablePath $Candidate
  if (-not $nodePath) {
    return $null
  }

  $major = Get-NodeMajorVersion $nodePath
  if ($null -eq $major -or $major -lt 22) {
    return $null
  }

  $npmCliPath = Find-PairedNpmCli $nodePath
  if (-not $npmCliPath) {
    return $null
  }

  return [pscustomobject]@{
    NodePath = $nodePath
    NpmCliPath = $npmCliPath
    Major = $major
  }
}

function Resolve-UbotNodeRuntime {
  if ($env:UBOT_NODE) {
    $configured = Get-UbotNodeRuntime $env:UBOT_NODE
    if ($null -eq $configured) {
      throw "UBOT_NODE must resolve to Node.js 22 or newer with its paired npm CLI."
    }
    return $configured
  }

  $nvmRoots = @(
    $env:NVM_HOME,
    $env:NVM_SYMLINK,
    (Join-Path ([Environment]::GetFolderPath("UserProfile")) "AppData\Roaming\nvm"),
    "C:\environment\nvm",
    "D:\environment\nvm",
    "C:\nvm",
    "D:\nvm"
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($nvmRoot in $nvmRoots) {
    if (-not (Test-Path -LiteralPath $nvmRoot -PathType Container)) {
      continue
    }
    $versionDirectories = Get-ChildItem -LiteralPath $nvmRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^v?\d+\.\d+\.\d+$" } |
      Sort-Object @{ Expression = { [version]$_.Name.TrimStart("v") }; Descending = $true }
    foreach ($directory in $versionDirectories) {
      $runtime = Get-UbotNodeRuntime (Join-Path $directory.FullName "node.exe")
      if ($null -ne $runtime) {
        return $runtime
      }
    }
  }

  # PATH can contain multiple Node installations. Evaluate each concrete path
  # rather than passing a command array into a string parameter, then select
  # the first runtime that satisfies the Node 22 + paired npm contract.
  $pathCommands = @(Get-Command "node" -CommandType Application -All -ErrorAction SilentlyContinue)
  foreach ($pathCommand in $pathCommands) {
    if (-not $pathCommand.Path) {
      continue
    }
    $fromPath = Get-UbotNodeRuntime ([string]$pathCommand.Path)
    if ($null -ne $fromPath) {
      return $fromPath
    }
  }

  throw "Node.js 22 or newer with its paired npm CLI is required to package a Windows release. Set UBOT_NODE to an absolute Node executable if necessary."
}

$nodeRuntime = Resolve-UbotNodeRuntime
$nodeBinary = $nodeRuntime.NodePath
$npmCli = $nodeRuntime.NpmCliPath
$env:UBOT_NODE = $nodeBinary
$env:Path = "$(Split-Path -Parent $nodeBinary);$env:Path"

function Invoke-UbotNode {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & $nodeBinary @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Controlled Node.js command failed: $($Arguments -join ' ')"
  }
}

function Invoke-UbotNpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & $nodeBinary $npmCli @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Controlled npm command failed: $($Arguments -join ' ')"
  }
}

Write-Host "Packaging with Node.js $(& $nodeBinary --version) from $nodeBinary"

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
  Invoke-UbotNpm "run" "build"
} finally {
  Pop-Location
}

$itemsToCopy = @(
  "dist",
  "scripts/configure-v3-network.mjs",
  "scripts/configure-image-model.mjs",
  "scripts/install-node22-runtime.sh",
  "scripts/update-cloudflare-origin-allowlist.sh",
  "scripts/install-cloudflare-origin-hardening.sh",
  "scripts/verify-nginx-vhost-ownership.mjs",
  "scripts/upgrade-model-policy.mjs",
  "scripts/repair-member-name.mjs",
  "scripts/maintain-member-alias.mjs",
  "scripts/deploy-linux-release.sh",
  "scripts/normalize-dotenv-bom.mjs",
  "scripts/migrate-v3-state.mjs",
  "scripts/verify-release-source.mjs",
  "scripts/validate-release-archive.mjs",
  "scripts/public-docs.mjs",
  "package.json",
  "package-lock.json",
  "README.md",
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
  "deploy/systemd/ubot-cloudflare-allowlist.service.template",
  "deploy/systemd/ubot-cloudflare-allowlist.timer.template",
  "assets/huixian-profile.json",
  "assets/meme-pack-index.json",
  "assets/private-enterprises-2026.json",
  "assets/private-enterprises-2026-audit.json",
  "assets/private-enterprises-2026-review.md",
  "assets/private-enterprises-2026-headquarters.json",
  "assets/private-enterprises-2026-headquarters-evidence.json",
  "assets/private-enterprises-2026-headquarters-review.md",
  "assets/blacklisted-at-meme.jpg"
)

$itemsToCopy += @(Invoke-UbotNode "$projectRoot/scripts/bt-release-files.cjs")
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
  Invoke-UbotNode "scripts/verify-release-source.mjs" $bundleDir
} finally {
  Pop-Location
}

Invoke-UbotNode "scripts/create-release-zip.mjs" $bundleDir $zipPath
$hash = Get-Sha256Hex -LiteralPath $zipPath
$assetName = Split-Path -Leaf $zipPath
Set-Content -LiteralPath $checksumPath -Value "$hash *$assetName" -Encoding ASCII -NoNewline

# Validate the archive itself, then prove a clean extracted release can install
# only production dependencies.  This catches accidental bundle omissions that
# source-tree checks cannot see.
$verifyDir = Join-Path $releaseRoot ".verify-$packageVersion-win-$PID"
try {
  Invoke-UbotNode "scripts/validate-release-zip.mjs" $zipPath
  Expand-Archive -LiteralPath $zipPath -DestinationPath $verifyDir -Force
  Push-Location $projectRoot
  try {
    Invoke-UbotNode "scripts/verify-release-source.mjs" $verifyDir
    Invoke-UbotNode "scripts/secret-scan.mjs" "--source" $verifyDir
  } finally {
    Pop-Location
  }
  Push-Location $verifyDir
  try {
    Invoke-UbotNpm "ci" "--omit=dev" "--ignore-scripts"
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
