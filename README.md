# MCDB 静态 API（汉化 + 标题搜索）

GitHub Pages：[`https://mcdb.astral.fan/`](https://mcdb.astral.fan/)  
仓库：[`AstralNext/mcdb.github.io`](https://github.com/AstralNext/mcdb.github.io)

## 1. 汉化 I18n（按需分片）

| 路径 | 说明 |
|------|------|
| `/api/v1/manifest.json` | 汉化 manifest |
| `/api/v1/i18n/{hex}.json` | `hex = utf8(id[0:2]).hex()` |

例：`AANobbMI` → `4141` → [`/api/v1/i18n/4141.json`](https://mcdb.astral.fan/api/v1/i18n/4141.json)

## 2. 标题索引（模糊搜索数据）

| 路径 | 说明 |
|------|------|
| `/api/v1/titles/manifest.json` | 条数与说明 |
| `/api/v1/titles/titles.pack.json` | `{id,en,zh,slug,type}` 并行数组 |

> 已不再托管语义向量。

## 3. 在线检索（Cloudflare Worker）

```bash
cd workers/semantic-search
npx wrangler deploy
```

```http
POST https://mcdb.1806190090.workers.dev/v1/search
Content-Type: application/json

{"q":"发条","limit":12}
```

Worker 只加载 `titles.pack.json`，对 `en` / `zh` / `slug` 做模糊匹配（精确 > 前缀 > 包含）。

## 重建

```bash
# 汉化
python scripts/build_i18n_api.py --clean

# 标题索引（读 ../mcdb/dist/bilingual.jsonl）
python scripts/build_titles_api.py --clean
```

## 与 AML

- 列表译名 → `GET https://mcdb.astral.fan/api/v1/i18n/...`
- 中文标题搜 → 本地 `bilingual.jsonl` 模糊匹配（或在线 Worker）
