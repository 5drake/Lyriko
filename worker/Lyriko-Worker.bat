@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

set "LYRIKO_PORTABLE=1"
set "UTAKANA_PORTABLE=1"
set "LYRIKO_DATA_DIR=%BASE_DIR%\data"
set "UTAKANA_DATA_DIR=%BASE_DIR%\data"
set "PORT=3840"
if not defined LYRIKO_PYTHON (
  if defined UTAKANA_PYTHON set "LYRIKO_PYTHON=%UTAKANA_PYTHON%"
)
if not defined LYRIKO_PYTHON (
  if exist "%BASE_DIR%\python\python.exe" set "LYRIKO_PYTHON=%BASE_DIR%\python\python.exe"
)
if defined LYRIKO_PYTHON set "UTAKANA_PYTHON=%LYRIKO_PYTHON%"

echo ============================================================
echo   Lyriko - Local GPU Worker (Portable Edition)
echo ============================================================
echo   - Worker URL  : http://127.0.0.1:%PORT%
echo   - Data Folder : %LYRIKO_DATA_DIR%
echo   - Stop Worker : Close this window
echo   - Uninstall   : Delete this folder completely (zero leftovers)
echo ============================================================
echo.

set "NODE_BIN="
if exist "%BASE_DIR%\node\node.exe" set "NODE_BIN=%BASE_DIR%\node\node.exe"
if not defined NODE_BIN (
  for /f "delims=" %%I in ('where node 2^>nul') do (
    if not defined NODE_BIN set "NODE_BIN=%%I"
  )
)

if not defined NODE_BIN (
  echo [오류] Node.js 를 찾을 수 없습니다.
  echo Node.js LTS 버전을 설치하거나, node\node.exe 를 이 폴더에 넣어주세요.
  pause
  exit /b 1
)

if not exist "%BASE_DIR%\python\python.exe" (
  if not defined LYRIKO_PYTHON (
    echo [최초 실행 안내] 폴더 내부^(.\python^)에 AI 보컬/가사 싱크 환경을 자동 설치합니다.
    echo 시스템 폴더나 레지스트리에는 아무것도 기록하지 않습니다.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\setup-ai-env.ps1"
    if exist "%BASE_DIR%\python\python.exe" (
      set "LYRIKO_PYTHON=%BASE_DIR%\python\python.exe"
      set "UTAKANA_PYTHON=%BASE_DIR%\python\python.exe"
    )
  )
)

echo [시작] Lyriko 로컬 GPU 워커 서버를 실행합니다...
echo.
"%NODE_BIN%" "%BASE_DIR%\node_modules\tsx\dist\cli.mjs" "%BASE_DIR%\server\index.ts"

echo.
echo 워커가 종료되었습니다.
pause
