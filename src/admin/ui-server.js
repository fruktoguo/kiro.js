/**
 * Admin UI 静态文件服务
 * 服务 admin-ui/dist/ 目录，SPA fallback
 */

import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

const distDir = path.join(process.cwd(), 'admin-ui', 'dist');

export function serveAdminUI(urlPath, res) {
    // /admin 或 /admin/ → index.html
    let filePath;
    if (urlPath === '/admin' || urlPath === '/admin/') {
        filePath = path.join(distDir, 'index.html');
    } else if (urlPath.startsWith('/admin/')) {
        filePath = path.join(distDir, urlPath.replace('/admin/', ''));
    } else {
        return false;
    }

    if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readFileSync(filePath));
        return true;
    }

    // SPA fallback: 非文件路径返回 index.html
    const indexPath = path.join(distDir, 'index.html');
    if (existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(readFileSync(indexPath));
        return true;
    }

    return false;
}
