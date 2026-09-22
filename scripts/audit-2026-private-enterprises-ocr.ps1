param(
  [Parameter(Mandatory = $true)][string]$ScreenshotPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$MaxChunks = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
function Await-Result($operation, [type]$resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}

$language = New-Object Windows.Globalization.Language('zh-Hans-CN')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if (-not $engine) { throw 'Simplified Chinese Windows OCR is not installed.' }

$bitmap = New-Object System.Drawing.Bitmap($ScreenshotPath)
$lines = New-Object System.Collections.Generic.List[object]
$tempImage = Join-Path ([IO.Path]::GetTempPath()) ('ubot-ranking-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
try {
  $left = [Math]::Floor($bitmap.Width * 0.25)
  $width = [Math]::Min(900, $bitmap.Width - $left)
  $chunkHeight = 1400
  $chunkNumber = 0
  for ($top = 0; $top -lt $bitmap.Height; $top += $chunkHeight) {
    if ($MaxChunks -gt 0 -and $chunkNumber -ge $MaxChunks) { break }
    $height = [Math]::Min($chunkHeight, $bitmap.Height - $top)
    $rect = New-Object System.Drawing.Rectangle($left, $top, $width, $height)
    $crop = $bitmap.Clone($rect, $bitmap.PixelFormat)
    try { $crop.Save($tempImage, [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $crop.Dispose() }

    $file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempImage)) ([Windows.Storage.StorageFile])
    $stream = Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $softwareBitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      try {
        $result = Await-Result ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
        foreach ($line in $result.Lines) {
          $firstWord = $line.Words | Select-Object -First 1
          $lines.Add([pscustomobject]@{
            x = [Math]::Round($left + $firstWord.BoundingRect.X, 2)
            y = [Math]::Round($top + $firstWord.BoundingRect.Y, 2)
            text = $line.Text
          })
        }
      } finally { $softwareBitmap.Dispose() }
    } finally { $stream.Dispose() }
    $chunkNumber++
  }
  $lines | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $OutputPath -Encoding utf8
  Write-Output "OCR $chunkNumber chunks, $($lines.Count) text lines: $OutputPath"
} finally {
  $bitmap.Dispose()
  if (Test-Path -LiteralPath $tempImage) { Remove-Item -LiteralPath $tempImage }
}
