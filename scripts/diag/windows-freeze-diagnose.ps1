# SemaClip: diagnose the frozen download on WINDOWS.
#
# WHY POWERSHELL: the previous diagnostic was a bash script. On a Windows box that either
# does not run at all or needs Git Bash, and pointing one at ffmpeg.exe from a Linux path
# ("C:/Users/...") failed before it tested anything. This runs where the problem is.
#
# Run it in PowerShell WHILE the download is frozen, then paste the whole output back.
# Nothing here writes to your project or your data.
#
#   powershell -ExecutionPolicy Bypass -File .\windows-freeze-diagnose.ps1

$ErrorActionPreference = 'Continue'
$dataDir = Join-Path $env:APPDATA 'SemaClip'
$ffmpeg  = Join-Path $dataDir 'tools\ffmpeg\win-x64\bin\ffmpeg.exe'

Write-Host "=== 1. IS THE BACKEND STILL ANSWERING? (the core question)" -ForegroundColor Cyan
# The app serves on a random loopback port; find it from the log's own startup line.
$logPath = Join-Path $dataDir 'SemaClip.log'
$port = $null
if (Test-Path $logPath) {
    $m = Select-String -Path $logPath -Pattern 'server running on http://127\.0\.0\.1:(\d+)' |
         Select-Object -Last 1
    if ($m) { $port = $m.Matches[0].Groups[1].Value }
}
Write-Host "  log:      $logPath"
Write-Host "  app port: $(if ($port) { $port } else { 'not found in the log' })"
if ($port) {
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/diagnostics" -TimeoutSec 8 -UseBasicParsing
        $sw.Stop()
        Write-Host "  HTTP:     $($r.StatusCode) in $($sw.ElapsedMilliseconds)ms" -ForegroundColor Green
        Write-Host "  => THE BACKEND IS ALIVE. It is a stuck download, not a dead server."
        Write-Host "  body:     $($r.Content.Substring(0, [Math]::Min(300, $r.Content.Length)))"
    } catch {
        Write-Host "  HTTP:     FAILED after $($sw.ElapsedMilliseconds)ms — $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  => THE BACKEND IS NOT ANSWERING. The event loop is blocked, or the process is gone."
        Write-Host "     Check Task Manager for a SemaClip process that is still running."
    }
}

Write-Host ""
Write-Host "=== 2. THE LOG TAIL (where the download stopped)" -ForegroundColor Cyan
if (Test-Path $logPath) {
    Get-Content $logPath -Tail 25 | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  no log at $logPath"
}

Write-Host ""
Write-Host "=== 3. DOES THE MANAGED FFMPEG RUN?" -ForegroundColor Cyan
# It is a `-shared` build: ffmpeg.exe needs its lib/ tree beside it. A missing DLL fails
# instantly, and to the app that looks identical to a stall.
if (Test-Path $ffmpeg) {
    Write-Host "  found: $ffmpeg"
    Write-Host "  lib dir beside it:"
    Get-ChildItem (Split-Path $ffmpeg) -ErrorAction SilentlyContinue |
        Select-Object -First 8 | ForEach-Object { Write-Host "    $($_.Name)" }
    $libDir = Join-Path (Split-Path (Split-Path $ffmpeg)) 'lib'
    if (Test-Path $libDir) {
        Write-Host "  DLLs:"
        Get-ChildItem $libDir -Filter *.dll -ErrorAction SilentlyContinue |
            Select-Object -First 6 | ForEach-Object { Write-Host "    $($_.Name)" }
    } else {
        Write-Host "  !! no lib/ dir at $libDir — a -shared build without its DLLs" -ForegroundColor Red
    }
    Write-Host "  running 'ffmpeg -version':"
    & $ffmpeg -version 2>&1 | Select-Object -First 3 | ForEach-Object { Write-Host "    $_" }
    Write-Host "  exit code: $LASTEXITCODE"
} else {
    Write-Host "  NOT FOUND at $ffmpeg" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 4. CAN THIS MACHINE REACH THE CHUNK CDN? (the fetch that never returns)" -ForegroundColor Cyan
# The chunk URL from the log. If this hangs or 403s, the download stalls on fetch — which
# is what the log shows: ffmpeg spawned, then nothing, because no chunk ever arrived.
$urls = @()
if (Test-Path $logPath) {
    $u = Select-String -Path $logPath -Pattern 'playlist ok: \d+ chunks, first=(\S+)' |
         Select-Object -Last 1
    if ($u) {
        $base = $u.Matches[0].Groups[1].Value
        $urls += $base
        $urls += ($base -replace '\.ts$', '.ts')
    }
}
if ($urls.Count -gt 0) {
    foreach ($u in $urls) {
        Write-Host "  trying: $($u.Substring(0, [Math]::Min(110, $u.Length)))"
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-WebRequest -Uri $u -TimeoutSec 25 -UseBasicParsing -Method Head
            $sw.Stop()
            Write-Host "    HEAD $($r.StatusCode) in $($sw.ElapsedMilliseconds)ms" -ForegroundColor Green
        } catch {
            Write-Host "    FAILED after $($sw.ElapsedMilliseconds)ms — $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "    => this is why no chunk arrives: the fetch never completes."
        }
    }
} else {
    Write-Host "  no chunk URL found in the log (the run that froze did not log one)."
}
Write-Host "  control — a known-good HTTPS host:"
try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-WebRequest -Uri 'https://github.com' -TimeoutSec 15 -UseBasicParsing -Method Head
    $sw.Stop()
    Write-Host "    github.com HEAD $($r.StatusCode) in $($sw.ElapsedMilliseconds)ms" -ForegroundColor Green
} catch {
    Write-Host "    github.com FAILED — network/proxy problem" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 5. OPEN FOLDER (the button that stopped working)" -ForegroundColor Cyan
try {
    Start-Process explorer.exe -ArgumentList $dataDir -PassThru | Out-Null
    Write-Host "  asked explorer to open: $dataDir"
    Write-Host "  (if the window did not appear, say so — that is itself a data point)"
} catch {
    Write-Host "  explorer failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 6. IS DOWNLOADED MEDIA ACTUALLY ON DISK?"
$vods = Join-Path $dataDir 'cache\vods'
if (Test-Path $vods) {
    Get-ChildItem $vods -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 8 |
        ForEach-Object { Write-Host ("    {0,12:N0}  {1}" -f $_.Length, $_.Name) }
} else {
    Write-Host "  no $vods"
}
Write-Host ""
Write-Host "=== DONE — paste everything above" -ForegroundColor Cyan
