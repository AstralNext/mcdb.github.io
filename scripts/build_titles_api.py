#!/usr/bin/env python3
"""从 bilingual.jsonl（或 review）生成标题模糊搜索静态索引。

输出：
  api/v1/titles/manifest.json
  api/v1/titles/titles.pack.json   # {id,en,zh,slug,type} 并行数组
  zh = zh_human ?? zh_ai ?? zh_draft ?? zh
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT.parent / "mcdb" / "dist" / "bilingual.jsonl"
OUT = ROOT / "api" / "v1" / "titles"


def effective_zh(o: dict) -> str:
    for key in ("zh_human", "zh_ai", "zh_draft", "zh"):
        v = str(o.get(key) or "").strip()
        if v:
            return v
    return ""


def build(src: Path, clean: bool) -> None:
    if not src.is_file():
        raise SystemExit(f"缺少源文件：{src}")

    if clean and OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    ids: list[str] = []
    ens: list[str] = []
    zhs: list[str] = []
    slugs: list[str] = []
    types: list[str] = []
    skipped = 0
    with src.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            if str(o.get("status") or "") == "skip":
                skipped += 1
                continue
            zh = effective_zh(o)
            en = str(o.get("en") or "").strip()
            if not en or not zh:
                skipped += 1
                continue
            ids.append(str(o.get("id") or ""))
            ens.append(en)
            zhs.append(zh)
            slugs.append(str(o.get("slug") or ""))
            types.append(str(o.get("type") or ""))

    pack = {"id": ids, "en": ens, "zh": zhs, "slug": slugs, "type": types}
    pack_path = OUT / "titles.pack.json"
    pack_path.write_text(
        json.dumps(pack, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    manifest = {
        "api": 1,
        "kind": "titles",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(ids),
        "skipped": skipped,
        "search": "title-fuzzy",
        "files": {
            "titles.pack.json": {
                "bytes": pack_path.stat().st_size,
                "rows": len(ids),
            },
            "types.json": {},
        },
    }

    from collections import Counter

    TYPE_LABELS = {
        "mod": "模组",
        "modpack": "整合包",
        "resourcepack": "资源包",
        "datapack": "数据包",
        "shader": "着色器",
        "plugin": "插件",
        "modpacks": "整合包",
        "resource_pack": "资源包",
        "data_pack": "数据包",
        "minecraft_java_server": "服务器",
    }
    counts = Counter(types)
    types_doc = {
        "generated_at": manifest["generated_at"],
        "total": len(ids),
        "types": [
            {
                "id": tid,
                "label": TYPE_LABELS.get(tid, tid),
                "count": cnt,
            }
            for tid, cnt in sorted(counts.items(), key=lambda x: (-x[1], x[0]))
        ],
    }
    types_path = OUT / "types.json"
    types_path.write_text(
        json.dumps(types_doc, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest["files"]["types.json"] = {
        "bytes": types_path.stat().st_size,
        "rows": len(types_doc["types"]),
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Build titles fuzzy-search static API")
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC)
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()
    build(args.src, args.clean)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
