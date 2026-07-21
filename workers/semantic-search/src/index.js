/**
 * MCDB Cloudflare Worker — title fuzzy search (en / zh / slug).
 * Data: titles.pack.json
 */

/** @type {null | object} */
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
            search: "title-fuzzy",
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
        const type = String(body.type ?? "").trim() || null;
        if (!q) {
          return cors(json({ error: "empty query" }, 400));
        }
        const idx = await ensureIndex(env);
        const hits = search(idx, q, limit, type);
        return cors(json({ q, type, count: hits.length, hits }));
      }

      if (url.pathname === "/v1/browse" && request.method === "GET") {
        const type = String(url.searchParams.get("type") ?? "").trim();
        const page = clampInt(url.searchParams.get("page") ?? 0, 0, 1_000_000);
        const limit = clampInt(url.searchParams.get("limit") ?? 50, 1, 100);
        if (!type) {
          return cors(json({ error: "missing type" }, 400));
        }
        const idx = await ensureIndex(env);
        const result = browse(idx, type, page, limit);
        return cors(json(result));
      }

      return cors(
        json({
          service: "mcdb-title-search",
          host: "search.mcdb.astral.fan",
          endpoints: [
            "GET /health",
            "POST /v1/search",
            "GET /v1/browse?type=mod&page=0&limit=50",
          ],
          example: { q: "发条", limit: 12, type: "mod" },
          note: "title fuzzy match on en / zh / slug",
        }),
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

function buildBrowseIndex(meta, count) {
  /** @type {Record<string, number[]>} */
  const byType = {};
  for (let row = 0; row < count; row++) {
    const t = meta.type[row] || "other";
    (byType[t] ||= []).push(row);
  }
  for (const rows of Object.values(byType)) {
    rows.sort((a, b) =>
      (meta.en[a] || "").localeCompare(meta.en[b] || "", "en", {
        sensitivity: "base",
      }),
    );
  }
  return byType;
}

async function loadIndex(env) {
  const base = (env.DATA_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("DATA_BASE_URL not set");

  const packRes = await fetch(`${base}/titles.pack.json`);
  if (!packRes.ok) throw new Error(`fetch titles.pack.json failed: ${packRes.status}`);
  const meta = await packRes.json();
  const count = meta.id?.length ?? 0;
  if (!count) throw new Error("empty titles.pack.json");

  return { count, meta, byType: buildBrowseIndex(meta, count) };
}

function rowToHit(meta, row, score = null) {
  const hit = {
    id: meta.id[row] || "",
    en: meta.en[row] || "",
    zh: meta.zh[row] || "",
    slug: meta.slug[row] || null,
    type: meta.type[row] || null,
  };
  if (score != null) hit.score = Math.round(score * 1e6) / 1e6;
  return hit;
}

function browse(idx, type, page, limit) {
  const rows = idx.byType[type] || [];
  const offset = page * limit;
  const slice = rows.slice(offset, offset + limit);
  return {
    type,
    page,
    limit,
    total: rows.length,
    pages: Math.ceil(rows.length / limit) || 0,
    items: slice.map((row) => rowToHit(idx.meta, row)),
  };
}

function normalize(text) {
  return [...(text || "").toLowerCase()].filter((c) => !/\s/.test(c)).join("");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** exact > prefix > contains; prefer short titles */
function scoreTitle(rawQuery, en, zh, slug) {
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

  for (const title of [nZh, nEn]) {
    if (!title || title === q) continue;
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

function search(idx, query, limit, typeFilter = null) {
  const { meta, count } = idx;
  const top = [];
  for (let row = 0; row < count; row++) {
    if (typeFilter && (meta.type[row] || "") !== typeFilter) continue;
    const score = scoreTitle(
      query,
      meta.en[row] || "",
      meta.zh[row] || "",
      meta.slug[row] || "",
    );
    if (score <= 0) continue;
    if (top.length < limit) {
      top.push({ score, row });
      top.sort((a, b) => b.score - a.score);
    } else if (score > top[top.length - 1].score) {
      top[top.length - 1] = { score, row };
      top.sort((a, b) => b.score - a.score);
    }
  }

  return top.map(({ score, row }) => rowToHit(meta, row, score));
}
