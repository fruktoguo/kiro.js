/**
 * kiro.js 凭据管理器
 * 融合 kiro.py 的均衡算法和 A2 的凭据文件格式
 */

import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import logger from '../utils/logger.js';
import { KiroApiService } from '../providers/kiro-core.js';

const DisabledReason = {
    MANUAL: 'manual',
    TOO_MANY_FAILURES: 'too_many_failures',
    QUOTA_EXCEEDED: 'quota_exceeded',
};

const MAX_FAILURES = 3;
const TRANSIENT_COOLDOWN_MS = 15000;

class CredentialEntry {
    constructor(id, credentials) {
        this.id = id;
        this.credentials = credentials;
        this.failureCount = 0;
        this.disabled = credentials.disabled || false;
        this.disabledReason = this.disabled ? DisabledReason.MANUAL : null;
        this.successCount = 0;
        this.sessionCount = 0;
        this.lastUsedAt = null;
        this.balanceScore = 0;
        this.requestTimestamps = [];
        this.transientDisabledUntil = null;
        this.cachedBalance = null;
        this.balanceUpdatedAt = null;
        this.service = null; // KiroApiService 实例
    }
}

export default class CredentialManager {
    constructor(config) {
        this.config = config;
        this.entries = [];
        this.currentId = 0;
        this.groups = {};
        this.freeModels = new Set();
        this.requestTimestamps = [];
        this.peakRpm = 0;
        this.modelCallCounts = {};
        this.modelCredCounts = {};
        this.credentialsPath = config.CREDENTIALS_FILE || 'configs/credentials.json';
        this._balanceCache = {}; // { id: { cachedAt, data } }
        this._balanceCachePath = path.join(process.cwd(), 'configs', 'kiro_balance_cache.json');
        // Token 用量统计
        this.tokenUsage = {
            today: { input: 0, output: 0 },
            yesterday: { input: 0, output: 0 },
            models: {}, // { model: { today: { input, output }, yesterday: { input, output } } }
        };
        this._tokenUsageDate = new Date().toDateString();
        this._loadBalanceCache();
    }

    // 从文件恢复余额缓存
    _loadBalanceCache() {
        try {
            if (fs.existsSync(this._balanceCachePath)) {
                const raw = JSON.parse(fs.readFileSync(this._balanceCachePath, 'utf8'));
                if (raw && typeof raw === 'object') {
                    this._balanceCache = raw;
                }
            }
        } catch { /* ignore */ }
    }

    // 持久化余额缓存到文件
    async _saveBalanceCache() {
        try {
            const dir = path.dirname(this._balanceCachePath);
            if (!fs.existsSync(dir)) await pfs.mkdir(dir, { recursive: true });
            await pfs.writeFile(this._balanceCachePath, JSON.stringify(this._balanceCache, null, 2), 'utf8');
        } catch (e) { logger.warn('[Credentials] Balance cache save failed:', e.message); }
    }

    /** 从 credentials.json 加载（兼容单凭据 dict 和多凭据 list） */
    async loadCredentials() {
        try {
            const raw = await pfs.readFile(this.credentialsPath, 'utf8');
            let data = JSON.parse(raw);
            let credList = Array.isArray(data) ? data : [data];

            this.entries = [];
            let maxId = 0;
            for (const c of credList) { if (c.id > maxId) maxId = c.id || 0; }
            let nextId = maxId + 1;

            for (const cred of credList) {
                if (cred.id == null) cred.id = nextId++;
                const entry = new CredentialEntry(cred.id, cred);
                // 恢复 group
                if (cred.group) this.groups[cred.id] = cred.group;
                // 恢复余额缓存
                const cached = this._balanceCache[cred.id];
                if (cached && cached.data) {
                    entry.cachedBalance = cached.data;
                    entry.balanceUpdatedAt = new Date(cached.cachedAt).toISOString();
                }
                this.entries.push(entry);
            }
            this.entries.sort((a, b) => (a.credentials.priority || 0) - (b.credentials.priority || 0));
            if (this.entries.length > 0) this.currentId = this.entries[0].id;
            logger.info(`[Credentials] Loaded ${this.entries.length} credential(s)`);
        } catch (error) {
            if (error.code === 'ENOENT') logger.warn('[Credentials] File not found: ' + this.credentialsPath);
            else logger.error('[Credentials] Failed to load:', error.message);
        }
        await this.scanKiroConfigs();
        await this._initServices();
    }

