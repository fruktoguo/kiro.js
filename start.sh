#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# 检查 node
if ! command -v node &>/dev/null; then
    echo "[kiro] Node.js not found. Please install Node.js 18+ first."
    exit 1
fi

# 检查 node_modules
if [ ! -d "node_modules" ]; then
    echo "[kiro] Installing dependencies..."
    npm install
fi

# 自动创建配置文件（不退出，直接用默认值启动）
if [ ! -f "config.json" ]; then
    if [ -f "config.example.json" ]; then
        echo "[kiro] config.json not found, creating from example..."
        cp config.example.json config.json
    else
        echo "[kiro] Creating default config.json..."
        cat > config.json << 'EOF'
{
  "host": "0.0.0.0",
  "port": 8990,
  "region": "us-east-1",
  "apiKey": "sk-kiro",
  "adminApiKey": "admin"
}
EOF
    fi
    echo "[kiro] config.json created. Edit it later to customize."
fi

# 自动创建凭据文件
if [ ! -f "credentials.json" ]; then
    if [ -f "credentials.example.json" ]; then
        echo "[kiro] credentials.json not found, creating from example..."
        cp credentials.example.json credentials.json
    else
        echo "[kiro] Creating empty credentials.json..."
        echo '[]' > credentials.json
    fi
    echo "[kiro] credentials.json created. Add credentials via admin UI."
fi

# 创建 configs 目录
mkdir -p configs

echo "[kiro] Starting server (auto-restart on code change)..."
exec node --watch-path=src src/server.js "$@"
