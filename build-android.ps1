<#
.SYNOPSIS
    QuarryVault Android Application Build Script (PowerShell)

.DESCRIPTION
    Builds the QuarryVault Android Employee App using the Gradle wrapper and project configuration.
    Verifies the repository environment, determines app version, builds the target APK,
    validates the output artifact, and copies the ready-to-install APK to dist/android/.

.PARAMETER BuildType
    The build type to produce: 'debug' (default, signed with debug key, ready to install)
    or 'release' (unsigned, since release signing is not configured in the repo).

.PARAMETER RunTests
    Switch to run unit tests (:app:testDebugUnitTest) prior to building the APK.

.PARAMETER Clean
    Switch to execute Gradle clean (:app:clean) before building.

.PARAMETER OutputDir
    Custom directory for the final distributable APK artifact. Defaults to <repo-root>/dist/android.

.EXAMPLE
    .\build-android.ps1
    Builds the default debug APK, signed and ready to install.

.EXAMPLE
    .\build-android.ps1 -BuildType release
    Builds the release APK (unsigned).

.EXAMPLE
    .\build-android.ps1 -RunTests -Clean
    Runs clean, executes all unit tests, and builds the debug APK.
#>

[CmdletBinding()]
param(
    [ValidateSet('debug', 'release')]
    [string]$BuildType = 'debug',

    [switch]$RunTests,
    [switch]$Clean,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

# -----------------------------------------------------------------------------
# 1. Automatic Path & Environment Resolution
# -----------------------------------------------------------------------------
$ScriptPath = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = (Resolve-Path $ScriptPath).Path
$AndroidDir = Join-Path $RepoRoot "android"
$GradlewBat = Join-Path $AndroidDir "gradlew.bat"
$VersionFile = Join-Path $AndroidDir "version.properties"
$BuildGradle = Join-Path $AndroidDir "app/build.gradle.kts"

if (-not $OutputDir) {
    $OutputDir = Join-Path $RepoRoot "dist/android"
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "                 QuarryVault Android Build Script                     " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Repository Root  : $RepoRoot"
Write-Host "Android Project  : $AndroidDir"
Write-Host "Target Variant   : $BuildType"
Write-Host "Destination Dir  : $OutputDir"
Write-Host ""

# -----------------------------------------------------------------------------
# 2. Prerequisite & File Verification
# -----------------------------------------------------------------------------
Write-Host "[1/5] Verifying project files and tools..." -ForegroundColor Yellow

if (-not (Test-Path $AndroidDir)) {
    Write-Host "[ERROR] Android directory not found: $AndroidDir" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $GradlewBat)) {
    Write-Host "[ERROR] Gradle wrapper script not found: $GradlewBat" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $BuildGradle)) {
    Write-Host "[ERROR] App build.gradle.kts not found: $BuildGradle" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $VersionFile)) {
    Write-Host "[ERROR] Version properties file not found: $VersionFile" -ForegroundColor Red
    exit 1
}

# Verify Java availability
$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCmd) {
    Write-Host "[ERROR] 'java' command not found in PATH. Java Development Kit (JDK 17+) is required." -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------------------------
# 3. Read Current Configured Version
# -----------------------------------------------------------------------------
Write-Host "[2/5] Inspecting configured version..." -ForegroundColor Yellow

function Get-ProjectVersion($path) {
    $props = @{}
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $parts = $line.Split('=', 2)
            $props[$parts[0].Trim()] = $parts[1].Trim()
        }
    }
    $major = if ($props.ContainsKey('version.major')) { [int]$props['version.major'] } else { 1 }
    $minor = if ($props.ContainsKey('version.minor')) { [int]$props['version.minor'] } else { 0 }
    $code  = if ($props.ContainsKey('version.code'))  { [int]$props['version.code'] }  else { 1 }
    $name  = if ($props.ContainsKey('version.name'))  { $props['version.name'] }       else { "$major.$minor.$code" }
    return [PSCustomObject]@{
        Major = $major
        Minor = $minor
        Code  = $code
        Name  = $name
    }
}

$initialVersion = Get-ProjectVersion $VersionFile
Write-Host "Configured Version Code : $($initialVersion.Code)" -ForegroundColor Green
Write-Host "Configured Version Name : $($initialVersion.Name)" -ForegroundColor Green

# -----------------------------------------------------------------------------
# 4. Check Signing Status
# -----------------------------------------------------------------------------
Write-Host "[3/5] Checking signing configuration..." -ForegroundColor Yellow

