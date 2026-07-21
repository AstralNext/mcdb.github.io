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

## 3. 在线检索服务（推荐给 AML）

目录：`services/search`（FastAPI）

```bash
cd services/search
pip install -r requirements.txt
set MCDB_SEMANTIC_DIR=..\..\api\v1\semantic
uvicorn app:app --host 0.0.0.0 --port 8080
```

```http
POST /v1/search
Content-Type: application/json

{"q":"机械动力","limit":12}
```

Docker：

```bash
docker build -t mcdb-search services/search
docker run -p 8080:8080 -v /path/to/api/v1/semantic:/data mcdb-search
```

可将 `search.mcdb.astral.fan` CNAME 到该服务主机。

## 重建

```bash
# 汉化（读 ../mcdb/dist/bilingual.jsonl）
python scripts/build_i18n_api.py --clean

# 向量（读本地 AML MCDB 缓存 semantic/）
python scripts/build_semantic_api.py --clean --root "%APPDATA%/com.example/aml/mcdb"
```

## 与 AML

- 列表译名 → `GET mcdb.astral.fan/api/v1/i18n/...`
- 中文语义搜 → `POST` 自建 `/v1/search`（勿在客户端加载 140MB 向量）
