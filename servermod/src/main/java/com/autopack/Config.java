package com.autopack;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/** 服务端配置：<gameDir>/config/autopack.json（字段与 Node 版 pack.json 保持兼容）。 */
public final class Config {
    public static final class Scope {
        public String id;
        public String kind = "mods";
        public String source;
        public String target;
        public String role = "required";
        public boolean enabled = true;
        public List<String> include = new ArrayList<>();
        public List<String> exclude = new ArrayList<>();
        public Boolean mirrorEnabled;
    }

    public boolean enabled = true;
    public String packId = "mypack";    public String packName = "我的整合包";
    public String packVersion;
    public String notes = "";
    public String mc = "1.21.1";
    public String loader = "neoforge";
    public String loaderVersion = "";
    public Path gameDir;
    public Path outDir;
    public Path stateDir;
    public final List<Scope> scopes = new ArrayList<>();
    public List<String> exclude = new ArrayList<>(List.of(
            "**/*.bak", "**/*.tmp", "**/*.log", "**/.DS_Store", "**/Thumbs.db",
            "**/__pycache__/**", "**/cache/**", "**/logs/**", "**/crash-reports/**"));
    public List<String> requiredModIds = new ArrayList<>();
    public boolean mirrorEnabled = true;
    public String mirrorBase = Mirror.DEFAULT_BASE;
    public String userAgent = "AutoPackUpdater/0.1";
    public String pagesProject = "";
    public String pagesAccountId = "";
    public String pagesApiToken = "";
    public String pagesBranch = "main";
    public String pagesBaseUrl = "";
    public String wranglerCommand = "";
    public long maxAssetBytes = 24L * 1024 * 1024;
    public long chunkBytes = 20L * 1024 * 1024;
    public int retainVersions = 1;
    public int concurrency = 4;
    public boolean autoBuild = true;
    public boolean autoPublish = true;
    public int intervalMinutes = 0;

    public static Path configPath(Path gameDir) {
        return gameDir.resolve("config").resolve("autopack.json");
    }

