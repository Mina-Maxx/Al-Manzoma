<#
.SYNOPSIS
    QuarryVault - Unified Multi-Process Startup Script (PowerShell)
.DESCRIPTION
    Checks Docker status, ensures MongoDB is healthy, and launches both Backend and Admin servers.
.PARAMETER Mode
    'dev' for tsx/next dev (default), or 'prod' for compiled production server.
.PARAMETER OpenBrowser
    Switch to automatically open the Web Dashboard and Admin Portal in the default browser.
#>

[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')]
    [string]$Mode = 'dev',
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "                 QuarryVault Unified Startup Script                   " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------------------
# 1. Docker Engine Verification
# ----------------------------------------------------------------------
Write-Host "[1/4] Checking Docker status..." -ForegroundColor Yellow
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Write-Host "[ERROR] 'docker' command was not found in PATH." -ForegroundColor Red
    Write-Host "Please install Docker Desktop and make sure it is added to your PATH." -ForegroundColor Red
    exit 1
}

& docker info > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[INFO] Docker daemon is not running. Attempting to start Docker Desktop..." -ForegroundColor Yellow
    $dockerDesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerDesktopExe) {
        Start-Process -FilePath $dockerDesktopExe
    } else {
        Write-Host "[WARNING] Docker Desktop.exe not found at standard path: $dockerDesktopExe" -ForegroundColor Yellow
        Write-Host "Please start Docker Desktop manually, then rerun this script." -ForegroundColor Yellow
        exit 1
    }

    Write-Host "[INFO] Waiting for Docker daemon to become responsive..." -ForegroundColor Yellow
    $dockerReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        & docker info > $null 2>&1
        if ($LASTEXITCODE -eq 0) {
            $dockerReady = $true
            break
        }
    }

    if (-not $dockerReady) {
        Write-Host "[ERROR] Docker engine did not become ready in time." -ForegroundColor Red
        exit 1
    }
}
Write-Host "[OK] Docker engine is running." -ForegroundColor Green

# ----------------------------------------------------------------------
# 2. MongoDB Container Management
# ----------------------------------------------------------------------
Write-Host "`n[2/4] Ensuring MongoDB container (quarryvault-mongodb) is running..." -ForegroundColor Yellow
$isRunning = (& docker inspect -f "{{.State.Running}}" quarryvault-mongodb 2>$null) -eq "true"

if ($isRunning) {
    Write-Host "[OK] MongoDB container is already running." -ForegroundColor Green
} else {
    & docker inspect quarryvault-mongodb > $null 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[INFO] Starting stopped container 'quarryvault-mongodb'..." -ForegroundColor Yellow
        & docker start quarryvault-mongodb > $null
    } else {
        Write-Host "[INFO] Container 'quarryvault-mongodb' not found. Creating and starting..." -ForegroundColor Yellow
        & docker volume create quarryvault-mongo-data > $null
        if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Could not create MongoDB data volume." -ForegroundColor Red; exit 1 }
        & docker volume create quarryvault-mongo-config > $null
        if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Could not create MongoDB config volume." -ForegroundColor Red; exit 1 }
        & docker run -d --name quarryvault-mongodb -p 127.0.0.1:27017:27017 -v quarryvault-mongo-data:/data/db -v quarryvault-mongo-config:/data/configdb mongo:8 mongod --replSet rs0 --bind_ip_all > $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Failed to run MongoDB container." -ForegroundColor Red
            exit 1
        }
    }
}

# Wait for MongoDB ping inside container
Write-Host "[INFO] Verifying MongoDB database connectivity on port 27017..." -ForegroundColor Yellow
$mongoReady = $false
for ($i = 0; $i -lt 20; $i++) {
    $pingOut = & docker exec quarryvault-mongodb mongosh --quiet --eval "db.adminCommand('ping')" 2>$null
    if ($pingOut -match "ok:\s*1") {
        $mongoReady = $true
        break
    }
    Start-Sleep -Seconds 1
}

if ($mongoReady) {
    Write-Host "[OK] MongoDB is ready and accepting queries!" -ForegroundColor Green
} else {
    Write-Host "[ERROR] MongoDB did not become ready; backend and dashboard were not started." -ForegroundColor Red
    exit 1
}

