package com.autopack;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
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
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 原生 Cloudflare Pages 直传：不依赖 wrangler，也不需要浏览器登录。
 * 认证优先级：pages.apiToken → 环境变量 CLOUDFLARE_API_TOKEN → 本机 wrangler 已保存的 OAuth 令牌。
 */
public final class PagesUploader {
    private static final String API = "https://api.cloudflare.com/client/v4";
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .version(HttpClient.Version.HTTP_1_1)
            .build();

    static final class AuthException extends IOException {
        AuthException(String msg) { super(msg); }
    }

    private final Config cfg;
    private final String token;
    private String accountId;
    private String jwt;

    public PagesUploader(Config cfg) throws IOException {
        this.cfg = cfg;
        this.token = resolveToken();
        if (this.token == null) {
            throw new AuthException("没有可用的 Cloudflare 令牌：请在配置里填 pages.apiToken，或设置环境变量 CLOUDFLARE_API_TOKEN");
        }
    }

    /** 按优先级找令牌；最后读取 wrangler 的登录态，避免要求用户再登录一次。 */
    private String resolveToken() {
        if (cfg.pagesApiToken != null && !cfg.pagesApiToken.isEmpty()) return cfg.pagesApiToken;
        String env = System.getenv("CLOUDFLARE_API_TOKEN");
        if (env != null && !env.isEmpty()) return env;
        return readWranglerToken();
    }