    /** 配置不存在时返回 null（由调用方提示如何创建）。 */
    public static Config load(Path gameDir) throws IOException {
        Path p = configPath(gameDir);
        if (!Files.isRegularFile(p)) return null;
        JsonObject root = JsonUtil.parse(Files.readString(p, StandardCharsets.UTF_8));
        Config c = new Config();
        c.gameDir = gameDir;
        c.enabled = JsonUtil.bool(root, "enabled", true);

        JsonObject pack = JsonUtil.obj(root, "pack");
        c.packId = JsonUtil.str(pack, "id", c.packId);
        c.packName = JsonUtil.str(pack, "name", c.packName);
        c.packVersion = emptyToNull(JsonUtil.str(pack, "version", null));
        c.notes = JsonUtil.str(pack, "notes", "");

        JsonObject game = JsonUtil.obj(root, "game");
        c.mc = JsonUtil.str(game, "minecraft", c.mc);
        c.loader = JsonUtil.str(game, "loader", c.loader);
        c.loaderVersion = JsonUtil.str(game, "loaderVersion", "");

        JsonObject paths = JsonUtil.obj(root, "paths");
        c.outDir = resolve(gameDir, JsonUtil.str(paths, "outDir", "autopack/out"));
        c.stateDir = resolve(gameDir, JsonUtil.str(paths, "stateDir", "autopack/state"));

        JsonArray scopes = root.has("scopes") && root.get("scopes").isJsonArray() ? root.getAsJsonArray("scopes") : new JsonArray();
        for (JsonElement e : scopes) {
            if (!e.isJsonObject()) continue;
            JsonObject s = e.getAsJsonObject();
            Scope sc = new Scope();
            sc.id = JsonUtil.str(s, "id", "scope" + c.scopes.size());
            sc.kind = JsonUtil.str(s, "kind", "files");
            sc.source = JsonUtil.str(s, "source", "mods");
            sc.target = JsonUtil.str(s, "target", sc.source);
            sc.role = JsonUtil.str(s, "role", "mods".equals(sc.kind) ? "required" : "content");
            sc.enabled = JsonUtil.bool(s, "enabled", true);
            sc.include = JsonUtil.strList(s, "include");
            sc.exclude = JsonUtil.strList(s, "exclude");
            if (s.has("mirror") && s.get("mirror").isJsonObject()) {
                sc.mirrorEnabled = JsonUtil.bool(s.getAsJsonObject("mirror"), "enabled", true);
            }
            c.scopes.add(sc);
        }
        if (c.scopes.isEmpty()) {
            Scope sc = new Scope();
            sc.id = "mods"; sc.kind = "mods"; sc.source = "mods"; sc.target = "mods"; sc.role = "required";
            c.scopes.add(sc);
        }

        c.exclude = JsonUtil.strList(root, "exclude");
        if (c.exclude.isEmpty()) c.exclude = new ArrayList<>(List.of(
                "**/*.bak", "**/*.tmp", "**/*.log", "**/.DS_Store", "**/Thumbs.db",
                "**/__pycache__/**", "**/cache/**", "**/logs/**", "**/crash-reports/**"));
        c.requiredModIds = JsonUtil.strList(root, "requiredModIds");
        c.concurrency = Math.max(1, (int) JsonUtil.num(root, "concurrency", c.concurrency));

        JsonObject mirror = JsonUtil.obj(root, "mirror");
        c.mirrorEnabled = JsonUtil.bool(mirror, "enabled", true);
        c.mirrorBase = JsonUtil.str(mirror, "baseUrl", Mirror.DEFAULT_BASE);
        c.userAgent = JsonUtil.str(mirror, "userAgent", c.userAgent);

        JsonObject pages = JsonUtil.obj(root, "pages");
        c.pagesProject = JsonUtil.str(pages, "project", "");
        c.pagesAccountId = JsonUtil.str(pages, "accountId", "");
        c.pagesApiToken = JsonUtil.str(pages, "apiToken", "");
        c.pagesBranch = JsonUtil.str(pages, "branch", "main");
        c.pagesBaseUrl = JsonUtil.str(pages, "baseUrl", "");
        c.wranglerCommand = JsonUtil.str(pages, "wranglerCommand", "");
        c.maxAssetBytes = JsonUtil.num(pages, "maxAssetBytes", c.maxAssetBytes);
        c.chunkBytes = JsonUtil.num(pages, "chunkBytes", c.chunkBytes);
        c.retainVersions = (int) JsonUtil.num(pages, "retainVersions", c.retainVersions);
        c.autoBuild = JsonUtil.bool(pages, "autoBuild", true);
        c.autoPublish = JsonUtil.bool(pages, "autoPublish", true);
        c.intervalMinutes = (int) JsonUtil.num(pages, "intervalMinutes", 0);

        if (c.pagesBaseUrl.isEmpty() && !c.pagesProject.isEmpty()) {
            c.pagesBaseUrl = "https://" + c.pagesProject + ".pages.dev";
        }
        while (c.pagesBaseUrl.endsWith("/")) c.pagesBaseUrl = c.pagesBaseUrl.substring(0, c.pagesBaseUrl.length() - 1);
        if (c.maxAssetBytes > 25L * 1024 * 1024) c.maxAssetBytes = 24L * 1024 * 1024;
        if (c.chunkBytes > c.maxAssetBytes) c.chunkBytes = c.maxAssetBytes;
        return c;
    }

    private static Path resolve(Path base, String p) {
        Path path = Paths.get(p);
        return path.isAbsolute() ? path : base.resolve(p);
    }

    private static String emptyToNull(String s) { return s == null || s.isEmpty() ? null : s; }

    public String siteUrl(String relativePath) {
        String base = pagesBaseUrl.isEmpty() ? "https://example.pages.dev" : pagesBaseUrl;
        return base + "/" + relativePath;
    }

    public boolean scopeMirrorEnabled(Scope s) {
        return mirrorEnabled && (s.mirrorEnabled == null || s.mirrorEnabled);
    }
}
