package com.autopack;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/** 构建主流程：扫描 → 哈希/元数据 → 镜像解析 → 清单/版权页/站点。 */
public final class Builder {
    private Builder() {}

    public record SourceFile(
            String scopeId, String kind, String role, Path abs, String rel, String target,
            long size, String sha1, String sha256, ModJar meta, JsonObject remote) {}

    public static final class Result {
        public JsonObject manifest;
        public String manifestText;
        public String manifestSha256;
        public JsonObject latest;
        public int files, mirrored, hosted, modCount, siteFiles, partCount;
        public long totalBytes;
        public String version;
        public boolean changed;
    }

    public static Result build(Config cfg) throws Exception {
        Log.info("=== 开始构建 " + cfg.packName + " (" + cfg.packId + ") ===");
        List<Config.Scope> scopes = cfg.scopes.stream().filter(s -> s.enabled).toList();
        if (scopes.isEmpty()) throw new IllegalStateException("没有启用的 scope");
        Log.info("scope: " + scopes.stream().map(s -> s.id + "(" + s.kind + ")").reduce((a, b) -> a + ", " + b).orElse(""));

        List<SourceFile> scanned = scan(cfg, scopes);
        Log.info("待处理文件 " + scanned.size() + " 个");

        List<SourceFile> entries = hashAll(cfg, scanned);
        resolveAll(cfg, scopes, entries);

        // 先清理站点目录，再准备对象与分片
        Path siteDir = cfg.outDir.resolve("site");
        deleteTree(siteDir);
        Files.createDirectories(siteDir);
        Path objectDir = cfg.stateDir.resolve("objects");
        Files.createDirectories(objectDir);
        Path partsCache = cfg.stateDir.resolve("objects-parts");
        Files.createDirectories(partsCache);

        List<JsonObject> files = new ArrayList<>();
        int mirrored = 0, hosted = 0, partCount = 0;
        long total = 0;
        for (SourceFile e : entries) {
            JsonObject f = new JsonObject();
            f.addProperty("path", e.target);
            f.addProperty("scope", e.scopeId);
            f.addProperty("role", e.role);
            f.addProperty("size", e.size);
            f.addProperty("sha1", e.sha1);
            f.addProperty("sha256", e.sha256);
            f.add("mods", modsJson(e.meta));
            if (e.remote != null) {
                mirrored++;
                JsonObject src = new JsonObject();
                src.addProperty("kind", "mirror");
                src.addProperty("url", JsonUtil.str(e.remote, "url", ""));
                src.add("fallbacks", JsonUtil.arr(List.of(JsonUtil.str(e.remote, "officialUrl", ""))));
                src.addProperty("provider", "modrinth");
                src.addProperty("projectId", JsonUtil.str(e.remote, "projectId", ""));
                src.addProperty("projectSlug", JsonUtil.str(e.remote, "projectSlug", ""));
                src.addProperty("versionNumber", JsonUtil.str(e.remote, "versionNumber", ""));
                f.add("source", src);
            } else {
                hosted++;
                String contentPath = contentPath(e.sha256, e.target);
                Path obj = objectDir.resolve(e.sha256);
                if (!Files.exists(obj)) Files.copy(e.abs, obj, StandardCopyOption.REPLACE_EXISTING);
                JsonObject src = new JsonObject();
                src.addProperty("kind", "pages");
                src.addProperty("path", contentPath);
                src.addProperty("url", cfg.siteUrl(contentPath));
                f.add("source", src);
                if (e.size > cfg.maxAssetBytes) {
                    JsonObject parts = splitParts(cfg, obj, e, partsCache, siteDir, contentPath);
                    f.add("parts", parts.getAsJsonArray("parts"));
                    partCount += parts.getAsJsonArray("parts").size();
                }
            }
            total += e.size;
            files.add(f);
        }

        // requiredModIds 校验
        Set<String> provided = new LinkedHashSet<>();
        for (JsonObject f : files) for (var m : f.getAsJsonArray("mods")) {
            String id = JsonUtil.str(m.getAsJsonObject(), "modId", null);
            if (id != null) provided.add(id);
        }
        List<String> missing = new ArrayList<>();
        for (String id : cfg.requiredModIds) if (!provided.contains(id)) missing.add(id);
        if (!missing.isEmpty()) {
            throw new IllegalStateException("requiredModIds 里的模组没有出现在更新范围中: " + missing
                    + "（把客户端专属 mod 目录也配成一个 scope）");
        }

        JsonObject prevLatest = readJson(cfg.stateDir.resolve("latest.json"));
        JsonObject prevManifest = prevLatest != null
                ? readJson(cfg.stateDir.resolve("versions").resolve(JsonUtil.str(prevLatest, "version", "")).resolve("manifest.json"))
                : null;

        String contentHash = computeContentHash(cfg, files);
        boolean changed = prevManifest == null || !contentHash.equals(JsonUtil.str(prevManifest, "contentHash", ""));
        String version;
        String publishedAt;
        if (!changed && cfg.packVersion == null) {
            version = JsonUtil.str(prevManifest, "version", "");
            publishedAt = JsonUtil.str(prevManifest, "publishedAt", now());
            Log.info("内容无变化，沿用版本 " + version);
        } else {
            version = cfg.packVersion != null ? cfg.packVersion : dateStamp() + "-" + contentHash.substring(0, 8);
            publishedAt = now();
        }

        JsonObject manifest = new JsonObject();
        manifest.addProperty("schema", 1);
        manifest.addProperty("packId", cfg.packId);
        manifest.addProperty("packName", cfg.packName);
        manifest.addProperty("version", version);
        manifest.addProperty("contentHash", contentHash);
        manifest.addProperty("publishedAt", publishedAt);
        manifest.addProperty("notes", cfg.notes);
        manifest.addProperty("baseUrl", cfg.pagesBaseUrl);
        JsonObject game = new JsonObject();
        game.addProperty("minecraft", cfg.mc);
        game.addProperty("loader", cfg.loader);
        game.addProperty("loaderVersion", cfg.loaderVersion);
        manifest.add("game", game);
        JsonObject policy = new JsonObject();
        policy.addProperty("keepUnknownMods", true);
        policy.addProperty("deleteOrphans", false);
        policy.addProperty("backupBeforeReplace", true);
        manifest.add("policy", policy);
        manifest.add("requiredModIds", JsonUtil.arr(cfg.requiredModIds));
        manifest.addProperty("chunkBytes", cfg.chunkBytes);
        JsonArray scopeArr = new JsonArray();
        for (Config.Scope s : scopes) {
            JsonObject o = new JsonObject();
            o.addProperty("id", s.id);
            o.addProperty("kind", s.kind);
            o.addProperty("dir", s.target);
            o.addProperty("role", s.role);
            scopeArr.add(o);
        }
        manifest.add("scopes", scopeArr);
        JsonArray fa = new JsonArray();
        files.forEach(fa::add);
        manifest.add("files", fa);

        String manifestText = JsonUtil.pretty(manifest);
        String manifestSha = HashUtil.sha256Hex(manifestText);

        JsonObject latest = new JsonObject();
        latest.addProperty("schema", 1);
        latest.addProperty("packId", cfg.packId);
        latest.addProperty("version", version);
        latest.addProperty("contentHash", contentHash);
        latest.addProperty("manifest", "packs/" + version + "/manifest.json");
        latest.addProperty("manifestSha256", manifestSha);
        latest.addProperty("publishedAt", publishedAt);
        latest.addProperty("notes", cfg.notes);

        JsonObject catalog = catalog(manifest, files, mirrored, hosted);

        // 站点
        List<JsonObject> retained = retained(cfg, prevManifest, manifest);
        int[] counts = writeSite(cfg, retained, catalog, latest, manifestText, files, objectDir, partsCache);
        if (counts[0] > 20000) throw new IllegalStateException("站点文件数 " + counts[0] + " 超过 Pages 20,000 上限");

        // 状态落盘
        Path vdir = cfg.stateDir.resolve("versions").resolve(version);
        Files.createDirectories(vdir);
        writeString(vdir.resolve("manifest.json"), manifestText);
        writeString(cfg.stateDir.resolve("latest.json"), JsonUtil.pretty(latest));
        Files.createDirectories(cfg.outDir);
        writeString(cfg.outDir.resolve("latest.json"), JsonUtil.pretty(latest));
        writeString(cfg.outDir.resolve("manifest.json"), manifestText);
        pruneObjects(cfg, retained);

        Result r = new Result();
        r.manifest = manifest;
        r.manifestText = manifestText;
        r.manifestSha256 = manifestSha;
        r.latest = latest;
        r.files = files.size();
        r.mirrored = mirrored;
        r.hosted = hosted;
        r.modCount = catalog.getAsJsonArray("mods").size();
        r.siteFiles = counts[0];
        r.partCount = partCount;
        r.totalBytes = total;
        r.version = version;
        r.changed = changed;
        Log.ok("构建完成：" + r.files + " 个文件（镜像 " + mirrored + " / 自托管 " + hosted + "），共 " + human(total));
        Log.info("版本 " + version + "，站点文件 " + r.siteFiles + " 个" + (partCount > 0 ? "（含分片 " + partCount + "）" : ""));
        return r;
    }

