```
    ██╗      ██████╗ ██████╗ ██╗   ██╗    ██╗      ██████╗  █████╗ ██████╗ ██╗███╗   ██╗ ██████╗
    ██║     ██╔═══██╗██╔══██╗██║   ██║    ██║     ██╔═══██╗██╔══██╗██╔══██╗██║████╗  ██║██╔════╝
    ██║     ██║   ██║██║  ██║██║   ██║    ██║     ██║   ██║███████║██║  ██║██║██╔██╗ ██║██║  ███╗
    ██║     ██║   ██║██║  ██║██║   ██║    ██║     ██║   ██║██╔══██║██║  ██║██║██║╚██╗██║██║   ██║
    ███████╗╚██████╔╝██████╔╝╚██████╔╝    ███████╗╚██████╔╝██║  ██║██████╔╝██║██║ ╚████║╚██████╔╝
    ╚══════╝ ╚═════╝ ╚═════╝  ╚═════╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝

                                  the opposite of lazy loading
                                  ─────────────────────────────
                              ship the entire dataset. own it in WASM.
                                  walk it with zero-copy handles.
```

---

## What

**Lazy loading** says: don't fetch what the user might not need.
**Lodu loading** says the opposite. **Fetch everything. Right now. All of it.**

Then put it somewhere V8 can't ruin it.

```
                ┌─────────────────────── LAZY LOADING ───────────────────────┐
                │                                                            │
                │   client                                       server      │
                │     │                                            │         │
                │     │ ─── GET /page ────────────────────────►    │         │
                │     │ ◄── HTML shell ────────────────────────    │         │
                │     │                                            │         │
                │     │ ─── XHR /api/user ─────────────────────►   │  ⏱ wait │
                │     │ ◄── { user } ──────────────────────────    │         │
                │     │ ─── XHR /api/posts ────────────────────►   │  ⏱ wait │
                │     │ ◄── [ posts ] ─────────────────────────    │         │
                │     │ ─── XHR /api/comments ─────────────────►   │  ⏱ wait │
                │     │ ◄── [ comments ] ──────────────────────    │         │
                │     │ ─── XHR /api/likes ────────────────────►   │  ⏱ wait │
                │     │ ◄── [ likes ] ─────────────────────────    │         │
                │     │                                            │         │
                │     V                                            V         │
                │   waterfall of doom                          a sad cpu     │
                └────────────────────────────────────────────────────────────┘

                ┌─────────────────────── LODU LOADING ───────────────────────┐
                │                                                            │
                │   client                                       server      │
                │     │                                            │         │
                │     │ ─── GET /page ────────────────────────►    │         │
                │     │                                            │ ↯ build │
                │     │                                            │ ↯ encode│
                │     │ ◄── HTML + ENTIRE DATASET ─────────────    │         │
                │     │                                                      │
                │     │  hydrate → WASM linear memory                        │
                │     │  render → instant                                    │
                │     │                                                      │
                │     V                                                      │
                │   the page, already done                                   │
                └────────────────────────────────────────────────────────────┘
```

The whole thing is one round trip. No spinners. No "skeleton screens." No
hand-wringing about cache headers. The user clicked the link, the bytes
came down, the page is done.

But you're thinking: "if I shove an entire database into a `<script>` tag,
V8 is going to hate me." Correct. Which is why we don't give it to V8.

---

## The trick

The payload lives inside **WebAssembly linear memory**, not the JS heap.

```
            ╔══════════════════════════════════════════════════════════╗
            ║                JavaScript heap (V8)                      ║
            ║                                                          ║
            ║   ┌───────────┐                                          ║
            ║   │ lodudb    │ ── handle: u32 ─┐                        ║
            ║   └───────────┘                 │                        ║
            ║                                 │                        ║
            ╚═════════════════════════════════│════════════════════════╝
                                              │
                                              │ asks WASM to walk it
                                              ▼
            ╔══════════════════════════════════════════════════════════╗
            ║              WebAssembly linear memory                   ║
            ║                                                          ║
            ║  ┌──────┬─────┬─────┬─────────────────┬────────────────┐ ║
            ║  │ LODU │ ver │ ... │  value tree     │ string table   │ ║
            ║  └──────┴─────┴─────┴─────────────────┴────────────────┘ ║
            ║   │                  │                  │                ║
            ║   │ <- 16 byte hdr ->│<- offset graph ->│<- interned ->  ║
            ║                                                          ║
            ║   one ArrayBuffer. zero objects. zero GC pressure.       ║
            ╚══════════════════════════════════════════════════════════╝
```

