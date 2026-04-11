//! lodu-core
//!
//! A zero-copy payload engine for LODU loading (the opposite of lazy loading).
//!
//! # Philosophy
//!
//! In lazy loading you fetch data on demand. In LODU loading, the server
//! serializes the entire dataset into a compact binary blob, ships it inside
//! the HTML, and the client walks it in place. No JSON.parse, no V8 heap
//! allocations per node, no GC pressure — the payload lives inside WASM
//! linear memory for the lifetime of the page, and JavaScript only ever
//! receives `u32` handles (offsets into that memory).
//!
//! # Format
//!
//! The payload is one contiguous buffer:
//!
//! ```text
//! offset  field
//! 0       "LODU" magic (4 bytes)
//! 4       version u8
//! 5       _pad  u8 x3
//! 8       string_table_offset u32
//! 12      root_offset         u32
//! 16      <value tree...>
//! ...
//! STR_TBL u32 count
//!         repeat count times:
//!             u32 byte_offset (from start of buffer)
//!             u32 byte_length
//!         <raw utf-8 bytes>
//! ```
//!
//! A value is a single tag byte followed by its payload:
//!
//! ```text
//! 0x00 NULL   (no body)
//! 0x01 FALSE  (no body)
//! 0x02 TRUE   (no body)
//! 0x03 I32    i32 little-endian
//! 0x04 F64    f64 little-endian
//! 0x05 STR    u32 string_index
//! 0x06 ARRAY  u32 count, u32 * count (value offsets)
//! 0x07 OBJECT u32 count, (u32 key_string_index, u32 value_offset) * count
//! ```
//!
//! Object entries are sorted by key string index, so `object_get` does
//! binary search. Strings are interned once in the string table, which
//! turns repeated object keys (the common case in tabular data) into a
//! 4-byte reference.

#![no_std]
#![allow(clippy::missing_safety_doc)]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// ---------- tags ----------

pub const TAG_NULL: u8 = 0x00;
pub const TAG_FALSE: u8 = 0x01;
pub const TAG_TRUE: u8 = 0x02;
pub const TAG_I32: u8 = 0x03;
pub const TAG_F64: u8 = 0x04;
pub const TAG_STR: u8 = 0x05;
pub const TAG_ARRAY: u8 = 0x06;
pub const TAG_OBJECT: u8 = 0x07;

// ---------- bump allocator ----------
//
// We don't need a real allocator. The host loads one payload, maybe
// replaces it, and walks it. We hand out linear regions from a bump
// pointer that starts at `__heap_base`. `lodu_reset()` rewinds it.

extern "C" {
    static __heap_base: u8;
}

static mut BUMP: usize = 0;

unsafe fn heap_base() -> usize {
    (&__heap_base as *const u8) as usize
}

unsafe fn bump_init_if_needed() {
    if BUMP == 0 {
        BUMP = heap_base();
    }
}

/// Allocate `size` bytes of WASM linear memory, growing the memory as
/// needed. Returns a pointer into linear memory (offset from 0).
#[no_mangle]
pub unsafe extern "C" fn lodu_alloc(size: u32) -> u32 {
    bump_init_if_needed();
    let size = size as usize;
    // 8 byte align
    let aligned = (BUMP + 7) & !7;
    let new_top = aligned + size;

    // Grow memory if necessary. wasm32 pages are 64 KiB.
    let current_bytes = core::arch::wasm32::memory_size(0) * 65536;
    if new_top > current_bytes {
        let need = new_top - current_bytes;
        let pages = (need + 65535) / 65536;
        let prev = core::arch::wasm32::memory_grow(0, pages);
        if prev == usize::MAX {
            return 0;
        }
    }

    BUMP = new_top;
    aligned as u32
}

/// Rewind the bump allocator, releasing every prior allocation.
/// Call this before loading a replacement payload.
#[no_mangle]
pub unsafe extern "C" fn lodu_reset() {
    BUMP = heap_base();
}

/// Current high-water mark of WASM memory in use (bytes).
#[no_mangle]
pub unsafe extern "C" fn lodu_used() -> u32 {
    bump_init_if_needed();
    (BUMP - heap_base()) as u32
}

// ---------- payload registration ----------
//
// A payload is a buffer that was previously allocated via `lodu_alloc`
// and then filled by the JS host (e.g. via `new Uint8Array(memory.buffer)`).
// `lodu_load` records its base offset and validates the header, returning
// the root value handle (an absolute offset in linear memory).

static mut PAYLOAD_BASE: u32 = 0;
static mut PAYLOAD_LEN: u32 = 0;
static mut STRING_TABLE: u32 = 0;

#[inline]
unsafe fn read_u32(off: u32) -> u32 {
    let p = off as *const u8;
    let mut b = [0u8; 4];
    b[0] = *p;
    b[1] = *p.add(1);
    b[2] = *p.add(2);
    b[3] = *p.add(3);
    u32::from_le_bytes(b)
}

