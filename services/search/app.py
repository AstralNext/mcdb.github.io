"""MCDB 语义检索 HTTP 服务。

启动：
  pip install -r requirements.txt
  set MCDB_SEMANTIC_DIR=<...\\api\\v1\\semantic 或 AML semantic 目录>
  uvicorn app:app --host 0.0.0.0 --port 8080

POST /v1/search  {"q":"机械动力","limit":12}
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DIM = 256
EMBED_NAME = "char-unigram+bigram-hash"
VEC_POOL = 250
QUERY_ALIASES: dict[str, list[str]] = {
    "机械动力": ["Create", "create"],
    "物品管理": ["Just Enough Items", "jei"],
    "光影": ["shader", "shaders"],
}

app = FastAPI(title="MCDB Semantic Search", version="1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def semantic_dir() -> Path:
    raw = os.environ.get("MCDB_SEMANTIC_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parents[2] / "api" / "v1" / "semantic"


def char_ngrams(text: str, n: int) -> list[str]:
    t = re.sub(r"\s+", "", (text or "").lower())
    if not t:
        return []
    if len(t) < n:
        return [t]
    return [t[i : i + n] for i in range(len(t) - n + 1)]


def embed_text(text: str) -> np.ndarray:
    vec = np.zeros(DIM, dtype=np.float32)
    grams = char_ngrams(text, 1) + char_ngrams(text, 2)
    if not grams:
        return vec
    for g in grams:
        h = int(hashlib.md5(g.encode("utf-8")).hexdigest(), 16)
        idx = h % DIM
        sign = 1.0 if (h >> 8) & 1 else -1.0
        w = 1.4 if len(g) == 1 else 1.0
        vec[idx] += np.float32(sign * w)
    norm = float(np.linalg.norm(vec)) or 1.0
    vec /= np.float32(norm)
    return vec


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").lower())


def expand_queries(query: str) -> list[str]:
    out = [query]
    nq = _norm(query)
    for key, alts in QUERY_ALIASES.items():
        if _norm(key) == nq:
            out.extend(alts)
    return out


def lexical_boost(raw_query: str, en: str, zh: str, slug: str) -> float:
    q = _norm(raw_query)
    if not q:
        return 0.0
    n_en, n_zh = _norm(en), _norm(zh)
    n_slug = (slug or "").lower()
    ascii_q = bool(re.fullmatch(r"[a-z0-9_.:-]+", raw_query.strip(), flags=re.I))
    best = 0.0
    if n_en == q or n_zh == q:
        best = max(best, 5.0)
    if n_slug == q:
        best = max(best, 4.5)
    if ascii_q:
        tokens = [t for t in re.split(r"[-_.]+", n_slug) if t]
        if q in tokens and n_slug != q:
            best = max(best, 1.15)
        if n_en != q and re.search(
            rf"(?:^|[^a-z0-9]){re.escape(q)}(?:[^a-z0-9]|$)", en or "", flags=re.I
        ):
            best = max(best, 1.35)
        return best
    for title in (n_zh, n_en):
        if not title or title == q:
            continue
        if title.startswith(q):
            best = max(best, 1.6 + len(q) / max(len(title), 1))
        elif q in title:
            best = max(best, 0.85 * (len(q) / max(len(title), 1)))
    if n_slug != q and q in n_slug:
        best = max(best, 0.5 * (len(q) / max(len(n_slug), 1)))
    return best


class Index:
    def __init__(self, root: Path):
        self.root = root
        if not (root / "index.json").is_file():
            raise FileNotFoundError(f"index.json not in {root}")
        self.meta = json.loads((root / "index.json").read_text(encoding="utf-8"))
        self.dim = int(self.meta["dim"])
        self.count = int(self.meta["count"])
        if self.dim != DIM:
            raise ValueError(f"dim {self.dim} != {DIM}")

        whole = root / "vectors.f32"
        if whole.is_file():
            raw = whole.read_bytes()
        else:
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            chunks = [(root / p["file"]).read_bytes() for p in manifest["parts"]]
            raw = b"".join(chunks)

        expected = self.count * self.dim * 4
        if len(raw) != expected:
            raise ValueError(f"vectors size {len(raw)} != {expected}")

        self.matrix = np.frombuffer(raw, dtype="<f4").reshape(self.count, self.dim)

        self.records: list[dict] = []
        with (root / "meta.jsonl").open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.records.append(json.loads(line))
        self.count = min(self.count, len(self.records))
        if self.matrix.shape[0] != self.count:
            self.matrix = self.matrix[: self.count]

    def search(self, query: str, limit: int) -> list[dict]:
        variants = expand_queries(query)
        scores = self.matrix @ embed_text(query)
        pool_n = min(self.count, max(limit * 25, VEC_POOL))
        if pool_n >= self.count:
            pool_idx = np.argsort(-scores)
        else:
            pool_idx = np.argpartition(-scores, pool_n)[:pool_n]
            pool_idx = pool_idx[np.argsort(-scores[pool_idx])]

        cand: dict[int, float] = {int(r): float(scores[int(r)]) for r in pool_idx}
        for row, rec in enumerate(self.records):
            lex = 0.0
            for v in variants:
                lex = max(
                    lex,
                    lexical_boost(
                        v,
                        rec.get("en") or "",
                        rec.get("zh") or "",
                        rec.get("slug") or "",
                    ),
                )
            if lex > 0:
                cand[row] = float(scores[row]) + lex

        ranked = sorted(cand.items(), key=lambda x: -x[1])[:limit]
        out = []
        for row, score in ranked:
            rec = self.records[row]
            out.append(
                {
                    "id": rec.get("id", ""),
                    "en": rec.get("en", ""),
                    "zh": rec.get("zh", ""),
                    "score": round(float(score), 6),
                    "slug": rec.get("slug") or None,
                    "type": rec.get("type") or None,
                }
            )
        return out


@lru_cache(maxsize=1)
def get_index() -> Index:
    return Index(semantic_dir())


class SearchIn(BaseModel):
    q: str = Field(..., min_length=1)
    limit: int = Field(12, ge=1, le=50)


@app.get("/health")
def health():
    root = semantic_dir()
    loaded = False
    count = 0
    try:
        idx = get_index()
        loaded = True
        count = idx.count
    except Exception:
        pass
    return {
        "ok": True,
        "semantic_dir": str(root),
        "loaded": loaded,
        "count": count,
        "embed": EMBED_NAME,
        "rank": "vector+lexical+alias",
    }


@app.post("/v1/search")
def search(body: SearchIn):
    try:
        idx = get_index()
    except Exception as e:
        raise HTTPException(503, f"index load failed: {e}") from e
    q = body.q.strip()
    if not q:
        raise HTTPException(400, "empty query")
    hits = idx.search(q, body.limit)
    return {"q": q, "count": len(hits), "hits": hits}


@app.on_event("startup")
def _warmup():
    try:
        idx = get_index()
        print(f"loaded {idx.count} vectors from {semantic_dir()}")
    except Exception as e:
        print(f"warmup skipped: {e}")
