package com.autopack;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 服务端 mod 入口：开服后自动扫描 mods/ 等范围、生成清单并（可选）发布到 Cloudflare Pages。
 * 也支持放置 autopack/trigger 文件手动触发一次构建发布。
 */
@Mod(AutoPackMod.MODID)
public final class AutoPackMod {
    public static final String MODID = "autopack";

    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static ScheduledExecutorService SCHED;
    private static Path gameDir;
    private static long lastIntervalRun;

    public AutoPackMod(IEventBus modEventBus, ModContainer modContainer) {
        if (!isDedicatedServer()) {
            Log.info("检测到客户端环境，AutoPack 只在服务端运行（已跳过）");
            return;
        }
        gameDir = FMLPaths.GAMEDIR.get();
        NeoForge.EVENT_BUS.register(this);
        ensureTemplate();
        startScheduler();
        Log.info("AutoPack 已加载，配置：" + Config.configPath(gameDir));
    }

    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        Config cfg = loadQuiet();
        if (cfg == null) {
            Log.warn("没有找到配置，已生成模板：" + Config.configPath(gameDir) + "，填好后重启服务器或放置 autopack/trigger");
            return;
        }
        if (!cfg.enabled) { Log.info("配置里 enabled=false，跳过自动构建"); return; }
        if (!cfg.autoBuild) { Log.info("配置里 autoBuild=false，跳过自动构建（可放置 autopack/trigger 手动触发）"); return; }
        Log.info("服务器已启动，5 秒后开始构建…");
        schedule(() -> runOnce("服务器启动", cfg), 5);
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        if (SCHED != null) SCHED.shutdownNow();
    }

    private static void startScheduler() {
        SCHED = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "autopack-publisher");
            t.setDaemon(true);
            return t;
        });
        SCHED.scheduleAtFixedRate(() -> {
            try { tick(); } catch (Throwable t) { Log.warn("触发器检查异常: " + t.getMessage()); }
        }, 10, 5, TimeUnit.SECONDS);
    }

    private static void tick() {
        Path trigger = gameDir.resolve("autopack").resolve("trigger");
        if (Files.exists(trigger)) {
            try { Files.deleteIfExists(trigger); } catch (Exception ignored) {}
            runOnce("手动触发", null);
            return;
        }
        Config cfg = loadQuiet();
        if (cfg == null || !cfg.enabled || !cfg.autoBuild) return;
        if (cfg.intervalMinutes <= 0) return;
        long now = System.currentTimeMillis();
        if (now - lastIntervalRun >= cfg.intervalMinutes * 60_000L) {
            lastIntervalRun = now;
            runOnce("定时刷新", cfg);
        }
    }

    private static void schedule(Runnable r, int seconds) {
        if (SCHED != null) SCHED.schedule(r, seconds, TimeUnit.SECONDS);
    }

    private static void runOnce(String reason, Config preset) {
        if (!RUNNING.compareAndSet(false, true)) {
            Log.info("已有构建任务在运行，跳过本次触发（" + reason + "）");
            return;
        }
        try {
            Config cfg = preset != null ? preset : loadQuiet();
            if (cfg == null) { Log.warn("没有配置文件，跳过"); return; }
            if (!cfg.enabled) return;
            Log.info("开始任务：" + reason);
            Builder.Result result = Builder.build(cfg);
            if (cfg.autoPublish) {
                if (cfg.pagesProject == null || cfg.pagesProject.isEmpty()) {
                    Log.warn("未配置 pages.project，只构建不发布（站点在 " + cfg.outDir.resolve("site") + "）");
                } else {
                    Publisher.publish(cfg);
                }
            } else {
                Log.info("autoPublish=false，已跳过发布；站点目录：" + cfg.outDir.resolve("site"));
            }
            Log.ok("任务完成：" + reason + "，版本 " + result.version);
        } catch (Throwable t) {
            Log.error("任务失败：" + t.getMessage());
            if (System.getenv("AUTOPACK_DEBUG") != null) t.printStackTrace();
        } finally {
            RUNNING.set(false);
        }
    }

    private static Config loadQuiet() {
        try { return Config.load(gameDir); }
        catch (Exception e) { Log.error("读取配置失败: " + e.getMessage()); return null; }
    }

    /** 首次启动生成一份模板配置，降低上手成本。 */
    private static void ensureTemplate() {
        Path p = Config.configPath(gameDir);
        if (Files.exists(p)) return;
        String template = """
                {
                  "enabled": true,
                  "pack": { "id": "mypack", "name": "我的整合包" },
                  "game": { "minecraft": "1.21.1", "loader": "neoforge", "loaderVersion": "" },
                  "paths": { "outDir": "autopack/out", "stateDir": "autopack/state" },
                  "scopes": [
                    { "id": "mods", "kind": "mods", "source": "mods", "target": "mods", "role": "required", "enabled": true },
                    { "id": "kubejs", "kind": "files", "source": "kubejs", "target": "kubejs", "role": "content", "enabled": false }
                  ],
                  "requiredModIds": [],
                  "mirror": { "enabled": true, "baseUrl": "https://mod.mcimirror.top" },
                  "pages": {
                    "project": "",
                    "branch": "main",
                    "autoBuild": true,
                    "autoPublish": true,
                    "retainVersions": 1
                  }
                }
                """;
        try {
            Files.createDirectories(p.getParent());
            Files.writeString(p, template, StandardCharsets.UTF_8);
            Log.info("已生成模板配置：" + p);
        } catch (Exception e) {
            Log.warn("生成模板配置失败: " + e.getMessage());
        }
    }

    /** 用反射判断专用服务端，避免编译期依赖 Dist。 */
    private static boolean isDedicatedServer() {
        try {
            Class<?> env = Class.forName("net.neoforged.fml.loading.FMLEnvironment");
            Object dist = env.getField("dist").get(null);
            return "DEDICATED_SERVER".equals(String.valueOf(dist));
        } catch (Throwable t) {
            return true;
        }
    }
}
