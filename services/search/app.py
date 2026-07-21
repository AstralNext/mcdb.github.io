"""MCDB 标题模糊检索 HTTP 服务（无向量）。

启动：
  pip install -r requirements.txt
  set MCDB_TITLES_DIR=..\..\api\v1\titles
  uvicorn app:app --host 0.0.0.0 --port 8080

POST /v1/search  {"q":"发条","limit":12}
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="MCDB Title Search", version="2")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def titles_dir() -> Path:
    raw = os.environ.get("MCDB_TITLES_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parents[2] / "api" / "v1" / "titles"


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").lower())


def score_title(raw_query: str, en: str, zh: str, slug: str) -> float:
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
        pack = root / "titles.pack.json"
        if not pack.is_file():
            raise FileNotFoundError(f"titles.pack.json not in {root}")
        data = json.loads(pack.read_text(encoding="utf-8"))
        self.id = data["id"]
        self.en = data["en"]
        self.zh = data["zh"]
        self.slug = data.get("slug") or [""] * len(self.id)
        self.type = data.get("type") or [""] * len(self.id)
        self.count = len(self.id)

    def search(self, query: str, limit: int) -> list[dict]:
        ranked: list[tuple[float, int]] = []
        for i in range(self.count):
            s = score_title(query, self.en[i], self.zh[i], self.slug[i] or "")
            if s <= 0:
                continue
            ranked.append((s, i))
        ranked.sort(key=lambda x: -x[0])
        out = []
        for s, i in ranked[:limit]:
            out.append(
                {
                    "id": self.id[i],
                    "en": self.en[i],
                    "zh": self.zh[i],
                    "score": round(s, 6),
                    "slug": self.slug[i] or None,
                    "type": self.type[i] or None,
                }
            )
        return out


@lru_cache(maxsize=1)
def get_index() -> Index:
    return Index(titles_dir())


class SearchIn(BaseModel):
    q: str = Field(..., min_length=1)
    limit: int = Field(12, ge=1, le=50)


@app.get("/health")
def health():
    root = titles_dir()
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
        "titles_dir": str(root),
        "loaded": loaded,
        "count": count,
        "search": "title-fuzzy",
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
