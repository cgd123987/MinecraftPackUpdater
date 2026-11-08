package com.autopack;

import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** 用官方 wrangler CLI 发布站点：内容未变自动跳过，失败时给出可操作的提示。 */
public final class Publisher {
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private Publisher() {}

    public static void publish(Config cfg) throws Exception {
        Path siteDir = cfg.outDir.resolve("site");
        JsonObject latest = Builder.readJson(siteDir.resolve("latest.json"));
        if (latest == null) throw new IllegalStateException("没有找到待发布站点，请先构建");
        if (cfg.pagesProject == null || cfg.pagesProject.isEmpty()) throw new IllegalStateException("未配置 pages.project");

        String contentHash = JsonUtil.str(latest, "contentHash", "");
        String version = JsonUtil.str(latest, "version", "");

        if (!cfg.pagesBaseUrl.isEmpty()) {
            JsonObject remote = getLatestJson(cfg.pagesBaseUrl);
            if (remote != null && contentHash.equals(JsonUtil.str(remote, "contentHash", ""))) {
                Log.ok("远端 contentHash 一致（" + version + "），跳过部署以节省 Pages 额度");
                return;
            }
        }

        // 1) 原生 API 直传：不需要 wrangler，也不需要浏览器登录
        try {
            Log.info("Cloudflare API 直传 → 项目 " + cfg.pagesProject + "，分支 " + cfg.pagesBranch);
            new PagesUploader(cfg).publish(siteDir);
            Log.ok("部署已提交：" + cfg.pagesBaseUrl + "（版本 " + version + "）");
            Log.ok("版权页：" + cfg.pagesBaseUrl + "/catalog");
            verify(cfg, contentHash);
            return;
        } catch (PagesUploader.AuthException e) {
            Log.warn("原生直传认证失败：" + e.getMessage());
            Log.warn("改用 wrangler CLI 重试…");
        }

        // 2) 回退 wrangler（本机已登录时可用）
        ensureWranglerLoggedIn(cfg);
        Log.info("调用 wrangler 上传站点 → 项目 " + cfg.pagesProject + "，分支 " + cfg.pagesBranch);
        List<String> base = command(cfg);
        List<String> deploy = new ArrayList<>(base);
        deploy.addAll(List.of("pages", "deploy", ".", "--project-name", cfg.pagesProject,
                "--branch", cfg.pagesBranch, "--commit-dirty=true"));

        ExecResult r = exec(deploy, siteDir);
        if (r.code != 0 && (r.output.contains("Project not found") || r.output.contains("does not exist") || r.output.contains("8000007"))) {
            Log.warn("Pages 项目不存在，尝试创建…");
            List<String> create = new ArrayList<>(base);
            create.addAll(List.of("pages", "project", "create", cfg.pagesProject, "--production-branch", cfg.pagesBranch));
            ExecResult c = exec(create, siteDir);
            if (c.code != 0) throw new IOException("创建 Pages 项目失败:\n" + tail(c.output));
            r = exec(deploy, siteDir);
        }
        if (r.code != 0) throw new IOException("wrangler 部署失败（退出码 " + r.code + "）:\n" + tail(r.output));

        Log.ok("部署已提交：" + cfg.pagesBaseUrl + "（版本 " + version + "）");
        Log.ok("版权页：" + cfg.pagesBaseUrl + "/catalog");
        verify(cfg, contentHash);
    }

