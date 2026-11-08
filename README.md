# AutoPack · 整合包自动更新装置

Minecraft **1.21.1 / NeoForge** 整合包自动更新：

- **服务端 = 一个 mod jar**：丢进服务端 `mods/`，开服后自动扫描 `mods/`、`kubejs/` 等范围，读取每个 mod jar 的版权页（`META-INF/neoforge.mods.toml`），把 Modrinth / CurseForge 下载链接换成 **MCIM 国内镜像**，其余文件（未发布 mod、kubejs、自定义目录）切片后当网盘，最后**直接调 Cloudflare API** 传到 **Pages**（不需要 wrangler、不需要浏览器登录）。
- **客户端 = 一个 exe**：`AutoPackClient.exe`，**游戏外**更新。双击开本地网页，检查 → 下载 → 校验 → 备份 → 落位。清单里没有的 mod 只补不删；玩家自装的 mod 只要不影响进服就保留。

```
服务端（NeoForge 21.1.265 / 1.21.1）
  mods/AutoPack-1.0.0.jar
    └ 开服 5 秒后：扫描 → 解析 → 生成清单/版权页 → Cloudflare API 直传
                                      │
                                      ▼
                          Cloudflare Pages（免费）
                            latest.json
                            packs/<ver>/manifest.json
                            files/…  自托管（内容寻址）
                            parts/…  >24MiB 自动切片
                            catalog  版权页

玩家
  AutoPackClient.exe ──读 latest.json──▶ 差异计算 ──▶ 镜像直链 / Pages 下载
                     └─ 校验 SHA-256 ─▶ 备份旧文件 ─▶ 原子落位
```

---

## 1. 目录结构

```
autoserverpack-1.21.1/
├─ AutoPack-1.0.0.jar                ← 服务端 mod（就是它）
├─ AutoPackClient.exe                ← 玩家更新器
├─ AutoPackBuilder.exe               ← 可选：命令行构建/发布（不装 mod 时用）
├─ servermod/                        服务端 mod 源码（Java 21，无 Gradle）
│  ├─ src/main/java/com/autopack/
│  │  ├─ AutoPackMod.java            入口：ServerStartedEvent / autopack/trigger
│  │  ├─ Builder.java                扫描→哈希→镜像解析→清单→站点
│  │  ├─ Publisher.java              发布入口（API 直传优先，wrangler 兜底）+ 线上校验
│  │  ├─ ModJar.java                 jar 版权页解析（NeoForge/Forge/Fabric）
│  │  ├─ Resolver.java               Modrinth SHA-1 反查（MCIM 镜像）
│  │  ├─ Toml.java / Catalog.java / Mirror.java / …
│  └─ src/main/resources/META-INF/neoforge.mods.toml
├─ src/builder/                      同一套逻辑的 Node 版（本机调试/预览用）
├─ src/client/                       客户端同步引擎 + 本地网页 UI
├─ tools/build-server-jar.mjs        javac 直接编译打 jar
├─ tools/build-exe.mjs               esbuild + Node SEA 打包 exe
├─ docs/protocol.md                  清单/同步协议
└─ config/pack.json                  Node 版用的配置（字段与 mod 的 config 一致）
```

---

## 2. 服务端：安装 mod jar

### 2.1 装

1. 把 `AutoPack-1.0.0.jar` 复制到服务器 `mods/`。
2. 首次开服会在 `config/autopack.json` 生成模板配置（也可以直接复制 `servermod/config.example.json`）。
3. 改两处：

```json
"pages": { "project": "yunmengyuan-pack", "branch": "main" }
```

`project` 填 Cloudflare Pages 项目名，域名自动推导为 `https://<项目名>.pages.dev`。

4. **不需要登录**。上传走 Cloudflare API，令牌按这个顺序找：

   1. 配置里 `pages.apiToken`（推荐长期部署用，Cloudflare 后台建，权限 `Account → Cloudflare Pages → Edit`）
   2. 环境变量 `CLOUDFLARE_API_TOKEN`
   3. 本机 `~/.wrangler/config/default.toml` 里已有的 OAuth 令牌（装过 wrangler 并登录过的机器会自动复用）

   都没有时才会回退到 `wrangler` CLI（那条路才需要 `wrangler login`）。

5. 重启服务器。控制台出现：

```
[AutoPack] 服务器已启动，5 秒后开始构建…
[AutoPack] Modrinth 解析：命中 220 / 未发布 58 / 缓存 0
[AutoPack] 构建完成：287 个文件（镜像 220 / 自托管 67），共 1.6 GiB
[AutoPack] 站点资源 81 个，共 392 MiB
[AutoPack] 部署完成：https://xxxx.yunmengyuan-pack.pages.dev
[AutoPack] 线上校验通过
```

### 2.2 触发方式