#[inline]
unsafe fn read_i32(off: u32) -> i32 {
    read_u32(off) as i32
}

#[inline]
unsafe fn read_f64(off: u32) -> f64 {
    let p = off as *const u8;
    let mut b = [0u8; 8];
    let mut i = 0;
    while i < 8 {
        b[i] = *p.add(i);
        i += 1;
    }
    f64::from_le_bytes(b)
}

/// Validate the header of a freshly uploaded payload and return the
/// root value handle. Returns 0 on error.
#[no_mangle]
pub unsafe extern "C" fn lodu_load(ptr: u32, len: u32) -> u32 {
    if len < 16 {
        return 0;
    }
    let magic = [
        *(ptr as *const u8),
        *((ptr + 1) as *const u8),
        *((ptr + 2) as *const u8),
        *((ptr + 3) as *const u8),
    ];
    if &magic != b"LODU" {
        return 0;
    }
    let version = *((ptr + 4) as *const u8);
    if version != 1 {
        return 0;
    }
    let str_tbl_rel = read_u32(ptr + 8);
    let root_rel = read_u32(ptr + 12);
    if str_tbl_rel >= len || root_rel >= len {
        return 0;
    }
    PAYLOAD_BASE = ptr;
    PAYLOAD_LEN = len;
    STRING_TABLE = ptr + str_tbl_rel;
    ptr + root_rel
}

/// Number of bytes in the currently loaded payload.
#[no_mangle]
pub unsafe extern "C" fn lodu_payload_size() -> u32 {
    PAYLOAD_LEN
}

// ---------- value accessors ----------

#[no_mangle]
pub unsafe extern "C" fn lodu_type(handle: u32) -> u32 {
    if handle == 0 || handle < PAYLOAD_BASE {
        return 0xFF;
    }
    *(handle as *const u8) as u32
}

