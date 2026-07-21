# MCDB 静态汉化 API

GitHub Pages 托管的 Modrinth 项目中英对照查询服务（无服务端计算）。

## 在线地址（推送并开启 Pages 后）

- Manifest：`https://astralnext.github.io/mcdb.github.io/api/v1/manifest.json`
- 分片示例：`https://astralnext.github.io/mcdb.github.io/api/v1/i18n/4141.json`（`AA` → hex）

## 分片规则（大小写安全）

```
prefixHex = hex(utf8(id[0:2]))   // 小写
URL       = api/v1/i18n/{prefixHex}.json
```

例：`AANobbMI` → `AA` → `4141` → `api/v1/i18n/4141.json` → 键 `AANobbMI`。

> 不用原始两字符当文件名，避免 Windows/Git 大小写折叠导致分片互相覆盖。

## 客户端怎么用

1. `GET api/v1/manifest.json`
2. 对每个 id 算 `prefixHex`，去重后并行拉分片
3. 在分片 JSON 里用完整 id 取值：`{ zh, en, desc_zh?, slug?, type? }`

**不要**启动时下载全部分片；按需 + LRU。

### Dart 示例

```dart
String shardName(String id) {
  final p = id.length >= 2 ? id.substring(0, 2) : id.padRight(2, '_');
  return utf8.encode(p).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}
```

## 重新构建

```bash
python scripts/build_i18n_api.py --clean
```

默认读取 `../mcdb/dist/bilingual.jsonl`。

## 与向量服务

本仓库当前只提供 **i18n（汉化）**。语义向量检索另做。