    // ---------- 扫描 ----------

    private static List<SourceFile> scan(Config cfg, List<Config.Scope> scopes) throws IOException {
        List<SourceFile> out = new ArrayList<>();
        Set<String> targets = new LinkedHashSet<>();
        for (Config.Scope scope : scopes) {
            Path src = Path.of(scope.source);
            if (!src.isAbsolute()) src = cfg.gameDir.resolve(scope.source);
            if (!Files.isDirectory(src)) throw new IllegalStateException("scope " + scope.id + " 的目录不存在: " + src);
            List<Path> files = new ArrayList<>();
            try (Stream<Path> walk = Files.walk(src)) {
                walk.filter(Files::isRegularFile).forEach(files::add);
            }
            for (Path p : files) {
                String rel = src.relativize(p).toString().replace('\\', '/');
                if (rel.contains("/.") || rel.startsWith(".")) continue;
                if (Glob.matchesAny(rel, cfg.exclude)) continue;
                if (Glob.matchesAny(rel, scope.exclude)) continue;
                if (!scope.include.isEmpty() && !Glob.matchesAny(rel, scope.include)) continue;
                if ("mods".equals(scope.kind) && !rel.toLowerCase().endsWith(".jar")) continue;
                if ("mods".equals(scope.kind) && rel.toLowerCase().matches("^autopack-.*\\.jar$")) {
                    Log.info("跳过自身: " + rel);
                    continue;
                }
                String target = (scope.target + "/" + rel).replaceAll("^/+", "");
                if (!targets.add(target)) throw new IllegalStateException("目标路径冲突: " + target);
                out.add(new SourceFile(scope.id, scope.kind, scope.role, p, rel, target, 0, null, null, null, null));
            }
        }
        if (out.isEmpty()) throw new IllegalStateException("扫描结果为空：检查 scope 的 source/include/exclude");
        return out;
    }