    /** 为每个凭据条目创建并初始化 KiroApiService 实例 */
    async _initServices() {
        for (const entry of this.entries) {
            try {
                await this._createService(entry);
            } catch (err) {
                logger.warn(`[Credentials] #${entry.id} service init failed: ${err.message}`);
            }
        }
        const ok = this.entries.filter(e => e.service).length;
        logger.info(`[Credentials] Initialized ${ok}/${this.entries.length} service(s)`);
    }

    /** 为单个 entry 创建 KiroApiService，直接注入凭据跳过文件加载 */
    async _createService(entry) {
        const c = entry.credentials;
        const svcConfig = {
            ...this.config,
            KIRO_OAUTH_CREDS_DIR_PATH: '__skip__',
        };
        const svc = new KiroApiService(svcConfig);
        // 直接注入凭据，跳过 loadCredentials 的文件读取
        svc.accessToken = c.accessToken || null;
        svc.refreshToken = c.refreshToken;
        svc.clientId = c.clientId || 'oidc-kiro';
        svc.clientSecret = c.clientSecret || null;
        svc.authMethod = c.authMethod || 'social';
        svc.expiresAt = c.expiresAt || null;
        svc.profileArn = c.profileArn || null;
        svc.region = c.apiRegion || c.region || this.config.API_REGION || 'us-east-1';
        svc.idcRegion = c.authRegion || c.idcRegion || svc.region;
        svc._credentialsInjected = true;

        // 覆盖 saveCredentialsToFile，token 刷新后同步回 entry 并持久化
        const manager = this;
        svc.saveCredentialsToFile = async (_filePath, newData) => {
            if (newData.accessToken) c.accessToken = newData.accessToken;
            if (newData.refreshToken) c.refreshToken = newData.refreshToken;
            if (newData.expiresAt) c.expiresAt = newData.expiresAt;
            if (newData.profileArn) c.profileArn = newData.profileArn;
            try { await manager.persistCredentials(); } catch (e) {
                logger.warn(`[Credentials] #${entry.id} persist after refresh failed: ${e.message}`);
            }
        };

        await svc.initialize();

        // 如果没有 accessToken，自动刷新 token
        if (!svc.accessToken && svc.refreshToken) {
            try {
                logger.info(`[Credentials] #${entry.id} no accessToken, refreshing...`);
                await svc.initializeAuth(true);
                // 同步刷新后的凭据回 entry
                if (svc.accessToken) c.accessToken = svc.accessToken;
                if (svc.expiresAt) c.expiresAt = svc.expiresAt;
                if (svc.profileArn) c.profileArn = svc.profileArn;
                await this.persistCredentials();
            } catch (err) {
                logger.warn(`[Credentials] #${entry.id} token refresh failed: ${err.message}`);
            }
        }

        entry.service = svc;
    }

    /** 扫描 configs/kiro/ 目录加载 OAuth 凭据 */
    async scanKiroConfigs() {
        const kiroDir = path.join(process.cwd(), 'configs', 'kiro');
        try {
            if (!fs.existsSync(kiroDir)) return;
            const existing = new Set(this.entries.map(e => e.credentials.refreshToken).filter(Boolean));
            const added = await this._scanDir(kiroDir, existing);
            if (added > 0) logger.info(`[Credentials] Scanned ${added} credential(s) from configs/kiro/`);
        } catch (e) { logger.warn('[Credentials] Scan failed:', e.message); }
    }

    async _scanDir(dirPath, existing) {
        let added = 0;
        const items = await pfs.readdir(dirPath, { withFileTypes: true });
        for (const item of items) {
            const full = path.join(dirPath, item.name);
            if (item.isDirectory()) { added += await this._scanDir(full, existing); continue; }
            if (!item.name.endsWith('.json')) continue;
            try {
                const c = JSON.parse(await pfs.readFile(full, 'utf8'));
                if (c.refreshToken && !existing.has(c.refreshToken)) {
                    existing.add(c.refreshToken);
                    const id = Math.max(0, ...this.entries.map(e => e.id)) + 1;
                    c.id = id;
                    c._filePath = path.relative(process.cwd(), full);
                    this.entries.push(new CredentialEntry(id, c));
                    added++;
                }
            } catch { /* skip */ }
        }
        return added;
    }

