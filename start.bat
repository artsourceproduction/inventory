@echo off
REM ============================================================
REM  The Art Source - Printing Department System
REM  Double-click this file to start the application.
REM ============================================================
title The Art Source - Printing Department System

cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies for the first time - this can take a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo Dependency install failed. Make sure Node.js is installed:
        echo https://nodejs.org
        pause
        exit /b 1
    )
)

echo Starting Printing Department System...
call node server\server.js

pause
