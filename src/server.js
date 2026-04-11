// Node-side helper for LODU loading.
//
//     const lodu = require('loduloading/server');
//
//     app.get('/', (req, res) => {
//         const data = {
//             user:  db.user(req.userId),
//             posts: db.allPosts(),
//             stats: db.stats(),
//         };
//         res.send(lodu.page({
//             title: 'Dashboard',
//             body: fs.readFileSync('dashboard.html', 'utf8'),
//             data,
//         }));
//     });

'use strict';

const fs = require('fs');
const path = require('path');
const { encode } = require('./encoder');

const DEFAULT_WASM_PATH = path.resolve(__dirname, '..', 'dist', 'lodu_core.wasm');
const DEFAULT_CLIENT_PATH = path.resolve(__dirname, 'lodu.js');

function payloadScript(value, { id = 'lodu-payload' } = {}) {
    const bytes = encode(value);
    const b64 = Buffer.from(bytes).toString('base64');
    return `<script id="${id}" type="application/lodu">${b64}</script>`;
}

function bootScript({
    wasmURL = '/lodu_core.wasm',
    clientURL = '/lodu.js',
    root = null,
} = {}) {
    const rootExpr = root ? JSON.stringify(root) : 'null';
    return (
        `<script>window.__LODU_WASM_URL__=${JSON.stringify(wasmURL)};</script>` +
        `<script src="${clientURL}"></script>` +
        `<script>` +
        `lodu.hydrate({` +
        (root ? `root:document.querySelector(${rootExpr}),` : '') +
        `}).then(db=>{window.lodudb=db;});` +
        `</script>`
    );
}

/**
 * Build a full HTML page with an inline LODU payload and auto-hydrating boot
 * script. Pass your body as an HTML string with `data-lodu` bindings.
 */
function page({
    title = 'lodu',
    body = '',
    data = {},
    head = '',
    wasmURL = '/lodu_core.wasm',
    clientURL = '/lodu.js',
} = {}) {
    return (
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<title>${escapeHtml(title)}</title>${head}</head><body>` +
        body +
        payloadScript(data) +
        bootScript({ wasmURL, clientURL }) +
        `</body></html>`
    );
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function serveStatic(req, res, next) {
    // Tiny helper for examples: serves lodu.js and lodu_core.wasm.
    const url = req.url.split('?')[0];
    if (url === '/lodu.js') {
        res.setHeader('content-type', 'application/javascript');
        fs.createReadStream(DEFAULT_CLIENT_PATH).pipe(res);
        return true;
    }
    if (url === '/lodu_core.wasm') {
        res.setHeader('content-type', 'application/wasm');
        fs.createReadStream(DEFAULT_WASM_PATH).pipe(res);
        return true;
    }
    return false;
}

module.exports = {
    encode,
    payloadScript,
    bootScript,
    page,
    serveStatic,
    DEFAULT_WASM_PATH,
    DEFAULT_CLIENT_PATH,
};