#[no_mangle]
pub unsafe extern "C" fn lodu_as_i32(handle: u32) -> i32 {
    match *(handle as *const u8) {
        TAG_I32 => read_i32(handle + 1),
        TAG_F64 => read_f64(handle + 1) as i32,
        TAG_TRUE => 1,
        TAG_FALSE | TAG_NULL => 0,
        _ => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn lodu_as_f64(handle: u32) -> f64 {
    match *(handle as *const u8) {
        TAG_F64 => read_f64(handle + 1),
        TAG_I32 => read_i32(handle + 1) as f64,
        TAG_TRUE => 1.0,
        TAG_FALSE | TAG_NULL => 0.0,
        _ => 0.0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn lodu_as_bool(handle: u32) -> u32 {
    match *(handle as *const u8) {
        TAG_TRUE => 1,
        TAG_I32 => (read_i32(handle + 1) != 0) as u32,
        TAG_F64 => (read_f64(handle + 1) != 0.0) as u32,
        TAG_STR => {
            let idx = read_u32(handle + 1);
            (str_len_by_index(idx) > 0) as u32
        }
        _ => 0,
    }
}

// ---------- strings ----------
//
// The string table is an array of (offset, length) pairs followed by raw
// UTF-8 bytes. A STR value is a tag + index, so dereferencing a string
// is a 12-byte read.

#[inline]
unsafe fn str_entry(idx: u32) -> (u32, u32) {
    let tbl = STRING_TABLE;
    let count = read_u32(tbl);
    if idx >= count {
        return (0, 0);
    }
    let entry = tbl + 4 + idx * 8;
    let off = read_u32(entry);
    let len = read_u32(entry + 4);
    (PAYLOAD_BASE + off, len)
}

#[inline]
unsafe fn str_len_by_index(idx: u32) -> u32 {
    str_entry(idx).1
}

/// Returns a pointer into linear memory at the first UTF-8 byte of the
/// string referenced by `handle`. The JS host reads directly from that
/// pointer; no copy is performed on the WASM side.
#[no_mangle]
pub unsafe extern "C" fn lodu_str_ptr(handle: u32) -> u32 {
    if *(handle as *const u8) != TAG_STR {
        return 0;
    }
    let idx = read_u32(handle + 1);
    str_entry(idx).0
}

#[no_mangle]
pub unsafe extern "C" fn lodu_str_len(handle: u32) -> u32 {
    if *(handle as *const u8) != TAG_STR {
        return 0;
    }
    let idx = read_u32(handle + 1);
    str_entry(idx).1
}

#[no_mangle]
pub unsafe extern "C" fn lodu_str_index(handle: u32) -> u32 {
    if *(handle as *const u8) != TAG_STR {
        return u32::MAX;
    }
    read_u32(handle + 1)
}

// ---------- arrays ----------

#[no_mangle]
pub unsafe extern "C" fn lodu_array_len(handle: u32) -> u32 {
    if *(handle as *const u8) != TAG_ARRAY {
        return 0;
    }
    read_u32(handle + 1)
}

#[no_mangle]
pub unsafe extern "C" fn lodu_array_get(handle: u32, i: u32) -> u32 {
    if *(handle as *const u8) != TAG_ARRAY {
        return 0;
    }
    let count = read_u32(handle + 1);
    if i >= count {
        return 0;
    }
    let rel = read_u32(handle + 5 + i * 4);
    PAYLOAD_BASE + rel
}

// ---------- objects ----------

#[no_mangle]
pub unsafe extern "C" fn lodu_object_len(handle: u32) -> u32 {
    if *(handle as *const u8) != TAG_OBJECT {
        return 0;
    }
    read_u32(handle + 1)
}

/// Returns a STR value handle for the i-th key of an object.
#[no_mangle]
pub unsafe extern "C" fn lodu_object_key_handle(handle: u32, i: u32) -> u32 {
    if *(handle as *const u8) != TAG_OBJECT {
        return 0;
    }
    let count = read_u32(handle + 1);
    if i >= count {
        return 0;
    }
    // Synthesize a STR handle by writing over the entry? No — we can't.
    // Instead, we store a tiny 5-byte scratch STR ahead of time by reusing
    // a shared cell in the bump heap. Allocate once, reuse on each call.
    static mut SCRATCH_STR: u32 = 0;
    if SCRATCH_STR == 0 {
        SCRATCH_STR = lodu_alloc(5);
        *(SCRATCH_STR as *mut u8) = TAG_STR;
    }
    let key_idx = read_u32(handle + 5 + i * 8);
    // write key_idx at SCRATCH_STR + 1
    let b = key_idx.to_le_bytes();
    *((SCRATCH_STR + 1) as *mut u8) = b[0];
    *((SCRATCH_STR + 2) as *mut u8) = b[1];
    *((SCRATCH_STR + 3) as *mut u8) = b[2];
    *((SCRATCH_STR + 4) as *mut u8) = b[3];
    SCRATCH_STR
}

/// Returns the string table index of the i-th key (cheaper than
/// `lodu_object_key_handle` when you just want the id).
#[no_mangle]
pub unsafe extern "C" fn lodu_object_key_index(handle: u32, i: u32) -> u32 {
    if *(handle as *const u8) != TAG_OBJECT {
        return u32::MAX;
    }
    let count = read_u32(handle + 1);
    if i >= count {
        return u32::MAX;
    }
    read_u32(handle + 5 + i * 8)
}

#[no_mangle]
pub unsafe extern "C" fn lodu_object_value(handle: u32, i: u32) -> u32 {
    if *(handle as *const u8) != TAG_OBJECT {
        return 0;
    }
    let count = read_u32(handle + 1);
    if i >= count {
        return 0;
    }
    let rel = read_u32(handle + 5 + i * 8 + 4);
    PAYLOAD_BASE + rel
}

/// Look up a key by its string-table index. Object entries are sorted by
/// key index at serialization time, so this is a binary search.
/// Returns 0 if the key isn't present.
#[no_mangle]
pub unsafe extern "C" fn lodu_object_get_by_index(handle: u32, key_idx: u32) -> u32 {
    if *(handle as *const u8) != TAG_OBJECT {
        return 0;
    }
    let count = read_u32(handle + 1);
    let entries = handle + 5;
    let mut lo: u32 = 0;
    let mut hi: u32 = count;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let k = read_u32(entries + mid * 8);
        if k == key_idx {
            let rel = read_u32(entries + mid * 8 + 4);
            return PAYLOAD_BASE + rel;
        } else if k < key_idx {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    0
}

/// Resolve a UTF-8 key (copied into a previously-allocated buffer by the
/// host) to its string-table index, or `u32::MAX` if not present.
#[no_mangle]
pub unsafe extern "C" fn lodu_string_table_lookup(key_ptr: u32, key_len: u32) -> u32 {
    let tbl = STRING_TABLE;
    let count = read_u32(tbl);
    let mut i: u32 = 0;
    while i < count {
        let entry = tbl + 4 + i * 8;
        let off = read_u32(entry);
        let len = read_u32(entry + 4);
        if len == key_len {
            let a = (PAYLOAD_BASE + off) as *const u8;
            let b = key_ptr as *const u8;
            let mut j: u32 = 0;
            let mut eq = true;
            while j < key_len {
                if *a.add(j as usize) != *b.add(j as usize) {
                    eq = false;
                    break;
                }
                j += 1;
            }
            if eq {
                return i;
            }
        }
        i += 1;
    }
    u32::MAX
}

/// Convenience: look up a UTF-8 key in an object in one WASM call.
#[no_mangle]
pub unsafe extern "C" fn lodu_object_get(handle: u32, key_ptr: u32, key_len: u32) -> u32 {
    let idx = lodu_string_table_lookup(key_ptr, key_len);
    if idx == u32::MAX {
        return 0;
    }
    lodu_object_get_by_index(handle, idx)
}
