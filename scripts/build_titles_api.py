#!/usr/bin/env python3
"""从 bilingual.jsonl 生成标题模糊搜索静态索引（无向量）。

输出：
  api/v1/titles/manifest.json
  api/v1/titles/titles.pack.json   # {id,en,zh,slug,type} 并行数组

用法：
  python scripts/build_titles_api.py --clean
  python scripts/build_titles_api.py --src ../mcdb/dist/bilingual.jsonl
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
    with src.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            ids.append(str(o.get("id") or ""))
            ens.append(str(o.get("en") or ""))
            zhs.append(str(o.get("zh") or ""))
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
        "search": "title-fuzzy",
        "files": {
            "titles.pack.json": {
                "bytes": pack_path.stat().st_size,
                "rows": len(ids),
            }
        },
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
