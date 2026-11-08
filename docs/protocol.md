# 协议（v1）

本文件是服务端构建器与客户端 exe 之间的唯一契约。改动必须先改这里再改代码。

## 1. 拓扑

```
服主机器                                    Cloudflare Pages（免费）
─────────                                   ──────────────────────
autoserverpack-1.21.1/
  src/builder  ──扫描 mods/kubejs…──┐
                                   ├─ 生成 dist/site/ ──wrangler──▶ https://<project>.pages.dev/
  config/pack.json ────────────────┘                                 ├─ latest.json
                                                                     ├─ packs/<version>/manifest.json
                                                                     ├─ mods/<file>（仅需自托管的）
                                                                     └─ catalog.html / index.html
玩家机器
  AutoPackClient.exe ──GET latest.json──▶ 比对本地 ──下载──▶ 校验 ──▶ 备份并替换
                     └── Modrinth/CF 镜像直链（官方 mod）──┘
```

## 2. 站点目录布局

```
/                      index.html（人类入口，列出整合包）
/latest.json           指向当前版本的指针（客户端只请求这一个文件做版本判断）
/packs/<version>/manifest.json
/catalog.html          版权页：所有 mod 的名称/版本/作者/许可/源站链接/镜像下载链接
/catalog.json          同上，机器可读
/files/<sha256 前 2 位>/<sha256>.<ext>   自托管文件（未发布 mod、kubejs 等）
/parts/<sha256 前 2 位>/<sha256>.partNN  超过 24MiB 的文件切片
```

`/files/...` 与 `/parts/...` 的内容寻址路径保证：同内容只上传一次，跨版本复用，客户端可用哈希直接校验。
扩展名保留是为了让 Pages 返回正确 `Content-Type`，客户端不依赖它。

## 3. latest.json

```json
{
  "schema": 1,
  "packId": "yunmengyuan",
  "version": "20261108-01",
  "manifest": "packs/20261108-01/manifest.json",
  "manifestSha256": "…",
  "publishedAt": "2026-11-08T01:02:03.000Z",
  "notes": "本次更新说明"
}
```

客户端先取 `latest.json`，若 `version` 与本地 `state.installedVersion` 相同则跳过；
若不同则下载 `manifest` 并用 `manifestSha256` 校验。

## 4. manifest.json

```json
{
  "schema": 1,
  "packId": "yunmengyuan",
  "packName": "云梦缘 2.0",
  "version": "20261108-01",
  "publishedAt": "…",
  "baseUrl": "https://xxx.pages.dev",
  "game": { "minecraft": "1.21.1", "loader": "neoforge", "loaderVersion": "21.1.265" },
  "policy": { "keepUnknownMods": true, "deleteOrphans": false, "backupBeforeReplace": true },
  "requiredModIds": ["sodium", "iris"],
  "scopes": [
    { "id": "mods", "kind": "mods", "dir": "mods", "role": "required" },
    { "id": "kubejs", "kind": "files", "dir": "kubejs", "role": "content" }
  ],
  "files": [
    {
      "path": "mods/ae2ct-1.0.1.jar",
      "scope": "mods",
      "role": "required",
      "size": 474215,
      "sha1": "8d2b789b…",
      "sha256": "…",
      "source": {
        "kind": "mirror",
        "url": "https://mod.mcimirror.top/data/a1RwDz90/versions/35O4yt0D/ae2ct-1.0.1.jar",
        "fallbacks": ["https://cdn.modrinth.com/data/a1RwDz90/versions/35O4yt0D/ae2ct-1.0.1.jar"],
        "provider": "modrinth",
        "projectId": "a1RwDz90",
        "versionNumber": "1.0.1"
      },
      "mods": [
        {
          "modId": "ae2ct",
          "name": "AE2: Crafting Tree Refreshed",
          "version": "1.0.1",
          "authors": "vcwdfca",
          "license": "LGPL-3.0",
          "description": "A refreshed fork of AE2: Crafting Tree"
        }
      ]
    },
    {
      "path": "mods/自研mod-1.0.jar",
      "size": 1234,
      "sha1": "…",
      "sha256": "…",
      "source": { "kind": "pages", "url": "https://xxx.pages.dev/files/ab/abcdef….jar" },
      "parts": null
    }
  ]
}
```

规则：

- `path` 一律使用 `/` 分隔，相对游戏目录，禁止 `..`。
- 只下发 `role` 为 `required` / `optional` / `content` 的条目；`role` 供客户端展示分组，不决定是否安装。
- `source.kind`：
  - `mirror`：官方 mod 平台直链（已换成镜像），带 `fallbacks` 官方源；
  - `pages`：本站内容寻址路径，`parts` 非空时分片。
- `parts`（可选）：按顺序拼接还原原文件。每片 `{ "path": "...", "size": n, "sha256": "..." }`，
  单片 ≤ 24MiB（Cloudflare Pages 单文件 25MiB 硬限制）。
- `mods`：该 jar 内声明的模组元数据（客户端用于 modId 级差异判断与“必须装”检查）。

## 5. 客户端本地状态 `state.json`

```json
{
  "schema": 1,
  "packId": "yunmengyuan",
  "installedVersion": "20261108-01",
  "lastSyncAt": "…",
  "lastResult": "success",
  "files": {
    "mods/ae2ct-1.0.1.jar": { "sha256": "…", "size": 474215, "installedAt": "…" }
  },
  "optOut": ["mods/客户端可选.jar"]
}
```

客户端只管理 `state.files` 里记录过的路径 + 本次清单里的路径。
**不在清单、也不在 state 里的文件一律不删**（玩家自装 mod 永远保留）。
被替换/移除的文件进 `.autopack/backup/<时间戳>/`，不直接删除。

## 6. 更新判定

1. 读 `latest.json`，`version` 相同且本地校验通过 → 直接“已是最新”。
2. 对 manifest 每个文件：
   - 本地存在且 `sha256` 一致 → 跳过；
   - 本地存在但哈希不同 / 不存在 → 需要下载。
3. mods 作用域按 **modId** 细化：
   - 本地某 jar 提供相同 modId 但版本不同 → 下载服务端版本并备份本地 jar（不会同时留两份）；
   - 本地 jar 的 modId 不在服务端清单里 → 保留（纯客户端 mod，不影响进服）。
4. `requiredModIds` 检查：扫描本地 `mods/*.jar` 的元数据，缺哪个就装哪个（清单里有对应文件则自动装，没有则报错）。
5. 下载 → 暂存 `.autopack/staging/<version>/` → 校验 sha256（分片先合并再校验）→ 备份旧文件 → 原子改名落位。
6. 写入 `state.json`。失败时不动任何已生效文件。

## 7. 镜像规则

| 原站 | 镜像 |
| --- | --- |
| `api.modrinth.com` | `https://mod.mcimirror.top/modrinth` |
| `cdn.modrinth.com` | `https://mod.mcimirror.top` |
| `api.curseforge.com` | `https://mod.mcimirror.top/curseforge` |
| `edge.forgecdn.net` / `mediafilez.forgecdn.net` | `https://mod.mcimirror.top` |
| 项目网页 `modrinth.com/mod/x` | 无网页镜像；目录页展示源站链接 + 镜像 API 链接 |

MCIM 只缓存 ≤20MB 的文件；超出时镜像可能 404，客户端会按 `fallbacks` 回退官方源。