    private static String readWranglerToken() {
        try {
            String home = System.getProperty("user.home");
            Path p = Path.of(home, ".wrangler", "config", "default.toml");
            if (!Files.isRegularFile(p)) return null;
            String text = Files.readString(p, StandardCharsets.UTF_8);
            var m = java.util.regex.Pattern.compile("oauth_token\\s*=\\s*\"([^\"]+)\"").matcher(text);
            return m.find() ? m.group(1) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 返回本次部署的线上地址。 */
    public String publish(Path siteDir) throws IOException, InterruptedException {
        if (!Files.isDirectory(siteDir)) throw new IOException("站点目录不存在: " + siteDir);
        ensureAccount();
        ensureProject();

        JsonObject tokenResp = api("GET", "/accounts/" + accountId + "/pages/projects/" + cfg.pagesProject + "/upload-token", null);
        jwt = JsonUtil.str(tokenResp, "jwt", "");
        if (jwt.isEmpty()) throw new IOException("获取 Pages upload-token 失败");

        List<Asset> assets = collect(siteDir);
        if (assets.isEmpty()) throw new IOException("站点目录为空");
        if (assets.size() > 20000) throw new IOException("站点文件 " + assets.size() + " 个，超过 Pages 免费版 20,000 上限");
        Log.info("站点资源 " + assets.size() + " 个，共 " + Builder.human(assets.stream().mapToLong(a -> a.size).sum()));

        List<String> hashes = new ArrayList<>();
        for (Asset a : assets) hashes.add(a.hash);

        JsonArray missing = missingHashesRequest(hashes);
        List<String> missingHashes = new ArrayList<>();
        for (JsonElement e : missing) missingHashes.add(e.getAsString());
        Log.info("已有 " + (assets.size() - missingHashes.size()) + " 个，需上传 " + missingHashes.size() + " 个");

        if (!missingHashes.isEmpty()) uploadMissing(assets, missingHashes);
        request("POST", "/pages/assets/upsert-hashes", bodyOfHashes(hashes), jwt);

        JsonObject manifestObj = new JsonObject();
        for (Asset a : assets) manifestObj.addProperty("/" + a.path, a.hash);
        JsonObject deployment = deploy(manifestObj);
        String url = JsonUtil.str(deployment, "url", "");
        Log.ok("部署完成：" + (url.isEmpty() ? cfg.pagesBaseUrl : url));
        return url;
    }

    /** 部署接口要 multipart/form-data（manifest 是 JSON 字符串），不是 JSON body。 */
    private JsonObject deploy(JsonObject manifest) throws IOException, InterruptedException {
        IOException last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            try {
                return deployOnce(manifest);
            } catch (IOException e) {
                last = e;
                Log.warn("部署请求失败（第 " + (attempt + 1) + " 次）：" + e.getMessage());
                Thread.sleep(1500L * (attempt + 1));
            }
        }
        throw last;
    }

    private JsonObject deployOnce(JsonObject manifest) throws IOException, InterruptedException {
        String boundary = "----AutoPackBoundary" + System.currentTimeMillis();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        writeField(out, boundary, "manifest", JsonUtil.GSON.toJson(manifest));
        writeField(out, boundary, "branch", cfg.pagesBranch);
        writeField(out, boundary, "commit_message", "AutoPack " + cfg.packId);
        writeField(out, boundary, "commit_dirty", "true");
        out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

        HttpRequest req = HttpRequest.newBuilder(URI.create(API + "/accounts/" + accountId
                        + "/pages/projects/" + cfg.pagesProject + "/deployments"))
                .timeout(Duration.ofMinutes(5))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .header("User-Agent", cfg.userAgent)
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()))
                .build();
        HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonObject json;
        try { json = JsonUtil.parse(res.body()); }
        catch (Exception e) { throw new IOException("部署接口返回非 JSON（HTTP " + res.statusCode() + "）: " + res.body()); }
        if (res.statusCode() == 401 || res.statusCode() == 403) {
            throw new AuthException("Cloudflare 认证失败（HTTP " + res.statusCode() + "）: " + firstError(json));
        }
        if (!JsonUtil.bool(json, "success", false)) {
            throw new IOException("部署失败（HTTP " + res.statusCode() + "）: " + firstError(json));
        }
        return json.getAsJsonObject("result");
    }

    private static void writeField(java.io.ByteArrayOutputStream out, String boundary, String name, String value) throws IOException {
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private void uploadMissing(List<Asset> assets, List<String> missing) throws IOException, InterruptedException {
        Map<String, Asset> byHash = new LinkedHashMap<>();
        for (Asset a : assets) byHash.put(a.hash, a);
        List<Asset> queue = new ArrayList<>();
        for (String h : missing) if (byHash.containsKey(h)) queue.add(byHash.get(h));

        final long bucketLimit = 30L * 1024 * 1024;
        final int countLimit = 500;
        int index = 0;
        while (index < queue.size()) {
            List<Asset> bucket = new ArrayList<>();
            long size = 0;
            while (index < queue.size() && bucket.size() < countLimit) {
                Asset a = queue.get(index);
                if (!bucket.isEmpty() && size + a.size > bucketLimit) break;
                bucket.add(a);
                size += a.size;
                index++;
            }
            JsonArray payload = new JsonArray();
            for (Asset a : bucket) {
                JsonObject item = new JsonObject();
                item.addProperty("key", a.hash);
                item.addProperty("value", Base64.getEncoder().encodeToString(Files.readAllBytes(a.file)));
                JsonObject meta = new JsonObject();
                meta.addProperty("contentType", a.contentType);
                item.add("metadata", meta);
                item.addProperty("base64", true);
                payload.add(item);
            }
            requestWithRetry("POST", "/pages/assets/upload", payload, jwt, 3);
            Log.info("已上传 " + Math.min(index, queue.size()) + "/" + queue.size() + " 个资源");
        }
    }

    private List<Asset> collect(Path siteDir) throws IOException {
        List<Asset> assets = new ArrayList<>();
        List<Path> files;
        try (Stream<Path> walk = Files.walk(siteDir)) {
            files = walk.filter(Files::isRegularFile).sorted().toList();
        }
        for (Path p : files) {
            long size = Files.size(p);
            if (size > 25L * 1024 * 1024) throw new IOException("文件超过 Pages 单文件 25MiB 限制: " + p);
            String rel = siteDir.relativize(p).toString().replace('\\', '/');
            String ext = extension(rel);
            byte[] b64 = Base64.getEncoder().encode(Files.readAllBytes(p));
            byte[] input = new byte[b64.length + ext.length()];
            System.arraycopy(b64, 0, input, 0, b64.length);
            System.arraycopy(ext.getBytes(StandardCharsets.UTF_8), 0, input, b64.length, ext.length());
            String hash = Blake3.hexPrefix(Blake3.hash(input), 32);
            assets.add(new Asset(rel, hash, size, contentType(rel), p));
        }
        return assets;
    }

    private record Asset(String path, String hash, long size, String contentType, Path file) {}

    private static String extension(String path) {
        int slash = path.lastIndexOf('/');
        int dot = path.lastIndexOf('.');
        if (dot <= slash) return "";
        return path.substring(dot + 1).toLowerCase().replaceAll("[^a-z0-9]", "");
    }

    private static String contentType(String path) {
        String ext = extension(path);
        return switch (ext) {
            case "json" -> "application/json";
            case "html" -> "text/html; charset=utf-8";
            case "css" -> "text/css; charset=utf-8";
            case "js" -> "text/javascript; charset=utf-8";
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "webp" -> "image/webp";
            case "jar" -> "application/java-archive";
            case "zip" -> "application/zip";
            case "txt", "toml", "md", "properties", "kubejs", "snbt" -> "text/plain; charset=utf-8";
            default -> "application/octet-stream";
        };
    }

    // ---------- HTTP ----------

    private void ensureAccount() throws IOException, InterruptedException {
        if (cfg.pagesAccountId != null && !cfg.pagesAccountId.isEmpty()) { accountId = cfg.pagesAccountId; return; }
        String env = System.getenv("CLOUDFLARE_ACCOUNT_ID");
        if (env != null && !env.isEmpty()) { accountId = env; return; }
        JsonArray accounts = apiArray("GET", "/accounts", null);
        if (accounts.size() == 0) throw new IOException("该令牌下没有可用的 Cloudflare 账号");
        accountId = JsonUtil.str(accounts.get(0).getAsJsonObject(), "id", "");
    }

    private void ensureProject() throws IOException, InterruptedException {
        if (projectExists()) return;
        Log.warn("Pages 项目不存在，尝试创建：" + cfg.pagesProject);
        JsonObject body = new JsonObject();
        body.addProperty("name", cfg.pagesProject);
        body.addProperty("production_branch", cfg.pagesBranch);
        try {
            api("POST", "/accounts/" + accountId + "/pages/projects", body);
        } catch (IOException e) {
            // 刚创建过/并发创建时可能报已存在
            if (!projectExists()) throw e;
        }
        Log.ok("已创建 Pages 项目：" + cfg.pagesProject);
        for (int i = 0; i < 15; i++) {
            if (projectExists()) return;
            Thread.sleep(1500);
        }
        throw new IOException("项目创建后仍不可见（可能仍在初始化），请稍后重试：" + cfg.pagesProject);
    }

    private boolean projectExists() {
        try {
            api("GET", "/accounts/" + accountId + "/pages/projects/" + cfg.pagesProject, null);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private JsonObject api(String method, String path, JsonObject body) throws IOException, InterruptedException {
        JsonElement result = request(method, path, body, token);
        return result == null ? new JsonObject() : result.getAsJsonObject();
    }

    private JsonArray apiArray(String method, String path, JsonObject body) throws IOException, InterruptedException {
        JsonElement result = request(method, path, body, token);
        return result == null ? new JsonArray() : result.getAsJsonArray();
    }

    private JsonArray missingHashesRequest(List<String> hashes) throws IOException, InterruptedException {
        JsonElement result = request("POST", "/pages/assets/check-missing", bodyOfHashes(hashes), jwt);
        if (result == null) return new JsonArray();
        if (result.isJsonArray()) return result.getAsJsonArray();
        // 有的账号/版本会返回 {missing:[...]} 结构
        if (result.isJsonObject() && result.getAsJsonObject().has("missing")) {
            return result.getAsJsonObject().getAsJsonArray("missing");
        }
        return new JsonArray();
    }

    private JsonElement requestWithRetry(String method, String path, JsonElement body, String bearer, int attempts) throws IOException, InterruptedException {
        IOException last = null;
        for (int i = 0; i < attempts; i++) {
            try {
                return request(method, path, body, bearer);
            } catch (AuthException e) {
                throw e;
            } catch (IOException e) {
                last = e;
                Log.warn("请求 " + path + " 失败（" + (i + 1) + "/" + attempts + "）：" + e.getMessage());
                Thread.sleep(1000L * (i + 1));
            }
        }
        throw last;
    }

    private JsonElement request(String method, String path, JsonElement body, String bearer) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(API + path))
                .timeout(Duration.ofMinutes(5))
                .header("Authorization", "Bearer " + bearer)
                .header("User-Agent", cfg.userAgent);
        if (body != null) {
            b.header("Content-Type", "application/json");
            b.method(method, HttpRequest.BodyPublishers.ofString(JsonUtil.GSON.toJson(body), StandardCharsets.UTF_8));
        } else {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        }
        HttpResponse<String> res = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonObject json;
        try { json = JsonUtil.parse(res.body()); }
        catch (Exception e) { throw new IOException("接口返回非 JSON（HTTP " + res.statusCode() + "）: " + res.body()); }
        if (res.statusCode() == 401 || res.statusCode() == 403) {
            throw new AuthException("Cloudflare 认证失败（HTTP " + res.statusCode() + "）: " + firstError(json));
        }
        if (!JsonUtil.bool(json, "success", false)) {
            throw new IOException("接口失败（HTTP " + res.statusCode() + "）: " + firstError(json));
        }
        return json.get("result");
    }

    private static String firstError(JsonObject json) {
        try {
            JsonArray errors = json.getAsJsonArray("errors");
            if (errors != null && errors.size() > 0) {
                JsonObject e = errors.get(0).getAsJsonObject();
                return JsonUtil.str(e, "message", "") + " (code " + JsonUtil.num(e, "code", 0) + ")";
            }
        } catch (Exception ignored) {}
        return "";
    }

    private static JsonObject bodyOfHashes(List<String> hashes) {
        JsonObject o = new JsonObject();
        o.add("hashes", JsonUtil.arr(hashes));
        return o;
    }
}