    // ==================== 均衡算法 ====================

    _computeBalance(entry) {
        const now = Date.now();
        entry.requestTimestamps = entry.requestTimestamps.filter(t => t > now - 60000);
        const credRpm = entry.requestTimestamps.length;
        let decay = 0;
        if (credRpm === 0 && entry.lastUsedAt) {
            try {
                const idle = Math.max(0, now - new Date(entry.lastUsedAt).getTime());
                decay = Math.min(Math.floor(idle / 5000), 100);
            } catch { decay = 0; }
        }
        const score = Math.max(-100, Math.min(100, credRpm - decay));
        entry.balanceScore = score;
        return { score, rpm: credRpm, decay };
    }

    selectCredential(model = null, excludeIds = null) {
        const now = Date.now();
        const available = this.entries.filter(e =>
            !e.disabled && (!e.transientDisabledUntil || e.transientDisabledUntil <= now)
            && (!excludeIds || !excludeIds.has(e.id))
        );
        if (!available.length) return null;
        available.sort((a, b) => {
            const sa = this._computeBalance(a).score, sb = this._computeBalance(b).score;
            if (sa !== sb) return sa - sb;
            const pa = a.credentials.priority || 0, pb = b.credentials.priority || 0;
            return pa !== pb ? pa - pb : a.id - b.id;
        });
        this.currentId = available[0].id;
        return available[0];
    }

    recordSuccess(credId, model = null, inputTokens = 0, outputTokens = 0) {
        const e = this.entries.find(x => x.id === credId);
        if (!e) return;
        const now = Date.now();
        e.successCount++; e.sessionCount++; e.failureCount = 0;
        e.lastUsedAt = new Date().toISOString();
        e.requestTimestamps.push(now);
        this.requestTimestamps.push(now);
        this.requestTimestamps = this.requestTimestamps.filter(t => t > now - 60000);
        const rpm = this.requestTimestamps.length;
        if (rpm > this.peakRpm) this.peakRpm = rpm;
        if (model) {
            this.modelCallCounts[model] = (this.modelCallCounts[model] || 0) + 1;
            if (!this.modelCredCounts[model]) this.modelCredCounts[model] = {};
            this.modelCredCounts[model][credId] = (this.modelCredCounts[model][credId] || 0) + 1;
        }
        // Token 用量统计
        if (inputTokens || outputTokens) {
            const today = new Date().toDateString();
            if (today !== this._tokenUsageDate) {
                this.tokenUsage.yesterday = { ...this.tokenUsage.today };
                this.tokenUsage.today = { input: 0, output: 0 };
                // 翻转 models 的 today → yesterday
                for (const m of Object.keys(this.tokenUsage.models)) {
                    this.tokenUsage.models[m].yesterday = { ...this.tokenUsage.models[m].today };
                    this.tokenUsage.models[m].today = { input: 0, output: 0 };
                }
                this._tokenUsageDate = today;
            }
            this.tokenUsage.today.input += inputTokens;
            this.tokenUsage.today.output += outputTokens;
            if (model) {
                if (!this.tokenUsage.models[model]) {
                    this.tokenUsage.models[model] = {
                        today: { input: 0, output: 0 },
                        yesterday: { input: 0, output: 0 },
                    };
                }
                this.tokenUsage.models[model].today.input += inputTokens;
                this.tokenUsage.models[model].today.output += outputTokens;
            }
        }
    }

    recordFailure(credId) {
        const e = this.entries.find(x => x.id === credId);
        if (!e) return;
        e.failureCount++;
        if (e.failureCount >= MAX_FAILURES) {
            e.disabled = true;
            e.disabledReason = DisabledReason.TOO_MANY_FAILURES;
            logger.warn(`[Credentials] #${credId} disabled: too many failures`);
        } else {
            e.transientDisabledUntil = Date.now() + TRANSIENT_COOLDOWN_MS;
        }
    }

    // ==================== Admin API 格式 ====================

