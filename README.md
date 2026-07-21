# MCDB 静态 API（汉化分片 + 标题模糊搜索）

站点：[`https://mcdb.astral.fan/`](https://mcdb.astral.fan/)  
仓库：[`AstralNext/mcdb.github.io`](https://github.com/AstralNext/mcdb.github.io)

## 1. 汉化 I18n

| 路径 | 说明 |
|------|------|
| `/api/v1/manifest.json` | 汉化 manifest |
| `/api/v1/i18n/{hex}.json` | `hex = utf8(id[0:2]).hex()` |

## 2. 标题索引（模糊匹配数据）

| 路径 | 说明 |
|------|------|
| `/api/v1/titles/manifest.json` | 条数 |
| `/api/v1/titles/titles.pack.json` | `{id,en,zh,slug,type}` |

`zh` = `zh_human` ?? `zh_ai` ?? `zh_draft`（有效译名）。**无向量。**

## 3. 在线模糊搜索（Cloudflare Worker）

```bash
cd workers/semantic-search
npx wrangler deploy
```

```http
POST https://mcdb.1806190090.workers.dev/v1/search
Content-Type: application/json

{"q":"发条","limit":12}
```

Worker 只加载 `titles.pack.json`，对 en/zh/slug 做精确 > 前缀 > 包含。

## 自动同步

工作流 `sync-mcdb-hourly`：每小时从 [`AstralNext/MCDB`](https://github.com/AstralNext/MCDB) 编译最新对照表，重建：

- `api/v1/i18n/*` 汉化分片
- `api/v1/titles/*` 模糊搜索索引

也可在 Actions 里手动 **Run workflow**。

## 重建（本地）

```bash
# 先在 MCDB 仓库 compile
python ../mcdb/scripts/compile_dist.py

# 汉化分片
python scripts/build_i18n_api.py --clean

# 标题模糊索引
python scripts/build_titles_api.py --clean --src ../mcdb/dist/bilingual.jsonl
```

## 与 AML

- 列表译名 → `GET /api/v1/i18n/...`
- 中文搜 → 本地 bilingual 模糊，或 `POST .../v1/search`
