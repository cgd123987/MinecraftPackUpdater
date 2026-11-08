package com.autopack;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.List;

/** 版权页：把每个 mod 的元数据与 Modrinth/CurseForge 链接整理成 JSON + HTML。 */
public final class Catalog {
    private Catalog() {}

    public static JsonObject build(JsonObject manifest, List<JsonObject> files, int mirrored, int hosted) {
        JsonArray mods = new JsonArray();
        for (JsonObject f : files) {
            JsonArray infos = f.getAsJsonArray("mods");
            if (infos == null || infos.size() == 0) {
                JsonObject info = new JsonObject();
                info.addProperty("modId", (String) null);
                info.addProperty("name", fileName(JsonUtil.str(f, "path", "")));
                info.addProperty("version", (String) null);
                mods.add(toCatalogEntry(f, info));
            } else {
                for (var e : infos) mods.add(toCatalogEntry(f, e.getAsJsonObject()));
            }
        }
        JsonObject c = new JsonObject();
        c.addProperty("schema", 1);
        c.addProperty("packId", JsonUtil.str(manifest, "packId", ""));
        c.addProperty("packName", JsonUtil.str(manifest, "packName", ""));
        c.addProperty("version", JsonUtil.str(manifest, "version", ""));
        c.addProperty("publishedAt", JsonUtil.str(manifest, "publishedAt", ""));
        c.add("game", JsonUtil.obj(manifest, "game"));
        JsonObject counts = new JsonObject();
        counts.addProperty("mods", mods.size());
        counts.addProperty("files", files.size());
        counts.addProperty("mirrored", mirrored);
        counts.addProperty("selfHosted", hosted);
        c.add("counts", counts);
        c.add("mods", mods);
        return c;
    }

    private static JsonObject toCatalogEntry(JsonObject file, JsonObject info) {
        JsonObject src = JsonUtil.obj(file, "source");
        JsonObject o = new JsonObject();
        o.addProperty("modId", JsonUtil.str(info, "modId", null));
        o.addProperty("name", JsonUtil.str(info, "name", fileName(JsonUtil.str(file, "path", ""))));
        o.addProperty("version", JsonUtil.str(info, "version", null));
        o.addProperty("authors", JsonUtil.str(info, "authors", null));
        o.addProperty("license", JsonUtil.str(info, "license", null));
        o.addProperty("description", JsonUtil.str(info, "description", null));
        o.addProperty("file", JsonUtil.str(file, "path", ""));
        o.addProperty("role", JsonUtil.str(file, "role", ""));
        o.addProperty("size", JsonUtil.num(file, "size", 0));
        o.addProperty("sha1", JsonUtil.str(file, "sha1", ""));
        o.addProperty("sha256", JsonUtil.str(file, "sha256", ""));
        JsonArray links = new JsonArray();
        JsonArray in = info.has("links") ? info.getAsJsonArray("links") : new JsonArray();
        for (var e : in) {
            JsonObject l = e.getAsJsonObject();
            String kind = JsonUtil.str(l, "kind", "");
            String url = JsonUtil.str(l, "url", "");
            JsonObject lo = new JsonObject();
            lo.addProperty("kind", kind);
            lo.addProperty("label", label(kind));
            lo.addProperty("url", url);
            lo.addProperty("mirrorUrl", Mirror.projectMirror(kind, url, Mirror.DEFAULT_BASE));
            links.add(lo);
        }
        o.add("links", links);
        JsonObject s = new JsonObject();
        s.addProperty("kind", JsonUtil.str(src, "kind", ""));
        s.addProperty("url", JsonUtil.str(src, "url", ""));
        s.addProperty("provider", JsonUtil.str(src, "provider", "self"));
        s.addProperty("projectId", JsonUtil.str(src, "projectId", null));
        s.addProperty("versionNumber", JsonUtil.str(src, "versionNumber", null));
        o.add("source", s);
        return o;
    }

    private static String label(String kind) {
        return switch (kind) {
            case "modrinth" -> "Modrinth";
            case "curseforge" -> "CurseForge";
            case "github" -> "GitHub";
            case "discord" -> "Discord";
            default -> "主页";
        };
    }

    private static String fileName(String path) {
        int i = path.lastIndexOf('/');
        return i >= 0 ? path.substring(i + 1) : path;
    }

    // ---------- HTML ----------