    getStatus() {
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter(t => t > now - 60000);
        const credentials = this.entries.map(entry => {
            const { score, rpm: credRpm, decay } = this._computeBalance(entry);
            const c = entry.credentials;
            const rtHash = c.refreshToken
                ? crypto.createHash('sha256').update(c.refreshToken).digest('hex') : null;
            const subTitle = entry.cachedBalance?.subscriptionTitle || null;
            let group = this.groups[entry.id] || null;
            // 未手动分组时，根据 subscriptionTitle 自动推断
            if (!group && subTitle) {
                group = subTitle.toUpperCase().includes('FREE') ? 'free' : 'pro';
            }
            return {
                id: entry.id, priority: c.priority || 0, disabled: entry.disabled,
                failureCount: entry.failureCount, isCurrent: entry.id === this.currentId,
                expiresAt: c.expiresAt || null, authMethod: c.authMethod || null,
                hasProfileArn: !!c.profileArn, email: c.email || undefined,
                refreshTokenHash: rtHash, successCount: entry.successCount,
                sessionCount: entry.sessionCount, lastUsedAt: entry.lastUsedAt,
                hasProxy: !!c.proxyUrl, proxyUrl: c.proxyUrl || undefined,
                subscriptionTitle: subTitle,
                group,
                balanceScore: score, balanceDecay: decay, balanceRpm: credRpm,
                cachedBalance: entry.cachedBalance || undefined,
                balanceUpdatedAt: entry.balanceUpdatedAt || undefined,
                disabledReason: entry.disabledReason || undefined,
            };
        });
        return {
            total: this.entries.length,
            available: this.entries.filter(e => !e.disabled).length,
            currentId: this.currentId,
            rpm: this.requestTimestamps.length,
            credentials,
        };
    }

    getStats() {
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter(t => t > now - 60000);
        return {
            totalRequests: this.entries.reduce((s, e) => s + e.successCount, 0),
            sessionRequests: this.entries.reduce((s, e) => s + e.sessionCount, 0),
            rpm: this.requestTimestamps.length, peakRpm: this.peakRpm,
            modelCounts: { ...this.modelCallCounts },
            modelCredCounts: JSON.parse(JSON.stringify(this.modelCredCounts)),
            credentialCount: this.entries.length,
            availableCount: this.entries.filter(e => !e.disabled).length,
        };
    }

    // ==================== CRUD ====================

    getEntry(id) { return this.entries.find(e => e.id === id) || null; }

    async setDisabled(id, disabled) {
        const e = this.getEntry(id); if (!e) return false;
        e.disabled = disabled;
        e.disabledReason = disabled ? DisabledReason.MANUAL : null;
        if (!disabled) e.failureCount = 0;
        await this.persistCredentials();
        return true;
    }

    async setPriority(id, priority) {
        const e = this.getEntry(id); if (!e) return false;
        e.credentials.priority = priority;
        await this.persistCredentials();
        return true;
    }

    async resetFailure(id) {
        const e = this.getEntry(id); if (!e) return false;
        e.failureCount = 0; e.transientDisabledUntil = null;
        if (e.disabledReason === DisabledReason.TOO_MANY_FAILURES) {
            e.disabled = false; e.disabledReason = null;
        }
        await this.persistCredentials();
        return true;
    }

    async resetAllCounters() {
        for (const e of this.entries) {
            e.sessionCount = 0; e.failureCount = 0; e.transientDisabledUntil = null;
            if (e.disabledReason === DisabledReason.TOO_MANY_FAILURES) {
                e.disabled = false; e.disabledReason = null;
            }
        }
        this.requestTimestamps = []; this.peakRpm = 0;
        this.modelCallCounts = {}; this.modelCredCounts = {};
        await this.persistCredentials();
    }

    async deleteCredential(id) {
        const idx = this.entries.findIndex(e => e.id === id);
        if (idx === -1) return false;
        this.entries.splice(idx, 1);
        if (this.currentId === id && this.entries.length > 0) this.currentId = this.entries[0].id;
        await this.persistCredentials();
        return true;
    }

