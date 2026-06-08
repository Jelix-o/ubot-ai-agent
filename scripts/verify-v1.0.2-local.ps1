param(
  [switch]$WithScreenshots,
  [string]$ForbiddenSecret = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseZip = Join-Path $projectRoot "release\ubot-1.0.2-win.zip"
$contactSheet = Join-Path $projectRoot "release\admin-ui-smoke\_contact-sheet.png"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Script
  )

  Write-Host ""
  Write-Host "==> $Name"
  & $Script
}

Push-Location $projectRoot
try {
  Invoke-Step "npm test" {
    npm test
  }

  if ($WithScreenshots) {
    Invoke-Step "visual admin smoke screenshots" {
      $env:ADMIN_SMOKE_SCREENSHOTS = "1"
      node scripts\run-node22.cjs scripts\visual-admin-smoke.mjs
    }
  }

  Invoke-Step "package Windows release" {
    npm run package:win
  }

  Invoke-Step "GitHub Release dry run" {
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-github-release.ps1 -DryRun
  }

  Invoke-Step "verify package contents" {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (-not (Test-Path -LiteralPath $releaseZip)) {
      throw "Release package missing: $releaseZip"
    }

    $archive = [System.IO.Compression.ZipFile]::OpenRead($releaseZip)
    try {
      $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
      foreach ($required in @(
        "dist\index.js",
        "dist\admin\index.html",
        "config\groups.example.json",
        "README.md",
        "COMMANDS.md",
        "RELEASE-v1.0.2.md",
        "V1.0.2-LOCAL-AUDIT.md"
      )) {
        if ($entryNames -notcontains $required) {
          throw "Release package missing required entry: $required"
        }
      }

      foreach ($forbidden in @(
        ".env",
        "config\groups.json",
        "data\system-settings.json",
        "data\admin-operations.jsonl"
      )) {
        if ($entryNames -contains $forbidden) {
          throw "Release package contains forbidden runtime entry: $forbidden"
        }
      }
    } finally {
      $archive.Dispose()
    }
  }

  Invoke-Step "verify screenshots artifact" {
    if ($WithScreenshots -and -not (Test-Path -LiteralPath $contactSheet)) {
      throw "Contact sheet missing: $contactSheet"
    }
    $smokeDir = Join-Path $projectRoot "release\admin-ui-smoke"
    if (Test-Path -LiteralPath $smokeDir) {
      $pngFiles = @(Get-ChildItem -Path $smokeDir -Filter *.png | Sort-Object Name)
      $pngCount = $pngFiles.Count
      Write-Host "Screenshot PNG count: $pngCount"
      if ($WithScreenshots -and $pngCount -lt 50) {
        throw "Expected at least 50 smoke screenshot PNG files, found $pngCount"
      }

      if ($WithScreenshots) {
        Add-Type -AssemblyName System.Drawing
        foreach ($pngFile in $pngFiles) {
          $bitmap = [System.Drawing.Bitmap]::FromFile($pngFile.FullName)
          try {
            $width = [int]$bitmap.Width
            $height = [int]$bitmap.Height
            $xSamples = @(0, [Math]::Floor($width / 4), [Math]::Floor($width / 2), [Math]::Floor((3 * $width) / 4), ($width - 1))
            $ySamples = @(0, [Math]::Floor($height / 4), [Math]::Floor($height / 2), [Math]::Floor((3 * $height) / 4), ($height - 1))
            $sampleColors = @()
            foreach ($x in $xSamples) {
              foreach ($y in $ySamples) {
                $color = $bitmap.GetPixel([int]$x, [int]$y)
                $sampleColors += "$($color.R),$($color.G),$($color.B)"
              }
            }
            $uniqueColorCount = ($sampleColors | Sort-Object -Unique).Count
            if ($width -lt 300 -or $height -lt 300 -or $uniqueColorCount -lt 2 -or $pngFile.Length -lt 10000) {
              throw "Smoke screenshot looks invalid: $($pngFile.Name), ${width}x${height}, unique sampled colors: $uniqueColorCount, bytes: $($pngFile.Length)"
            }
          } finally {
            $bitmap.Dispose()
          }
        }
        Write-Host "Screenshot pixel smoke passed."
      }
    }
  }

  Invoke-Step "verify forbidden secret is absent" {
    if ([string]::IsNullOrWhiteSpace($ForbiddenSecret)) {
      Write-Host "No forbidden secret provided; skipping literal secret scan."
    } else {
      $diffSecretHits = git diff -- . ':!release' | Select-String -SimpleMatch -Pattern $ForbiddenSecret
      if ($diffSecretHits) {
        throw "Forbidden secret found in git diff."
      }

      $zipSecretHits = Select-String -Path $releaseZip -SimpleMatch -Pattern $ForbiddenSecret
      if ($zipSecretHits) {
        throw "Forbidden secret found in release package."
      }
    }
  }

  Invoke-Step "git diff check" {
    git diff --check
  }

  Write-Host ""
  Write-Host "V1.0.2 local verification passed."
} finally {
  Pop-Location
}
