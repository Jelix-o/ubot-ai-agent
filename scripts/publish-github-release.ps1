param(
  [string]$Repo = "Jelix-o/ubot-ai-agent",
  [string]$Tag = "v1.0.1",
  [string]$Name = "UBot V1.0.1",
  [string]$ReleaseNotesPath = "RELEASE-v1.0.1.md",
  [string]$AssetPath = "release/ubot-1.0.1-win.zip",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch "^[^/]+/[^/]+$") {
  throw "Repo must use owner/name format."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$notesFullPath = Join-Path $projectRoot $ReleaseNotesPath
$assetFullPath = Join-Path $projectRoot $AssetPath

if (-not (Test-Path -LiteralPath $notesFullPath)) {
  throw "Release notes not found: $ReleaseNotesPath"
}

if (-not (Test-Path -LiteralPath $assetFullPath)) {
  throw "Release asset not found: $AssetPath. Run npm run package:win first."
}

$notes = Get-Content -LiteralPath $notesFullPath -Raw -Encoding UTF8
$assetItem = Get-Item -LiteralPath $assetFullPath

if ($DryRun) {
  Write-Host "GitHub Release dry run:"
  Write-Host "  Repo:  $Repo"
  Write-Host "  Tag:   $Tag"
  Write-Host "  Name:  $Name"
  Write-Host "  Notes: $ReleaseNotesPath ($($notes.Length) chars)"
  Write-Host "  Asset: $AssetPath ($($assetItem.Length) bytes)"
  exit 0
}

$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = $env:GH_TOKEN
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "Set GITHUB_TOKEN or GH_TOKEN with GitHub Contents/Release write permission."
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

function Invoke-GitHubJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [object]$Body
  )

  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
  }

  $json = $Body | ConvertTo-Json -Depth 10
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -Body $json -ContentType "application/json; charset=utf-8"
}

$apiBase = "https://api.github.com/repos/$Repo"
$release = $null

try {
  $release = Invoke-GitHubJson -Method "Get" -Uri "$apiBase/releases/tags/$Tag"
} catch {
  $response = $_.Exception.Response
  if ($response -and [int]$response.StatusCode -eq 404) {
    $release = Invoke-GitHubJson -Method "Post" -Uri "$apiBase/releases" -Body @{
      tag_name = $Tag
      target_commitish = "main"
      name = $Name
      body = $notes
      draft = $false
      prerelease = $false
    }
  } else {
    throw
  }
}

$release = Invoke-GitHubJson -Method "Patch" -Uri "$apiBase/releases/$($release.id)" -Body @{
  tag_name = $Tag
  target_commitish = "main"
  name = $Name
  body = $notes
  draft = $false
  prerelease = $false
}

$assetName = Split-Path -Leaf $assetFullPath
foreach ($asset in @($release.assets)) {
  if ($asset.name -eq $assetName) {
    Invoke-RestMethod -Method Delete -Uri "$apiBase/releases/assets/$($asset.id)" -Headers $headers | Out-Null
  }
}

$uploadBase = $release.upload_url -replace "\{\?name,label\}$", ""
$encodedName = [uri]::EscapeDataString($assetName)
$uploadUri = "$uploadBase?name=$encodedName"

Invoke-RestMethod -Method Post -Uri $uploadUri -Headers @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
} -ContentType "application/zip" -InFile $assetFullPath | Out-Null

Write-Host "GitHub Release updated:"
Write-Host "  Release: $($release.html_url)"
Write-Host "  Asset:   $assetName"
