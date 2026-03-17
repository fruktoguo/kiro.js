/**
 * kiro.js 配置管理器
 * 精简自 A2 的 config-manager.js，只保留 Kiro 相关配置
 */

import * as fs from 'fs';
import { promises as pfs } from 'fs';
import logger from '../utils/logger.js';

export let CONFIG = {};

export async function initializeConfig(args = process.argv.slice(2), configFilePath = 'configs/config.json') {
    const defaultConfig = {
        REQUIRED_API_KEY: "123456",
        ADMIN_API_KEY: "",
        SERVER_PORT: 8990,
        HOST: '0.0.0.0',
        REGION: 'us-east-1',
        AUTH_REGION: null,
        API_REGION: null,
        KIRO_VERSION: '0.10.0',
        MACHINE_ID: null,
        SYSTEM_VERSION: 'win32#10.0.22631',
        NODE_VERSION: '22.21.1',
        TLS_BACKEND: 'rustls',
        COUNT_TOKENS_API_URL: null,
        COUNT_TOKENS_API_KEY: null,
        COUNT_TOKENS_AUTH_TYPE: 'x-api-key',
        REQUEST_MAX_BYTES: 8388608,
        REQUEST_MAX_CHARS: 2000000,
        REQUEST_CONTEXT_TOKEN_LIMIT: 184000,
        STREAM_PING_INTERVAL_SECS: 15,
        STREAM_MAX_IDLE_PINGS: 4,
        STREAM_IDLE_WARN_AFTER_PINGS: 2,
        TOOL_RESULT_CURRENT_MAX_CHARS: 16000,
        TOOL_RESULT_CURRENT_MAX_LINES: 300,
        TOOL_RESULT_HISTORY_MAX_CHARS: 6000,
        TOOL_RESULT_HISTORY_MAX_LINES: 120,
        PROXY_URL: null,
        PROXY_USERNAME: null,
        PROXY_PASSWORD: null,
        PROXY_ENABLED_PROVIDERS: [],
        REQUEST_MAX_RETRIES: 3,
        REQUEST_BASE_DELAY: 1000,
        CRON_NEAR_MINUTES: 15,
        CRON_REFRESH_TOKEN: true,
        CREDENTIALS_FILE: 'credentials.json',
        LOAD_BALANCING_MODE: 'priority',
        LOG_ENABLED: true,
        LOG_OUTPUT_MODE: 'all',
        LOG_LEVEL: 'info',
        LOG_DIR: 'logs',
        LOG_MAX_FILE_SIZE: 10485760,
        LOG_MAX_FILES: 10,
    };

    let currentConfig = { ...defaultConfig };

    // 加载 config.json
    try {
        const configData = fs.readFileSync(configFilePath, 'utf8');
        const loaded = JSON.parse(configData);
        // camelCase → CONFIG key 映射
        const keyMap = {
            apiKey: 'REQUIRED_API_KEY', adminApiKey: 'ADMIN_API_KEY',
            port: 'SERVER_PORT', host: 'HOST', region: 'REGION',
            authRegion: 'AUTH_REGION', apiRegion: 'API_REGION',
            kiroVersion: 'KIRO_VERSION', machineId: 'MACHINE_ID',
            systemVersion: 'SYSTEM_VERSION', nodeVersion: 'NODE_VERSION',
            tlsBackend: 'TLS_BACKEND',
            countTokensApiUrl: 'COUNT_TOKENS_API_URL',
            countTokensApiKey: 'COUNT_TOKENS_API_KEY',
            countTokensAuthType: 'COUNT_TOKENS_AUTH_TYPE',
            requestMaxBytes: 'REQUEST_MAX_BYTES',
            requestMaxChars: 'REQUEST_MAX_CHARS',
            requestContextTokenLimit: 'REQUEST_CONTEXT_TOKEN_LIMIT',
            streamPingIntervalSecs: 'STREAM_PING_INTERVAL_SECS',
            streamMaxIdlePings: 'STREAM_MAX_IDLE_PINGS',
            streamIdleWarnAfterPings: 'STREAM_IDLE_WARN_AFTER_PINGS',
            toolResultCurrentMaxChars: 'TOOL_RESULT_CURRENT_MAX_CHARS',
            toolResultCurrentMaxLines: 'TOOL_RESULT_CURRENT_MAX_LINES',
            toolResultHistoryMaxChars: 'TOOL_RESULT_HISTORY_MAX_CHARS',
            toolResultHistoryMaxLines: 'TOOL_RESULT_HISTORY_MAX_LINES',
            proxyUrl: 'PROXY_URL', proxyUsername: 'PROXY_USERNAME',
            proxyPassword: 'PROXY_PASSWORD',
            credentialsFile: 'CREDENTIALS_FILE',
            loadBalancingMode: 'LOAD_BALANCING_MODE',
            cronNearMinutes: 'CRON_NEAR_MINUTES',
            cronRefreshToken: 'CRON_REFRESH_TOKEN',
        };
        for (const [jsonKey, configKey] of Object.entries(keyMap)) {
            if (loaded[jsonKey] !== undefined) currentConfig[configKey] = loaded[jsonKey];
        }
        // 直接覆盖大写 key
        for (const key of Object.keys(defaultConfig)) {
            if (loaded[key] !== undefined) currentConfig[key] = loaded[key];
        }
        logger.info('[Config] Loaded configuration from ' + configFilePath);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error('[Config Error] Failed to load config:', error.message);
        } else {
            logger.info('[Config] Config file not found, using defaults.');
        }
    }

    // CLI 参数覆盖
    const cliDefs = [
        { flag: '--api-key', key: 'REQUIRED_API_KEY', type: 'string' },
        { flag: '--admin-api-key', key: 'ADMIN_API_KEY', type: 'string' },
        { flag: '--port', key: 'SERVER_PORT', type: 'int' },
        { flag: '--host', key: 'HOST', type: 'string' },
        { flag: '--region', key: 'REGION', type: 'string' },
        { flag: '--credentials-file', key: 'CREDENTIALS_FILE', type: 'string' },
        { flag: '--cron-near-minutes', key: 'CRON_NEAR_MINUTES', type: 'int' },
        { flag: '--cron-refresh-token', key: 'CRON_REFRESH_TOKEN', type: 'bool' },
    ];
    const flagMap = new Map(cliDefs.map(d => [d.flag, d]));
    for (let i = 0; i < args.length; i++) {
        const def = flagMap.get(args[i]);
        if (!def || i + 1 >= args.length) continue;
        const raw = args[++i];
        if (def.type === 'string') currentConfig[def.key] = raw;
        else if (def.type === 'int') currentConfig[def.key] = parseInt(raw, 10);
        else if (def.type === 'bool') currentConfig[def.key] = raw.toLowerCase() === 'true';
    }

    Object.assign(CONFIG, currentConfig);

    // 初始化 logger
    logger.initialize({
        enabled: CONFIG.LOG_ENABLED ?? true,
        outputMode: CONFIG.LOG_OUTPUT_MODE || 'all',
        logLevel: CONFIG.LOG_LEVEL || 'info',
        logDir: CONFIG.LOG_DIR || 'logs',
        includeRequestId: true,
        includeTimestamp: true,
        maxFileSize: CONFIG.LOG_MAX_FILE_SIZE || 10485760,
        maxFiles: CONFIG.LOG_MAX_FILES || 10,
    });
    logger.cleanupOldLogs();

    return CONFIG;
}
