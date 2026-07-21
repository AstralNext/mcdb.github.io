# MCDB 静态 API（汉化 + 向量）

GitHub Pages：[`https://mcdb.astral.fan/`](https://mcdb.astral.fan/)  
仓库：[`AstralNext/mcdb.github.io`](https://github.com/AstralNext/mcdb.github.io)

## 1. 汉化 I18n（按需分片）

| 路径 | 说明 |
|------|------|
| `/api/v1/manifest.json` | 汉化 manifest |
| `/api/v1/i18n/{hex}.json` | `hex = utf8(id[0:2]).hex()` |

例：`AANobbMI` → `4141` → [`/api/v1/i18n/4141.json`](https://mcdb.astral.fan/api/v1/i18n/4141.json)

## 2. 向量 Semantic（静态数据）

| 路径 | 说明 |
|------|------|
| `/api/v1/semantic/manifest.json` | 分片列表与用法 |
| `/api/v1/semantic/index.json` | dim/count/embed |
| `/api/v1/semantic/meta.jsonl` | 与向量行对齐的 id/en/zh |
| `/api/v1/semantic/vectors/part-*.f32` | float32 LE 分片（&lt;100MB） |
| `/api/v1/semantic/vectors.i8.bin` | int8 量化整包 ~35MB |
| `/api/v1/semantic/scales.f32` | i8 每行尺度 |

**说明**：GitHub Pages **不能**做全库检索计算。静态文件供下载 / 自建服务加载。

## 3. 在线检索

### Cloudflare Worker（推荐）

```bash
cd workers/semantic-search
npx wrangler deploy
# 绑定自定义域（Dashboard → Workers → 触发器 → 添加域）
# search.mcdb.astral.fan
```

```http
POST https://search.mcdb.astral.fan/v1/search
Content-Type: application/json

{"q":"发条","limit":12}
```

Worker 冷启动从 `mcdb.astral.fan` 拉取 `vectors.i8.bin` + `scales.f32` + `meta.pack.json`，isolate 内缓存后做 Top-K。

排序：`余弦(hash向量) + 词法加分(精确/前缀/词边界) + 查询别名`（例如「机械动力」→ Create / 创作）。无需重编向量即可改善英文精确命中与社区惯用名。

### FastAPI 备用

目录：`services/search`（见上文）。

## 重建

```bash
# 汉化
python scripts/build_i18n_api.py --clean

# 向量（含 meta.pack.json / i8）
python scripts/build_semantic_api.py --clean --root "%APPDATA%/com.example/aml/mcdb"
```

## 与 AML

- 列表译名 → `GET https://mcdb.astral.fan/api/v1/i18n/...`
- 中文语义搜 → `POST https://search.mcdb.astral.fan/v1/search`
