// LODU binary encoder.
//
// Input: any JSON-serializable value.
// Output: a Uint8Array in the LODU v1 format (see crates/lodu-core/src/lib.rs).
//
// The encoder interns every string — both object keys and string values —
// into a single string table, then writes the value tree. Object entries
// are sorted by key-string index so the WASM reader can binary-search.

'use strict';

const TAG_NULL   = 0x00;
const TAG_FALSE  = 0x01;
const TAG_TRUE   = 0x02;
const TAG_I32    = 0x03;
const TAG_F64    = 0x04;
const TAG_STR    = 0x05;
const TAG_ARRAY  = 0x06;
const TAG_OBJECT = 0x07;

const MAGIC = [0x4c, 0x4f, 0x44, 0x55]; // "LODU"
const VERSION = 1;
const HEADER_SIZE = 16;

class ByteWriter {
    constructor(capacity = 1024) {
        this.buf = new Uint8Array(capacity);
        this.view = new DataView(this.buf.buffer);
        this.pos = 0;
    }
    _ensure(n) {
        if (this.pos + n <= this.buf.length) return;
        let cap = this.buf.length;
        while (cap < this.pos + n) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf);
        this.buf = next;
        this.view = new DataView(this.buf.buffer);
    }
    u8(v) { this._ensure(1); this.buf[this.pos++] = v; }
    u32(v) { this._ensure(4); this.view.setUint32(this.pos, v, true); this.pos += 4; }
    i32(v) { this._ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
    f64(v) { this._ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
    bytes(b) { this._ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
    patchU32(at, v) { this.view.setUint32(at, v, true); }
    finalize() { return this.buf.slice(0, this.pos); }
}

function internString(table, s) {
    const hit = table.map.get(s);
    if (hit !== undefined) return hit;
    const idx = table.list.length;
    table.list.push(s);
    table.map.set(s, idx);
    return idx;
}

function collectStrings(value, table) {
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { internString(table, value); return; }
    if (typeof value === 'number') return;
    if (Array.isArray(value)) {
        for (const v of value) collectStrings(v, table);
        return;
    }
    if (typeof value === 'object') {
        for (const k of Object.keys(value)) {
            internString(table, k);
            collectStrings(value[k], table);
        }
        return;
    }
    throw new TypeError(`lodu: unsupported value of type ${typeof value}`);
}

// writeValue returns the offset (from start of buffer) at which the value
// was written.
function writeValue(w, value, table) {
    const at = w.pos;
    if (value === null) { w.u8(TAG_NULL); return at; }
    if (value === false) { w.u8(TAG_FALSE); return at; }
    if (value === true) { w.u8(TAG_TRUE); return at; }

    if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
            w.u8(TAG_I32); w.i32(value);
        } else {
            w.u8(TAG_F64); w.f64(value);
        }
        return at;
    }

    if (typeof value === 'string') {
        w.u8(TAG_STR);
        w.u32(internString(table, value));
        return at;
    }

    if (Array.isArray(value)) {
        w.u8(TAG_ARRAY);
        w.u32(value.length);
        const slotStart = w.pos;
        for (let i = 0; i < value.length; i++) w.u32(0); // placeholders
        for (let i = 0; i < value.length; i++) {
            const childAt = writeValue(w, value[i], table);
            w.patchU32(slotStart + i * 4, childAt);
        }
        return at;
    }

    if (typeof value === 'object') {
        // Intern all keys and sort entries by key-index so the reader can
        // binary search.
        const keys = Object.keys(value);
        const entries = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
            entries[i] = [internString(table, keys[i]), value[keys[i]]];
        }
        entries.sort((a, b) => a[0] - b[0]);

        w.u8(TAG_OBJECT);
        w.u32(entries.length);
        const slotStart = w.pos;
        for (let i = 0; i < entries.length; i++) { w.u32(entries[i][0]); w.u32(0); }
        for (let i = 0; i < entries.length; i++) {
            const childAt = writeValue(w, entries[i][1], table);
            w.patchU32(slotStart + i * 8 + 4, childAt);
        }
        return at;
    }

    throw new TypeError(`lodu: cannot encode ${typeof value}`);
}

/**
 * Encode a JavaScript value into a LODU v1 binary payload.
 * @param {*} value - any JSON-serializable value.
 * @returns {Uint8Array}
 */
function encode(value) {
    const table = { list: [], map: new Map() };
    collectStrings(value, table);

    // Layout:
    //   header (16 bytes)
    //   value tree
    //   string table
    const w = new ByteWriter(4096);
    // Reserve header
    for (let i = 0; i < HEADER_SIZE; i++) w.u8(0);

    const rootOffset = writeValue(w, value, table);

    const stringTableOffset = w.pos;
    w.u32(table.list.length);

    const encoder = new TextEncoder();
    const encoded = table.list.map(s => encoder.encode(s));

    // Reserve (offset, length) entries, we'll patch offsets after writing bytes.
    const entriesAt = w.pos;
    for (let i = 0; i < encoded.length; i++) { w.u32(0); w.u32(encoded[i].length); }

    for (let i = 0; i < encoded.length; i++) {
        const byteOffset = w.pos;
        w.bytes(encoded[i]);
        w.patchU32(entriesAt + i * 8, byteOffset);
    }

    // Write header.
    w.buf[0] = MAGIC[0];
    w.buf[1] = MAGIC[1];
    w.buf[2] = MAGIC[2];
    w.buf[3] = MAGIC[3];
    w.buf[4] = VERSION;
    w.view.setUint32(8, stringTableOffset, true);
    w.view.setUint32(12, rootOffset, true);

    return w.finalize();
}

module.exports = {
    encode,
    TAG_NULL, TAG_FALSE, TAG_TRUE, TAG_I32, TAG_F64,
    TAG_STR, TAG_ARRAY, TAG_OBJECT,
};
