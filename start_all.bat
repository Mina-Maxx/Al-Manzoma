@echo off
setlocal enabledelayedexpansion

title QuarryVault Launcher

echo ======================================================================
echo                  QuarryVault Unified Startup Script
echo ======================================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "MODE=dev"
if /i "%~1"=="prod" set "MODE=prod"

:: ----------------------------------------------------------------------
:: 1. Verify Docker Engine & Launch Docker Desktop if necessary
:: ----------------------------------------------------------------------
echo [1/4] Checking Docker status...
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 'docker' command was not found in PATH.
    echo Please make sure Docker Desktop is installed and added to your System PATH.
    echo Default path: C:\Program Files\Docker\Docker\resources\bin
    echo.
    pause
    exit /b 1
)

docker info >nul 2>&1
if %errorlevel% equ 0 goto DOCKER_READY

echo [INFO] Docker daemon is not running. Attempting to start Docker Desktop...
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
) else (
    echo [WARNING] Docker Desktop.exe not found at standard location:
    echo           C:\Program Files\Docker\Docker\Docker Desktop.exe
    echo Please launch Docker Desktop manually from the Start Menu, then re-run this script.
    pause
    exit /b 1
)

echo [INFO] Waiting for Docker engine to become ready...
set /a D_RETRIES=0
:WAIT_DOCKER
ping -n 3 127.0.0.1 >nul
docker info >nul 2>&1
if %errorlevel% equ 0 goto DOCKER_READY
set /a D_RETRIES+=1
if !D_RETRIES! geq 30 (
    echo [ERROR] Docker engine did not start within the expected time.
    echo Please ensure Docker Desktop is running and try again.
    pause
    exit /b 1
)
goto WAIT_DOCKER

:DOCKER_READY
echo [OK] Docker engine is running.

:: ----------------------------------------------------------------------
:: 2. MongoDB Container Management (quarryvault-mongodb)
:: ----------------------------------------------------------------------
echo.
echo [2/4] Ensuring MongoDB container quarryvault-mongodb is running...
docker inspect -f "{{.State.Running}}" quarryvault-mongodb 2>nul | findstr /i "true" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] MongoDB container is already running.
    goto WAIT_MONGO_READY
)

docker inspect quarryvault-mongodb >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Starting stopped container quarryvault-mongodb...
    docker start quarryvault-mongodb >nul
) else (
    echo [INFO] Container quarryvault-mongodb not found. Creating and starting container...
    docker volume inspect quarryvault-mongo-data >nul 2>&1
    if !errorlevel! neq 0 docker volume create quarryvault-mongo-data >nul
    if !errorlevel! neq 0 (
        echo [ERROR] Could not create MongoDB data volume.
        pause
        exit /b 1
    )
    docker volume inspect quarryvault-mongo-config >nul 2>&1
    if !errorlevel! neq 0 docker volume create quarryvault-mongo-config >nul
    if !errorlevel! neq 0 (
        echo [ERROR] Could not create MongoDB config volume.
        pause
        exit /b 1
    )
    docker run -d --name quarryvault-mongodb -p 127.0.0.1:27017:27017 -v quarryvault-mongo-data:/data/db -v quarryvault-mongo-config:/data/configdb mongo:8 mongod --replSet rs0 --bind_ip_all >nul
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create MongoDB container. Check Docker logs.
        pause
        exit /b 1
    )
)

:WAIT_MONGO_READY
echo [INFO] Verifying MongoDB database connectivity on port 27017...
set /a M_RETRIES=0
:POLL_MONGO
docker exec quarryvault-mongodb mongosh --quiet --eval "db.adminCommand('ping')" 2>nul | findstr /i "ok: 1" >nul 2>&1
if %errorlevel% equ 0 goto MONGO_READY
ping -n 2 127.0.0.1 >nul
set /a M_RETRIES+=1
if !M_RETRIES! geq 20 (
    echo [ERROR] MongoDB did not become ready; backend and dashboard were not started.
    pause
    exit /b 1
)
goto POLL_MONGO

:MONGO_READY
echo [OK] MongoDB is ready and accepting connections!
for /f "delims=" %%R in ('docker exec quarryvault-mongodb mongosh --quiet --eval "try { rs.status().myState } catch (e) { e.codeName === 'NotYetInitialized' ? 'uninitialized' : 'standalone' }" 2^>nul') do set "REPLICA_STATUS=%%R"
if "!REPLICA_STATUS!"=="uninitialized" (
    docker exec quarryvault-mongodb mongosh --quiet --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})" >nul
    if !errorlevel! neq 0 (
        echo [ERROR] Could not initialize MongoDB replica set rs0.
        pause
        exit /b 1
    )
    ping -n 3 127.0.0.1 >nul
)
set /a RS_RETRIES=0
:WAIT_RS_PRIMARY
for /f "delims=" %%R in ('docker exec quarryvault-mongodb mongosh --quiet --eval "try { rs.status().myState } catch (e) { 0 }" 2^>nul') do set "REPLICA_STATUS=%%R"
if "!REPLICA_STATUS!"=="1" goto RS_PRIMARY
ping -n 2 127.0.0.1 >nul
set /a RS_RETRIES+=1
if !RS_RETRIES! geq 30 (
    echo [ERROR] MongoDB is not PRIMARY in replica set rs0; backend and dashboard were not started.
    pause
    exit /b 1
)
goto WAIT_RS_PRIMARY
:RS_PRIMARY
echo [OK] MongoDB replica set rs0 is PRIMARY.

