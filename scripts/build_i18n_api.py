#!/usr/bin/env python3
"""从 MCDB bilingual.jsonl 生成 GitHub Pages 静态汉化 API。

输出：
  api/v1/manifest.json
  api/v1/i18n/{prefix2}.json   # id 前 2 字符分片，值为 {zh,en,desc_zh,slug,type}

用法：
  python scripts/build_i18n_api.py
  python scripts/build_i18n_api.py --bilingual ../mcdb/dist/bilingual.jsonl
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BILINGUAL = Path(__file__).resolve().parents[2] / "mcdb" / "dist" / "bilingual.jsonl"
DEFAULT_VERSION = Path(__file__).resolve().parents[2] / "mcdb" / "dist" / "version.json"
OUT_API = ROOT / "api" / "v1"
OUT_I18N = OUT_API / "i18n"

API_VERSION = 1


def load_mcdb_version(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return str(data.get("version") or "") or None
    except Exception:
        return None


def row_from_line(line: str) -> tuple[str, dict] | None:
    line = line.strip()
    if not line:
        return None
    try:
        o = json.loads(line)
    except json.JSONDecodeError:
        return None
    pid = str(o.get("id") or "").strip()
    en = str(o.get("en") or "").strip()
    zh = str(o.get("zh") or "").strip()
    if not pid or not en or not zh:
        return None
    desc_zh = str(o.get("desc_zh") or o.get("description_zh") or "").strip()
    slug = str(o.get("slug") or "").strip()
    rtype = str(o.get("type") or "").strip()
    entry = {"zh": zh, "en": en}
    if desc_zh:
        entry["desc_zh"] = desc_zh
    if slug:
        entry["slug"] = slug
    if rtype:
        entry["type"] = rtype
    return pid, entry


def shard_key(project_id: str) -> str:
    """大小写安全的分片名（Windows / Git 忽略大小写时也不会撞车）。

    例：id「AANobbMI」→ prefix「AA」→「4141」
    """
    prefix = project_id[:2] if len(project_id) >= 2 else project_id.ljust(2, "_")
    return prefix.encode("utf-8").hex()


def build(bilingual: Path, version_file: Path, clean: bool) -> None:
    if not bilingual.is_file():
        raise SystemExit(f"找不到 bilingual：{bilingual}")

    if clean and OUT_I18N.exists():
        shutil.rmtree(OUT_I18N)
    OUT_I18N.mkdir(parents=True, exist_ok=True)

    shards: dict[str, dict[str, dict]] = defaultdict(dict)
    count = 0
    with bilingual.open("r", encoding="utf-8") as f:
        for line in f:
            parsed = row_from_line(line)
            if parsed is None:
                continue
            pid, entry = parsed
            shards[shard_key(pid)][pid] = entry
            count += 1

    shard_names = sorted(shards.keys())
    for name in shard_names:
        path = OUT_I18N / f"{name}.json"
        path.write_text(
            json.dumps(shards[name], ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    mcdb_version = load_mcdb_version(version_file)
    manifest = {
        "api": API_VERSION,
        "kind": "i18n",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mcdb_version": mcdb_version,
        "count": count,
        "shard_by": "id_prefix2_hex",
        "shard_name": "utf8(id[:2]).hex().lower()",
        "entry_fields": {
            "zh": "中文标题（必有）",
            "en": "英文标题（必有）",
            "desc_zh": "中文简介（可选）",
            "slug": "Modrinth slug（可选）",
            "type": "project type（可选）",
        },
        "endpoints": {
            "manifest": "api/v1/manifest.json",
            "shard": "api/v1/i18n/{prefix2_hex}.json",
            "example": "api/v1/i18n/4141.json",
        },
        "usage": {
            "lookup": "prefixHex = Buffer.from(id.slice(0,2),'utf8').toString('hex'); GET i18n/{prefixHex}.json 后取 [id]",
            "batch": "同一页多个 id 按 prefixHex 去重后并行 GET 分片，客户端内存合并",
            "dart": "prefixHex = utf8.encode(id.substring(0,2)).map((b)=>b.toRadixString(16).padLeft(2,'0')).join()",
        },
        "shard_count": len(shard_names),
    }
    OUT_API.mkdir(parents=True, exist_ok=True)
    (OUT_API / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"OK count={count} shards={len(shard_names)} -> {OUT_API}")


def main() -> None:
    p = argparse.ArgumentParser(description="Build static MCDB i18n API for GitHub Pages")
    p.add_argument(
        "--bilingual",
        type=Path,
        default=DEFAULT_BILINGUAL,
        help="path to bilingual.jsonl",
    )
    p.add_argument(
        "--version-file",
        type=Path,
        default=DEFAULT_VERSION,
        help="path to MCDB version.json",
    )
    p.add_argument("--clean", action="store_true", help="删除旧 i18n 分片后再生成")
    args = p.parse_args()
    build(args.bilingual, args.version_file, clean=args.clean or True)


if __name__ == "__main__":
    main()
