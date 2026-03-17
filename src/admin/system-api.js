/**
 * Admin 系统 API
 * 统计、模型、路由、日志、版本、重启等
 */

import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getRequestBody } from '../utils/common.js';
import logger from '../utils/logger.js';
import { PLUGIN_MANIFEST, createRemoteApiAdminHandler } from '../plugins/remote-api.js';

const VERSION = (() => {
    try { return fs.readFileSync('VERSION', 'utf8').trim(); }
    catch { return '1.0.0'; }
})();

// 对齐 kiro.py 的模型列表
const KIRO_MODELS = [
    { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5' },
    { id: 'claude-sonnet-4-5-20250929-thinking', displayName: 'Claude Sonnet 4.5 (Thinking)' },
    { id: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5' },
    { id: 'claude-opus-4-5-20251101-thinking', displayName: 'Claude Opus 4.5 (Thinking)' },
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-4-6-thinking', displayName: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
    { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' },
    { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    { id: 'claude-haiku-4-5-20251001-thinking', displayName: 'Claude Haiku 4.5 (Thinking)' },
];

const ROUTING_PATH = path.join(process.cwd(), 'configs', 'kiro_routing.json');
let messageLogEnabled = false;

// 加载路由配置
function loadRouting() {
    try {
        if (fs.existsSync(ROUTING_PATH)) {
            return JSON.parse(fs.readFileSync(ROUTING_PATH, 'utf8'));
        }
    } catch (e) { logger.warn('[Routing] Load failed:', e.message); }
    return { freeModels: [], customModels: [] };
}

// 保存路由配置
async function saveRouting(config) {
    try {
        const dir = path.dirname(ROUTING_PATH);
        if (!fs.existsSync(dir)) await pfs.mkdir(dir, { recursive: true });
        await pfs.writeFile(ROUTING_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) { logger.warn('[Routing] Save failed:', e.message); }
}

let routingConfig = loadRouting();

export { KIRO_MODELS, routingConfig };

export function createSystemApi(credentialManager) {
    return async function handleSystemApi(method, pathParts, req, res) {
        const p0 = pathParts[0];
        const p1 = pathParts[1];

        // GET /stats
        if (method === 'GET' && p0 === 'stats' && pathParts.length === 1) {
            const stats = credentialManager.getStats();
            stats.tokenUsage = { today: { input: 0, output: 0 }, yesterday: { input: 0, output: 0 }, models: {} };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
            return true;
        }

        // GET /models（内置 + 自定义模型）
        if (method === 'GET' && p0 === 'models' && pathParts.length === 1) {
            const custom = (routingConfig.customModels || []).map(m => ({ id: m, displayName: m }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [...KIRO_MODELS, ...custom] }));
            return true;
        }

        // GET /routing
        if (method === 'GET' && p0 === 'routing' && pathParts.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(routingConfig));
            return true;
        }

        // PUT /routing
        if (method === 'PUT' && p0 === 'routing' && pathParts.length === 1) {
            const body = await getRequestBody(req);
            routingConfig = { ...routingConfig, ...body };
            await saveRouting(routingConfig);
            // 同步 freeModels 到 credentialManager
            if (body.freeModels) credentialManager.freeModels = new Set(body.freeModels);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Routing updated' }));
            return true;
        }

        // GET /system/stats
        if (method === 'GET' && p0 === 'system' && p1 === 'stats') {
            const mem = process.memoryUsage();
            const rssMb = Math.round(mem.rss / 1024 / 1024 * 100) / 100;
            const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100;
            const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100;
            const externalMb = Math.round(mem.external / 1024 / 1024 * 100) / 100;
            const abMb = Math.round((mem.arrayBuffers || 0) / 1024 / 1024 * 100) / 100;
            // V8 Heap 未使用部分（已分配但空闲）
            const heapFreeMb = Math.round((heapTotalMb - heapUsedMb) * 100) / 100;
            // RSS 中除 heapTotal + external 之外的部分（Node.js 运行时、V8 引擎、代码段等）
            const runtimeMb = Math.round((rssMb - heapTotalMb - externalMb) * 100) / 100;
            const tracedMb = rssMb;

            const pct = (v) => rssMb > 0 ? Math.round(v / rssMb * 1000) / 10 : 0;

            const breakdown = [
                { module: 'Node.js 运行时', path: 'V8 引擎 + libuv + 代码段 + 栈', memoryMb: Math.max(runtimeMb, 0), sharePercent: pct(Math.max(runtimeMb, 0)) },
                { module: 'V8 Heap (已用)', path: '对象、闭包、字符串等 JS 堆内存', memoryMb: heapUsedMb, sharePercent: pct(heapUsedMb) },
                { module: 'V8 Heap (空闲)', path: '已分配但未使用的堆空间', memoryMb: heapFreeMb, sharePercent: pct(heapFreeMb) },
                { module: 'External (C++)', path: 'Buffer、WASM 等原生内存', memoryMb: externalMb, sharePercent: pct(externalMb) },
                { module: 'ArrayBuffers', path: 'SharedArrayBuffer / ArrayBuffer（含 External）', memoryMb: abMb, sharePercent: pct(abMb) },
            ];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                cpuPercent: 0,
                memoryMb: rssMb,
                tracedMemoryMb: tracedMb,
                memoryBreakdown: breakdown,
            }));
            return true;
        }

        // GET /version
        if (method === 'GET' && p0 === 'version' && pathParts.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                current: VERSION, latest: VERSION, hasUpdate: false, behindCount: 0,
            }));
            return true;
        }

        // GET /log
        if (method === 'GET' && p0 === 'log' && pathParts.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ enabled: messageLogEnabled }));
            return true;
        }

        // PUT /log
        if (method === 'PUT' && p0 === 'log' && pathParts.length === 1) {
            const body = await getRequestBody(req);
            messageLogEnabled = !!body.enabled;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Log status updated' }));
            return true;
        }

        // GET /logs/runtime
        if (method === 'GET' && p0 === 'logs' && p1 === 'runtime') {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const cursor = parseInt(url.searchParams.get('cursor')) || 0;
            const limit = parseInt(url.searchParams.get('limit')) || 100;
            const level = url.searchParams.get('level') || undefined;
            const q = url.searchParams.get('q') || undefined;
            const result = logger.getRuntimeLogs({ cursor, limit, level, q });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return true;
        }

        // POST /restart
        if (method === 'POST' && p0 === 'restart' && pathParts.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Restarting...' }));
            // --watch 模式下 touch 一个文件触发重启，否则直接退出
            setTimeout(async () => {
                try {
                    const touchPath = path.join(process.cwd(), 'src', '.restart-trigger');
                    await pfs.writeFile(touchPath, Date.now().toString(), 'utf8');
                } catch { /* fallback */ }
                setTimeout(() => process.exit(1), 300);
            }, 300);
            return true;
        }

        // GET /update/status
        if (method === 'GET' && p0 === 'update' && p1 === 'status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ log: [] }));
            return true;
        }

        // POST /update
        if (method === 'POST' && p0 === 'update' && pathParts.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Update not supported in kiro.js' }));
            return true;
        }

        // GET /plugins
        if (method === 'GET' && p0 === 'plugins' && pathParts.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ plugins: [PLUGIN_MANIFEST] }));
            return true;
        }

        // /plugins/remote-api/* — 委托给插件 admin handler
        if (p0 === 'plugins' && pathParts[1] === 'remote-api' && pathParts.length >= 3) {
            const remoteAdminHandler = createRemoteApiAdminHandler();
            const subParts = pathParts.slice(2); // 去掉 plugins/remote-api
            const handled = await remoteAdminHandler(method, subParts, req, res);
            if (handled) return true;
        }

        // GET /git/status
        if (method === 'GET' && p0 === 'git' && p1 === 'status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasLocalChanges: false, changedFiles: [] }));
            return true;
        }

        // GET /git/log
        if (method === 'GET' && p0 === 'git' && p1 === 'log') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ currentHash: '', commits: [] }));
            return true;
        }

        return false;
    };
}
