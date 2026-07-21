/**
 * MCDB Cloudflare Worker — semantic Top-K search (int8 vectors).
 * Embed must match compile_dist.py / AML rust mcdb_embed.rs
 *
 * Ranking = cosine(hash-vector) + lexical boost (exact/prefix/token).
 * Query aliases cover CN community names (e.g. 机械动力 → Create).
 */

const DIM = 256;
const VEC_POOL = 250;

/** CN/community aliases → official titles / slugs to boost */
const QUERY_ALIASES = {
  机械动力: ["Create", "create"],
  物品管理: ["Just Enough Items", "jei"],
  光影: ["shader", "shaders"],
};

/** @type {null | { i8: Int8Array, scales: Float32Array, meta: any, count: number, dim: number }} */
let CACHE = null;
let LOADING = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        const idx = CACHE;
        return cors(
          json({
            ok: true,
            loaded: !!idx,
            count: idx?.count ?? 0,
            embed: "char-unigram+bigram-hash",
            rank: "vector+lexical+alias",
            dim: DIM,
          }),
        );
      }

      if (
        (url.pathname === "/v1/search" || url.pathname === "/search") &&
        request.method === "POST"
      ) {
        const body = await request.json().catch(() => ({}));
        const q = String(body.q ?? body.query ?? "").trim();
        const limit = clampInt(body.limit ?? 12, 1, 50);
        if (!q) {
          return cors(json({ error: "empty query" }, 400));
        }
        const idx = await ensureIndex(env);
        const hits = search(idx, q, limit);
        return cors(json({ q, count: hits.length, hits }));
      }

      return cors(
        json(
          {
            service: "mcdb-semantic-search",
            endpoints: ["GET /health", "POST /v1/search"],
            example: { q: "发条", limit: 12 },
          },
          200,
        ),
      );
    } catch (e) {
      return cors(json({ error: String(e?.message || e) }, 503));
    }
  },
};

