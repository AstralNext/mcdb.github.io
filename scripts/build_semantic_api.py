#!/usr/bin/env python3
"""从本地 MCDB semantic 二进制生成 GitHub Pages 向量静态 API。

输出（单文件 <100MB，符合 GitHub 限制）：
  api/v1/semantic/manifest.json
  api/v1/semantic/index.json
  api/v1/semantic/meta.jsonl          # 与 vectors 行对齐
  api/v1/semantic/vectors/part-XX.f32 # float32 LE 分片
  api/v1/semantic/vectors.i8.bin      # int8 量化（可选，供 Worker）
  api/v1/semantic/scales.f32          # 每行 L2 缩放（与 i8 配套）

用法：
  python scripts/build_semantic_api.py --clean
  python scripts/build_semantic_api.py --root "%APPDATA%/com.example/aml/mcdb"
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MCDB = Path.home() / "AppData/Roaming/com.example/aml/mcdb"
OUT = ROOT / "api" / "v1" / "semantic"
# GitHub 硬限制 100MB；留余量
MAX_PART_BYTES = 90 * 1024 * 1024


def load_index(semantic_dir: Path) -> dict:
    return json.loads((semantic_dir / "index.json").read_text(encoding="utf-8"))


def build(mcdb_root: Path, clean: bool) -> None:
    semantic = mcdb_root / "semantic"
    vectors_path = semantic / "vectors.f32"
    meta_path = semantic / "meta.jsonl"
    index_path = semantic / "index.json"
    version_path = mcdb_root / "version.json"

    for p in (vectors_path, meta_path, index_path):
        if not p.is_file():
            raise SystemExit(f"缺少文件：{p}（请先在 AML 下载并转换 MCDB）")

    meta = load_index(semantic)
    dim = int(meta["dim"])
    count = int(meta["count"])
    row_bytes = dim * 4
    expected = count * row_bytes
    raw = vectors_path.read_bytes()
    if len(raw) != expected:
        raise SystemExit(f"vectors.f32 大小不符：{len(raw)} != {expected}")

    if clean and OUT.exists():
        shutil.rmtree(OUT)
    out_vec = OUT / "vectors"
    out_vec.mkdir(parents=True, exist_ok=True)

    # --- float32 分片 ---
    rows_per_part = max(1, MAX_PART_BYTES // row_bytes)
    parts = []
    for i, start in enumerate(range(0, count, rows_per_part)):
        end = min(count, start + rows_per_part)
        blob = raw[start * row_bytes : end * row_bytes]
        name = f"part-{i:03d}.f32"
        (out_vec / name).write_bytes(blob)
        parts.append(
            {
                "file": f"vectors/{name}",
                "row_start": start,
                "row_end": end,
                "bytes": len(blob),
            }
        )
        print(f"  wrote {name} rows=[{start},{end}) bytes={len(blob)}")

    # --- meta 原样 + Worker 用紧凑 pack ---
    shutil.copy2(meta_path, OUT / "meta.jsonl")
    ids: list[str] = []
    ens: list[str] = []
    zhs: list[str] = []
    slugs: list[str] = []
    types: list[str] = []
    with meta_path.open(encoding="utf-8") as f:
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
    (OUT / "meta.pack.json").write_text(
        json.dumps(pack, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  wrote meta.pack.json rows={len(ids)}")

    # --- int8 量化（整文件约 35MB，便于边缘/轻量服务）---
    try:
        import numpy as np

        f = np.frombuffer(raw, dtype="<f4").reshape(count, dim)
        peak = np.max(np.abs(f), axis=1, keepdims=True)
        peak = np.maximum(peak, 1e-12)
        scales_arr = (peak / 127.0).astype("<f4").reshape(count)
        q = np.clip(np.rint(f / scales_arr.reshape(count, 1)), -127, 127).astype(
            np.int8
        )
        (OUT / "vectors.i8.bin").write_bytes(q.tobytes(order="C"))
        (OUT / "scales.f32").write_bytes(scales_arr.tobytes(order="C"))
        print(f"  wrote vectors.i8.bin bytes={q.nbytes} scales={count} (numpy)")
    except ImportError:
        print("  skip i8（未安装 numpy）。pip install numpy 后可生成 vectors.i8.bin")
        print("  warn: 仅生成 float32 分片")

    # --- index / manifest ---
    mcdb_version = None
    if version_path.is_file():
        try:
            mcdb_version = json.loads(version_path.read_text(encoding="utf-8")).get(
                "version"
            )
        except Exception:
            pass

    index_out = {
        "version": meta.get("version", 1),
        "dim": dim,
        "count": count,
        "embed": meta.get("embed", "char-unigram+bigram-hash"),
        "mcdb_version": mcdb_version or meta.get("mcdb_version"),
        "vec_encoding": "float32le",
        "i8_encoding": "int8_per_row_scale",
    }
    (OUT / "index.json").write_text(
        json.dumps(index_out, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    manifest = {
        "api": 1,
        "kind": "semantic",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mcdb_version": index_out["mcdb_version"],
        "dim": dim,
        "count": count,
        "embed": index_out["embed"],
        "endpoints": {
            "manifest": "api/v1/semantic/manifest.json",
            "index": "api/v1/semantic/index.json",
            "meta": "api/v1/semantic/meta.jsonl",
            "meta_pack": "api/v1/semantic/meta.pack.json",
            "vectors_parts": "api/v1/semantic/vectors/part-XXX.f32",
            "vectors_i8": "api/v1/semantic/vectors.i8.bin",
            "scales": "api/v1/semantic/scales.f32",
            "search": "Cloudflare Worker：POST /v1/search（见 workers/semantic-search）",
        },
        "parts": parts,
        "usage": {
            "download": "按需拉取 part 分片或整包 i8；客户端/服务端 embed 须与 compile_dist.py 一致",
            "search_cf": "workers/semantic-search：Worker 冷启动加载 i8+scales+meta.pack，isolate 内缓存后 Top-K",
            "search_service": "备用 services/search FastAPI",
            "embed": "char-unigram+bigram-hash dim=256 md5；与 AML Rust mcdb_embed 对齐",
        },
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"OK semantic api -> {OUT} parts={len(parts)} count={count}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_MCDB,
        help="MCDB 根目录（含 semantic/vectors.f32）",
    )
    p.add_argument("--clean", action="store_true")
    args = p.parse_args()
    build(args.root, clean=True if args.clean or True else False)


if __name__ == "__main__":
    main()
