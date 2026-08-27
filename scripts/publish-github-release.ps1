param(
  [string]$Repo = "Jelix-o/ubot-ai-agent",
  [string]$Tag = "",
  [string]$Name = "",
  [string]$ReleaseNotesPath = "",
  [string[]]$AssetPath = @(),
  [string]$Proxy = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch "^[^/]+/[^/]+$") {
  throw "Repo must use owner/name format."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "package.json is missing a version."
}
if ($version -notmatch "^\d+\.\d+\.\d+$") {
  throw "Only a final semantic package version can be published as a formal GitHub Release: $version"
}
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$version" }
if ($Tag -ne "v$version") {
  throw "Formal GitHub Release tag must match package.json exactly: v$version"
}
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = "UBot V$version" }
if ([string]::IsNullOrWhiteSpace($ReleaseNotesPath)) { $ReleaseNotesPath = "RELEASE-v$version.md" }
if ($AssetPath.Count -eq 0) {
  $AssetPath = @(
    "release/ubot-$version-win.zip",
    "release/ubot-$version-win.zip.sha256",
    "release/ubot-$version-linux.tar.gz",
    "release/ubot-$version-linux.tar.gz.sha256"
  )
}
if ([string]::IsNullOrWhiteSpace($Proxy)) { $Proxy = $env:HTTPS_PROXY }

# The workflow is the normal release path. The local fallback is deliberately
# constrained to an already-created tag at the exact current commit so it
# cannot create a formal release from an untagged or stale worktree.
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
} finally {
  Pop-Location
}

$notesFullPath = Join-Path $projectRoot $ReleaseNotesPath
if (-not (Test-Path -LiteralPath $notesFullPath)) {
  throw "Release notes not found: $ReleaseNotesPath"
}

$assetFullPaths = @()
foreach ($asset in $AssetPath) {
  $fullPath = Join-Path $projectRoot $asset
  if (-not (Test-Path -LiteralPath $fullPath)) {
    throw "Release asset not found: $asset. Run npm run package:all first."
  }
  $assetFullPaths += $fullPath
}

Push-Location $projectRoot
try {
  & node scripts/verify-release-assets.mjs --directory release --version $version
  if ($LASTEXITCODE -ne 0) { throw "Release asset checksum validation failed." }
} finally {
  Pop-Location
}

$notes = Get-Content -LiteralPath $notesFullPath -Raw -Encoding UTF8

if ($DryRun) {
  Write-Host "GitHub Release dry run:"
  Write-Host "  Repo:  $Repo"
  Write-Host "  Tag:   $Tag"
  Write-Host "  Name:  $Name"
  Write-Host "  Notes: $ReleaseNotesPath ($($notes.Length) chars)"
  foreach ($asset in $assetFullPaths) {
    $item = Get-Item -LiteralPath $asset
    Write-Host "  Asset: $($item.Name) ($($item.Length) bytes)"
  }
  exit 0
}

$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { $token = $env:GH_TOKEN }
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "Set GITHUB_TOKEN or GH_TOKEN with GitHub Contents/Release write permission."
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

function Invoke-GitHubRest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [object]$Body,
    [string]$ContentType,
    [string]$InFile
  )
  $parameters = @{ Method = $Method; Uri = $Uri; Headers = $headers }
  if (-not [string]::IsNullOrWhiteSpace($Proxy)) { $parameters.Proxy = $Proxy }
  if ($null -ne $Body) {
    $parameters.Body = $Body | ConvertTo-Json -Depth 10
    $parameters.ContentType = "application/json; charset=utf-8"
  }
  if (-not [string]::IsNullOrWhiteSpace($ContentType)) { $parameters.ContentType = $ContentType }
  if (-not [string]::IsNullOrWhiteSpace($InFile)) { $parameters.InFile = $InFile }
  return Invoke-RestMethod @parameters
}

$apiBase = "https://api.github.com/repos/$Repo"
$release = $null
try {
  $release = Invoke-GitHubRest -Method "Get" -Uri "$apiBase/releases/tags/$Tag"
} catch {
  $response = $_.Exception.Response
  if ($response -and [int]$response.StatusCode -eq 404) {
    $release = Invoke-GitHubRest -Method "Post" -Uri "$apiBase/releases" -Body @{
      tag_name = $Tag
      target_commitish = $Tag
      name = $Name
      body = $notes
      draft = $false
      prerelease = $version.Contains("-rc.")
    }
  } else {
    throw
  }
}

$release = Invoke-GitHubRest -Method "Patch" -Uri "$apiBase/releases/$($release.id)" -Body @{
  tag_name = $Tag
  target_commitish = $Tag
  name = $Name
  body = $notes
  draft = $false
  prerelease = $version.Contains("-rc.")
}

foreach ($assetPath in $assetFullPaths) {
  $assetName = Split-Path -Leaf $assetPath
  foreach ($existing in @($release.assets)) {
    if ($existing.name -eq $assetName) {
      Invoke-GitHubRest -Method "Delete" -Uri "$apiBase/releases/assets/$($existing.id)" | Out-Null
    }
  }
  $uploadBase = $release.upload_url -replace "\{\?name,label\}$", ""
  $uploadUri = "$uploadBase?name=$([uri]::EscapeDataString($assetName))"
  $contentType = if ($assetName.EndsWith(".zip")) { "application/zip" } elseif ($assetName.EndsWith(".tar.gz")) { "application/gzip" } else { "text/plain; charset=utf-8" }
  Invoke-GitHubRest -Method "Post" -Uri $uploadUri -ContentType $contentType -InFile $assetPath | Out-Null
}

Write-Host "GitHub Release updated:"
Write-Host "  Release: $($release.html_url)"
foreach ($assetPath in $assetFullPaths) { Write-Host "  Asset:   $(Split-Path -Leaf $assetPath)" }
