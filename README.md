# MCDB 静态 API

- 汉化站点：[`https://mcdb.astral.fan/`](https://mcdb.astral.fan/)（只托管译名分片）
- 模糊搜索：[`https://search.mcdb.astral.fan/`](https://search.mcdb.astral.fan/)（Cloudflare Worker）
- 仓库：[`AstralNext/mcdb.github.io`](https://github.com/AstralNext/mcdb.github.io)

**无向量。** Pages 只提供汉化 JSON；搜索走 `search.mcdb.astral.fan`。

## 1. 汉化 I18n（本站）

| 路径 | 说明 |
|------|------|
| `/api/v1/manifest.json` | 汉化 manifest |
| `/api/v1/i18n/{hex}.json` | `hex = utf8(id[0:2]).hex()` |

## 2. 模糊搜索（search 子域）

```http
POST https://search.mcdb.astral.fan/v1/search
Content-Type: application/json

{"q":"发条","limit":12}
```

对 en / zh / slug 做精确 > 前缀 > 包含。Worker 从本站读取 `api/v1/titles/titles.pack.json` 作为数据源（内部用，不必对用户宣传为「向量」）。

部署 Worker：

```bash
cd workers/semantic-search
npx wrangler deploy
# Dashboard 绑定自定义域 search.mcdb.astral.fan
```

## 自动同步

工作流 `sync-mcdb-hourly`：每小时从 MCDB 重建 `api/v1/i18n/*` 与 `api/v1/titles/*`。

## 与 AML

- 列表译名 → `GET https://mcdb.astral.fan/api/v1/i18n/...`
- 中文搜 → `POST https://search.mcdb.astral.fan/v1/search`
