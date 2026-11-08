package com.autopack;

/** 统一日志：服务端控制台里以 [AutoPack] 前缀出现。 */
public final class Log {
    private Log() {}

    private static String stamp() {
        return java.time.LocalTime.now().withNano(0).toString();
    }

    public static void info(String msg) { System.out.println("[" + stamp() + "] [AutoPack] " + msg); }
    public static void warn(String msg) { System.out.println("[" + stamp() + "] [AutoPack][警告] " + msg); }
    public static void error(String msg) { System.out.println("[" + stamp() + "] [AutoPack][错误] " + msg); }
    public static void ok(String msg) { System.out.println("[" + stamp() + "] [AutoPack][完成] " + msg); }
}
