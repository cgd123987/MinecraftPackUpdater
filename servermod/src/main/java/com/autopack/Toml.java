package com.autopack;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 面向 neoforge.mods.toml / mods.toml 的 TOML 子集解析器（与 Node 版行为一致）。
 * 支持：注释、基础串、字面串、多行串、表、表数组、数组、数字、布尔、内联表、点号键。
 */
public final class Toml {
    private final String s;
    private int i;

    private Toml(String text) {
        this.s = text.startsWith("\uFEFF") ? text.substring(1) : text;
    }

    public static Map<String, Object> parse(String text) {
        Toml p = new Toml(text);
        Map<String, Object> root = new LinkedHashMap<>();
        Map<String, Object> table = root;
        p.skipWs();
        while (!p.eof()) {
            if (p.peek() == '[') {
                boolean array = p.peek(1) == '[';
                p.i++;
                if (array) p.i++;
                p.skipInline();
                List<String> path = p.keyPath();
                p.skipInline();
                p.expect(']');
                if (array) p.expect(']');
                table = array ? p.arrayTable(root, path) : p.table(root, path);
                p.skipWs();
            } else {
                List<String> path = p.keyPath();
                p.skipInline();
                p.expect('=');
                p.skipInline();
                Object value = p.value();
                assign(table, path, value);
                p.skipWs();
            }
        }
        return root;
    }

