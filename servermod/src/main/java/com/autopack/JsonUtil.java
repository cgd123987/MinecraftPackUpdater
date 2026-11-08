package com.autopack;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Gson 小工具：安全取值、稳定序列化（用于 contentHash）。 */
public final class JsonUtil {
    public static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final Gson PRETTY = new GsonBuilder().disableHtmlEscaping().setPrettyPrinting().create();

    private JsonUtil() {}

    public static JsonObject parse(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }

    public static String pretty(JsonElement e) { return PRETTY.toJson(e) + "\n"; }

    public static String canonical(JsonElement e) { return GSON.toJson(sort(e)); }

    private static JsonElement sort(JsonElement e) {
        if (e.isJsonArray()) {
            JsonArray out = new JsonArray();
            for (JsonElement x : e.getAsJsonArray()) out.add(sort(x));
            return out;
        }
        if (e.isJsonObject()) {
            TreeMap<String, JsonElement> map = new TreeMap<>();
            for (Map.Entry<String, JsonElement> en : e.getAsJsonObject().entrySet()) map.put(en.getKey(), sort(en.getValue()));
            JsonObject out = new JsonObject();
            for (Map.Entry<String, JsonElement> en : map.entrySet()) out.add(en.getKey(), en.getValue());
            return out;
        }
        return e;
    }

    public static String str(JsonObject o, String key, String def) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? def : e.getAsString();
    }

    public static boolean bool(JsonObject o, String key, boolean def) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? def : e.getAsBoolean();
    }

    public static long num(JsonObject o, String key, long def) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? def : e.getAsLong();
    }

    public static JsonObject obj(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
    }

    public static List<String> strList(JsonObject o, String key) {
        List<String> out = new ArrayList<>();
        JsonElement e = o.get(key);
        if (e != null && e.isJsonArray()) for (JsonElement x : e.getAsJsonArray()) out.add(x.getAsString());
        return out;
    }

    public static JsonArray arr(List<String> values) {
        JsonArray a = new JsonArray();
        for (String v : values) a.add(v);
        return a;
    }
}
