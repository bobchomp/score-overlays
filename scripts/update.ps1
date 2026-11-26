# Score Overlays updater - run it with update.bat (double-click).
# Safely pulls the latest version from GitHub:
#   1. checks Git and Node.js are installed
#   2. stops the running score server (and its remote-access tunnel)
#   3. backs up and resets any edited files that would block the update
#      (your theme is kept: config/theme.json edits are copied to data/theme.json)
#   4. pulls the update and shows what changed
#   5. runs "npm install" only if the dependencies changed
#   6. installs cloudflared (once) if a remote-access tunnel token is set in .env
# Written for Windows PowerShell 5.1 (built into Windows 10/11). ASCII only on purpose.
# -Folder <path> updates a different copy (used by the automated Windows test).
param([string]$Folder = '')

$ErrorActionPreference = 'Continue'   # we check every git/npm exit code ourselves
if ($Folder) { $root = (Resolve-Path $Folder).Path } else { $root = Split-Path -Parent $PSScriptRoot }
Set-Location $root

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail([string]$msg) {
  Write-Host ''
  Write-Host "UPDATE STOPPED: $msg" -ForegroundColor Red
  Write-Host 'Nothing else was changed. Send a screenshot of this window if you need help.' -ForegroundColor Red
  exit 1
}
function Run-Git([string[]]$GitArgs) {
  $out = & git @GitArgs 2>&1 | ForEach-Object { "$_" }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}

Say ''
Say '=== Score Overlays update ===' 'Cyan'
Say "Folder: $root"

# ---- 1. tools --------------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'Git is not installed (or not on PATH). Install it from https://git-scm.com/download/win and run update.bat again.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed (or not on PATH). Install the LTS version from https://nodejs.org and run update.bat again.'
}
if (-not (Test-Path (Join-Path $root '.git'))) {
  Fail 'This folder was not set up with git (was it downloaded as a ZIP?). Download it again with "git clone", then copy your .env and data folder across.'
}

# ---- 2. stop the server ----------------------------------------------------
try {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -match 'server[\\/]+index\.js' })
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($procs.Count -gt 0) {
    Say "Stopped the running score server ($($procs.Count) process)." 'Yellow'
    Start-Sleep -Seconds 1
  } else {
    Say 'Score server was not running.'
  }
} catch {
  Say 'Could not check for a running server. If its window is still open, close it now.' 'Yellow'
}
# The remote-access tunnel the server started (if any) - the server starts it again afterwards.
$tunnelPid = Join-Path $root 'data\cloudflared.pid'
if (Test-Path $tunnelPid) {
  $tp = 0
  [int]::TryParse(((Get-Content -Raw $tunnelPid) -as [string]).Trim(), [ref]$tp) | Out-Null
  $tproc = $null
  if ($tp -gt 0) { $tproc = Get-Process -Id $tp -ErrorAction SilentlyContinue }
  if ($tproc -and $tproc.ProcessName -eq 'cloudflared') {
    Stop-Process -Id $tp -Force -ErrorAction SilentlyContinue
    Say 'Stopped the remote-access tunnel.' 'Yellow'
  }
  Remove-Item $tunnelPid -Force -ErrorAction SilentlyContinue
}

# ---- 3. local edits that would block the pull ------------------------------
$before = (Run-Git @('rev-parse', 'HEAD')).Out.Trim()
$status = Run-Git @('status', '--porcelain', '--untracked-files=no')
if ($status.Code -ne 0) { Fail "git status failed:`n$($status.Out)" }
$changed = @()
foreach ($line in ($status.Out -split "`n")) {
  if ($line.Length -gt 3) {
    $path = $line.Substring(3).Trim().Trim('"')
    if ($path -match ' -> ') { $path = ($path -split ' -> ')[-1] }
    if ($path) { $changed += $path }
  }
}
if ($changed.Count -gt 0) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $root "data\update-backup\$stamp"
  Say ''
  Say 'These files were edited on this PC and would block the update:' 'Yellow'
  foreach ($f in $changed) {
    $src = Join-Path $root $f
    if (Test-Path $src) {
      $dest = Join-Path $backup $f
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $src -Destination $dest -Force
    }
    Say "  $f" 'Yellow'
    if ($f -eq 'config/theme.json') {
      $userTheme = Join-Path $root 'data\theme.json'
      if (-not (Test-Path $userTheme)) {
        Copy-Item -LiteralPath $src -Destination $userTheme -Force
        Say '    Your theme was moved to data\theme.json and stays in use.' 'Green'
      }
    }
  }
  Say "A copy of each was saved in: $backup" 'Yellow'
  $reset = Run-Git (@('reset', '-q', '--') + $changed)
  $co = Run-Git (@('checkout', '--') + $changed)
  if ($co.Code -ne 0) { Fail "Could not reset the edited files:`n$($co.Out)" }
}

# ---- 4. pull ---------------------------------------------------------------
Say ''
Say 'Downloading the latest version...' 'Cyan'
$pull = Run-Git @('pull', '--ff-only', 'origin', 'main')
if ($pull.Code -ne 0) {
  if ($pull.Out -match 'untracked working tree files would be overwritten') {
    Fail "A file you added has the same name as one in the update:`n$($pull.Out)`nRename or move that file, then run update.bat again."
  }
  Fail "git pull failed (check the internet connection):`n$($pull.Out)"
}
$after = (Run-Git @('rev-parse', 'HEAD')).Out.Trim()
if ($after -eq $before) {
  Say 'Already up to date.' 'Green'
} else {
  Say 'Updated. What is new:' 'Green'
  $log = Run-Git @('log', '--oneline', '--no-decorate', "$before..$after")
  Say $log.Out
}

# ---- 5. dependencies -------------------------------------------------------
$needInstall = -not (Test-Path (Join-Path $root 'node_modules'))
if (-not $needInstall -and $after -ne $before) {
  $deps = Run-Git @('diff', '--name-only', $before, $after, '--', 'package.json', 'package-lock.json')
  if ($deps.Out.Trim()) { $needInstall = $true }
}
if ($needInstall) {
  Say ''
  Say 'Installing updated dependencies (npm install)...' 'Cyan'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Check the internet connection and run update.bat again.' }
}

# ---- 6. remote access: install cloudflared once a tunnel token is in .env -----
$envFile = Join-Path $root '.env'
$wantTunnel = (Test-Path $envFile) -and ((Get-Content $envFile) -match '^\s*CLOUDFLARE_TUNNEL_TOKEN\s*=\s*\S')
if ($wantTunnel) {
  $haveCf = (Get-Command cloudflared -ErrorAction SilentlyContinue) -or
    (Test-Path 'C:\Program Files (x86)\cloudflared\cloudflared.exe') -or (Test-Path 'C:\Program Files\cloudflared\cloudflared.exe')
  if (-not $haveCf) {
    Say ''
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Say 'Installing cloudflared for remote access (one time)...' 'Cyan'
      & winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) { Say 'Could not install cloudflared. Remote access stays off; the graphics are not affected.' 'Yellow' }
    } else {
      Say 'Remote access needs cloudflared: download it from https://github.com/cloudflare/cloudflared/releases (Windows .msi). The graphics work without it.' 'Yellow'
    }
  }
}

Say ''
Say 'Update complete. The overlay and dock reload themselves once the server is running.' 'Green'
exit 0
