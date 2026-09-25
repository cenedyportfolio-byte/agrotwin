# Starts AgroTwin on Windows from this folder.
#   .\run.ps1              production: builds the frontend once, then serves it
#   .\run.ps1 dev          hot-reloading dev servers
#   .\run.ps1 -Lan         also listen on the LAN (0.0.0.0) so phones running
#                          the mobile app can reach :8000 and :3000
#   .\run.ps1 stop         stops servers started by any of the above, even
#                          from another window
# From the repo root, npm start / npm run start:lan / npm run stop call this.
# Backend :8000 (from backend\.venv-gpu when present, else backend\.venv),
# frontend :3000. Ctrl-C stops both. Logs go to .\logs\.
# Everything project-related stays on this drive: temp files, package caches
# and compiled CUDA kernels live under .\.cache\.
param([ValidateSet("prod", "dev", "stop")][string]$Mode = "prod", [switch]$Lan)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root
$pidFile = "$root\.cache\run.pid"

function Get-PortOwners {
  @(Get-NetTCPConnection -LocalPort 8000, 3000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

if ($Mode -eq "stop") {
  # The launcher goes first, with its whole tree (watchfiles, uvicorn, next);
  # killing only uvicorn would let watchfiles start it again.
  $launchers = @()
  if (Test-Path $pidFile) { $launchers += [int](Get-Content $pidFile) }
  $self = [regex]::Escape("$root\run.ps1")
  $launchers += Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match $self -and $_.CommandLine -notmatch '\bstop\b' } |
    Select-Object -ExpandProperty ProcessId
  foreach ($id in $launchers | Sort-Object -Unique) {
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { & taskkill /PID $id /T /F 2>&1 | Out-Null }
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  # then orphans still holding a port (docs/DEV_NOTES.md, "stale backend")
  foreach ($id in Get-PortOwners) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if ($p -and $p.CommandLine -match 'agrotwin|uvicorn app\.main') { & taskkill /PID $id /T /F 2>&1 | Out-Null }
  }
  Start-Sleep -Milliseconds 500
  $left = Get-PortOwners
  if ($left) {
    Write-Host "Port 8000 or 3000 is held by another program (PID $($left -join ', ')), not AgroTwin - left alone."
  } else {
    Write-Host "AgroTwin stopped."
  }
  exit 0
}

if (Get-PortOwners) {
  # A second backend binds :8000 fine on Windows, but the old one keeps
  # answering with old code - so never start twice.
  Write-Host "AgroTwin is already running: http://localhost:3000"
  Write-Host "To restart it: npm run stop, then npm start"
  exit 0
}

foreach ($d in "logs", ".cache\tmp", ".cache\uv", ".cache\pip", ".cache\torch_extensions") {
  New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
}
$env:TEMP = "$root\.cache\tmp"; $env:TMP = $env:TEMP
$env:UV_CACHE_DIR = "$root\.cache\uv"
$env:PIP_CACHE_DIR = "$root\.cache\pip"
$env:TORCH_EXTENSIONS_DIR = "$root\.cache\torch_extensions"

$python = "$root\backend\.venv-gpu\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "$root\backend\.venv\Scripts\python.exe" }
if (-not (Test-Path $python)) {
  Write-Host "No backend virtualenv found. Create one first, e.g.:"
  Write-Host "  uv venv backend\.venv-gpu --python 3.11"
  Write-Host "  uv pip install --python backend\.venv-gpu\Scripts\python.exe -r backend\requirements.txt"
  exit 1
}
if (-not (Test-Path "$root\frontend\node_modules")) {
  Write-Host "frontend\node_modules missing - run: cd frontend; npm ci"
  exit 1
}

# stored absolute paths -> this checkout (no-op when nothing moved)
Push-Location "$root\backend"
& $python -m scripts.relocate_paths 2>$null | Out-Null
Pop-Location

$bind = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
$backendArgs = "-m uvicorn app.main:app --host $bind --port 8000"
# Dev reload watches app\ only: the API never imports backend\scripts (the GPU
# pipeline), so edits there must not restart it.
if ($Mode -eq "dev") {
  # uvicorn's own --reload cannot restart its worker here: on Windows it sends
  # CTRL_C_EVENT, which never stops the worker in this hidden console, and the
  # reloader then waits forever (verified 2026-09-18). watchfiles restarts the
  # whole uvicorn process with TerminateProcess instead, which works.
  $backendArgs = "-m watchfiles --filter python --target-type command `"$python $backendArgs`" app"
}
# The backend gets its own (hidden) console. On Windows, uvicorn --reload
# restarts its worker with CTRL_C_EVENT, which is delivered to every process
# on the same console; with -NoNewWindow that Ctrl-C also hit this script and
# the frontend, so every reload took the whole stack down.
$backend = Start-Process -FilePath $python -ArgumentList $backendArgs -WorkingDirectory "$root\backend" -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput "$root\logs\backend.log" -RedirectStandardError "$root\logs\backend.err.log"

$next = "node_modules\next\dist\bin\next"
if ($Mode -eq "dev") {
  $frontendArgs = "$next dev -H $bind -p 3000"
} else {
  if (-not (Test-Path "$root\frontend\.next\BUILD_ID")) {
    Write-Host "Building the frontend (first run only)..."
    Push-Location "$root\frontend"
    & node scripts\copy-cesium.mjs
    & node $next build
    Pop-Location
  }
  $frontendArgs = "$next start -H $bind -p 3000"
}
$frontend = Start-Process -FilePath "node" -ArgumentList $frontendArgs -WorkingDirectory "$root\frontend" -PassThru -NoNewWindow `
  -RedirectStandardOutput "$root\logs\frontend.log" -RedirectStandardError "$root\logs\frontend.err.log"

Write-Host "AgroTwin: http://localhost:3000   (API docs: http://localhost:8000/docs)   mode=$Mode"
if ($Lan) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
  if ($ip) { Write-Host "LAN: http://${ip}:3000  API http://${ip}:8000  (use these in mobile\.env; allow ports 3000/8000 in Windows Firewall)" }
}
Write-Host "Logs: logs\backend.log, logs\frontend.log   Ctrl-C stops both servers."
if (-not (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host "Note: Ollama is not running, so Ask AI can't use the local model - start the Ollama app."
}
Set-Content -Path $pidFile -Value $PID
try {
  while (-not $backend.HasExited -and -not $frontend.HasExited) { Start-Sleep -Seconds 1 }
  if ($backend.HasExited) { Write-Host "backend exited ($($backend.ExitCode)) - see logs\backend.err.log" }
  if ($frontend.HasExited) { Write-Host "frontend exited ($($frontend.ExitCode)) - see logs\frontend.err.log" }
} finally {
  # Kill the whole trees: watchfiles/uvicorn and next both spawn children,
  # and an orphaned child keeps the port and answers with stale code.
  foreach ($p in $backend, $frontend) {
    if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
