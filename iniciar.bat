@echo off
title Concha - Panel de cuentas Emby
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Falta Node.js. Descarga la version LTS en https://nodejs.org , instalala y vuelve a abrir este archivo.
  pause
  exit /b 1
)
node server.js
pause