The WASM module is **2.2 KB**. It is `no_std` Rust with a hand-rolled bump
allocator and no dependencies — not even `core::alloc`. It owns the dataset
and exposes accessors that take `u32` handles (which are just offsets into
the buffer) and return `u32` handles (which are also just offsets into the
buffer). JavaScript holds nothing but those handles.

The result: **load until infinity**. You can lodu-load a payload that
would shred V8 if you tried to `JSON.parse` it, because there is no
parsing, no object graph, and no heap traffic. There is one big buffer
and a tiny program that knows how to walk it.

---

## How it works, step by step

```
   ┌─── 1. server ──────────────────────────────────────────────┐
   │                                                            │
   │    const data = await db.everything();                     │
   │    const html = lodu.page({ body: tpl, data });            │
   │              │                                             │
   │              ▼                                             │
   │    encoder.js scans the value, interns every string        │
   │    (object keys + string values) into one table, then      │
   │    writes the value tree with forward offsets.             │
   │              │                                             │
   │              ▼                                             │
   │    base64 → <script type="application/lodu">…</script>     │
   │                                                            │
   └────────────────────────────┬───────────────────────────────┘
                                │ HTTP
                                ▼
   ┌─── 2. wire ────────────────────────────────────────────────┐
   │                                                            │
   │    one HTML document, one LODU payload, one WASM blob.     │
   │    no /api/anything. no waterfall. one round trip.         │
   │                                                            │
   └────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
   ┌─── 3. browser ─────────────────────────────────────────────┐
   │                                                            │
   │    lodu.hydrate() reads the <script>, base64-decodes it    │
   │    into a Uint8Array, asks WASM for linear memory, copies  │
   │    the bytes in, and calls lodu_load() to validate the     │
   │    header. WASM hands back a root handle.                  │
   │              │                                             │
   │              ▼                                             │
   │    The HTML contains data-lodu="user.posts.0.title"        │
   │    bindings. The runtime walks each one through WASM,      │
   │    materializing only the strings that actually go on      │
   │    screen, and stamps the DOM. First paint is fully data.  │
   │                                                            │
   └────────────────────────────────────────────────────────────┘
```

---

## What's in the box

```
loduloading/
├── crates/
│   └── lodu-core/             ← Rust crate, no_std, zero deps
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs         ← the WASM accessors live here
│
├── dist/
│   └── lodu_core.wasm         ← 2.2 KB. precompiled. you're welcome.
│
├── src/
│   ├── encoder.js             ← JSON -> LODU binary, server-side
│   ├── server.js              ← HTML page builder, static helpers
│   └── lodu.js                ← client runtime: hydrate, walk, render
│
├── examples/
│   └── server.js              ← 500-row table, no fetches, instant
│
├── test/
│   └── roundtrip.test.js      ← 11 tests through the real WASM
│
├── Cargo.toml                 ← workspace root
├── package.json
├── README.md                  ← you are here
└── LICENSE
```

---

## Install

```sh
git clone https://github.com/protosphinx/loduloading
cd loduloading
npm install        # there are no dependencies, but it's cute that you tried

# optional: rebuild the WASM module from source
rustup target add wasm32-unknown-unknown
npm run build:wasm
```

The repo ships a prebuilt `dist/lodu_core.wasm`, so you don't need a Rust
toolchain unless you want to hack on the core.

---

## Use it (server side)

```js
const http = require('http');
const fs   = require('fs');
const lodu = require('loduloading/server');

http.createServer((req, res) => {
    // Serves /lodu.js and /lodu_core.wasm out of dist/. You can also drop
    // these into your existing static asset pipeline.
    if (lodu.serveStatic(req, res)) return;

    // Build the entire dataset for this page. Yes, all of it.
    const data = {
        user:    db.user(req.userId),
        posts:   db.allPosts(),       // 4242 rows? sure.
        friends: db.friendsOf(req.userId),
        stats:   db.statsFor(req.userId),
    };

    res.setHeader('content-type', 'text/html');
    res.end(lodu.page({
        title: 'Dashboard',
        body:  fs.readFileSync('dashboard.html', 'utf8'),
        data,
    }));
}).listen(3000);
```

