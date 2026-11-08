package com.autopack;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public final class HashUtil {
    private HashUtil() {}

    public static String sha256Hex(byte[] data) { return digest("SHA-256", data); }
    public static String sha1Hex(byte[] data) { return digest("SHA-1", data); }

    public static String sha256Hex(String text) { return sha256Hex(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }

    public static String[] fileHashes(Path file) throws IOException {
        MessageDigest s1 = md("SHA-1");
        MessageDigest s256 = md("SHA-256");
        byte[] buf = new byte[1 << 16];
        try (InputStream in = Files.newInputStream(file)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                s1.update(buf, 0, n);
                s256.update(buf, 0, n);
            }
        }
        return new String[]{hex(s1.digest()), hex(s256.digest())};
    }

    public static String fileSha256(Path file) throws IOException {
        MessageDigest md = md("SHA-256");
        byte[] buf = new byte[1 << 16];
        try (InputStream in = Files.newInputStream(file)) {
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    private static String digest(String algo, byte[] data) { return hex(md(algo).digest(data)); }

    private static MessageDigest md(String algo) {
        try { return MessageDigest.getInstance(algo); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        return sb.toString();
    }
}