$replicaSetState = & docker exec quarryvault-mongodb mongosh --quiet --eval "try { rs.status().myState } catch (e) { e.codeName === 'NotYetInitialized' ? 'uninitialized' : 'standalone' }" 2>$null
if ($replicaSetState -eq "uninitialized") {
    & docker exec quarryvault-mongodb mongosh --quiet --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})" > $null
    if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Could not initialize MongoDB replica set rs0." -ForegroundColor Red; exit 1 }
}
$replicaSetPrimary = $false
for ($i = 0; $i -lt 30; $i++) {
    $replicaSetState = & docker exec quarryvault-mongodb mongosh --quiet --eval "try { rs.status().myState } catch (e) { 0 }" 2>$null
    if ($replicaSetState -eq "1") { $replicaSetPrimary = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $replicaSetPrimary) {
    Write-Host "[ERROR] MongoDB is not PRIMARY in replica set rs0; backend and dashboard were not started." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] MongoDB replica set rs0 is PRIMARY." -ForegroundColor Green

# ----------------------------------------------------------------------
# 3. Launch Backend Server (Port 8000)
# ----------------------------------------------------------------------
Write-Host "`n[3/4] Launching Express Backend Server on port 8000 (Mode: $Mode)..." -ForegroundColor Yellow
$backendDir = Join-Path $ScriptDir "backend"
if (-not (Test-Path (Join-Path $backendDir "node_modules"))) {
    Write-Host "[INFO] Installing backend dependencies..." -ForegroundColor Yellow
    Push-Location $backendDir
    & npm.cmd install
    Pop-Location
}

if ($Mode -eq 'prod') {
    Write-Host "[INFO] Building latest backend source..." -ForegroundColor Yellow
    Push-Location $backendDir
    & npm.cmd run build
    $backendBuildExitCode = $LASTEXITCODE
    Pop-Location
    if ($backendBuildExitCode -ne 0) { Write-Host "[ERROR] Backend build failed; not starting a stale server." -ForegroundColor Red; exit 1 }
    Start-Process cmd.exe -ArgumentList "/k title QuarryVault Backend [Port 8000] && cd /d `"$backendDir`" && npm.cmd start"
} else {
    Start-Process cmd.exe -ArgumentList "/k title QuarryVault Backend [Port 8000] && cd /d `"$backendDir`" && npm.cmd run dev"
}

# ----------------------------------------------------------------------
# 4. Launch Admin Frontend (Port 3001)
# ----------------------------------------------------------------------
Write-Host "`n[4/4] Launching Next.js Admin Portal on port 3001 (Mode: $Mode)..." -ForegroundColor Yellow
$adminDir = Join-Path $ScriptDir "admin"
if (-not (Test-Path (Join-Path $adminDir "node_modules"))) {
    Write-Host "[INFO] Installing admin dependencies..." -ForegroundColor Yellow
    Push-Location $adminDir
    & npm.cmd install
    Pop-Location
}

if ($Mode -eq 'prod') {
    Write-Host "[INFO] Building latest Admin Dashboard source..." -ForegroundColor Yellow
    Push-Location $adminDir
    & npm.cmd run build
    $adminBuildExitCode = $LASTEXITCODE
    Pop-Location
    if ($adminBuildExitCode -ne 0) { Write-Host "[ERROR] Dashboard build failed; not starting a stale portal." -ForegroundColor Red; exit 1 }
    Start-Process cmd.exe -ArgumentList "/k title QuarryVault Admin [Port 3001] && cd /d `"$adminDir`" && npm.cmd start"
} else {
    Start-Process cmd.exe -ArgumentList "/k title QuarryVault Admin [Port 3001] && cd /d `"$adminDir`" && npm.cmd run dev"
}

# ----------------------------------------------------------------------
# 5. Readiness Polling & Summary
# ----------------------------------------------------------------------
Write-Host "`n[INFO] Polling services for health status..." -ForegroundColor Yellow
$backendHealthy = $false
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8000/health" -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.status -eq "healthy") {
            $backendHealthy = $true
            break
        }
    } catch {}
}

if ($backendHealthy) {
    Write-Host "[OK] Backend API is responding and healthy!" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Backend did not become healthy. Check the Backend console window." -ForegroundColor Red
    exit 1
}

$adminHealthy = $false
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 2
    try {
        $adminResponse = Invoke-WebRequest -Uri "http://localhost:3001/" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($adminResponse.StatusCode -eq 200) { $adminHealthy = $true; break }
    } catch {}
}
if (-not $adminHealthy) {
    Write-Host "[ERROR] Admin Dashboard did not become available on port 3001." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Admin Dashboard is responding!" -ForegroundColor Green

Write-Host "`n======================================================================" -ForegroundColor Cyan
Write-Host "              QuarryVault Services Started Successfully!              " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  * Backend API:        http://localhost:8000" -ForegroundColor White
Write-Host "  * Backend Health:     http://localhost:8000/health" -ForegroundColor White
Write-Host "  * Admin Portal:       http://localhost:3001" -ForegroundColor White
Write-Host "  * MongoDB Database:   mongodb://127.0.0.1:27017/quarryvault" -ForegroundColor White
Write-Host ""
Write-Host "  ------------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  * Each service is running in its own terminal window." -ForegroundColor DarkGray
Write-Host "  * To stop everything cleanly anytime, run: .\stop_all.ps1 or stop_all.bat" -ForegroundColor DarkGray
Write-Host "======================================================================`n" -ForegroundColor Cyan

if ($OpenBrowser) {
    Start-Process "http://localhost:3001"
}