`lodu.page()` returns a complete HTML document with the payload inlined,
the WASM module fetched, and the runtime auto-hydrating. If you want
finer control, the building blocks are exported separately:

```js
lodu.encode(value)            // -> Uint8Array (LODU binary)
lodu.payloadScript(value)     // -> '<script id="lodu-payload">...</script>'
lodu.bootScript({ wasmURL })  // -> '<script>...hydrate()...</script>'
```

---

## Use it (client side, declarative)

Drop `data-lodu` attributes on your HTML. The runtime walks them after
hydration and stamps the DOM.

```html
<h1 data-lodu="user.name"></h1>
<img data-lodu-attr-src="user.avatar" alt="">

<p>You have <strong data-lodu="stats.unread"></strong> new messages.</p>

<ul data-lodu-each="posts">
  <template>
    <li>
      <a data-lodu-attr-href="url" data-lodu="title"></a>
      <small data-lodu="publishedAt"></small>
    </li>
  </template>
</ul>
```

Three directives, that's the whole templating language:

```
   ┌────────────────────────────┬──────────────────────────────────────┐
   │  data-lodu="path"          │  set textContent from a value        │
   │  data-lodu-attr-NAME="path"│  set attribute NAME from a value     │
   │  data-lodu-each="path"     │  stamp child <template> per element  │
   └────────────────────────────┴──────────────────────────────────────┘
```

Paths are dot-separated. Numeric segments index into arrays.
`user.posts.0.comments.3.body` is fine.

---

## Use it (client side, programmatic)

The DOM binder is just a thin wrapper over a cursor API. You can use the
cursors directly:

```js
await lodu.hydrate();
const db = window.lodudb;       // a LoduDB instance

const root = db.root;            // the root Value cursor

root.get('user').get('name').str        // "Ada"
root.get('posts').length                // 4242
root.get('posts').at(100).get('title').str

// Dot paths
root.path('user.posts.0.comments.3.body').str

// Iteration (yields cursors, doesn't materialize)
for (const post of root.get('posts')) {
    console.log(post.get('title').str);
}

// Object iteration yields [key, valueCursor]
for (const [key, val] of root.get('user')) {
    console.log(key, val.toJS());
}

// Coercions
root.get('stats').get('unread').int     // i32
root.get('stats').get('ratio').num      // f64
root.get('stats').get('verified').bool  // boolean

// Existence
root.get('nope').exists                 // false
root.get('user').has('email')           // true

// Memory introspection
db.payloadSize       // bytes of the payload
db.memoryUsed        // bytes used inside WASM
db.memoryBytes       // total bytes of WASM linear memory
```

A `Value` cursor is a tiny JS object holding `(db, handle)`. You can
create and discard millions of them — they're cheap. The expensive
operation is `.str`, which copies a UTF-8 slice out of WASM memory into
a JS string. Try not to call it on data the user can't actually see.

---

## The format

LODU v1 is one contiguous buffer. The header is 16 bytes:

```
   off  size  field
   ─────────────────────────────────────────────────────────────────
    0    4    "LODU" magic
    4    1    version (= 1)
    5    3    padding
    8    4    string_table_offset (u32 LE, from start of buffer)
   12    4    root_offset         (u32 LE, from start of buffer)
   16   ...   value tree
   ...        string table
```

A value is a tag byte plus a payload:

```
   tag    name      body
   ─────────────────────────────────────────────────────────────────
   0x00   NULL      –
   0x01   FALSE     –
   0x02   TRUE      –
   0x03   I32       i32 LE                            (5 bytes total)
   0x04   F64       f64 LE                            (9 bytes total)
   0x05   STR       u32 string_table_index            (5 bytes total)
   0x06   ARRAY     u32 count, u32 * count value_offsets
   0x07   OBJECT    u32 count, (u32 key_index, u32 value_offset) * count
```

Object entries are **sorted by key string-table index** at serialization
time, so `lodu_object_get_by_index` does a binary search. The string
table dedupes every string in the document, including all object keys.
For tabular data — arrays of objects with the same shape — this is huge:
keys cost 4 bytes per occurrence after the first, instead of
`"keyname":` plus quoting.

Layout, end to end:

```
   ┌──────────────────────┐  offset 0
   │ "LODU" │ ver │ pad   │
   ├──────────────────────┤
   │ string_table_offset  │
   ├──────────────────────┤
   │ root_offset          │
   ├──────────────────────┤  offset 16
   │                      │
   │     value tree       │
   │   (forward refs)     │
   │                      │
   ├──────────────────────┤  string_table_offset
   │ count : u32          │
   │ (off,len) (off,len)…│
   │                      │
   │ raw utf-8 bytes      │
   │                      │
   └──────────────────────┘
```

