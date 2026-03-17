/**
 * 远程 API 插件 — 对齐 kiro.py 的 plugins/remote_api
 * 提供可控开关的远程调用接口（凭据、统计、重启等）
 */

import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';

export const PLUGIN_MANIFEST = {
    id: 'remote-api',
    name: '远程 API',
    description: '提供可控开关的远程调用接口（凭据、统计、重启等）',
    version: '1.0.0',
    icon: 'Cloud',
    has_frontend: true,
    api_prefix: '/plugins/remote-api',
    public_mount: '/api/remote',
};

const DEFAULT_ENABLED_APIS = {
    availableCredentials: true,
    batchImport: true,
    restart: false,
    refreshQuota: true,
    totalRemainingQuota: true,
    todayTokenTotal: true,
    totalCalls: true,
};

const CONFIG_PATH = path.join(process.cwd(), 'configs', 'remote_api_plugin.json');

// ==================== 配置存储 ====================

function loadPluginConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const raw = data.enabledApis || {};
            const enabled = { ...DEFAULT_ENABLED_APIS };
            for (const key of Object.keys(enabled)) {
                if (key in raw) enabled[key] = !!raw[key];
            }
            return { enabledApis: enabled };
        }
    } catch (e) { logger.warn('[RemoteAPI] Config load failed:', e.message); }
    return { enabledApis: { ...DEFAULT_ENABLED_APIS } };
}

async function savePluginConfig(config) {
    try {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) await pfs.mkdir(dir, { recursive: true });
        await pfs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) { logger.warn('[RemoteAPI] Config save failed:', e.message); }
}

let pluginConfig = loadPluginConfig();

function sha256Hex(str) {
    return crypto.createHash('sha256').update(str || '').digest('hex');
}

function isApiEnabled(name) {
    pluginConfig = loadPluginConfig(); // 每次重新读取
    return !!pluginConfig.enabledApis[name];
}

function forbidden(res, apiName) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'forbidden', message: `API 已被禁用: ${apiName}` } }));
}

// ==================== Admin 路由（/api/admin/plugins/remote-api/*） ====================

export function createRemoteApiAdminHandler() {
    return async function handleRemoteApiAdmin(method, pathParts, req, res) {
        // pathParts 已经去掉了 plugins/remote-api 前缀
        const sub = pathParts[0];

        // GET /config
        if (method === 'GET' && sub === 'config' && pathParts.length === 1) {
            pluginConfig = loadPluginConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pluginConfig));
            return true;
        }

        // PUT /config
        if (method === 'PUT' && sub === 'config' && pathParts.length === 1) {
            const body = await getRequestBody(req);
            const payload = body.enabledApis || {};
            pluginConfig = loadPluginConfig();
            for (const key of Object.keys(DEFAULT_ENABLED_APIS)) {
                if (key in payload) pluginConfig.enabledApis[key] = !!payload[key];
            }
            await savePluginConfig(pluginConfig);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pluginConfig));
            return true;
        }

        return false;
    };
}

// ==================== 公共远程路由（/api/remote/*） ====================

export function createRemoteApiPublicHandler(credentialManager, adminApiKey) {
    const expectedToken = sha256Hex(adminApiKey);

    return async function handleRemoteApiPublic(req, res, pathAfterRemote) {
        // 鉴权：token = SHA-256(adminApiKey)
        const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        if (token !== expectedToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid or missing admin API key' } }));
            return;
        }

        const method = req.method;
        const p = pathAfterRemote; // e.g. "/credentials/available"

        // GET /credentials/available
        if (method === 'GET' && p === '/credentials/available') {
            if (!isApiEnabled('availableCredentials')) return forbidden(res, 'availableCredentials');
            const available = credentialManager.entries.filter(e => !e.disabled).length;
            const total = credentialManager.entries.length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ available, total }));
            return;
        }

        // POST /credentials/batch-import
        if (method === 'POST' && p === '/credentials/batch-import') {
            if (!isApiEnabled('batchImport')) return forbidden(res, 'batchImport');
            const body = await getRequestBody(req);
            let creds = [];
            if (Array.isArray(body)) creds = body;
            else if (body.credentials) creds = Array.isArray(body.credentials) ? body.credentials : [body.credentials];
            else if (body.refreshToken) creds = [body];

            let added = 0, skipped = 0;
            for (const c of creds) {
                if (!c.refreshToken) { skipped++; continue; }
                // 去重
                const exists = credentialManager.entries.some(e => e.credentials.refreshToken === c.refreshToken);
                if (exists) { skipped++; continue; }
                await credentialManager.addCredential(c);
                added++;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, added, skipped, total: credentialManager.entries.length }));
            return;
        }

        // POST /server/restart
        if (method === 'POST' && p === '/server/restart') {
            if (!isApiEnabled('restart')) return forbidden(res, 'restart');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Restarting...' }));
            setTimeout(() => process.exit(1), 500);
            return;
        }

        // POST /quota/refresh
        if (method === 'POST' && p === '/quota/refresh') {
            if (!isApiEnabled('refreshQuota')) return forbidden(res, 'refreshQuota');
            const data = await getTotalRemaining(credentialManager, true);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return;
        }

        // GET /quota/total-remaining
        if (method === 'GET' && p === '/quota/total-remaining') {
            if (!isApiEnabled('totalRemainingQuota')) return forbidden(res, 'totalRemainingQuota');
            const data = await getTotalRemaining(credentialManager, false);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return;
        }

        // GET /stats/today-tokens
        if (method === 'GET' && p === '/stats/today-tokens') {
            if (!isApiEnabled('todayTokenTotal')) return forbidden(res, 'todayTokenTotal');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ input: 0, output: 0, total: 0 }));
            return;
        }

        // GET /stats/total-calls
        if (method === 'GET' && p === '/stats/total-calls') {
            if (!isApiEnabled('totalCalls')) return forbidden(res, 'totalCalls');
            const stats = credentialManager.getStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                totalRequests: stats.totalRequests, sessionRequests: stats.sessionRequests,
                rpm: stats.rpm, peakRpm: stats.peakRpm,
            }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
    };
}

// 汇总剩余额度
async function getTotalRemaining(credentialManager, forceRefresh) {
    const enabled = credentialManager.entries.filter(e => !e.disabled);
    let totalRemaining = 0;
    const details = [], failed = [];
    for (const entry of enabled) {
        try {
            const balance = await credentialManager.getBalance(entry.id, forceRefresh);
            totalRemaining += balance.remaining;
            details.push({ id: entry.id, remaining: balance.remaining, subscriptionTitle: balance.subscriptionTitle });
        } catch (e) {
            failed.push({ id: entry.id, error: e.message });
        }
    }
    return { totalRemaining, details, failed };
}
