package com.autopack;

import com.google.gson.JsonObject;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** 用文件 SHA-1 经 MCIM 镜像反查 Modrinth 版本，得到镜像下载直链。 */
public final class Resolver {
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .version(HttpClient.Version.HTTP_1_1)
            .build();
    private final Config cfg;
    private final Map<String, JsonObject> cache = new LinkedHashMap<>();
    private final Path cachePath;
    private boolean dirty;
    public int hits, misses, cachedHits;

    public Resolver(Config cfg) {
        this.cfg = cfg;
        this.cachePath = cfg.stateDir.resolve("resolve-cache.json");
        try {
            if (Files.isRegularFile(cachePath)) {
                JsonObject root = JsonUtil.parse(Files.readString(cachePath, StandardCharsets.UTF_8));
                for (String k : root.keySet()) {
                    if (root.get(k).isJsonObject()) cache.put(k, root.getAsJsonObject(k));
                }
            }
        } catch (Exception ignored) {}
    }

    /** 返回 null 表示未在 Modrinth 找到（按自托管处理）。 */
    public JsonObject resolve(String sha1) {
        if (cache.containsKey(sha1)) {
            cachedHits++;
            JsonObject o = cache.get(sha1);
            return o.size() == 0 ? null : o;
        }
        JsonObject result = null;
        try { result = lookup(sha1); }
        catch (Exception e) { Log.warn("Modrinth 查询失败 " + sha1 + ": " + e.getMessage()); }
        cache.put(sha1, result == null ? new JsonObject() : result);
        dirty = true;
        if (result != null) hits++; else misses++;
        return result == null || result.size() == 0 ? null : result;
    }

    private JsonObject lookup(String sha1) throws IOException, InterruptedException {
        String url = cfg.mirrorBase + "/modrinth/v2/version_file/" + sha1 + "?algorithm=sha1";
        HttpResponse<String> res = get(url);
        if (res.statusCode() == 404) return null;
        if (res.statusCode() != 200) throw new IOException("HTTP " + res.statusCode());
        JsonObject version = JsonUtil.parse(res.body());

        String projectId = JsonUtil.str(version, "project_id", "");
        String official = null;
        if (version.has("files") && version.getAsJsonArray("files").size() > 0) {
            for (var el : version.getAsJsonArray("files")) {
                JsonObject f = el.getAsJsonObject();
                String fsha = JsonUtil.str(JsonUtil.obj(f, "hashes"), "sha1", "");
                if (fsha.equalsIgnoreCase(sha1) || official == null) {
                    official = JsonUtil.str(f, "url", null);
                    if (fsha.equalsIgnoreCase(sha1)) break;
                }
            }
        }
        if (official == null) return null;

        JsonObject out = new JsonObject();
        out.addProperty("url", Mirror.toMirror(official, cfg.mirrorBase));
        out.addProperty("officialUrl", official);
        out.addProperty("projectId", projectId);
        out.addProperty("versionNumber", JsonUtil.str(version, "version_number", ""));
        out.addProperty("projectSlug", "");
        try {
            HttpResponse<String> pr = get(cfg.mirrorBase + "/modrinth/v2/project/" + projectId);
            if (pr.statusCode() == 200) {
                JsonObject project = JsonUtil.parse(pr.body());
                out.addProperty("projectSlug", JsonUtil.str(project, "slug", ""));
            }
        } catch (Exception ignored) {}
        return out;
    }

    private HttpResponse<String> get(String url) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("User-Agent", cfg.userAgent)
                .header("Accept", "application/json")
                .GET().build();
        return http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    public void save() {
        if (!dirty) return;
        try {
            Files.createDirectories(cfg.stateDir);
            JsonObject root = new JsonObject();
            cache.forEach(root::add);
            Files.writeString(cachePath, JsonUtil.pretty(root), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.warn("保存解析缓存失败: " + e.getMessage());
        }
    }

    public String stats() {
        return "命中 " + hits + " / 未发布 " + misses + " / 缓存 " + cachedHits;
    }
}
