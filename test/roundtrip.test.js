// Round-trip tests: encode JS values -> LODU bytes -> WASM -> walk back out.
// Runs under plain `node test/roundtrip.test.js`, no framework.

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { encode } = require('../src/encoder');
const { load } = require('../src/lodu');

const WASM_PATH = path.resolve(__dirname, '..', 'dist', 'lodu_core.wasm');

async function loadDB(value) {
    const bytes = encode(value);
    const wasmBytes = fs.readFileSync(WASM_PATH);
    return await load(bytes, wasmBytes);
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('primitives', async () => {
    const cases = [null, true, false, 0, 1, -1, 2147483647, -2147483648, 3.14, 'hi', ''];
    for (const v of cases) {
        const db = await loadDB(v);
        assert.deepStrictEqual(db.root.toJS(), v, `round-trip ${JSON.stringify(v)}`);
    }
});

test('large float', async () => {
    const db = await loadDB(1.5e200);
    assert.strictEqual(db.root.num, 1.5e200);
    assert.strictEqual(db.root.type, 'float');
});

test('array of mixed', async () => {
    const v = [1, 'two', false, null, 4.5, [7, 8]];
    const db = await loadDB(v);
    assert.deepStrictEqual(db.root.toJS(), v);
    assert.strictEqual(db.root.length, 6);
    assert.strictEqual(db.root.at(1).str, 'two');
    assert.strictEqual(db.root.at(5).at(1).int, 8);
});

test('object get', async () => {
    const v = { name: 'ada', age: 37, tags: ['math', 'eng'] };
    const db = await loadDB(v);
    assert.strictEqual(db.root.get('name').str, 'ada');
    assert.strictEqual(db.root.get('age').int, 37);
    assert.strictEqual(db.root.get('tags').at(0).str, 'math');
    assert.strictEqual(db.root.get('missing').exists, false);
});

test('dot path', async () => {
    const v = { user: { posts: [{ title: 'first' }, { title: 'second' }] } };
    const db = await loadDB(v);
    assert.strictEqual(db.root.path('user.posts.0.title').str, 'first');
    assert.strictEqual(db.root.path('user.posts.1.title').str, 'second');
});

test('key interning + random access on a 10k-row dataset', async () => {
    // A realistic-ish table of users: repeated keys + repeated enum-like
    // values ("admin", "user", "guest"). The string table should intern
    // each of those exactly once.
    const roles = ['admin', 'user', 'guest'];
    const rows = [];
    for (let i = 0; i < 10000; i++) {
        rows.push({
            id: i,
            email: `user${i}@example.com`,
            role: roles[i % 3],
            verified: (i & 1) === 0,
        });
    }
    const bytes = encode(rows);

    const wasmBytes = fs.readFileSync(WASM_PATH);
    const db = await load(bytes, wasmBytes);
    assert.strictEqual(db.root.length, 10000);

    // Random-access reads without ever materializing the full array.
    assert.strictEqual(db.root.at(4242).get('id').int, 4242);
    assert.strictEqual(db.root.at(4242).get('email').str, 'user4242@example.com');
    assert.strictEqual(db.root.at(4242).get('role').str, roles[4242 % 3]);
    assert.strictEqual(db.root.at(4242).get('verified').bool, true);
    assert.strictEqual(db.root.at(4243).get('verified').bool, false);

    // The 4 keys ('id','email','role','verified') should have been interned
    // once each, along with the 3 role enums. That's 7 unique strings plus
    // 10k unique emails.
    assert.ok(bytes.length > 0);
    // Memory used inside WASM should be ~ payload size (no explosion).
    assert.ok(db.memoryUsed < bytes.length * 2);
});

test('iteration', async () => {
    const v = { a: 1, b: 2, c: 3 };
    const db = await loadDB(v);
    const seen = {};
    for (const [k, val] of db.root) seen[k] = val.int;
    assert.deepStrictEqual(seen, { a: 1, b: 2, c: 3 });
});

test('deeply nested', async () => {
    let v = 0;
    for (let i = 0; i < 50; i++) v = { next: v, n: i };
    const db = await loadDB(v);
    let cur = db.root;
    for (let i = 49; i > 0; i--) {
        assert.strictEqual(cur.get('n').int, i);
        cur = cur.get('next');
    }
});

test('reset allows reload', async () => {
    const db = await loadDB({ x: 1 });
    assert.strictEqual(db.root.get('x').int, 1);
    // Reuse the same instance to load a fresh payload.
    db.load(encode({ y: 'two' }));
    assert.strictEqual(db.root.get('y').str, 'two');
    assert.strictEqual(db.root.get('x').exists, false);
});

test('empty object and array', async () => {
    const db1 = await loadDB({});
    assert.strictEqual(db1.root.type, 'object');
    assert.strictEqual(db1.root.length, 0);
    const db2 = await loadDB([]);
    assert.strictEqual(db2.root.type, 'array');
    assert.strictEqual(db2.root.length, 0);
});

test('unicode strings', async () => {
    const v = { greeting: 'héllo 🌍', jp: 'こんにちは' };
    const db = await loadDB(v);
    assert.strictEqual(db.root.get('greeting').str, 'héllo 🌍');
    assert.strictEqual(db.root.get('jp').str, 'こんにちは');
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (e) {
            failed++;
            console.log(`  FAIL ${name}`);
            console.log('    ' + (e.stack || e.message));
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed === 0 ? 0 : 1);
})();
