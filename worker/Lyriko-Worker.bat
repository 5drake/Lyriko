@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"
pushd "%BASE_DIR%"

set "LYRIKO_PORTABLE=1"
set "UTAKANA_PORTABLE=1"
set "LYRIKO_DATA_DIR=%BASE_DIR%\data"
set "UTAKANA_DATA_DIR=%BASE_DIR%\data"
set "PORT=3840"

if defined LYRIKO_PYTHON goto :python_ready
if defined UTAKANA_PYTHON set "LYRIKO_PYTHON=%UTAKANA_PYTHON%"
if defined LYRIKO_PYTHON goto :python_ready
if exist "%BASE_DIR%\python\python.exe" set "LYRIKO_PYTHON=%BASE_DIR%\python\python.exe"
:python_ready
if defined LYRIKO_PYTHON set "UTAKANA_PYTHON=%LYRIKO_PYTHON%"

echo ============================================================
echo   Lyriko - Local GPU Worker ^(Portable Edition^)
echo ============================================================
echo   - Worker URL  : http://127.0.0.1:%PORT%
echo   - Data Folder : %LYRIKO_DATA_DIR%
echo   - Stop Worker : Close this window
echo   - Uninstall   : Delete this folder completely
echo ============================================================
echo.

set "NODE_BIN="
if exist "%BASE_DIR%\node\node.exe" set "NODE_BIN=%BASE_DIR%\node\node.exe"
if defined NODE_BIN goto :node_ready
for /f "delims=" %%I in ('where node 2^>nul') do (
  if not defined NODE_BIN set "NODE_BIN=%%I"
)
:node_ready

if not defined NODE_BIN (
  echo [ERROR] Node.js 20+ was not found in PATH or .\node\node.exe
  echo Please install Node.js LTS ^(https://nodejs.org^) and try again.
  popd
  pause
  exit /b 1
)

if exist "%BASE_DIR%\python\python.exe" goto :check_python_health
if defined LYRIKO_PYTHON goto :after_ai_setup

echo [INFO] First launch: setting up portable Python AI environment inside .\python ...
echo [INFO] Nothing will be written outside this folder ^(zero registry/AppData^).
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\setup-ai-env.ps1"
if errorlevel 1 (
  echo.
  echo [WARN] AI Python setup did not complete ^(you can retry next launch^).
  echo [INFO] Starting worker anyway for search, lyrics, and MP4 export...
)
goto :bind_portable_python

:check_python_health
if /I not "%LYRIKO_PYTHON%"=="%BASE_DIR%\python\python.exe" goto :after_ai_setup
"%BASE_DIR%\python\python.exe" -c "import torch, torchaudio" >nul 2>&1
if not errorlevel 1 goto :bind_portable_python
echo [WARN] Portable AI Python packages need repair. Running repair...
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\setup-ai-env.ps1"

:bind_portable_python
if exist "%BASE_DIR%\python\python.exe" set "LYRIKO_PYTHON=%BASE_DIR%\python\python.exe"
if defined LYRIKO_PYTHON set "UTAKANA_PYTHON=%LYRIKO_PYTHON%"
:after_ai_setup

echo [START] Starting Lyriko Local GPU Worker Server...
echo.
"%NODE_BIN%" "%BASE_DIR%\node_modules\tsx\dist\cli.mjs" "%BASE_DIR%\server\index.ts"
set "EXIT_CODE=%errorlevel%"

echo.
echo Worker exited ^(code: %EXIT_CODE%^).
popd
pause
exit /b %EXIT_CODE%
