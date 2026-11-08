package com.autopack;

import java.util.List;
import java.util.regex.Pattern;

/** 与 Node 版一致的简易 glob：** 任意层、* 单层、? 单字符；不含通配符的目录名按前缀匹配。 */
public final class Glob {
    private Glob() {}

    public static boolean matchesAny(String relPath, List<String> patterns) {
        for (String p : patterns) {
            if (p == null || p.isEmpty() || p.startsWith("!")) continue;
            if (Pattern.compile(toRegex(p)).matcher(relPath).matches()) return true;
            if (p.indexOf('*') < 0 && p.indexOf('?') < 0
                    && (relPath.equals(p) || relPath.startsWith(p + "/"))) return true;
        }
        return false;
    }

    static String toRegex(String glob) {
        StringBuilder re = new StringBuilder("^");
        for (int i = 0; i < glob.length(); i++) {
            char c = glob.charAt(i);
            if (c == '*') {
                if (i + 1 < glob.length() && glob.charAt(i + 1) == '*') {
                    re.append(".*");
                    i++;
                    if (i + 1 < glob.length() && glob.charAt(i + 1) == '/') i++;
                } else re.append("[^/]*");
            } else if (c == '?') re.append("[^/]");
            else if ("\\^$.|+()[]{}".indexOf(c) >= 0) re.append('\\').append(c);
            else re.append(c);
        }
        return re.append('$').toString();
    }
}