:: ----------------------------------------------------------------------
:: 3. Launch Backend Server (Port 8000)
:: ----------------------------------------------------------------------
echo.
echo [3/4] Launching Express Backend Server on port 8000 (Mode: %MODE%)...
if not exist "%SCRIPT_DIR%backend\node_modules" (
    echo [INFO] Installing backend dependencies...
    pushd "%SCRIPT_DIR%backend"
    call npm.cmd install
    popd
)

if /i "%MODE%"=="prod" (
    echo [INFO] Building latest backend source...
    pushd "%SCRIPT_DIR%backend"
    call npm.cmd run build
    if !errorlevel! neq 0 (
        popd
        echo [ERROR] Backend build failed; not starting a stale server.
        pause
        exit /b 1
    )
    popd
    start "QuarryVault Backend [Port 8000]" cmd /k "cd /d ""%SCRIPT_DIR%backend"" && title QuarryVault Backend [Port 8000] && npm.cmd start"
) else (
    start "QuarryVault Backend [Port 8000]" cmd /k "cd /d ""%SCRIPT_DIR%backend"" && title QuarryVault Backend [Port 8000] && npm.cmd run dev"
)

:: ----------------------------------------------------------------------
:: 4. Launch Admin Frontend (Port 3001)
:: ----------------------------------------------------------------------
echo.
echo [4/4] Launching Next.js Admin Portal on port 3001 (Mode: %MODE%)...
if not exist "%SCRIPT_DIR%admin\node_modules" (
    echo [INFO] Installing admin dependencies...
    pushd "%SCRIPT_DIR%admin"
    call npm.cmd install
    popd
)

if /i "%MODE%"=="prod" (
    echo [INFO] Building latest Admin Dashboard source...
    pushd "%SCRIPT_DIR%admin"
    call npm.cmd run build
    if !errorlevel! neq 0 (
        popd
        echo [ERROR] Dashboard build failed; not starting a stale portal.
        pause
        exit /b 1
    )
    popd
    start "QuarryVault Admin [Port 3001]" cmd /k "cd /d ""%SCRIPT_DIR%admin"" && title QuarryVault Admin [Port 3001] && npm.cmd start"
) else (
    start "QuarryVault Admin [Port 3001]" cmd /k "cd /d ""%SCRIPT_DIR%admin"" && title QuarryVault Admin [Port 3001] && npm.cmd run dev"
)

:: ----------------------------------------------------------------------
:: 5. Readiness Polling & Summary
:: ----------------------------------------------------------------------
echo.
echo [INFO] Waiting for services to initialize...
set /a H_RETRIES=0
:POLL_HEALTH
ping -n 3 127.0.0.1 >nul
curl.exe -s http://localhost:8000/health 2>nul | findstr /i "healthy" >nul 2>&1
if %errorlevel% equ 0 goto BACKEND_UP
set /a H_RETRIES+=1
if !H_RETRIES! geq 25 (
    echo [ERROR] Backend did not become healthy. Check the Backend terminal window.
    pause
    exit /b 1
)
goto POLL_HEALTH

:BACKEND_UP
echo [OK] Backend API is responding and healthy!

echo [INFO] Waiting for Admin Dashboard on port 3001...
set /a A_RETRIES=0
:POLL_ADMIN
curl.exe -s -o nul -w "%%{http_code}" http://localhost:3001/ 2>nul | findstr /x "200" >nul 2>&1
if !errorlevel! equ 0 goto ADMIN_UP
ping -n 3 127.0.0.1 >nul
set /a A_RETRIES+=1
if !A_RETRIES! geq 25 (
    echo [ERROR] Admin Dashboard did not become available on port 3001.
    pause
    exit /b 1
)
goto POLL_ADMIN

:ADMIN_UP
echo [OK] Admin Dashboard is responding!

:PRINT_SUMMARY
echo.
echo ======================================================================
echo              QuarryVault Services Started Successfully!
echo ======================================================================
echo.
echo   * Backend API:        http://localhost:8000
echo   * Backend Health:     http://localhost:8000/health
echo   * Admin Portal:       http://localhost:3001
echo   * MongoDB Database:   mongodb://127.0.0.1:27017/quarryvault
echo.
echo   ------------------------------------------------------------------
echo   * Each service is running in its own terminal window.
echo   * To stop everything cleanly anytime, run: stop_all.bat
echo ======================================================================
echo.
pause
