/**
 * kiro.js 主入口
 * 基于 A2 技术栈的 Kiro-only API 代理
 */

import 'dotenv/config';
import * as http from 'http';
import logger from './utils/logger.js';
import { initializeConfig, CONFIG } from './core/config-manager.js';
import { isRetryableNetworkError } from './utils/common.js';
import CredentialManager from './services/credential-manager.js';
import { createRequestHandler } from './handlers/request-handler.js';
import { createCredentialsApi } from './admin/credentials-api.js';
import { createSystemApi } from './admin/system-api.js';
import { setAdminApiKey } from './admin/auth.js';

let serverInstance = null;

async function startServer() {
    // 初始化配置
    await initializeConfig(process.argv.slice(2), 'config.json');

    // 初始化凭据管理器
    const credentialManager = new CredentialManager(CONFIG);
    await credentialManager.loadCredentials();

    // 设置 Admin API Key
    if (CONFIG.ADMIN_API_KEY) {
        setAdminApiKey(CONFIG.ADMIN_API_KEY);
        logger.info('[Admin] Admin API enabled');
    }

    // 创建 Admin API 处理器
    const credentialsApi = createCredentialsApi(credentialManager);
    const systemApi = createSystemApi(credentialManager);

    // 创建请求处理器（KiroApiService 实例由 CredentialManager 管理，每个凭据一个）
    const requestHandler = createRequestHandler(
        CONFIG, credentialManager, credentialsApi, systemApi
    );

    // 创建 HTTP 服务器
    serverInstance = http.createServer({
        requestTimeout: 0,
        headersTimeout: 60000,
        keepAliveTimeout: 65000,
    }, requestHandler);

    serverInstance.maxConnections = 1000;

    // 跟踪活跃连接
    serverInstance.on('connection', (conn) => {
        activeConnections.add(conn);
        conn.on('close', () => activeConnections.delete(conn));
    });

    serverInstance.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
        logger.info('='.repeat(50));
        logger.info('[kiro.js] Kiro API Proxy Server');
        logger.info(`  Host: ${CONFIG.HOST}`);
        logger.info(`  Port: ${CONFIG.SERVER_PORT}`);
        logger.info(`  Credentials: ${credentialManager.entries.length}`);
        logger.info(`  API Key: ${CONFIG.REQUIRED_API_KEY.slice(0, 4)}***`);
        logger.info('='.repeat(50));
        logger.info('API Endpoints:');
        logger.info('  POST /v1/messages');
        logger.info('  GET  /v1/models');
        logger.info('  POST /v1/messages/count_tokens');
        logger.info('  GET  /health');
        if (CONFIG.ADMIN_API_KEY) {
            logger.info('Admin:');
            logger.info(`  UI:  http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${CONFIG.SERVER_PORT}/admin`);
            logger.info('  API: /api/admin/*');
        }
        logger.info('='.repeat(50));

        // 定时 token 刷新
        if (CONFIG.CRON_REFRESH_TOKEN) {
            const intervalMs = (CONFIG.CRON_NEAR_MINUTES || 15) * 60 * 1000;
            setInterval(async () => {
                logger.info('[Heartbeat] Running token refresh check...');
                for (const entry of credentialManager.entries) {
                    if (!entry.service || entry.disabled) continue;
                    try {
                        if (entry.service.isExpiryDateNear?.()) {
                            logger.info(`[Heartbeat] Credential #${entry.id} token near expiry, refreshing...`);
                            await entry.service.initializeAuth(true);
                            // 同步刷新后的凭据回 entry
                            if (entry.service.accessToken) entry.credentials.accessToken = entry.service.accessToken;
                            if (entry.service.expiresAt) entry.credentials.expiresAt = entry.service.expiresAt;
                        }
                    } catch (err) {
                        logger.warn(`[Heartbeat] Credential #${entry.id} refresh failed: ${err.message}`);
                    }
                }
            }, intervalMs);
        }
    });

    return serverInstance;
}

// 跟踪活跃连接，用于快速关闭
const activeConnections = new Set();

// 信号处理
function setupSignalHandlers() {
    const shutdown = () => {
        logger.info('[Server] Shutting down...');
        if (serverInstance) {
            // 立即销毁所有活跃连接
            for (const conn of activeConnections) {
                conn.destroy();
            }
            activeConnections.clear();
            serverInstance.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 3000);
        } else {
            process.exit(0);
        }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('uncaughtException', (error) => {
        logger.error('[Server] Uncaught exception:', error);
        if (isRetryableNetworkError(error)) return;
        shutdown();
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('[Server] Unhandled rejection:', reason);
        if (reason && isRetryableNetworkError(reason)) return;
    });
}

setupSignalHandlers();
startServer().catch(err => {
    logger.error('[Server] Failed to start:', err.message);
    process.exit(1);
});
