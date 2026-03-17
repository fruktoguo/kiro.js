#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# 检查 node
if ! command -v node &>/dev/null; then
    echo "[kiro.js] Node.js not found. Please install Node.js 18+ first."
    exit 1
fi

# 检查 node_modules
if [ ! -d "node_modules" ]; then
    echo "[kiro.js] Installing dependencies..."
    npm install
fi

# 检查配置文件
if [ ! -f "config.json" ]; then
    if [ -f "config.example.json" ]; then
        echo "[kiro.js] config.json not found, copying from config.example.json..."
        cp config.example.json config.json
        echo "[kiro.js] Please edit config.json and set your apiKey and adminApiKey."
        exit 0
    fi
fi

# 检查凭据文件
if [ ! -f "credentials.json" ]; then
    if [ -f "credentials.example.json" ]; then
        echo "[kiro.js] credentials.json not found, copying from credentials.example.json..."
        cp credentials.example.json credentials.json
        echo "[kiro.js] Please edit credentials.json and set your refreshToken."
        exit 0
    fi
fi

echo "[kiro] Starting server (auto-restart on code change)..."
exec node --watch-path=src src/server.js "$@"
