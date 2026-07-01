# launch_chrome.ps1
# Makes Chrome ready for browser-use CDP attachment on port 9222.
#
# Strategy:
#   - If Chrome is NOT running → kill any stale locks, launch with --remote-debugging-port
#   - If Chrome IS  running   → copy the Default profile to a temp dir,
#                               launch a SECOND Chrome pointing at the copy + CDP port
#     (so your daily Chrome keeps working alongside the agent Chrome)
#
# Usage:
#   .\launch_chrome.ps1                         # auto mode (recommended)
#   .\launch_chrome.ps1 -ProfileDir "Profile 2" # pick a different source profile
#   .\launch_chrome.ps1 -Port 9223              # different port
#   .\launch_chrome.ps1 -ForceKill              # always kill existing Chrome first

param(
    [string]$ProfileDir = "Default",
    [int]   $Port       = 9222,
    [switch]$ForceKill
)

# ── Find chrome.exe ────────────────────────────────────────────────────────────
$candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromePath) {
    Write-Error "chrome.exe not found. Add its path to the `$candidates list."
    exit 1
}

$realUserData  = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$chromeRunning = [bool](Get-Process -Name "chrome" -ErrorAction SilentlyContinue)

# ── Decide mode ────────────────────────────────────────────────────────────────
if ($ForceKill -or -not $chromeRunning) {

    # Mode A: kill everything, launch fresh with debug port on real profile
    Write-Host "[Mode A] Killing Chrome, launching with real profile + CDP..."

    taskkill /F /IM chrome.exe /T 2>$null | Out-Null
    Start-Sleep -Milliseconds 800

    # Remove stale singleton locks
    "SingletonLock","SingletonCookie","SingletonSocket" | ForEach-Object {
        $f = Join-Path $realUserData $_
        if (Test-Path $f) { Remove-Item $f -Force }
    }

    $targetUserData = $realUserData

} else {

    # Mode B: Chrome is running — use a profile COPY so both can coexist
    Write-Host "[Mode B] Chrome is already running. Using a profile copy so both can run simultaneously."
    Write-Host "Note: the agent Chrome will have the cookies/logins from the last time the copy was synced."
    Write-Host ""

    $copyBase   = "$env:TEMP\cight-agent-profile"
    $copyTarget = "$copyBase\$ProfileDir"
    $srcProfile = "$realUserData\$ProfileDir"

    if (-not (Test-Path $copyTarget)) {
        Write-Host "Copying profile '$ProfileDir' to $copyTarget (first time — may take a moment)..."
        New-Item -ItemType Directory -Path $copyBase -Force | Out-Null
        Copy-Item -Recurse -Force $srcProfile $copyTarget
        Write-Host "Profile copied."
    } else {
        Write-Host "Using existing profile copy at $copyTarget"
        Write-Host "(Delete $copyBase to force a fresh copy next time)"
    }

    $targetUserData = $copyBase
}

# ── Check if port already in use ──────────────────────────────────────────────
$portInUse = netstat -ano 2>$null | Select-String ":$Port " | Measure-Object | Select-Object -ExpandProperty Count
if ($portInUse -gt 0) {
    Write-Warning "Port $Port is already in use. Another Chrome with CDP may already be running."
    Write-Host "Verify: http://localhost:$Port/json/version"
    exit 0
}

# ── Launch Chrome ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Launching Chrome:"
Write-Host "  Executable : $chromePath"
Write-Host "  User data  : $targetUserData"
Write-Host "  Profile    : $ProfileDir"
Write-Host "  CDP port   : $Port"
Write-Host ""

Start-Process -FilePath $chromePath -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$targetUserData",
    "--profile-directory=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
)

# ── Poll until CDP is ready ────────────────────────────────────────────────────
Write-Host "Waiting for CDP to become available on port $Port..."
$ready    = $false
$deadline = (Get-Date).AddSeconds(20)

while (-not $ready -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -TimeoutSec 1 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ready = $true }
    } catch { }
}

if ($ready) {
    Write-Host ""
    Write-Host "CDP ready at http://localhost:$Port/json/version" -ForegroundColor Green
    Write-Host ""
    Write-Host "Start the FastAPI server with:" -ForegroundColor Cyan
    Write-Host "  .venv\Scripts\uvicorn.exe agent_bridge.server:app --port 8000 --reload" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Warning "CDP did not respond within 20 seconds."
    Write-Warning "Check that Chrome opened a window, then try: http://localhost:$Port/json/version"
}
