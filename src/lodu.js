// lodu — the opposite of lazy loading.
//
// Usage (browser):
//
//     import { hydrate } from './lodu.js';
//     const db = await hydrate();           // reads <script id="lodu-payload">
//     db.root.get('user').get('name').str;  // walks WASM memory, no copies
//     db.render(document.body);              // binds [data-lodu] nodes
//
// Usage (Node, for tests):
//
//     const { load } = require('./lodu.js');
//     const db = await load(bytes, wasmBytes);

'use strict';

// ------- WASM loader -------

// Keep the module singleton per page. Multiple hydrations re-use it.
let _wasmPromise = null;

function defaultWasmURL() {
    // Resolved relative to this file when served as a module. The server
    // helper below writes an absolute URL via the <script> tag so the
    // browser doesn't need import.meta.url.
    if (typeof globalThis !== 'undefined' && globalThis.__LODU_WASM_URL__) {
        return globalThis.__LODU_WASM_URL__;
    }
    return './lodu_core.wasm';
}

async function fetchWasm(url) {
    if (typeof fetch === 'function') {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`lodu: failed to fetch ${url}: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }
    // Node fallback
    const fs = require('fs');
    const path = require('path');
    return new Uint8Array(fs.readFileSync(path.resolve(url)));
}

async function loadWasm(source) {
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
        return WebAssembly.instantiate(source, {});
    }
    if (typeof source === 'string') {
        const bytes = await fetchWasm(source);
        return WebAssembly.instantiate(bytes, {});
    }
    const bytes = await fetchWasm(defaultWasmURL());
    return WebAssembly.instantiate(bytes, {});
}

// ------- Database -------

class LoduDB {
    constructor(instance) {
        this.instance = instance;
        this.exports = instance.exports;
        this.memory = this.exports.memory;
        this._textDecoder = new TextDecoder('utf-8');
        this._rootHandle = 0;
        this._keyIndexCache = new Map(); // string -> string-table index
        this._lastPayloadSize = 0;
    }

    /** Upload a payload into WASM linear memory and validate its header. */
    load(bytes) {
        const e = this.exports;
        e.lodu_reset();
        const ptr = e.lodu_alloc(bytes.length);
        if (ptr === 0) throw new Error('lodu: allocation failed');
        new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
        const root = e.lodu_load(ptr, bytes.length);
        if (root === 0) throw new Error('lodu: invalid payload header');
        this._rootHandle = root;
        this._keyIndexCache.clear();
        this._lastPayloadSize = bytes.length;
        return this;
    }

    get root() { return new Value(this, this._rootHandle); }

    get payloadSize() { return this._lastPayloadSize; }
    get memoryUsed() { return this.exports.lodu_used(); }
    get memoryBytes() { return this.memory.buffer.byteLength; }

    // Internal: decode a WASM-owned string into a JS string.
    _readString(ptr, len) {
        return this._textDecoder.decode(
            new Uint8Array(this.memory.buffer, ptr, len)
        );
    }

    // Internal: resolve a JS string to its string-table index, caching.
    _keyIndex(key) {
        const cached = this._keyIndexCache.get(key);
        if (cached !== undefined) return cached;
        const enc = new TextEncoder().encode(key);
        const e = this.exports;
        const ptr = e.lodu_alloc(enc.length);
        new Uint8Array(this.memory.buffer, ptr, enc.length).set(enc);
        const idx = e.lodu_string_table_lookup(ptr, enc.length);
        this._keyIndexCache.set(key, idx);
        return idx;
    }
}

// ------- Value — zero-copy cursor into WASM linear memory -------

const TYPE_NAMES = {
    0x00: 'null', 0x01: 'false', 0x02: 'true',
    0x03: 'int', 0x04: 'float', 0x05: 'string',
    0x06: 'array', 0x07: 'object',
};

class Value {
    constructor(db, handle) {
        this.db = db;
        this.handle = handle;
    }

    get type() {
        const t = this.db.exports.lodu_type(this.handle);
        return TYPE_NAMES[t] || 'unknown';
    }

    get exists() { return this.handle !== 0; }

    // Coercions
    get bool() { return this.db.exports.lodu_as_bool(this.handle) !== 0; }
    get int() { return this.db.exports.lodu_as_i32(this.handle); }
    get num() { return this.db.exports.lodu_as_f64(this.handle); }
    get str() {
        const e = this.db.exports;
        if (e.lodu_type(this.handle) !== 0x05) return String(this.toJS());
        const ptr = e.lodu_str_ptr(this.handle);
        const len = e.lodu_str_len(this.handle);
        return this.db._readString(ptr, len);
    }

    // Array access
    get length() {
        const e = this.db.exports;
        const t = e.lodu_type(this.handle);
        if (t === 0x06) return e.lodu_array_len(this.handle);
        if (t === 0x07) return e.lodu_object_len(this.handle);
        if (t === 0x05) return e.lodu_str_len(this.handle);
        return 0;
    }

    at(i) {
        return new Value(this.db, this.db.exports.lodu_array_get(this.handle, i));
    }

    *[Symbol.iterator]() {
        const e = this.db.exports;
        const t = e.lodu_type(this.handle);
        if (t === 0x06) {
            const n = e.lodu_array_len(this.handle);
            for (let i = 0; i < n; i++) yield this.at(i);
        } else if (t === 0x07) {
            const n = e.lodu_object_len(this.handle);
            for (let i = 0; i < n; i++) yield [this.keyAt(i), this.valueAt(i)];
        }
    }

    // Object access
    get(key) {
        const e = this.db.exports;
        if (e.lodu_type(this.handle) !== 0x07) return new Value(this.db, 0);
        const idx = this.db._keyIndex(key);
        if (idx === 0xffffffff) return new Value(this.db, 0);
        return new Value(this.db, e.lodu_object_get_by_index(this.handle, idx));
    }

    has(key) {
        return this.get(key).exists;
    }

    keyAt(i) {
        const e = this.db.exports;
        const idx = e.lodu_object_key_index(this.handle, i);
        // Synthesize a temporary STR handle via lodu_object_key_handle and read.
        const strHandle = e.lodu_object_key_handle(this.handle, i);
        const ptr = e.lodu_str_ptr(strHandle);
        const len = e.lodu_str_len(strHandle);
        return this.db._readString(ptr, len);
    }

    valueAt(i) {
        return new Value(this.db, this.db.exports.lodu_object_value(this.handle, i));
    }

    // Dot-path accessor: db.root.path('user.posts.0.title')
    path(p) {
        const parts = Array.isArray(p) ? p : String(p).split('.');
        let cur = this;
        for (const part of parts) {
            if (!cur.exists) return cur;
            const t = this.db.exports.lodu_type(cur.handle);
            if (t === 0x06) cur = cur.at(Number(part));
            else if (t === 0x07) cur = cur.get(part);
            else return new Value(this.db, 0);
        }
        return cur;
    }

    // Materialize a subtree as a regular JS value. Only use when you
    // actually need the whole thing — defeats the point otherwise.
    toJS() {
        const e = this.db.exports;
        const t = e.lodu_type(this.handle);
        switch (t) {
            case 0x00: return null;
            case 0x01: return false;
            case 0x02: return true;
            case 0x03: return e.lodu_as_i32(this.handle);
            case 0x04: return e.lodu_as_f64(this.handle);
            case 0x05: return this.str;
            case 0x06: {
                const n = e.lodu_array_len(this.handle);
                const out = new Array(n);
                for (let i = 0; i < n; i++) out[i] = this.at(i).toJS();
                return out;
            }
            case 0x07: {
                const n = e.lodu_object_len(this.handle);
                const out = {};
                for (let i = 0; i < n; i++) out[this.keyAt(i)] = this.valueAt(i).toJS();
                return out;
            }
            default: return undefined;
        }
    }
}

// ------- Template binding -------
//
// <span data-lodu="user.name"></span>
//     -> textContent = db.root.path('user.name').str
//
// <img data-lodu-attr-src="user.avatar">
//     -> setAttribute('src', ...)
//
// <ul data-lodu-each="posts">
//     <template><li data-lodu="title"></li></template>
// </ul>
//     -> stamps the <template> once per array element, using each element
//        as the scope root.

function render(db, rootEl, scope = null) {
    scope = scope || db.root;

    // each loops (must run first because they create children)
    for (const el of rootEl.querySelectorAll('[data-lodu-each]')) {
        if (el.__loduDone) continue;
        el.__loduDone = true;
        const path = el.getAttribute('data-lodu-each');
        const list = scope.path(path);
        const tpl = el.querySelector('template');
        if (!tpl) continue;
        el.innerHTML = '';
        if (!list.exists) continue;
        const n = list.length;
        for (let i = 0; i < n; i++) {
            const clone = tpl.content.cloneNode(true);
            // Wrap in a container so we can run render with a child scope.
            const host = document.createElement('div');
            host.appendChild(clone);
            render(db, host, list.at(i));
            while (host.firstChild) el.appendChild(host.firstChild);
        }
    }

    for (const el of rootEl.querySelectorAll('[data-lodu]')) {
        if (el.__loduDone) continue;
        el.__loduDone = true;
        const path = el.getAttribute('data-lodu');
        const v = scope.path(path);
        el.textContent = v.exists ? v.str : '';
    }

    for (const el of rootEl.querySelectorAll('*')) {
        for (const attr of el.attributes) {
            if (!attr.name.startsWith('data-lodu-attr-')) continue;
            const target = attr.name.slice('data-lodu-attr-'.length);
            const v = scope.path(attr.value);
            if (v.exists) el.setAttribute(target, v.str);
        }
    }
}

// ------- Entry points -------

function base64Decode(b64) {
    if (typeof atob === 'function') {
        const s = atob(b64);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function load(payloadBytes, wasmSource) {
    if (!_wasmPromise) _wasmPromise = loadWasm(wasmSource);
    const { instance } = await _wasmPromise;
    const db = new LoduDB(instance);
    db.load(payloadBytes);
    return db;
}

async function hydrate(opts = {}) {
    let payloadBytes;
    if (opts.bytes) {
        payloadBytes = opts.bytes;
    } else {
        const tag = (typeof document !== 'undefined')
            ? document.getElementById(opts.scriptId || 'lodu-payload')
            : null;
        if (!tag) throw new Error('lodu: no <script id="lodu-payload"> found');
        payloadBytes = base64Decode(tag.textContent.trim());
    }
    const db = await load(payloadBytes, opts.wasm);
    if (typeof document !== 'undefined' && opts.render !== false) {
        render(db, opts.root || document.body, null);
    }
    return db;
}

// ------- Exports -------

const api = { hydrate, load, render, LoduDB, Value };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof globalThis !== 'undefined') {
    globalThis.lodu = api;
}
