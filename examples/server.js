// A tiny demo of LODU loading.
//
//     node examples/server.js
//     open http://localhost:3000
//
// The server generates a dataset, encodes it into a LODU payload, inlines
// it in the HTML, and the browser hydrates it into WASM linear memory.
// Everything you see is rendered instantly on the first paint — there are
// no XHR/fetch round-trips after the initial HTML lands.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const lodu = require('../src/server');

const PORT = process.env.PORT || 3000;

function buildDataset() {
    const roles = ['admin', 'editor', 'viewer'];
    const users = [];
    for (let i = 0; i < 500; i++) {
        users.push({
            id: i,
            name: `User ${i}`,
            email: `user${i}@example.com`,
            role: roles[i % 3],
            joined: `2025-${String((i % 12) + 1).padStart(2, '0')}-15`,
        });
    }
    return {
        title: 'lodu loading demo',
        generatedAt: new Date().toISOString(),
        stats: { total: users.length, admins: Math.ceil(users.length / 3) },
        users,
    };
}

const BODY = `
<h1 data-lodu="title"></h1>
<p>Generated at: <code data-lodu="generatedAt"></code></p>
<p>Total users: <strong data-lodu="stats.total"></strong> (<span data-lodu="stats.admins"></span> admins)</p>

<table border="1" cellpadding="4" cellspacing="0">
  <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
  <tbody data-lodu-each="users">
    <template>
      <tr>
        <td data-lodu="id"></td>
        <td data-lodu="name"></td>
        <td data-lodu="email"></td>
        <td data-lodu="role"></td>
        <td data-lodu="joined"></td>
      </tr>
    </template>
  </tbody>
</table>

<p><small>Payload embedded inline, parsed once into WASM linear memory,
walked via handle-based accessors. JavaScript never allocates a single
JS object for the rows.</small></p>
`;

const server = http.createServer((req, res) => {
    if (lodu.serveStatic(req, res, () => {})) return;

    if (req.url === '/' || req.url.startsWith('/?')) {
        const data = buildDataset();
        const html = lodu.page({
            title: 'lodu loading demo',
            body: BODY,
            data,
        });
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(html);
        return;
    }

    res.statusCode = 404;
    res.end('not found');
});

server.listen(PORT, () => {
    console.log(`lodu demo on http://localhost:${PORT}`);
});
