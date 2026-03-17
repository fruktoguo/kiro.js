/**
 * kiro.js 通用工具模块
 * 精简自 A2 的 common.js，只保留 Kiro 相关内容
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import logger from './logger.js';

// ==================== 网络错误处理 ====================

export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND',
    'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN',
    'ECONNABORTED', 'ESOCKETTIMEDOUT',
];

export function isRetryableNetworkError(error) {
    if (!error) return false;
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    return RETRYABLE_NETWORK_ERRORS.some(errId =>
        errorCode === errId || errorMessage.includes(errId)
    );
}

// ==================== API 常量 ====================

export const MODEL_PROVIDER = {
    KIRO_API: 'claude-kiro-oauth',
};

export const ENDPOINT_TYPE = {
    CLAUDE_MESSAGE: 'claude_message',
};

export const MODEL_PROTOCOL_PREFIX = {
    CLAUDE: 'claude',
};

export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

// ==================== 工具函数 ====================

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

export function formatLog(tag, message, data = null) {
    let logMessage = `[${tag}] ${message}`;
    if (data !== null && data !== undefined) {
        if (typeof data === 'object') {
            const dataStr = Object.entries(data).map(([key, value]) => `${key}: ${value}`).join(', ');
            logMessage += ` | ${dataStr}`;
        } else {
            logMessage += ` | ${data}`;
        }
    }
    return logMessage;
}

export function formatExpiryLog(tag, expiryDate, nearMinutes) {
    const currentTime = Date.now();
    const nearMinutesInMillis = nearMinutes * 60 * 1000;
    const thresholdTime = currentTime + nearMinutesInMillis;
    const isNearExpiry = expiryDate <= thresholdTime;
    const message = formatLog(tag, 'Checking expiry date', {
        'Expiry date': expiryDate,
        'Current time': currentTime,
        [`${nearMinutes} minutes from now`]: thresholdTime,
        'Is near expiry': isNearExpiry
    });
    return { message, isNearExpiry };
}

export function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    if (ip && ip.includes('::ffff:')) {
        ip = ip.replace('::ffff:', '');
    }
    return ip || 'unknown';
}

export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); }
            catch (error) { reject(new Error("Invalid JSON in request body.")); }
        });
        req.on('error', err => { reject(err); });
    });
}

// API Key 认证（支持 Bearer、x-api-key）
export function isAuthorized(req, requestUrl, requiredApiKey) {
    const authHeader = req.headers['authorization'];
    const claudeApiKey = req.headers['x-api-key'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        if (authHeader.substring(7) === requiredApiKey) return true;
    }
    if (claudeApiKey === requiredApiKey) return true;
    return false;
}

// 错误响应
export function handleError(res, error, provider) {
    if (res.writableEnded) return;
    const statusCode = error.statusCode || error.status || 500;
    const message = error.message || 'Internal Server Error';
    logger.error(`[Error] ${provider}: ${message}`);
    try {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message }
        }));
    } catch (e) {
        logger.error('[Error] Failed to send error response:', e.message);
    }
}

// 提取系统提示
export function extractSystemPromptFromRequestBody(requestBody) {
    if (typeof requestBody.system === 'string') return requestBody.system;
    if (Array.isArray(requestBody.system)) {
        return requestBody.system
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text)
            .join('\n');
    }
    return null;
}