    public static String html(JsonObject catalog, Config cfg) {
        String packName = JsonUtil.str(catalog, "packName", "");
        JsonObject game = JsonUtil.obj(catalog, "game");
        JsonObject counts = JsonUtil.obj(catalog, "counts");
        StringBuilder rows = new StringBuilder();
        for (var e : catalog.getAsJsonArray("mods")) {
            JsonObject m = e.getAsJsonObject();
            String name = JsonUtil.str(m, "name", "");
            String modId = JsonUtil.str(m, "modId", "");
            String ver = JsonUtil.str(m, "version", "");
            String search = (name + " " + modId + " " + JsonUtil.str(m, "authors", "") + " " + ver).toLowerCase();
            StringBuilder links = new StringBuilder();
            for (var le : m.getAsJsonArray("links")) {
                JsonObject l = le.getAsJsonObject();
                links.append("<a href=\"").append(esc(JsonUtil.str(l, "url", ""))).append("\" target=\"_blank\" rel=\"noreferrer\">")
                        .append(esc(JsonUtil.str(l, "label", ""))).append("</a>");
                String mirror = JsonUtil.str(l, "mirrorUrl", null);
                if (mirror != null && !mirror.isEmpty()) {
                    links.append("<a class=\"mirror\" href=\"").append(esc(mirror)).append("\" target=\"_blank\" rel=\"noreferrer\">")
                            .append(esc(JsonUtil.str(l, "label", ""))).append(" 镜像</a>");
                }
            }
            JsonObject src = JsonUtil.obj(m, "source");
            boolean self = "pages".equals(JsonUtil.str(src, "kind", ""));
            rows.append("<tr data-search=\"").append(esc(search)).append("\">")
                    .append("<td><div class=\"name\">").append(esc(name)).append("</div><div class=\"sub\">")
                    .append(esc(modId)).append(ver.isEmpty() ? "" : " · " + esc(ver)).append("</div></td>")
                    .append("<td class=\"desc\">").append(esc(JsonUtil.str(m, "description", ""))).append("</td>")
                    .append("<td>").append(esc(JsonUtil.str(m, "authors", "")))
                    .append("<div class=\"sub\">").append(esc(JsonUtil.str(m, "license", ""))).append("</div></td>")
                    .append("<td class=\"file\"><div class=\"mono\">").append(esc(JsonUtil.str(m, "file", ""))).append("</div><div class=\"sub\">")
                    .append(human(JsonUtil.num(m, "size", 0))).append(" · ").append(self ? "自托管" : "Modrinth").append("</div></td>")
                    .append("<td class=\"links\">").append(links).append("</td>")
                    .append("<td class=\"actions\"><a class=\"dl\" href=\"").append(esc(JsonUtil.str(src, "url", ""))).append("\">")
                    .append(self ? "本站下载" : "镜像下载").append("</a></td></tr>\n");
        }

        return "<!DOCTYPE html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>" + esc(packName) + " · 模组版权页</title><style>"
                + ":root{--bg:#0f1117;--card:#171a22;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--accent:#5aa9ff;--green:#4ade80}"
                + "*{box-sizing:border-box}"
                + "body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,\"Segoe UI\",\"Microsoft YaHei\",sans-serif}"
                + "header{padding:28px 20px 16px;max-width:1280px;margin:0 auto}h1{margin:0 0 4px;font-size:22px}"
                + ".meta{color:var(--dim);font-size:13px}.stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;color:var(--dim);font-size:13px}"
                + ".stats b{color:var(--fg)}.toolbar{max-width:1280px;margin:0 auto;padding:0 20px 12px}"
                + "input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:14px;outline:none}"
                + "input:focus{border-color:var(--accent)}main{max-width:1280px;margin:0 auto;padding:0 20px 60px}"
                + "table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}"
                + "th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}"
                + "th{font-size:12px;color:var(--dim);font-weight:600;position:sticky;top:0;background:#1b1f29}"
                + "tr:last-child td{border-bottom:0}tr:hover td{background:#1b1f29}.name{font-weight:600}"
                + ".sub{color:var(--dim);font-size:12px;margin-top:2px}.desc{color:#c3c9d6;max-width:340px}"
                + ".mono,.file{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}"
                + ".links a{display:inline-block;margin:0 8px 4px 0;color:var(--accent);text-decoration:none;font-size:12px}"
                + ".links a.mirror{color:var(--green)}.links a:hover{text-decoration:underline}"
                + ".actions a.dl{display:inline-block;padding:6px 10px;border-radius:6px;background:#1e3a5f;color:#9ecbff;text-decoration:none;font-size:12px;white-space:nowrap}"
                + ".actions a.dl:hover{background:#24486f}footer{max-width:1280px;margin:0 auto;padding:0 20px 40px;color:var(--dim);font-size:12px}"
                + "@media(max-width:820px){.desc,.file{display:none}}"
                + "</style></head><body><header><h1>" + esc(packName) + " · 模组版权页</h1>"
                + "<div class=\"meta\">整合包版本 <b>" + esc(JsonUtil.str(catalog, "version", "")) + "</b> · 发布于 "
                + esc(JsonUtil.str(catalog, "publishedAt", "")) + " · Minecraft " + esc(JsonUtil.str(game, "minecraft", ""))
                + " / " + esc(JsonUtil.str(game, "loader", "")) + " " + esc(JsonUtil.str(game, "loaderVersion", "")) + "</div>"
                + "<div class=\"stats\"><span>模组 <b>" + JsonUtil.num(counts, "mods", 0) + "</b></span>"
                + "<span>镜像直链 <b>" + JsonUtil.num(counts, "mirrored", 0) + "</b></span>"
                + "<span>本站托管 <b>" + JsonUtil.num(counts, "selfHosted", 0) + "</b></span></div></header>"
                + "<div class=\"toolbar\"><input id=\"q\" placeholder=\"搜索模组名 / modid / 作者…\"></div><main><table>"
                + "<thead><tr><th>模组</th><th>简介</th><th>作者 / 许可</th><th>文件</th><th>源站链接</th><th>下载</th></tr></thead>"
                + "<tbody>" + rows + "</tbody></table></main>"
                + "<footer>链接来自各 mod jar 内 META-INF/neoforge.mods.toml 的版权信息；下载直链已替换为 MCIM 镜像（mod.mcimirror.top）。"
                + "镜像未收录或超过 20MB 的文件回退官方源，本站自托管文件不经过第三方。</footer>"
                + "<script>const q=document.getElementById('q');q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();"
                + "for(const tr of document.querySelectorAll('tbody tr')){tr.style.display=(!v||tr.dataset.search.includes(v))?'':'none'}});</script>"
                + "</body></html>";
    }