    @SuppressWarnings("unchecked")
    private static void assign(Map<String, Object> table, List<String> path, Object value) {
        Map<String, Object> t = table;
        for (int k = 0; k < path.size() - 1; k++) {
            Object next = t.get(path.get(k));
            if (!(next instanceof Map)) {
                next = new LinkedHashMap<String, Object>();
                t.put(path.get(k), next);
            }
            t = (Map<String, Object>) next;
        }
        t.put(path.get(path.size() - 1), value);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> table(Map<String, Object> root, List<String> path) {
        Map<String, Object> t = root;
        for (String k : path) {
            Object next = t.get(k);
            if (next instanceof List) {
                List<Object> l = (List<Object>) next;
                next = l.isEmpty() ? new LinkedHashMap<String, Object>() : l.get(l.size() - 1);
            }
            if (!(next instanceof Map)) {
                next = new LinkedHashMap<String, Object>();
                t.put(k, next);
            }
            t = (Map<String, Object>) next;
        }
        return t;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> arrayTable(Map<String, Object> root, List<String> path) {
        Map<String, Object> t = root;
        for (int k = 0; k < path.size() - 1; k++) {
            Object next = t.get(path.get(k));
            if (next instanceof List) {
                List<Object> l = (List<Object>) next;
                next = l.get(l.size() - 1);
            }
            if (!(next instanceof Map)) {
                next = new LinkedHashMap<String, Object>();
                t.put(path.get(k), next);
            }
            t = (Map<String, Object>) next;
        }
        String last = path.get(path.size() - 1);
        Object arr = t.get(last);
        List<Object> list;
        if (arr instanceof List) list = (List<Object>) arr;
        else { list = new ArrayList<>(); t.put(last, list); }
        Map<String, Object> obj = new LinkedHashMap<>();
        list.add(obj);
        return obj;
    }

    private boolean eof() { return i >= s.length(); }
    private char peek() { return peek(0); }
    private char peek(int k) { return i + k < s.length() ? s.charAt(i + k) : '\0'; }
    private void expect(char c) {
        if (peek() != c) throw new IllegalArgumentException("TOML 位置 " + i + " 期望 '" + c + "'");
        i++;
    }
    private void skipInline() { while (!eof() && (peek() == ' ' || peek() == '\t')) i++; }
    private void skipWs() {
        for (;;) {
            skipInline();
            char c = peek();
            if (c == '\r' || c == '\n') { i++; continue; }
            if (c == '#') { while (!eof() && peek() != '\n') i++; continue; }
            break;
        }
    }

    private List<String> keyPath() {
        List<String> parts = new ArrayList<>();
        for (;;) {
            skipInline();
            char c = peek();
            if (c == '"' || c == '\'') parts.add(string());
            else {
                int start = i;
                while (!eof() && (Character.isLetterOrDigit(peek()) || peek() == '_' || peek() == '-')) i++;
                if (start == i) throw new IllegalArgumentException("TOML 位置 " + i + " 期望键名");
                parts.add(s.substring(start, i));
            }
            skipInline();
            if (peek() == '.') { i++; continue; }
            break;
        }
        return parts;
    }

    private Object value() {
        char c = peek();
        if (c == '"' || c == '\'') return string();
        if (c == '[') return array();
        if (c == '{') return inlineTable();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        return number();
    }

    private List<Object> array() {
        expect('[');
        List<Object> out = new ArrayList<>();
        skipWs();
        if (peek() == ']') { i++; return out; }
        for (;;) {
            skipWs();
            out.add(value());
            skipWs();
            if (peek() == ',') { i++; continue; }
            if (peek() == ']') { i++; break; }
            throw new IllegalArgumentException("TOML 位置 " + i + " 数组语法错误");
        }
        return out;
    }

    private Map<String, Object> inlineTable() {
        expect('{');
        Map<String, Object> out = new LinkedHashMap<>();
        skipInline();
        if (peek() == '}') { i++; return out; }
        for (;;) {
            skipInline();
            List<String> path = keyPath();
            skipInline();
            expect('=');
            skipInline();
            assign(out, path, value());
            skipInline();
            if (peek() == ',') { i++; continue; }
            if (peek() == '}') { i++; break; }
            throw new IllegalArgumentException("TOML 位置 " + i + " 内联表语法错误");
        }
        return out;
    }

    private Object number() {
        int start = i;
        while (!eof() && (Character.isLetterOrDigit(peek()) || peek() == '_' || peek() == '+' || peek() == '-' || peek() == '.')) i++;
        String raw = s.substring(start, i);
        if (raw.isEmpty()) throw new IllegalArgumentException("TOML 位置 " + start + " 无法解析值");
        String n = raw.replace("_", "");
        if (n.matches("[+-]?\\d+")) return Long.parseLong(n);
        if (n.matches("0x[0-9a-fA-F]+")) return Long.parseLong(n.substring(2), 16);
        if (n.matches("[+-]?\\d*\\.\\d+([eE][+-]?\\d+)?")) return Double.parseDouble(n);
        throw new IllegalArgumentException("TOML 位置 " + start + " 无法解析值: " + raw);
    }

    private String string() {
        char q = peek();
        if (s.startsWith(String.valueOf(q).repeat(3), i)) return multiline(q);
        i++;
        StringBuilder out = new StringBuilder();
        while (!eof() && peek() != q) {
            char c = s.charAt(i++);
            if (q == '"' && c == '\\') out.append(escape());
            else out.append(c);
        }
        expect(q);
        return out.toString();
    }

    private String multiline(char q) {
        i += 3;
        if (peek() == '\r') i++;
        if (peek() == '\n') i++;
        StringBuilder out = new StringBuilder();
        for (;;) {
            if (eof()) throw new IllegalArgumentException("TOML 多行字符串未闭合");
            if (s.startsWith(String.valueOf(q).repeat(3), i)) { i += 3; break; }
            char c = s.charAt(i++);
            if (q == '"' && c == '\\') {
                int j = i;
                while (j < s.length() && (s.charAt(j) == ' ' || s.charAt(j) == '\t')) j++;
                if (j < s.length() && (s.charAt(j) == '\r' || s.charAt(j) == '\n')) {
                    i = j;
                    while (!eof() && (peek() == '\r' || peek() == '\n' || peek() == ' ' || peek() == '\t')) i++;
                    continue;
                }
                i = j;
                out.append(escape());
            } else out.append(c);
        }
        return out.toString();
    }

    private char escape() {
        char c = s.charAt(i++);
        switch (c) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case '"': return '"';
            case '\\': return '\\';
            case 'b': return '\b';
            case 'f': return '\f';
            case 'u': { String h = s.substring(i, i + 4); i += 4; return (char) Integer.parseInt(h, 16); }
            case 'U': { String h = s.substring(i, i + 8); i += 8; return Character.toChars(Integer.parseInt(h, 16))[0]; }
            default: return c;
        }
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asMap(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>();
    }
}