    private static void verify(Config cfg, String contentHash) {
        for (int i = 0; i < 8; i++) {
            try { Thread.sleep(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
            JsonObject remote = getLatestJson(cfg.pagesBaseUrl);
            if (remote != null && contentHash.equals(JsonUtil.str(remote, "contentHash", ""))) {
                Log.ok("线上校验通过：" + cfg.pagesBaseUrl + "/latest.json");
                return;
            }
        }
        Log.warn("部署已提交，但线上 latest.json 尚未更新（CDN 传播延迟），稍后访问 " + cfg.pagesBaseUrl + "/latest.json");
    }

    private static JsonObject getLatestJson(String baseUrl) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/latest.json?t=" + System.currentTimeMillis()))
                    .timeout(Duration.ofSeconds(10)).GET().build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return res.statusCode() == 200 ? JsonUtil.parse(res.body()) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void ensureWranglerLoggedIn(Config cfg) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<>(command(cfg));
        cmd.add("whoami");
        ExecResult r = exec(cmd, cfg.outDir);
        if (r.code == 0 && r.output.contains("You are logged in")) {
            String email = firstMatch(r.output, "associated with the email\\s+([\\w.+-]+@[\\w.-]+\\.\\w+)");
            Log.info("Cloudflare 已登录" + (email != null ? "：" + email : ""));
            return;
        }
        throw new IOException("Cloudflare 未登录或 wrangler 不可用。请在服务器上打开终端执行：\n"
                + "  wrangler login\n"
                + "（或者把 CLOUDFLARE_API_TOKEN 设为系统环境变量后重启服务器）\n"
                + "当前 wrangler 命令：" + String.join(" ", command(cfg)));
    }

    /** 配置里的 wranglerCommand，默认 wrangler；未安装时回退 npx。 */
    private static List<String> command(Config cfg) {
        if (cfg.wranglerCommand != null && !cfg.wranglerCommand.isEmpty()) return split(cfg.wranglerCommand);
        if (probe("wrangler")) return List.of("wrangler");
        return List.of("npx", "--yes", "wrangler@4");
    }

    private static boolean probe(String bin) {
        try {
            Process p = new ProcessBuilder("cmd.exe", "/d", "/s", "/c", bin + " --version")
                    .redirectErrorStream(true).start();
            p.getInputStream().readAllBytes();
            return p.waitFor(30, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    private static ExecResult exec(List<String> args, Path cwd) throws IOException, InterruptedException {
        if (!Files.isDirectory(cwd)) cwd = cwd.getParent();
        boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
        List<String> cmd = new ArrayList<>();
        if (win) {
            cmd.add("cmd.exe"); cmd.add("/d"); cmd.add("/s"); cmd.add("/c");
            cmd.add(joinQuoted(args));
        } else {
            cmd.add("/bin/sh"); cmd.add("-c"); cmd.add(joinQuoted(args));
        }
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(cwd.toFile()).redirectErrorStream(true);
        Process p = pb.start();
        StringBuilder out = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                out.append(line).append('\n');
                if (out.length() > 200_000) out.delete(0, out.length() - 200_000);
            }
        }
        boolean done = p.waitFor(10, TimeUnit.MINUTES);
        if (!done) { p.destroyForcibly(); throw new IOException("wrangler 超时（10 分钟）"); }
        return new ExecResult(p.exitValue(), out.toString());
    }

    private record ExecResult(int code, String output) {}

    private static String joinQuoted(List<String> args) {
        StringBuilder sb = new StringBuilder();
        for (String a : args) {
            if (sb.length() > 0) sb.append(' ');
            if (a.matches(".*[\\s\"].*")) sb.append('"').append(a.replace("\"", "\\\"")).append('"');
            else sb.append(a);
        }
        return sb.toString();
    }

    static List<String> split(String command) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean quote = false;
        for (char c : command.toCharArray()) {
            if (c == '"') { quote = !quote; continue; }
            if (c == ' ' && !quote) { if (cur.length() > 0) { out.add(cur.toString()); cur.setLength(0); } continue; }
            cur.append(c);
        }
        if (cur.length() > 0) out.add(cur.toString());
        return out;
    }

    private static String firstMatch(String text, String regex) {
        var m = java.util.regex.Pattern.compile(regex).matcher(text);
        return m.find() ? m.group(1) : null;
    }

    private static String tail(String s) {
        return s.length() <= 3000 ? s : s.substring(s.length() - 3000);
    }
}
