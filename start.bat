@echo off
chcp 65001 >nul
title kiro-js

cd /d "%~dp0"
echo [kiro] Working directory: %cd%

:: 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [kiro] Node.js not found. Please install Node.js 18+.
    pause
    exit /b 1
)

:: 检查 node_modules
if not exist "node_modules" (
    echo [kiro] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [kiro] npm install failed!
        pause
        exit /b 1
    )
)

:: 检查配置文件
if not exist "config.json" (
    if exist "config.example.json" (
        echo [kiro] config.json not found, copying from config.example.json...
        copy "config.example.json" "config.json" >nul
        echo [kiro] Please edit config.json and set your apiKey and adminApiKey.
        pause
        exit /b 0
    )
)

:: 检查凭据文件
if not exist "credentials.json" (
    if exist "credentials.example.json" (
        echo [kiro] credentials.json not found, copying from credentials.example.json...
        copy "credentials.example.json" "credentials.json" >nul
        echo [kiro] Please edit credentials.json and set your refreshToken.
        pause
        exit /b 0
    )
)

echo [kiro] Starting server (auto-restart on code change)...
echo.
node --watch-path=src src/server.js %*

echo.
echo [kiro] Server has stopped. Exit code: %errorlevel%
pause
