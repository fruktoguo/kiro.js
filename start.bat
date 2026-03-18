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

:: 自动创建配置文件
if not exist "config.json" (
    if exist "config.example.json" (
        echo [kiro] config.json not found, creating from example...
        copy "config.example.json" "config.json" >nul
    ) else (
        echo [kiro] Creating default config.json...
        echo {"host":"0.0.0.0","port":8990,"region":"us-east-1","apiKey":"sk-kiro","adminApiKey":"admin"} > config.json
    )
    echo [kiro] config.json created. Edit it later to customize.
)

:: 自动创建凭据文件
if not exist "credentials.json" (
    if exist "credentials.example.json" (
        echo [kiro] credentials.json not found, creating from example...
        copy "credentials.example.json" "credentials.json" >nul
    ) else (
        echo [kiro] Creating empty credentials.json...
        echo [] > credentials.json
    )
    echo [kiro] credentials.json created. Add credentials via admin UI.
)

:: 创建 configs 目录
if not exist "configs" mkdir configs

echo [kiro] Starting server (auto-restart on code change)...
echo.
node --watch-path=src src/server.js %*

echo.
echo [kiro] Server has stopped. Exit code: %errorlevel%
pause