if ($BuildType -eq 'debug') {
    Write-Host "Signing Mode : Android Debug Keystore (Automatic, Signed, Ready to Install)" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Release signing is not configured in build.gradle.kts." -ForegroundColor Magenta
    Write-Host "          Gradle will produce an unsigned release APK (app-release-unsigned.apk)." -ForegroundColor Magenta
    Write-Host "          Unsigned APKs cannot be installed on Android devices without external signing." -ForegroundColor Magenta
    Write-Host "          Tip: Use '-BuildType debug' (default) to produce a ready-to-install signed APK." -ForegroundColor Cyan
}

# -----------------------------------------------------------------------------
# 5. Execute Gradle Build
# -----------------------------------------------------------------------------
Write-Host "[4/5] Executing Gradle tasks..." -ForegroundColor Yellow

$gradleTasks = [System.Collections.Generic.List[string]]::new()

if ($Clean) {
    $gradleTasks.Add(":app:clean")
}

if ($RunTests) {
    $gradleTasks.Add(":app:testDebugUnitTest")
}

if ($BuildType -eq 'debug') {
    $gradleTasks.Add(":app:assembleDebug")
} else {
    $gradleTasks.Add(":app:assembleRelease")
}

Write-Host "Running Gradle command: gradlew.bat $($gradleTasks -join ' ')" -ForegroundColor Cyan

Push-Location $AndroidDir
try {
    & $GradlewBat $gradleTasks
    $buildExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($buildExitCode -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] Gradle build failed with exit code $buildExitCode." -ForegroundColor Red
    exit $buildExitCode
}

# -----------------------------------------------------------------------------
# 6. Locate, Validate, and Copy Built APK
# -----------------------------------------------------------------------------
Write-Host "[5/5] Locating and validating generated APK..." -ForegroundColor Yellow

$apkSubDir = Join-Path $AndroidDir "app/build/outputs/apk/$BuildType"
$expectedApkPattern = if ($BuildType -eq 'debug') { "app-debug.apk" } else { "*release*.apk" }
$foundApks = Get-ChildItem -Path $apkSubDir -Filter $expectedApkPattern -File -ErrorAction SilentlyContinue

if (-not $foundApks -or $foundApks.Count -eq 0) {
    Write-Host "[ERROR] Expected APK not found in: $apkSubDir" -ForegroundColor Red
    exit 1
}

$builtApk = $foundApks[0]
if ($builtApk.Length -le 0) {
    Write-Host "[ERROR] Generated APK file is empty (0 bytes): $($builtApk.FullName)" -ForegroundColor Red
    exit 1
}

# Read updated version properties (auto-incremented on APK build by project Gradle logic)
$finalVersion = Get-ProjectVersion $VersionFile

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$isUnsigned = $builtApk.Name.Contains("unsigned")
$variantSuffix = if ($isUnsigned) { "$BuildType-unsigned" } else { $BuildType }
$targetApkName = "quarryvault-v$($finalVersion.Name)-$variantSuffix.apk"
$targetApkPath = Join-Path $OutputDir $targetApkName

# Copy artifact
Copy-Item -Path $builtApk.FullName -Destination $targetApkPath -Force

if (-not (Test-Path $targetApkPath) -or (Get-Item $targetApkPath).Length -le 0) {
    Write-Host "[ERROR] Failed to copy artifact to: $targetApkPath" -ForegroundColor Red
    exit 1
}

$finalItem = Get-Item $targetApkPath
$finalSizeMb = [math]::Round($finalItem.Length / 1MB, 2)
$sha256 = (Get-FileHash -Path $targetApkPath -Algorithm SHA256).Hash

# -----------------------------------------------------------------------------
# 7. Final Summary
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "                   BUILD SUCCESSFUL - SUMMARY                         " -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
$signDesc = if ($isUnsigned) { "Unsigned (Requires external signing for device install)" } else { "Signed with Debug Keystore (Ready to install on device/emulator)" }
$signColor = if ($isUnsigned) { "Magenta" } else { "Green" }
$rawBytes = $finalItem.Length
$sizeDisplay = "{0} MB ({1} bytes)" -f $finalSizeMb, $rawBytes

Write-Host "Status            : SUCCESS" -ForegroundColor Green
Write-Host "Application Name  : QuarryVault Employee App"
Write-Host "Application ID    : com.quarryvault.employee"
Write-Host "Version Name      : $($finalVersion.Name)" -ForegroundColor Cyan
Write-Host "Version Code      : $($finalVersion.Code)" -ForegroundColor Cyan
Write-Host "Build Variant     : $BuildType"
Write-Host "Signing Status    : $signDesc" -ForegroundColor $signColor
Write-Host "Gradle Artifact   : $($builtApk.FullName)"
Write-Host "Distributable APK : $targetApkPath" -ForegroundColor Cyan
Write-Host "File Size         : $sizeDisplay"
Write-Host "SHA-256 Checksum  : $sha256"
Write-Host "======================================================================" -ForegroundColor Green
Write-Host ""

exit 0
