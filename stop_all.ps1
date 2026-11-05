<#
.SYNOPSIS
    QuarryVault - Clean Multi-Process Shutdown Script (PowerShell)
.DESCRIPTION
    Stops processes listening on ports 8000 and 3001 and halts the MongoDB Docker container.
#>

[CmdletBinding()]
param()

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "                  QuarryVault Clean Shutdown Script                   " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------------------
# 1. Terminate Backend and Admin processes
# ----------------------------------------------------------------------
Write-Host "[1/2] Terminating servers on ports 8000 (Backend) and 3001 (Admin)..." -ForegroundColor Yellow

$ports = @(8000, 3001)
$pids = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if ($pids) {
    foreach ($procId in $pids) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Write-Host "[OK] Stopped process PID: $procId" -ForegroundColor Green
        } catch {
            Write-Host "[WARNING] Could not stop PID: $procId" -ForegroundColor DarkYellow
        }
    }
} else {
    Write-Host "[INFO] No running processes found on ports 8000 or 3001." -ForegroundColor Green
}

# ----------------------------------------------------------------------
# 2. Stop Docker Container
# ----------------------------------------------------------------------
Write-Host "`n[2/2] Stopping Docker container 'quarryvault-mongodb'..." -ForegroundColor Yellow
$isRunning = (& docker inspect -f "{{.State.Running}}" quarryvault-mongodb 2>$null) -eq "true"

if ($isRunning) {
    & docker stop quarryvault-mongodb > $null 2>&1
    Write-Host "[OK] MongoDB container stopped cleanly." -ForegroundColor Green
} else {
    Write-Host "[INFO] MongoDB container was not running." -ForegroundColor Green
}

Write-Host "`n======================================================================" -ForegroundColor Cyan
Write-Host "          All QuarryVault services have been stopped cleanly!         " -ForegroundColor Cyan
Write-Host "======================================================================`n" -ForegroundColor Cyan
