# kiro.js

Node.js 版 Kiro API 代理，基于 [AIClient-2-API](https://github.com/anthropics/AIClient-2-API) 技术栈，复用 kiro.py 的前端和交互设计。

## 快速开始

### Windows

```
双击 start.bat
```

### Linux / macOS

```bash
chmod +x start.sh
./start.sh
```

首次运行会自动安装依赖、创建配置文件并启动服务。

## 配置

- `config.json` — 服务配置（端口、API Key、Admin Key 等）
- `credentials.json` — Kiro OAuth 凭据（支持单个或数组格式）

配置文件首次运行时自动从 example 文件创建，也可通过 Admin UI 管理。

## 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/messages` | Anthropic Messages API 代理 |
| `GET /v1/models` | 模型列表 |
| `POST /v1/messages/count_tokens` | Token 计数 |
| `GET /health` | 健康检查 |
| `http://localhost:8990/admin` | Admin UI |

## 功能

- 多凭据均衡调度（RPM + 时间衰减算法）
- 失败自动切换（401/402/403/429）
- Token 自动刷新（Social / IdC）
- 余额查询与缓存
- 远程 API 插件（批量导入、额度查询等）
- 代码变动自动重启（`--watch`）
- Git 集成（版本检查、在线更新）
- 运行时日志查看

## 技术栈

- Node.js (ESM)
- 原生 HTTP Server
- Axios
- @anthropic-ai/tokenizer
- React + Vite + TypeScript (Admin UI)