    private static List<SourceFile> hashAll(Config cfg, List<SourceFile> scanned) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(cfg.concurrency);
        AtomicInteger done = new AtomicInteger();
        try {
            List<Future<SourceFile>> futures = new ArrayList<>();
            List<SourceFile> out = new ArrayList<>();
            for (SourceFile s : scanned) {
                futures.add(pool.submit(() -> {
                    long size = Files.size(s.abs());
                    String[] h = HashUtil.fileHashes(s.abs());
                    ModJar meta = "mods".equals(s.kind) ? ModJar.read(s.abs()) : null;
                    done.incrementAndGet();
                    return new SourceFile(s.scopeId(), s.kind(), s.role(), s.abs(), s.rel(), s.target(), size, h[0], h[1], meta, null);
                }));
            }
            for (Future<SourceFile> f : futures) out.add(f.get());
            return out;
        } finally {
            pool.shutdownNow();
        }
    }

    private static void resolveAll(Config cfg, List<Config.Scope> scopes, List<SourceFile> entries) throws Exception {
        if (!cfg.mirrorEnabled) { Log.info("镜像解析已关闭，所有文件自托管"); return; }
        Map<String, Config.Scope> byId = new LinkedHashMap<>();
        for (Config.Scope s : scopes) byId.put(s.id, s);
        Resolver resolver = new Resolver(cfg);
        List<SourceFile> jars = entries.stream()
                .filter(e -> "mods".equals(e.kind) && byId.get(e.scopeId()) != null && cfg.scopeMirrorEnabled(byId.get(e.scopeId())))
                .toList();
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(4, cfg.concurrency));
        try {
            List<Future<JsonObject>> fs = new ArrayList<>();
            for (SourceFile e : jars) fs.add(pool.submit(() -> resolver.resolve(e.sha1())));
            int i = 0;
            for (int k = 0; k < entries.size(); k++) {
                SourceFile e = entries.get(k);
                if (!jars.contains(e)) continue;
                JsonObject remote = fs.get(i++).get();
                entries.set(k, new SourceFile(e.scopeId(), e.kind(), e.role(), e.abs(), e.rel(), e.target(),
                        e.size(), e.sha1(), e.sha256(), e.meta(), remote));
            }
        } finally {
            pool.shutdownNow();
        }
        resolver.save();
        Log.info("Modrinth 解析：" + resolver.stats());
    }

    // ---------- 清单片段 ----------

    private static JsonArray modsJson(ModJar meta) {
        JsonArray arr = new JsonArray();
        if (meta == null || meta.mods.isEmpty()) return arr;
        for (ModJar.ModInfo m : meta.mods) {
            JsonObject o = new JsonObject();
            o.addProperty("modId", m.modId);
            o.addProperty("name", m.name);
            o.addProperty("version", m.version);
            o.addProperty("authors", m.authors);
            o.addProperty("license", m.license);
            String desc = m.description;
            if (desc != null && desc.length() > 400) desc = desc.substring(0, 400);
            o.addProperty("description", desc);
            o.addProperty("environment", (String) null);
            JsonArray links = new JsonArray();
            for (ModJar.Link l : m.links) {
                JsonObject lo = new JsonObject();
                lo.addProperty("kind", l.kind());
                lo.addProperty("url", l.url());
                links.add(lo);
            }
            o.add("links", links);
            arr.add(o);
        }
        return arr;
    }

    private static String computeContentHash(Config cfg, List<JsonObject> files) {
        JsonObject payload = new JsonObject();
        payload.addProperty("packId", cfg.packId);
        payload.addProperty("packName", cfg.packName);
        payload.addProperty("baseUrl", cfg.pagesBaseUrl);
        JsonObject game = new JsonObject();
        game.addProperty("minecraft", cfg.mc);
        game.addProperty("loader", cfg.loader);
        game.addProperty("loaderVersion", cfg.loaderVersion);
        payload.add("game", game);
        payload.add("requiredModIds", JsonUtil.arr(cfg.requiredModIds));
        payload.addProperty("chunkBytes", cfg.chunkBytes);
        JsonArray arr = new JsonArray();
        for (JsonObject f : files) {
            JsonObject o = new JsonObject();
            o.addProperty("path", JsonUtil.str(f, "path", ""));
            o.addProperty("sha256", JsonUtil.str(f, "sha256", ""));
            o.addProperty("role", JsonUtil.str(f, "role", ""));
            o.addProperty("source", JsonUtil.str(JsonUtil.obj(f, "source"), "kind", ""));
            arr.add(o);
        }
        payload.add("files", arr);
        return HashUtil.sha256Hex(JsonUtil.canonical(payload));
    }

    // ---------- 站点 ----------

    private record Counts(int files, int parts) {}

    private static int[] writeSite(Config cfg, List<JsonObject> manifests, JsonObject catalog, JsonObject latest,
                                   String currentManifestText, List<JsonObject> currentFiles,
                                   Path objectDir, Path partsCache) throws Exception {
        Path siteDir = cfg.outDir.resolve("site");
        int files = 0, parts = 0;
        for (JsonObject m : manifests) {
            String ver = JsonUtil.str(m, "version", "");
            Path dir = siteDir.resolve("packs").resolve(ver);
            Files.createDirectories(dir);
            String text = m == manifests.get(0) ? currentManifestText : JsonUtil.pretty(m);
            for (var fe : m.getAsJsonArray("files")) {
                JsonObject f = fe.getAsJsonObject();
                JsonObject src = JsonUtil.obj(f, "source");
                if (!"pages".equals(JsonUtil.str(src, "kind", ""))) continue;
                String sha = JsonUtil.str(f, "sha256", "");
                Path obj = objectDir.resolve(sha);
                if (!Files.exists(obj)) { Log.warn("对象缺失，跳过: " + JsonUtil.str(f, "path", "")); continue; }
                if (f.has("parts") && f.getAsJsonArray("parts").size() > 0) {
                    for (var p : f.getAsJsonArray("parts")) {
                        JsonObject po = p.getAsJsonObject();
                        String rel = JsonUtil.str(po, "path", "");
                        Path dest = siteDir.resolve(rel);
                        Files.createDirectories(dest.getParent());
                        if (!Files.exists(dest)) {
                            Path cached = partsCache.resolve(sha + "." + JsonUtil.num(po, "index", 0));
                            if (Files.exists(cached)) copy(cached, dest);
                            else writePart(obj, po, dest);
                        }
                        parts++;
                        files++;
                    }
                } else {
                    Path dest = siteDir.resolve(JsonUtil.str(src, "path", ""));
                    Files.createDirectories(dest.getParent());
                    copy(obj, dest);
                    files++;
                }
            }
            writeString(dir.resolve("manifest.json"), text);
            files++;
        }
        writeString(siteDir.resolve("latest.json"), JsonUtil.pretty(latest));
        writeString(siteDir.resolve("catalog.json"), JsonUtil.pretty(catalog));
        writeString(siteDir.resolve("catalog.html"), Catalog.html(catalog, cfg));
        writeString(siteDir.resolve("index.html"), Catalog.index(catalog));
        files += 4;
        return new int[]{files, parts};
    }

    private static void writePart(Path obj, JsonObject part, Path dest) throws IOException {
        long offset = JsonUtil.num(part, "offset", 0);
        long size = JsonUtil.num(part, "size", 0);
        try (var ch = java.nio.channels.FileChannel.open(obj, java.nio.file.StandardOpenOption.READ);
             var out = Files.newOutputStream(dest)) {
            java.nio.ByteBuffer buf = java.nio.ByteBuffer.allocate(1 << 16);
            long remaining = size;
            ch.position(offset);
            while (remaining > 0) {
                buf.clear();
                buf.limit((int) Math.min(buf.capacity(), remaining));
                int n = ch.read(buf);
                if (n <= 0) break;
                out.write(buf.array(), 0, n);
                remaining -= n;
            }
        }
    }

    private static JsonObject splitParts(Config cfg, Path obj, SourceFile e, Path partsCache, Path siteDir, String contentPath) throws IOException {
        List<JsonObject> parts = new ArrayList<>();
        long offset = 0;
        int index = 0;
        try (InputStream in = Files.newInputStream(obj)) {
            byte[] chunk = new byte[(int) cfg.chunkBytes];
            while (offset < e.size()) {
                int want = (int) Math.min(chunk.length, e.size() - offset);
                int read = 0;
                while (read < want) {
                    int n = in.read(chunk, read, want - read);
                    if (n < 0) break;
                    read += n;
                }
                byte[] data = java.util.Arrays.copyOf(chunk, read);
                String sha = HashUtil.sha256Hex(data);
                String rel = String.format("parts/%s/%s.part%02d", e.sha256().substring(0, 2), e.sha256(), index);
                Path dest = siteDir.resolve(rel);
                Files.createDirectories(dest.getParent());
                Files.write(dest, data);
                Path cached = partsCache.resolve(e.sha256() + "." + index);
                if (!Files.exists(cached)) Files.write(cached, data);

                JsonObject po = new JsonObject();
                po.addProperty("path", rel);
                po.addProperty("size", read);
                po.addProperty("sha256", sha);
                po.addProperty("index", index);
                po.addProperty("offset", offset);
                parts.add(po);

                offset += read;
                index++;
            }
        }
        JsonObject out = new JsonObject();
        JsonArray arr = new JsonArray();
        parts.forEach(arr::add);
        out.add("parts", arr);
        return out;
    }

    private static List<JsonObject> retained(Config cfg, JsonObject prevManifest, JsonObject current) throws IOException {
        List<JsonObject> out = new ArrayList<>();
        out.add(current);
        int keep = Math.max(0, cfg.retainVersions);
        if (keep == 0) return out;
        Path versionsDir = cfg.stateDir.resolve("versions");
        if (!Files.isDirectory(versionsDir)) return out;
        List<JsonObject> history = new ArrayList<>();
        try (Stream<Path> dirs = Files.list(versionsDir)) {
            for (Path d : dirs.filter(Files::isDirectory).toList()) {
                JsonObject m = readJson(d.resolve("manifest.json"));
                if (m != null && !JsonUtil.str(m, "version", "").equals(JsonUtil.str(current, "version", ""))) history.add(m);
            }
        }
        history.sort(Comparator.comparing((JsonObject m) -> JsonUtil.str(m, "publishedAt", "")).reversed());
        for (int i = 0; i < Math.min(keep, history.size()); i++) out.add(history.get(i));
        return out;
    }

    private static void pruneObjects(Config cfg, List<JsonObject> retained) throws IOException {
        Set<String> keep = new LinkedHashSet<>();
        for (JsonObject m : retained) for (var e : m.getAsJsonArray("files")) {
            JsonObject f = e.getAsJsonObject();
            if ("pages".equals(JsonUtil.str(JsonUtil.obj(f, "source"), "kind", ""))) keep.add(JsonUtil.str(f, "sha256", ""));
        }
        Path objectDir = cfg.stateDir.resolve("objects");
        if (!Files.isDirectory(objectDir)) return;
        int removed = 0;
        try (Stream<Path> list = Files.list(objectDir)) {
            for (Path p : list.toList()) {
                if (!keep.contains(p.getFileName().toString())) { Files.deleteIfExists(p); removed++; }
            }
        }
        if (removed > 0) Log.info("清理对象库 " + removed + " 个不再引用的文件");
    }

    // ---------- 工具 ----------

    private static String contentPath(String sha, String target) {
        int dot = target.lastIndexOf('.');
        String ext = dot > 0 ? target.substring(dot).toLowerCase().replaceAll("[^a-z0-9.]", "") : "";
        return "files/" + sha.substring(0, 2) + "/" + sha + ext;
    }

    private static String dateStamp() {
        return LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.BASIC_ISO_DATE);
    }

    private static String now() { return java.time.Instant.now().toString(); }

    public static String human(long n) {
        String[] u = {"B", "KiB", "MiB", "GiB"};
        double v = n;
        int i = 0;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return String.format(java.util.Locale.ROOT, v >= 100 || i == 0 ? "%.0f %s" : "%.1f %s", v, u[i]);
    }

    static void deleteTree(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
        }
    }

    static void copy(Path src, Path dest) throws IOException {
        try { Files.createLink(dest, src); }
        catch (Exception e) { Files.copy(src, dest, StandardCopyOption.REPLACE_EXISTING); }
    }

    static void writeString(Path p, String text) throws IOException {
        Files.createDirectories(p.getParent());
        Files.writeString(p, text, StandardCharsets.UTF_8);
    }

    static JsonObject readJson(Path p) {
        try {
            if (!Files.isRegularFile(p)) return null;
            return JsonUtil.parse(Files.readString(p, StandardCharsets.UTF_8));
        } catch (Exception e) { return null; }
    }

    // catalog 拆到 Catalog 类里，这里只做组装
    private static JsonObject catalog(JsonObject manifest, List<JsonObject> files, int mirrored, int hosted) {
        return Catalog.build(manifest, files, mirrored, hosted);
    }
}
