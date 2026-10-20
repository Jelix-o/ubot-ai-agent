param(
  [string]$Repo = "Jelix-o/ubot-ai-agent",
  [string]$Tag = "",
  [string]$Name = "",
  [string]$ReleaseNotesPath = "",
  [string[]]$AssetPath = @(),
  [switch]$DryRun,
  [switch]$EnablePublication
)

# Retained operational helper. It is intentionally excluded from release
# payloads and is permanently read-only: formal GitHub Release publication is
# performed only by the matching, reviewed GitHub Actions workflow.
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch "^[^/]+/[^/]+$") {
  throw "Repo must use owner/name format."
}
if (-not $DryRun -or $EnablePublication) {
  throw "This retained helper is read-only. Pass -DryRun; formal GitHub Release publication is CI-only."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -notmatch "^\d+\.\d+\.\d+$") {
  throw "Only a final semantic package version can be published as a formal GitHub Release."
}
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$version" }
if ($Tag -ne "v$version") {
  throw "Formal GitHub Release tag must match package.json exactly: v$version"
}
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = "UBot v$version" }
if ($AssetPath.Count -eq 0) {
  $AssetPath = @(
    "release/ubot-$version-win.zip",
    "release/ubot-$version-win.zip.sha256",
    "release/ubot-$version-linux.tar.gz",
    "release/ubot-$version-linux.tar.gz.sha256"
  )
}

function Invoke-UbotNode {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & node (Join-Path $projectRoot "scripts/run-node22.cjs") @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Controlled Node.js command failed: $($Arguments -join ' ')"
  }
}

Push-Location $projectRoot
try {
  $tagCommit = (& git rev-list -n 1 $Tag).Trim()
  $headCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tagCommit)) {
    throw "Required local tag is missing: $Tag"
  }
  if ($tagCommit -ne $headCommit) {
    throw "Current checkout must be the exact $Tag commit before publishing a formal release."
  }

  if ([string]::IsNullOrWhiteSpace($ReleaseNotesPath)) {
    $ReleaseNotesPath = ".codex_tmp/release-notes.md"
    Invoke-UbotNode "scripts/public-docs.mjs" "release-notes" "--output" $ReleaseNotesPath "--title" $Name
  }
  Invoke-UbotNode "scripts/verify-release-assets.mjs" "--directory" "release" "--version" $version
} finally {
  Pop-Location
}

$notesFullPath = Join-Path $projectRoot $ReleaseNotesPath
if (-not (Test-Path -LiteralPath $notesFullPath -PathType Leaf)) {
  throw "Release notes not found: $ReleaseNotesPath"
}
$assetFullPaths = @()
foreach ($asset in $AssetPath) {
  $fullPath = Join-Path $projectRoot $asset
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Release asset not found: $asset. Run npm run package:all first."
  }
  $assetFullPaths += $fullPath
}
$notes = Get-Content -LiteralPath $notesFullPath -Raw -Encoding UTF8
Write-Host "GitHub Release candidate dry run (no network request is made):"
Write-Host "  Repo:  $Repo"
Write-Host "  Tag:   $Tag"
Write-Host "  Name:  $Name"
Write-Host "  Notes: $ReleaseNotesPath ($($notes.Length) chars)"
foreach ($asset in $assetFullPaths) {
  $item = Get-Item -LiteralPath $asset
  Write-Host "  Asset: $($item.Name) ($($item.Length) bytes)"
}
Write-Host "Formal publication remains restricted to the reviewed GitHub Actions workflow."