function clampInt(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function ensureIndex(env) {
  if (CACHE) return CACHE;
  if (LOADING) return LOADING;
  LOADING = loadIndex(env)
    .then((idx) => {
      CACHE = idx;
      LOADING = null;
      return idx;
    })
    .catch((e) => {
      LOADING = null;
      throw e;
    });
  return LOADING;
}

async function loadIndex(env) {
  const base = (env.DATA_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("DATA_BASE_URL not set");

  const [indexRes, i8Res, scalesRes, metaRes] = await Promise.all([
    fetch(`${base}/index.json`),
    fetch(`${base}/vectors.i8.bin`),
    fetch(`${base}/scales.f32`),
    fetch(`${base}/meta.pack.json`),
  ]);
  for (const [name, res] of [
    ["index.json", indexRes],
    ["vectors.i8.bin", i8Res],
    ["scales.f32", scalesRes],
    ["meta.pack.json", metaRes],
  ]) {
    if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
  }

  const index = await indexRes.json();
  const dim = index.dim | 0;
  const count = index.count | 0;
  if (dim !== DIM) throw new Error(`dim ${dim} != ${DIM}`);

  const i8Buf = await i8Res.arrayBuffer();
  const scalesBuf = await scalesRes.arrayBuffer();
  const meta = await metaRes.json();

  if (i8Buf.byteLength !== count * dim) {
    throw new Error(`i8 size ${i8Buf.byteLength} != ${count * dim}`);
  }
  if (scalesBuf.byteLength !== count * 4) {
    throw new Error(`scales size ${scalesBuf.byteLength} != ${count * 4}`);
  }
  if (!meta.id || meta.id.length < count) {
    throw new Error(`meta.pack rows ${meta.id?.length} < ${count}`);
  }

  return {
    dim,
    count,
    i8: new Int8Array(i8Buf),
    scales: new Float32Array(scalesBuf),
    meta,
  };
}

function normalize(text) {
  return [...(text || "").toLowerCase()].filter((c) => !/\s/.test(c)).join("");
}

function expandQueries(query) {
  const out = [query];
  const nq = normalize(query);
  for (const [key, alts] of Object.entries(QUERY_ALIASES)) {
    if (normalize(key) === nq) {
      for (const a of alts) out.push(a);
    }
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lexical boost; exact title/slug must beat compound slug-token hits. */
function lexicalBoost(rawQuery, en, zh, slug) {
  const q = normalize(rawQuery);
  if (!q) return 0;

  const nEn = normalize(en);
  const nZh = normalize(zh);
  const nSlug = (slug || "").toLowerCase();
  const ascii = /^[a-z0-9_.:-]+$/i.test(rawQuery.trim());
  let best = 0;

  if (nEn === q || nZh === q) best = Math.max(best, 5.0);
  if (nSlug === q) best = Math.max(best, 4.5);

  if (ascii) {
    const tokens = nSlug.split(/[-_.]+/).filter(Boolean);
    if (tokens.includes(q) && nSlug !== q) best = Math.max(best, 1.15);
    const enLower = (en || "").toLowerCase();
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(q)}(?:[^a-z0-9]|$)`, "i");
    if (re.test(enLower) && nEn !== q) best = Math.max(best, 1.35);
    return best;
  }

  // CJK / mixed: prefix + contains with length ratio (prefer short titles)
  for (const title of [nZh, nEn]) {
    if (!title) continue;
    if (title === q) continue;
    if (title.startsWith(q)) {
      best = Math.max(best, 1.6 + q.length / Math.max(title.length, 1));
    } else if (title.includes(q)) {
      best = Math.max(best, 0.85 * (q.length / Math.max(title.length, 1)));
    }
  }
  if (nSlug.includes(q) && nSlug !== q) {
    best = Math.max(best, 0.5 * (q.length / Math.max(nSlug.length, 1)));
  }
  return best;
}

function search(idx, query, limit) {
  const variants = expandQueries(query);
  const qVec = embedText(query);
  const { i8, scales, meta, count, dim } = idx;
  const scores = new Float64Array(count);

  for (let row = 0; row < count; row++) {
    const scale = scales[row];
    const base = row * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++) {
      dot += qVec[j] * (i8[base + j] * scale);
    }
    scores[row] = dot;
  }

  // vector candidate pool
  const poolN = Math.min(count, Math.max(limit * 25, VEC_POOL));
  const pool = [];
  for (let row = 0; row < count; row++) {
    const score = scores[row];
    if (pool.length < poolN) {
      pool.push({ score, row });
      pool.sort((a, b) => b.score - a.score);
    } else if (score > pool[pool.length - 1].score) {
      pool[pool.length - 1] = { score, row };
      pool.sort((a, b) => b.score - a.score);
    }
  }

  const cand = new Map();
  for (const { row, score } of pool) cand.set(row, score);

  // lexical / alias scan (full meta — ~140k, fine in Worker)
  for (let row = 0; row < count; row++) {
    let lex = 0;
    for (const v of variants) {
      lex = Math.max(
        lex,
        lexicalBoost(v, meta.en[row] || "", meta.zh[row] || "", meta.slug[row] || ""),
      );
    }
    if (lex > 0) {
      const prev = cand.has(row) ? cand.get(row) : scores[row];
      cand.set(row, prev + lex);
    } else if (cand.has(row)) {
      // keep vector-only candidates
    }
  }

  const ranked = [];
  for (const [row, score] of cand) {
    ranked.push({ row, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit).map(({ score, row }) => ({
    id: meta.id[row] || "",
    en: meta.en[row] || "",
    zh: meta.zh[row] || "",
    score: Math.round(score * 1e6) / 1e6,
    slug: meta.slug[row] || null,
    type: meta.type[row] || null,
  }));
}

function embedText(text) {
  const vec = new Float32Array(DIM);
  const grams = [...charNgrams(text, 1), ...charNgrams(text, 2)];
  if (grams.length === 0) return vec;
  for (const g of grams) {
    const h = md5U128(g);
    const idx = Number(h % BigInt(DIM));
    const sign = (h >> 8n) & 1n ? 1.0 : -1.0;
    const w = [...g].length === 1 ? 1.4 : 1.0;
    vec[idx] += sign * w;
  }
  let sum = 0;
  for (let i = 0; i < DIM; i++) sum += vec[i] * vec[i];
  if (sum > 1e-12) {
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < DIM; i++) vec[i] *= inv;
  }
  return vec;
}

function charNgrams(text, n) {
  const t = [...(text || "").toLowerCase()].filter((c) => !/\s/.test(c)).join("");
  if (!t) return [];
  const chars = [...t];
  if (chars.length < n) return [t];
  const out = [];
  for (let i = 0; i <= chars.length - n; i++) {
    out.push(chars.slice(i, i + n).join(""));
  }
  return out;
}

/** MD5 → BigInt (first 16 bytes as big-endian u128) */
function md5U128(text) {
  const digest = md5Bytes(new TextEncoder().encode(text));
  let h = 0n;
  for (let i = 0; i < 16; i++) {
    h = (h << 8n) | BigInt(digest[i]);
  }
  return h;
}

// Minimal MD5 (public domain style)
function md5Bytes(bytes) {
  const n = bytes.length;
  const words = [];
  for (let i = 0; i < n; i++) {
    words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  }
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  const bitLen = n * 8;
  const size = (((n + 8) >> 6) + 1) * 16;
  words[size - 2] = bitLen & 0xffffffff;
  words[size - 1] = (bitLen / 0x100000000) | 0;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < size; i += 16) {
    const oa = a,
      ob = b,
      oc = c,
      od = d;
    a = ff(a, b, c, d, words[i + 0], 7, 0xd76aa478);
    d = ff(d, a, b, c, words[i + 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, words[i + 2], 17, 0x242070db);
    b = ff(b, c, d, a, words[i + 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, words[i + 4], 7, 0xf57c0faf);
    d = ff(d, a, b, c, words[i + 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, words[i + 6], 17, 0xa8304613);
    b = ff(b, c, d, a, words[i + 7], 22, 0xfd469501);
    a = ff(a, b, c, d, words[i + 8], 7, 0x698098d8);
    d = ff(d, a, b, c, words[i + 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, words[i + 10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, words[i + 11], 22, 0x895cd7be);
    a = ff(a, b, c, d, words[i + 12], 7, 0x6b901122);
    d = ff(d, a, b, c, words[i + 13], 12, 0xfd987193);
    c = ff(c, d, a, b, words[i + 14], 17, 0xa679438e);
    b = ff(b, c, d, a, words[i + 15], 22, 0x49b40821);

    a = gg(a, b, c, d, words[i + 1], 5, 0xf61e2562);
    d = gg(d, a, b, c, words[i + 6], 9, 0xc040b340);
    c = gg(c, d, a, b, words[i + 11], 14, 0x265e5a51);
    b = gg(b, c, d, a, words[i + 0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, words[i + 5], 5, 0xd62f105d);
    d = gg(d, a, b, c, words[i + 10], 9, 0x02441453);
    c = gg(c, d, a, b, words[i + 15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, words[i + 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, words[i + 9], 5, 0x21e1cde6);
    d = gg(d, a, b, c, words[i + 14], 9, 0xc33707d6);
    c = gg(c, d, a, b, words[i + 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, words[i + 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, words[i + 13], 5, 0xa9e3e905);
    d = gg(d, a, b, c, words[i + 2], 9, 0xfcefa3f8);
    c = gg(c, d, a, b, words[i + 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, words[i + 12], 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, words[i + 5], 4, 0xfffa3942);
    d = hh(d, a, b, c, words[i + 8], 11, 0x8771f681);
    c = hh(c, d, a, b, words[i + 11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, words[i + 14], 23, 0xfde5380c);
    a = hh(a, b, c, d, words[i + 1], 4, 0xa4beea44);
    d = hh(d, a, b, c, words[i + 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, words[i + 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, words[i + 10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, words[i + 13], 4, 0x289b7ec6);
    d = hh(d, a, b, c, words[i + 0], 11, 0xeaa127fa);
    c = hh(c, d, a, b, words[i + 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, words[i + 6], 23, 0x04881d05);
    a = hh(a, b, c, d, words[i + 9], 4, 0xd9d4d039);
    d = hh(d, a, b, c, words[i + 12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, words[i + 15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, words[i + 2], 23, 0xc4ac5665);

    a = ii(a, b, c, d, words[i + 0], 6, 0xf4292244);
    d = ii(d, a, b, c, words[i + 7], 10, 0x432aff97);
    c = ii(c, d, a, b, words[i + 14], 15, 0xab9423a7);
    b = ii(b, c, d, a, words[i + 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, words[i + 12], 6, 0x655b59c3);
    d = ii(d, a, b, c, words[i + 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, words[i + 10], 15, 0xffeff47d);
    b = ii(b, c, d, a, words[i + 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, words[i + 8], 6, 0x6fa87e4f);
    d = ii(d, a, b, c, words[i + 15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, words[i + 6], 15, 0xa3014314);
    b = ii(b, c, d, a, words[i + 13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, words[i + 4], 6, 0xf7537e82);
    d = ii(d, a, b, c, words[i + 11], 10, 0xbd3af235);
    c = ii(c, d, a, b, words[i + 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, words[i + 9], 21, 0xeb86d391);

    a = (a + oa) | 0;
    b = (b + ob) | 0;
    c = (c + oc) | 0;
    d = (d + od) | 0;
  }

  const out = new Uint8Array(16);
  writeIntLE(out, 0, a);
  writeIntLE(out, 4, b);
  writeIntLE(out, 8, c);
  writeIntLE(out, 12, d);
  return out;
}

function writeIntLE(buf, off, n) {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >>> 8) & 0xff;
  buf[off + 2] = (n >>> 16) & 0xff;
  buf[off + 3] = (n >>> 24) & 0xff;
}

function cmn(q, a, b, x, s, t) {
  a = (a + q + (x | 0) + t) | 0;
  return (((a << s) | (a >>> (32 - s))) + b) | 0;
}
function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