    public static String index(JsonObject catalog) {
        String packName = JsonUtil.str(catalog, "packName", "整合包");
        JsonObject game = JsonUtil.obj(catalog, "game");
        return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + esc(packName) + "</title>"
                + "<style>body{margin:0;background:#0f1117;color:#e6e9ef;font:15px/1.7 system-ui,\"Segoe UI\",\"Microsoft YaHei\",sans-serif}"
                + "main{max-width:760px;margin:0 auto;padding:60px 20px}h1{font-size:26px;margin:0 0 8px}.dim{color:#8b93a7}"
                + "a{color:#5aa9ff}.card{background:#171a22;border:1px solid #262b36;border-radius:12px;padding:20px;margin-top:20px}"
                + "code{background:#0b0d12;padding:2px 6px;border-radius:4px;font-size:13px}</style></head><body><main>"
                + "<h1>" + esc(packName) + "</h1><div class=\"dim\">Minecraft " + esc(JsonUtil.str(game, "minecraft", ""))
                + " · " + esc(JsonUtil.str(game, "loader", "")) + " " + esc(JsonUtil.str(game, "loaderVersion", ""))
                + " · 版本 " + esc(JsonUtil.str(catalog, "version", "")) + "</div>"
                + "<div class=\"card\"><p>本页是整合包的更新源，玩家请使用 <b>AutoPackClient.exe</b> 更新。</p>"
                + "<p><a href=\"catalog\">→ 模组版权页 / 下载列表</a></p>"
                + "<p class=\"dim\">客户端读取的接口：<code>latest.json</code> · <code>packs/"
                + esc(JsonUtil.str(catalog, "version", "")) + "/manifest.json</code></p></div></main></body></html>";
    }

    private static String human(long n) {
        String[] u = {"B", "KiB", "MiB", "GiB"};
        double v = n;
        int i = 0;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return String.format(java.util.Locale.ROOT, v >= 10 || i == 0 ? "%.0f %s" : "%.1f %s", v, u[i]);
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }
}
