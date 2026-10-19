param(
  [string]$ArchivePath = "release/ubot-1.0.2-win.zip",
  [string]$ExpectedSha256 = "",
  [switch]$AcknowledgeLegacy
)

# Retained legacy operational helper. It only inspects an existing historic
# artifact: it never builds, deploys, publishes, or changes source files.
# Current releases use npm run package:all and the gated Actions workflow.
$ErrorActionPreference = "Stop"

if (-not $AcknowledgeLegacy) {
  throw "This is a v1.0.2 archive-only verifier. Pass -AcknowledgeLegacy after selecting an approved historical artifact."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$archiveFullPath = Join-Path $projectRoot $ArchivePath
if (-not (Test-Path -LiteralPath $archiveFullPath -PathType Leaf)) {
  throw "Legacy archive not found: $ArchivePath"
}
if (-not $archiveFullPath.EndsWith(".zip", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Legacy verifier accepts a .zip archive only."
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
  if ($ExpectedSha256 -notmatch "^[a-fA-F0-9]{64}$") {
    throw "ExpectedSha256 must be a 64-character SHA-256 digest."
  }
  $actualHash = (Get-FileHash -LiteralPath $archiveFullPath -Algorithm SHA256).Hash
  if (-not $actualHash.Equals($ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Legacy archive checksum mismatch."
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archiveFullPath)
try {
  $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
  foreach ($required in @("dist/index.js", "README.md")) {
    if ($entryNames -notcontains $required) {
      throw "Legacy archive missing required entry: $required"
    }
  }
  foreach ($forbidden in @(".env", "config/groups.json", "data/system-settings.json", "data/admin-operations.jsonl")) {
    if ($entryNames -contains $forbidden) {
      throw "Legacy archive contains forbidden runtime entry: $forbidden"
    }
  }
} finally {
  $archive.Dispose()
}

Write-Host "Legacy v1.0.2 archive verification passed: $(Split-Path -Leaf $archiveFullPath)"
