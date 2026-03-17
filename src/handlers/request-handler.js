/**
 * kiro.js 主请求路由
 * 处理所有 HTTP 请求的分发
 */

import logger from '../utils/logger.js';
import { getClientIp, getRequestBody, isAuthorized, handleError } from '../utils/common.js';
import { serveAdminUI } from '../admin/ui-server.js';
import { checkAuth, handleLoginRequest } from '../admin/auth.js';
import { randomUUID } from 'crypto';
import { countTokensAnthropic } from '../utils/token-utils.js';
import { KIRO_MODELS, routingConfig } from '../admin/system-api.js';
import { createRemoteApiPublicHandler } from '../plugins/remote-api.js';

export function createRequestHandler(config, credentialManager, credentialsApi, systemApi) {
    return async function requestHandler(req, res) {
        const clientIp = getClientIp(req);
        const requestId = `${clientIp}:${randomUUID().slice(0, 8)}`;

        return logger.runWithContext(requestId, async () => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const path = url.pathname;
            const method = req.method;

            try {
                // CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
                if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

                // Admin UI 静态文件
                if (path.startsWith('/admin')) {
                    if (serveAdminUI(path, res)) return;
                }

                // Admin API: /api/admin/*
                if (path.startsWith('/api/admin/')) {
                    return await handleAdminApi(method, path, req, res, config, credentialsApi, systemApi);
                }

                // 远程 API 插件: /api/remote/*（独立鉴权，用 SHA-256(adminApiKey)）
                if (path.startsWith('/api/remote/') && config.ADMIN_API_KEY) {
                    const remoteHandler = createRemoteApiPublicHandler(credentialManager, config.ADMIN_API_KEY);
                    const pathAfterRemote = path.replace('/api/remote', '');
                    return await remoteHandler(req, res, pathAfterRemote);
                }

                // 健康检查
                if (method === 'GET' && path === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
                    return;
                }

                // API 代理端点 - 需要 API Key 认证
                if (!isAuthorized(req, url, config.REQUIRED_API_KEY)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }));
                    return;
                }

                logger.info(`[Server] ${method} ${path}`);

                // POST /v1/messages - Anthropic Messages API 代理
                if (method === 'POST' && path === '/v1/messages') {
                    return await handleMessagesProxy(req, res, credentialManager);
                }

                // POST /v1/messages/count_tokens
                if (method === 'POST' && path.includes('/count_tokens')) {
                    const body = await getRequestBody(req);
                    try {
                        const result = countTokensAnthropic(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ input_tokens: 0 }));
                    }
                    return;
                }

                // GET /v1/models（动态：内置 + 自定义模型）
                if (method === 'GET' && path === '/v1/models') {
                    const custom = (routingConfig.customModels || []).map(m => ({ id: m, object: 'model', owned_by: 'anthropic' }));
                    const builtIn = KIRO_MODELS.map(m => ({ id: m.id, object: 'model', owned_by: 'anthropic' }));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ object: 'list', data: [...builtIn, ...custom] }));
                    return;
                }

                // 404
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Not Found' } }));
            } catch (error) {
                handleError(res, error, 'kiro');
            } finally {
                logger.clearRequestContext(requestId);
            }
        });
    };
}

/**
 * Admin API 路由分发
 */
async function handleAdminApi(method, path, req, res, config, credentialsApi, systemApi) {
    // 去掉 /api/admin/ 前缀，拆分路径
    const subPath = path.replace('/api/admin/', '');
    const pathParts = subPath.split('/').filter(Boolean);

    // 登录不需要认证
    if (method === 'POST' && subPath === 'login') {
        // 前端发送 { password: "xxx" }，这里兼容处理
        return await handleLoginRequest(req, res);
    }

    // 其他 Admin API 需要认证
    if (!checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }));
        return;
    }

    // 凭据 API
    const credHandled = await credentialsApi(method, pathParts, req, res);
    if (credHandled) return;

    // 系统 API
    const sysHandled = await systemApi(method, pathParts, req, res);
    if (sysHandled) return;

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Admin API not found' } }));
}

/**
 * Anthropic Messages API 代理
 */
async function handleMessagesProxy(req, res, credentialManager) {
    const body = await getRequestBody(req);
    const model = body.model || 'claude-sonnet-4-5';
    const isStream = body.stream === true;

    const triedIds = new Set();
    const maxRetries = Math.min(credentialManager.entries.length, 5);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const entry = credentialManager.selectCredential(model, triedIds);
        if (!entry) {
            break;
        }
        triedIds.add(entry.id);

        if (!entry.service) {
            logger.warn(`[Proxy] Credential #${entry.id} service not initialized, skipping`);
            continue;
        }

        try {
            if (isStream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                const stream = entry.service.generateContentStream(model, body);
                for await (const chunk of stream) {
                    if (res.writableEnded) break;
                    if (chunk.type) res.write(`event: ${chunk.type}\n`);
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
                if (!res.writableEnded) res.end();
            } else {
                const result = await entry.service.generateContent(model, body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            }
            credentialManager.recordSuccess(entry.id, model);
            return; // 成功，直接返回
        } catch (error) {
            const status = error.response?.status || error.status || 0;
            const shouldRetry = error.shouldSwitchCredential || [401, 402, 403, 429].includes(status);

            if (shouldRetry && !error.skipErrorCount) {
                credentialManager.recordFailure(entry.id);
            }
            logger.warn(`[Proxy] Credential #${entry.id} failed (${status}), ${shouldRetry && attempt < maxRetries - 1 ? 'trying next...' : 'no more retries'}`);

            if (!shouldRetry || res.headersSent) {
                // 不可重试或已发送 header（流式），直接返回错误
                if (!res.headersSent) {
                    res.writeHead(status || 500, { 'Content-Type': 'application/json' });
                }
                if (!res.writableEnded) {
                    res.end(JSON.stringify({
                        type: 'error',
                        error: { type: 'api_error', message: error.message }
                    }));
                }
                return;
            }
            // 可重试，继续循环选下一个凭据
        }
    }

    // 所有凭据都失败了
    if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
    }
    if (!res.writableEnded) {
        res.end(JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'All credentials exhausted' }
        }));
    }
}