    async addCredential(credData) {
        // 重复检测（对齐 kiro.py token_manager.add_credential）
        const rt = credData.refreshToken;
        if (!rt) throw new Error('缺少 refreshToken');
        const rtHash = crypto.createHash('sha256').update(rt).digest('hex');
        const dup = this.entries.some(e =>
            e.credentials.refreshToken && crypto.createHash('sha256').update(e.credentials.refreshToken).digest('hex') === rtHash
        );
        if (dup) throw new Error('凭据已存在（refreshToken 重复）');

        const id = Math.max(0, ...this.entries.map(e => e.id)) + 1;
        credData.id = id;
        const entry = new CredentialEntry(id, credData);
        this.entries.push(entry);
        try {
            await this._createService(entry);
        } catch (err) {
            logger.warn(`[Credentials] #${id} service init failed on add: ${err.message}`);
        }
        await this.persistCredentials();
        return id;
    }

    async setGroups(groups) {
        for (const [k, v] of Object.entries(groups)) this.groups[parseInt(k)] = v;
        await this.persistCredentials();
    }

    async getRawCredentials() {
        try { return await pfs.readFile(this.credentialsPath, 'utf8'); }
        catch { return '[]'; }
    }

    async saveRawCredentials(content) {
        await pfs.writeFile(this.credentialsPath, content, 'utf8');
        await this.loadCredentials();
    }

    async persistCredentials() {
        const data = this.entries.map(e => {
            const c = { ...e.credentials };
            delete c._filePath;
            // 同步运行时状态到凭据对象
            c.disabled = e.disabled || undefined;
            c.priority = c.priority || undefined;
            const group = this.groups[e.id];
            if (group) c.group = group;
            return c;
        });
        await pfs.writeFile(this.credentialsPath, JSON.stringify(data, null, 2), 'utf8');
    }

    // ==================== 余额查询 ====================

    static BALANCE_CACHE_TTL = 300_000; // 5 分钟缓存

    /** 获取凭据余额，带缓存。forceRefresh 跳过缓存 */
    async getBalance(id, forceRefresh = false) {
        const entry = this.getEntry(id);
        if (!entry) throw new Error('Credential not found');
        if (!entry.service) throw new Error('Service not initialized');

        if (!forceRefresh) {
            const cached = this._balanceCache[id];
            if (cached && (Date.now() - cached.cachedAt) < CredentialManager.BALANCE_CACHE_TTL) {
                return cached.data;
            }
        }

        const usage = await entry.service.getUsageLimits();
        const balance = this._parseUsageLimits(id, usage);

        // 缓存结果
        this._balanceCache[id] = { cachedAt: Date.now(), data: balance };
        entry.cachedBalance = balance;
        entry.balanceUpdatedAt = new Date().toISOString();
        await this._saveBalanceCache();

        return balance;
    }

    /** 将 Kiro API getUsageLimits 响应转换为前端 BalanceResponse 格式 */
    _parseUsageLimits(id, data) {
        const breakdown = data?.usageBreakdownList?.[0];
        if (!breakdown) {
            return { id, subscriptionTitle: null, currentUsage: 0, usageLimit: 0, remaining: 0, usagePercentage: 0, nextResetAt: null };
        }

        let usageLimit = breakdown.usageLimitWithPrecision || 0;
        let currentUsage = breakdown.currentUsageWithPrecision || 0;

        // free trial（按 status 判断）
        const ft = breakdown.freeTrialInfo;
        if (ft && ft.freeTrialStatus === 'ACTIVE') {
            usageLimit += ft.usageLimitWithPrecision || 0;
            currentUsage += ft.currentUsageWithPrecision || 0;
        }

        // bonuses（按 status 判断）
        for (const bonus of (breakdown.bonuses || [])) {
            if (bonus.status === 'ACTIVE') {
                usageLimit += bonus.usageLimit || 0;
                currentUsage += bonus.currentUsage || 0;
            }
        }

        const remaining = Math.max(usageLimit - currentUsage, 0);
        const usagePercentage = usageLimit > 0 ? Math.min(currentUsage / usageLimit * 100, 100) : 0;
        const subscriptionTitle = data?.subscriptionInfo?.subscriptionTitle || null;
        const nextResetAt = data?.nextDateReset || breakdown.nextDateReset || null;

        return { id, subscriptionTitle, currentUsage, usageLimit, remaining, usagePercentage: Math.round(usagePercentage * 100) / 100, nextResetAt };
    }
}
