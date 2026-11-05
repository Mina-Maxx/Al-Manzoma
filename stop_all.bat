@echo off
setlocal enabledelayedexpansion

title QuarryVault Shutdown

echo ======================================================================
echo                  QuarryVault Clean Shutdown Script
echo ======================================================================
echo.

:: ----------------------------------------------------------------------
:: 1. Terminate Backend and Admin Node.js Processes (Ports 8000 & 3001)
:: ----------------------------------------------------------------------
echo [1/2] Terminating servers on ports 8000 (Backend) and 3001 (Admin)...

powershell -NoProfile -Command ^
    "$ports = @(8000, 3001); " ^
    "$pids = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue | " ^
    "Select-Object -ExpandProperty OwningProcess -Unique; " ^
    "if ($pids) { " ^
    "    foreach ($pidToKill in $pids) { " ^
    "        try { " ^
    "            Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue; " ^
    "            Write-Host ('[OK] Stopped process PID: ' + $pidToKill); " ^
    "        } catch {} " ^
    "    } " ^
    "} else { " ^
    "    Write-Host '[INFO] No running processes found on ports 8000 or 3001.'; " ^
    "}"

:: ----------------------------------------------------------------------
:: 2. Stop Docker Container (quarryvault-mongodb)
:: ----------------------------------------------------------------------
echo.
echo [2/2] Stopping Docker container 'quarryvault-mongodb'...
docker inspect -f "{{.State.Running}}" quarryvault-mongodb 2>nul | findstr /i "true" >nul 2>&1
if %errorlevel% equ 0 (
    docker stop quarryvault-mongodb >nul 2>&1
    echo [OK] MongoDB container stopped cleanly.
) else (
    echo [INFO] MongoDB container was not running.
)

echo.
echo ======================================================================
echo          All QuarryVault services have been stopped cleanly!
echo ======================================================================
echo.
pause
