package com.autopack;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** 从 mod jar 的版权页/元数据里抽取信息与链接（NeoForge / 旧 Forge / Fabric / mcmod.info）。 */
public final class ModJar {
    private static final String[] TOML_FILES = {"META-INF/neoforge.mods.toml", "META-INF/mods.toml", "mods.toml"};
    private static final String[] JSON_FILES = {"fabric.mod.json", "quilt.mod.json", "mcmod.info"};
    private static final Pattern URL_RE = Pattern.compile("https?://[^\\s\"'<>()\\[\\]，。；、）】]+", Pattern.CASE_INSENSITIVE);

    public record Link(String kind, String url) {}

    public static final class ModInfo {
        public String modId;
        public String name;
        public String version;
        public String authors;
        public String license;
        public String description;
        public final List<Link> links = new ArrayList<>();
    }

    public List<ModInfo> mods = new ArrayList<>();
    public String loader;
    public String loaderVersion;
    public String error;

    public static ModJar read(Path jar) {
        ModJar out = new ModJar();
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            for (String name : TOML_FILES) {
                ZipEntry e = zip.getEntry(name);
                if (e != null) { out.fromToml(readText(zip, e)); return out; }
            }
            for (String name : JSON_FILES) {
                ZipEntry e = zip.getEntry(name);
                if (e != null) { out.fromJson(readText(zip, e)); return out; }
            }
        } catch (Exception e) {
            out.error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        return out;
    }

    private static String readText(ZipFile zip, ZipEntry e) throws Exception {
        try (InputStream in = zip.getInputStream(e)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @SuppressWarnings("unchecked")
    private void fromToml(String text) {
        Map<String, Object> root;
        try { root = Toml.parse(text); }
        catch (Exception e) { this.error = "TOML 解析失败: " + e.getMessage(); return; }
        this.loader = str(root.get("modLoader"));
        this.loaderVersion = str(root.get("loaderVersion"));
        String topLicense = str(root.get("license"));
        Object modsObj = root.get("mods");
        if (modsObj instanceof List<?> blocks) {
            for (Object b : blocks) {
                Map<String, Object> m = (Map<String, Object>) b;
                ModInfo info = new ModInfo();
                info.modId = str(m.get("modId"));
                info.name = firstNonNull(str(m.get("displayName")), info.modId);
                info.version = str(m.get("version"));
                info.authors = str(m.get("authors"));
                info.license = firstNonNull(str(m.get("license")), topLicense);
                info.description = str(m.get("description"));
                info.links.addAll(linksFrom(info.description, str(m.get("displayURL")), str(m.get("issueTrackerURL")), str(m.get("credits"))));
                mods.add(info);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void fromJson(String text) {
        try {
            Object parsed = JsonUtil.GSON.fromJson(text, Object.class);
            List<Object> list = new ArrayList<>();
            if (parsed instanceof List<?> l) list.addAll(l);
            else list.add(parsed);
            for (Object o : list) {
                if (!(o instanceof Map)) continue;
                Map<String, Object> m = (Map<String, Object>) o;
                ModInfo info = new ModInfo();
                info.modId = str(m.get("id"));
                info.name = firstNonNull(str(m.get("name")), info.modId);
                info.version = str(m.get("version"));
                info.license = str(m.get("license"));
                info.description = str(m.get("description"));
                Object authors = m.get("authors");
                if (authors instanceof List<?> al) {
                    List<String> names = new ArrayList<>();
                    for (Object a : al) names.add(a instanceof Map ? str(((Map<String, Object>) a).get("name")) : str(a));
                    info.authors = String.join(", ", names);
                } else info.authors = str(authors);
                String homepage = str(m.get("homepage"));
                Object contact = m.get("contact");
                String issues = contact instanceof Map ? str(((Map<String, Object>) contact).get("issues")) : null;
                info.links.addAll(linksFrom(info.description, homepage, issues, null));
                mods.add(info);
            }
            this.loader = "fabric";
        } catch (Exception e) {
            this.error = "JSON 解析失败: " + e.getMessage();
        }
    }

    private static List<Link> linksFrom(String... texts) {
        List<Link> out = new ArrayList<>();
        Map<String, Link> seen = new LinkedHashMap<>();
        for (String t : texts) {
            if (t == null) continue;
            Matcher m = URL_RE.matcher(t);
            while (m.find()) {
                String url = m.group().replaceAll("[.,;:]+$", "");
                String key = url.toLowerCase();
                if (seen.containsKey(key)) continue;
                Link l = new Link(Mirror.kindOf(url), url);
                seen.put(key, l);
                out.add(l);
            }
        }
        return out;
    }

    private static String str(Object o) { return o == null ? null : String.valueOf(o); }

    private static String firstNonNull(String a, String b) { return a != null ? a : b; }

    /** 汇总所有 mod 的链接（去重）。 */
    public List<Link> allLinks() {
        Map<String, Link> seen = new LinkedHashMap<>();
        for (ModInfo m : mods) for (Link l : m.links) seen.putIfAbsent(l.url().toLowerCase(), l);
        return new ArrayList<>(seen.values());
    }

    /** 调试用：列出条目（SelfTest 用）。 */
    public static List<String> entries(Path jar) {
        List<String> names = new ArrayList<>();
        try (ZipFile z = new ZipFile(jar.toFile())) {
            Enumeration<? extends ZipEntry> en = z.entries();
            while (en.hasMoreElements()) names.add(en.nextElement().getName());
        } catch (Exception ignored) {}
        return names;
    }
}
