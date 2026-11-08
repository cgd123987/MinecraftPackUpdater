package com.autopack;

import java.net.URI;
import java.util.Set;

/** 官方 CDN/API → MCIM 镜像的映射，与 Node 版一致。 */
public final class Mirror {
    public static final String DEFAULT_BASE = "https://mod.mcimirror.top";

    private static final Set<String> CDN_HOSTS = Set.of(
            "cdn.modrinth.com", "edge.forgecdn.net", "mediafilez.forgecdn.net", "media.forgecdn.net");

    private Mirror() {}

    public static String toMirror(String url, String base) {
        if (url == null || url.isEmpty()) return url;
        try {
            URI u = URI.create(url);
            URI mb = URI.create(base);
            if (u.getHost() == null) return url;
            if (u.getHost().equals(mb.getHost())) return url;
            if (CDN_HOSTS.contains(u.getHost())) return base + u.getRawPath() + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "");
            if ("api.modrinth.com".equals(u.getHost())) return base + "/modrinth" + u.getRawPath() + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "");
            if ("api.curseforge.com".equals(u.getHost())) return base + "/curseforge" + u.getRawPath() + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "");
            return url;
        } catch (RuntimeException e) {
            return url;
        }
    }

    /** 项目页 → 可点击的镜像 API 地址（网页本身没有镜像）。 */
    public static String projectMirror(String kind, String url, String base) {
        if ("modrinth".equals(kind)) {
            String slug = match(url, "modrinth\\.com/mod/([A-Za-z0-9_-]+)");
            if (slug != null) return base + "/modrinth/v2/project/" + slug;
        } else if ("curseforge".equals(kind)) {
            String slug = match(url, "curseforge\\.com/minecraft/mc-mods/([A-Za-z0-9_-]+)");
            if (slug != null) return base + "/curseforge/v1/mods/search?gameId=432&slug=" + slug;
        }
        return null;
    }

    private static String match(String url, String regex) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(regex, java.util.regex.Pattern.CASE_INSENSITIVE).matcher(url);
        return m.find() ? m.group(1) : null;
    }

    public static String kindOf(String url) {
        try {
            String host = URI.create(url).getHost();
            if (host == null) return "website";
            if (host.matches("(?i).*modrinth\\.com$")) return "modrinth";
            if (host.matches("(?i).*curseforge\\.com$")) return "curseforge";
            if (host.matches("(?i).*github\\.com$")) return "github";
            if (host.matches("(?i).*discord\\.(gg|com)$")) return "discord";
            return "website";
        } catch (RuntimeException e) {
            return "website";
        }
    }
}
