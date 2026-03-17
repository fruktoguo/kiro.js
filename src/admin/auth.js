/**
 * Admin 登录认证
 * 使用 x-api-key header 验证
 */

import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';

let adminApiKey = '';

export function setAdminApiKey(key) {
    adminApiKey = key;
}

export function checkAuth(req) {
    if (!adminApiKey) return false;
    const key = req.headers['x-api-key'];
    return key === adminApiKey;
}

export async function handleLoginRequest(req, res) {
    try {
        const body = await getRequestBody(req);
        const { password } = body;
        if (password === adminApiKey) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, token: adminApiKey }));
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid password' }));
        }
    } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return true;
}
