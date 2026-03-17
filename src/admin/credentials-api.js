/**
 * Admin 凭据管理 API
 * 对齐 kiro.py 前端的 /api/admin/* 接口
 */

import { getRequestBody } from '../utils/common.js';
import logger from '../utils/logger.js';

export function createCredentialsApi(credentialManager) {
    return async function handleCredentialsApi(method, pathParts, req, res) {
        // GET /credentials
        if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'credentials') {
            const status = credentialManager.getStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
            return true;
        }

        // POST /credentials (添加)
        if (method === 'POST' && pathParts.length === 1 && pathParts[0] === 'credentials') {
            const body = await getRequestBody(req);
            const id = await credentialManager.addCredential(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Credential added', credentialId: id }));
            return true;
        }

        // DELETE /credentials/:id
        if (method === 'DELETE' && pathParts.length === 2 && pathParts[0] === 'credentials') {
            const id = parseInt(pathParts[1]);
            const ok = await credentialManager.deleteCredential(id);
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, message: ok ? 'Deleted' : 'Not found' }));
            return true;
        }

        // POST /credentials/:id/disabled
        if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'disabled') {
            const id = parseInt(pathParts[1]);
            const body = await getRequestBody(req);
            const ok = await credentialManager.setDisabled(id, body.disabled);
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, message: ok ? 'Updated' : 'Not found' }));
            return true;
        }

        // POST /credentials/:id/priority
        if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'priority') {
            const id = parseInt(pathParts[1]);
            const body = await getRequestBody(req);
            const ok = await credentialManager.setPriority(id, body.priority);
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, message: ok ? 'Updated' : 'Not found' }));
            return true;
        }

        // POST /credentials/:id/reset
        if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'reset') {
            const id = parseInt(pathParts[1]);
            const ok = await credentialManager.resetFailure(id);
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, message: ok ? 'Reset' : 'Not found' }));
            return true;
        }

        // GET /credentials/:id/balance
        if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'balance') {
            const id = parseInt(pathParts[1]);
            const url = new URL(req.url, `http://${req.headers.host}`);
            const forceRefresh = ['1', 'true'].includes(url.searchParams.get('forceRefresh'));
            try {
                const balance = await credentialManager.getBalance(id, forceRefresh);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(balance));
            } catch (err) {
                const status = err.message === 'Credential not found' ? 404 : 500;
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { type: status === 404 ? 'not_found' : 'api_error', message: err.message } }));
            }
            return true;
        }

        // GET /credentials-raw
        if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'credentials-raw') {
            const content = await credentialManager.getRawCredentials();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content }));
            return true;
        }

        // PUT /credentials-raw
        if (method === 'PUT' && pathParts.length === 1 && pathParts[0] === 'credentials-raw') {
            const body = await getRequestBody(req);
            try {
                await credentialManager.saveRawCredentials(body.content);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Saved and reloaded' }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: e.message }));
            }
            return true;
        }

        // PUT /credentials/groups
        if (method === 'PUT' && pathParts.length === 2 && pathParts[1] === 'groups') {
            const body = await getRequestBody(req);
            await credentialManager.setGroups(body.groups || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Groups updated' }));
            return true;
        }

        // POST /credentials/reset-all
        if (method === 'POST' && pathParts.length === 2 && pathParts[1] === 'reset-all') {
            await credentialManager.resetAllCounters();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'All counters reset' }));
            return true;
        }

        return false;
    };
}
