import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(projectRoot, 'dist', 'server');

const files = [
    ['index.html', 'text/html; charset=utf-8'],
    ['styles.css', 'text/css; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['session-engine.js', 'text/javascript; charset=utf-8'],
    ['service-worker.js', 'text/javascript; charset=utf-8'],
    ['manifest.json', 'application/manifest+json; charset=utf-8'],
    ['og.png', 'image/png'],
    ['icons/icon-180x180.png', 'image/png'],
    ['icons/icon-192x192.PNG', 'image/png'],
    ['icons/icon-512x512.PNG', 'image/png'],
    ['icons/icon-maskable-512.png', 'image/png']
];

const assets = {};
for (const [relativePath, contentType] of files) {
    const content = await readFile(path.join(projectRoot, relativePath));
    assets[`/${relativePath}`] = {
        contentType,
        base64: content.toString('base64')
    };
}

const worker = `
const ASSETS = ${JSON.stringify(assets)};
const DECODED = new Map();

function decode(base64) {
    if (DECODED.has(base64)) return DECODED.get(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    DECODED.set(base64, bytes);
    return bytes;
}

function responseFor(assetPath, requestMethod = 'GET') {
    const asset = ASSETS[assetPath];
    if (!asset) return null;
    const headers = new Headers({
        'Content-Type': asset.contentType,
        'Cache-Control': assetPath === '/index.html' || assetPath === '/service-worker.js'
            ? 'no-cache'
            : 'public, max-age=3600',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    if (assetPath === '/service-worker.js') headers.set('Service-Worker-Allowed', '/');
    return new Response(requestMethod === 'HEAD' ? null : decode(asset.base64), { status: 200, headers });
}

export default {
    async fetch(request) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        const url = new URL(request.url);
        let assetPath = decodeURIComponent(url.pathname);
        if (assetPath === '/') assetPath = '/index.html';
        const direct = responseFor(assetPath, request.method);
        if (direct) return direct;
        if ((request.headers.get('Accept') || '').includes('text/html')) {
            return responseFor('/index.html', request.method);
        }
        return new Response('Not found', { status: 404 });
    }
};
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'index.js'), worker.trimStart(), 'utf8');
console.log(`Built Quiet Breath for Sites with ${files.length} embedded assets.`);