| 方式 | 说明 |
| --- | --- |
| 开服自动 | `pages.autoBuild: true`（默认） |
| 手动 | 在服务器目录建空文件 `autopack/trigger`，5 秒内自动执行并删除 |
| 定时 | `pages.intervalMinutes: 30`（0 = 关闭） |
| 只构建不发布 | `pages.autoPublish: false`，产物在 `autopack/out/site` |

### 2.3 配置字段（`config/autopack.json`）

```json
{
  "enabled": true,
  "pack": { "id": "yunmengyuan", "name": "云梦缘 2.0" },
  "game": { "minecraft": "1.21.1", "loader": "neoforge", "loaderVersion": "21.1.265" },
  "paths": { "outDir": "autopack/out", "stateDir": "autopack/state" },
  "scopes": [ ... ],
  "requiredModIds": ["sodium"],
  "mirror": { "enabled": true, "baseUrl": "https://mod.mcimirror.top" },
  "pages": { "project": "...", "branch": "main", "apiToken": "", "autoBuild": true, "autoPublish": true,
             "retainVersions": 1, "intervalMinutes": 0 }
}
```

`scopes` 决定更新范围（见第 3 节）。`paths` 都相对服务器目录（也可写绝对路径）。

> 服务端 mod 会**跳过自己**（`mods/AutoPack-*.jar` 不进清单），并且只在**专用服务端**运行（客户端环境自动跳过）。

---

## 3. 自定义更新范围

```json
"scopes": [
  { "id": "mods", "kind": "mods", "source": "mods", "target": "mods", "role": "required" },

  { "id": "client-mods", "kind": "mods", "source": "mods_disabled_client", "target": "mods",
    "role": "optional", "include": ["*sodium*", "iris-*", "emi-*"] },

  { "id": "kubejs", "kind": "files", "source": "kubejs", "target": "kubejs", "role": "content",
    "exclude": ["**/cache/**"] },

  { "id": "config", "kind": "files", "source": "config", "target": "config", "role": "content",
    "enabled": false, "include": ["config/xxx/**"] }
]
```

- `source`：相对服务器目录或绝对路径；`target`：**客户端游戏目录里的相对路径**
- `kind: mods` 只收 `.jar` 并读元数据；`kind: files` 收任意文件
- `include` / `exclude` 支持 `*`、`**`、`?`，`exclude` 优先
- 单个 scope 可关镜像：`"mirror": { "enabled": false }`（大文件走自托管）

### 必须安装的 mod

```json
"requiredModIds": ["sodium", "iris"]
```

构建时校验这些 modId 是否真的在范围内（不在就报错，避免“以为要求了其实没发”）；客户端更新后会扫描本地 modId，缺哪个就标红提示。

### 客户端“多余 mod 不删”的规则

- 只处理**清单里的文件**和 `.autopack/state.json` 记录过的文件
- 玩家自装、modId 完全不在清单里的 jar：**永远保留**
- 同一 modId 的旧版本 jar：**替换**，旧文件进 `.autopack/backup/<时间戳>/`
- 被移除的受管文件默认也进备份，不硬删

---

## 4. 镜像策略

| 原站 | 镜像 |
| --- | --- |
| `cdn.modrinth.com` | `https://mod.mcimirror.top` |
| `api.modrinth.com` | `https://mod.mcimirror.top/modrinth` |
| `api.curseforge.com` | `https://mod.mcimirror.top/curseforge` |
| `edge.forgecdn.net` / `mediafilez.forgecdn.net` | `https://mod.mcimirror.top` |

- 已发布 mod：用文件 **SHA-1** 调 `mod.mcimirror.top/modrinth/v2/version_file/<sha1>?algorithm=sha1` 反查，直接拿镜像 CDN 直链；清单里保留官方源作 `fallbacks`，镜像挂了自动回退。
- 未发布 / 私发 mod：查不到就自托管到 Pages（当网盘）。
- **MCIM 只缓存 ≤20MB 的文件**，超出可能 404 → 客户端回退官方源；下载慢就关掉该 scope 的镜像。
- 版权页 `catalog`：每个 mod 的 modId、版本、作者、许可、简介、源站链接、镜像 API 链接、下载直链。**不改写 jar 内文本**（改 jar 会破坏哈希并翻倍占 Pages）。

---

## 5. Cloudflare Pages 免费额度

| 限制 | 免费版 | 本项目的处理 |
| --- | --- | --- |
| 单文件 | **25 MiB** | 超过 `pages.maxAssetBytes`（默认 24MiB）自动切片，客户端合并后校验 SHA-256 |
| 站点文件数 | **20,000** | 构建时统计，超限直接报错 |
| 部署次数 | **500 次/月** | 先读线上 `latest.json`，`contentHash` 相同直接跳过 |
| 带宽 | 不计 | 已发布 mod 走镜像直链，Pages 只承担自托管文件 |