A value cursor is a `(db, handle)` pair where `handle` is the absolute
offset of the tag byte. To navigate, the WASM module reads the count
and the relative offsets stored after the tag, adds the payload base,
and returns the next handle. There is **no allocation** anywhere on the
read path. Walking the tree is pointer chasing inside one buffer.

---

## The WASM ABI

All functions take and return `u32` (or `i32`/`f64` for value coercions).

```
   lodu_alloc(size: u32) -> ptr: u32
       bump-allocate `size` bytes in WASM linear memory.
       grows memory in 64 KiB pages as needed. returns 0 on OOM.

   lodu_reset()
       rewind the bump pointer. all prior allocations become invalid.

   lodu_used() -> u32
       bytes currently allocated by lodu_alloc.

   lodu_load(ptr: u32, len: u32) -> root_handle: u32
       validate the LODU header at `ptr`, register the payload base,
       return the root value handle. returns 0 on bad magic/version.

   lodu_payload_size() -> u32
       length of the currently loaded payload, in bytes.

   ── value cursor ──────────────────────────────────────────────────

   lodu_type(h)             -> tag (0..7) or 0xFF if invalid
   lodu_as_i32(h)           -> i32
   lodu_as_f64(h)           -> f64
   lodu_as_bool(h)          -> 0/1

   ── strings ───────────────────────────────────────────────────────

   lodu_str_ptr(h)          -> ptr into linear memory (no copy)
   lodu_str_len(h)          -> u32
   lodu_str_index(h)        -> string-table index, or u32::MAX

   ── arrays ────────────────────────────────────────────────────────

   lodu_array_len(h)        -> u32
   lodu_array_get(h, i)     -> value handle, or 0 if out of range

   ── objects ───────────────────────────────────────────────────────

   lodu_object_len(h)               -> u32
   lodu_object_key_index(h, i)      -> string-table index of i-th key
   lodu_object_key_handle(h, i)     -> synthesized STR handle for i-th key
   lodu_object_value(h, i)          -> value handle of i-th value
   lodu_object_get_by_index(h, idx) -> value handle, or 0
   lodu_string_table_lookup(p, n)   -> string-table index of utf-8 key
   lodu_object_get(h, p, n)         -> value handle by utf-8 key, or 0
```

That is the entire surface area. Sixteen functions. No glue code, no
`wasm-bindgen`, no JS → number → JS → number marshaling churn.

---

## Numbers

Built and measured on this branch:

```
   dist/lodu_core.wasm   2,282 bytes
   src/lodu.js          ~11.3 KB unminified, dependency-free
   src/encoder.js       ~4.5 KB unminified, dependency-free
   tests                11/11 passing through real WASM
```

Run the demo:

```sh
node examples/server.js
# open http://localhost:3000
```

500 rows × 5 columns. The HTML lands and the table is *already there*.
There is no second request.

---

## FAQ

**"Is this serious?"**
Yes. There is a class of pages — dashboards, admin tools, internal
back-offices, single-tenant apps — where the data is small enough to
ship and the network is the bottleneck. For those, lazy loading is a
performance pessimization dressed up as good engineering.

**"What about caching?"**
The payload is part of the HTML, so it inherits the page's cache
headers. If your page is dynamic, the payload is dynamic. If your page
can be ETag'd, so can the payload. The WASM blob is static and caches
forever.

**"What if my dataset is 500 MB?"**
Then this is not for you. Lodu loading is for "big enough that JSON
hurts, small enough that it fits." That's a surprisingly wide range
once you stop materializing everything into JS objects.

**"Why not just JSON?"**
`JSON.parse` allocates one V8 object per node, and those objects sit
in the heap forever (or until GC, which is its own kind of forever).
A 50k-row dataset is 50k objects. Lodu loading is *one* `ArrayBuffer`.

**"Why Rust if there are no dependencies?"**
Because I wanted `no_std`, hand-rolled bump allocation, and a 2.2 KB
binary. Also because the user asked for it. Also because it's fun.

**"Is the name a joke?"**
Yes.

---

## License

MIT. See `LICENSE`.

---

```
                                stop fetching.
                                start shipping.
```
