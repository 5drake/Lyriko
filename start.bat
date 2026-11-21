@echo off
cd /d "%~dp0"
echo Starting Lyriko...
start "" http://localhost:5173
call npm.cmd run dev