> 自托管内容几十 GB 时建议改用 R2（10GB 免费、无 25MiB 限制），本项目暂未实现，`source.kind` 已预留。

---

## 6. 客户端

1. 把 `AutoPackClient.exe` 放进玩家游戏目录（和 `mods/` 同级）。
2. 旁边放 `autopack.json`（省得玩家填地址）：

```json
{ "baseUrl": "https://yunmengyuan-pack.pages.dev", "launcher": "D:\\PCL\\Plain Craft Launcher.exe" }
```

3. 双击 → 浏览器打开界面 → 检查 → 开始更新。也可以命令行：

```powershell
AutoPackClient.exe --console --update
```

数据目录 `<游戏目录>/.autopack/`：`state.json`（已装文件）、`staging/`（暂存）、`backup/`（备份）、`mods-index.json`（modId 缓存）。
落位均为“临时文件 + 重命名”；文件被游戏占用会提示关游戏；磁盘不足整批拒绝；断点复用已校验的暂存文件。

下载默认 **64 线程**并行（同一份内容只下一次）。要改线程数：`AutoPackClient.exe --threads 32`，或写进 `.autopack/client.json` 的 `downloadConcurrency`。

---

## 7. 构建

```powershell
# 服务端 jar（javac 21，不依赖 Gradle；需服务器目录里的 libraries）
node tools/build-server-jar.mjs "D:/dd/云梦缘服务端"

# 客户端 exe（esbuild + Node SEA）
npm install
node tools/build-exe.mjs          # 两个 exe
node tools/build-exe.mjs client   # 只打客户端
```

jar 与 exe 都直接生成在项目根目录。exe 未签名，首次运行可能被 SmartScreen 拦，选择“仍要运行”。

---

## 8. 可选：不装 mod，用命令行构建器

同一套逻辑的 Node 版，适合本机调试、预览站点、或不想在服务器里跑构建的场景：

```powershell
node src/builder/cli.mjs build      # 读 config/pack.json，生成 dist/site
node src/builder/cli.mjs serve      # 本地预览 http://127.0.0.1:8788
node src/builder/cli.mjs login      # wrangler 登录
node src/builder/cli.mjs publish    # 发布
node src/builder/cli.mjs doctor     # 检查配置/镜像/登录
```

或直接用根目录的 `AutoPackBuilder.exe`。它与 jar 共用同一份配置字段和清单格式。

---

## 9. 常见问题

**Q：服务器没有 Node / wrangler 怎么办？**
不需要。默认走原生 Cloudflare API 直传（Java 内置 BLAKE3 与分片上传），只要一个令牌：配置 `pages.apiToken` 或环境变量 `CLOUDFLARE_API_TOKEN`。只有令牌失效时才会回退到 wrangler。

**Q：改了域名/项目名？**
`pages.baseUrl` 会写进清单和下载直链，改完必须重新构建发布。

**Q：构建很慢？**
首次要对所有 jar 做 SHA-1/SHA-256 并查镜像；之后 `autopack/state/resolve-cache.json` 缓存查询结果。224 个 mod 首次约 1~3 分钟（取决于网络），之后几十秒。

**Q：能同时用 jar 和 Node 构建器吗？**
可以，但 `contentHash` 算法略有差异，切换时会多发布一版。建议只用一个。

---

## 10. 开发与测试

```powershell
node --test test/*.test.mjs     # 单元 + 端到端（本地静态服务器模拟 Pages，不联网）
```

覆盖：TOML/ZIP 解析、镜像 URL 映射、glob、构建清单、首次同步、幂等、自装 mod 保留、同 modId 替换、增量更新、分片合并、requiredModIds、路径冲突。

协议细节见 [docs/protocol.md](docs/protocol.md)。

---

## 11. 发布到 GitHub

仓库已经初始化并提交（单文件 exe 87MB，jar 77KB，都在根目录）。首次推送：

```powershell
git remote add origin https://github.com/<你的用户名>/AutoPack.git
git push -u origin main
```

注意事项：

- GitHub **单文件硬上限 100MB**：`AutoPackClient.exe` 87.3MB、`AutoPackBuilder.exe` 87.3MB，刚好能推，但速度取决于上行带宽。
- 不想把二进制放进 git 历史，可以改用 **Git LFS**：

  ```powershell
  git lfs install
  git lfs track "*.exe" "*.jar"
  git add .gitattributes
  git commit -m "chore: 用 LFS 管理二进制"
  ```

- 也可以只在 GitHub Releases 上传 exe/jar，仓库里放 `.gitignore` 忽略它们（把 `*.exe`、`*.jar` 加进忽略列表，并删除已跟踪的）。
- 打包分发包（含源码与二进制，不含 `.git`）：`git archive --format=zip HEAD -o AutoPack-0.1.0.zip`。
