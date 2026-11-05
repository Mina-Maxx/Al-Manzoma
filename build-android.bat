@echo off
setlocal
title QuarryVault Android Builder

set "SCRIPT_DIR=%~dp0"

echo ======================================================================
echo               QuarryVault Android Build Launcher (Windows)
echo ======================================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-android.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if %EXIT_CODE% equ 0 (
    echo [INFO] Build completed successfully.
) else (
    echo [ERROR] Build failed with exit code %EXIT_CODE%.
)

echo.
echo Press any key to exit...
pause >nul
exit /b %EXIT_CODE%
