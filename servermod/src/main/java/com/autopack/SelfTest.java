package com.autopack;

import java.nio.file.Path;
import java.nio.file.Paths;

/** 独立自检：不启动游戏，直接跑一遍构建（可选发布），用于验证逻辑。 */
public final class SelfTest {
    public static void main(String[] args) throws Exception {
        Path gameDir = Paths.get(args.length > 0 ? args[0] : ".");
        boolean publish = args.length > 1 && "--publish".equals(args[1]);
        Config cfg = Config.load(gameDir);
        if (cfg == null) {
            System.err.println("找不到配置: " + Config.configPath(gameDir));
            System.exit(2);
        }
        Builder.Result r = Builder.build(cfg);
        System.out.println("SELFTEST_OK version=" + r.version
                + " files=" + r.files
                + " mirrored=" + r.mirrored
                + " hosted=" + r.hosted
                + " siteFiles=" + r.siteFiles
                + " parts=" + r.partCount
                + " changed=" + r.changed);
        if (publish) Publisher.publish(cfg);
    }
}
