package com.autopack;

/**
 * 纯 Java 实现的 BLAKE3（仅 32 字节输出）。
 * Cloudflare Pages 的资源键 = blake3(base64(文件内容) + 扩展名) 的十六进制前 32 位，
 * 所以这里必须自己实现（不能用 SHA-256 代替）。
 */
public final class Blake3 {
    private static final int[] IV = {
            0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
            0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19};

    private static final int CHUNK_START = 1, CHUNK_END = 2, PARENT = 4, ROOT = 8;
    private static final int BLOCK_LEN = 64, CHUNK_LEN = 1024;

    private static final byte[] MSG_PERMUTATION = {2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8};

    private Blake3() {}

    public static byte[] hash(byte[] input) {
        int len = input.length;
        if (len <= CHUNK_LEN) return chunkOutput(input, 0, 0, len).rootHash();

        java.util.ArrayDeque<byte[]> stack = new java.util.ArrayDeque<>();
        int chunkIndex = 0;
        int offset = 0;
        while (len - offset > CHUNK_LEN) {
            byte[] cv = chunkOutput(input, offset, chunkIndex, CHUNK_LEN).chainingValue();
            long total = (long) chunkIndex + 1;
            while ((total & 1) == 0) {
                byte[] left = stack.pop();
                cv = parentOutput(left, cv).chainingValue();
                total >>= 1;
            }
            stack.push(cv);
            chunkIndex++;
            offset += CHUNK_LEN;
        }
        int lastLen = len - offset;
        Output output = chunkOutput(input, offset, chunkIndex, lastLen);
        while (!stack.isEmpty()) {
            output = parentOutput(stack.pop(), output.chainingValue());
        }
        return output.rootHash();
    }

    private static Output chunkOutput(byte[] input, int offset, int counter, int len) {
        int[] cv = IV.clone();
        int blocks = len / BLOCK_LEN;
        int lastLen = len - blocks * BLOCK_LEN;
        // 长度是 64 的整数倍时，最后一块仍然是完整块
        if (len > 0 && lastLen == 0) {
            blocks--;
            lastLen = BLOCK_LEN;
        }
        int[] block = new int[16];
        for (int i = 0; i < blocks; i++) {
            toWords(input, offset + i * BLOCK_LEN, BLOCK_LEN, block);
            int flags = (i == 0) ? CHUNK_START : 0;
            cv = compress(cv, block, counter, BLOCK_LEN, flags, 0);
        }
        toWords(input, offset + blocks * BLOCK_LEN, Math.max(0, lastLen), block);
        int flags = CHUNK_END | (blocks == 0 ? CHUNK_START : 0);
        return new Output(cv, block, counter, Math.max(0, lastLen), flags);
    }

    private static Output parentOutput(byte[] leftCv, byte[] rightCv) {
        int[] block = new int[16];
        for (int i = 0; i < 8; i++) {
            block[i] = leInt(leftCv, i * 4);
            block[i + 8] = leInt(rightCv, i * 4);
        }
        return new Output(IV.clone(), block, 0, BLOCK_LEN, PARENT);
    }

    private static final class Output {
        final int[] cv;
        final int[] block;
        final int counter;
        final int blockLen;
        final int flags;

        Output(int[] cv, int[] block, int counter, int blockLen, int flags) {
            this.cv = cv; this.block = block; this.counter = counter; this.blockLen = blockLen; this.flags = flags;
        }

        byte[] chainingValue() {
            int[] words = compress(cv, block, counter, blockLen, flags, 0);
            byte[] out = new byte[32];
            for (int i = 0; i < 8; i++) putLe(out, i * 4, words[i]);
            return out;
        }

        byte[] rootHash() {
            int[] words = compress(cv, block, 0, blockLen, flags | ROOT, 0);
            byte[] out = new byte[32];
            for (int i = 0; i < 8; i++) putLe(out, i * 4, words[i]);
            return out;
        }
    }

    private static int[] compress(int[] cv, int[] block, int counter, int blockLen, int flags, int flagsExtra) {
        int[] s = new int[16];
        System.arraycopy(cv, 0, s, 0, 8);
        s[8] = IV[0]; s[9] = IV[1]; s[10] = IV[2]; s[11] = IV[3];
        s[12] = counter;
        s[13] = 0; // counter 高 32 位（本项目输入远小于 4GB）
        s[14] = blockLen;
        s[15] = flags | flagsExtra;
        int[] m = block.clone();
        for (int round = 0; round < 7; round++) {
            round(s, m);
            if (round != 6) m = permute(m);
        }
        int[] out = new int[16];
        for (int i = 0; i < 8; i++) {
            out[i] = s[i] ^ s[i + 8];
            out[i + 8] = s[i + 8] ^ cv[i];
        }
        return out;
    }

    private static void round(int[] s, int[] m) {
        g(s, 0, 4, 8, 12, m[0], m[1]);
        g(s, 1, 5, 9, 13, m[2], m[3]);
        g(s, 2, 6, 10, 14, m[4], m[5]);
        g(s, 3, 7, 11, 15, m[6], m[7]);
        g(s, 0, 5, 10, 15, m[8], m[9]);
        g(s, 1, 6, 11, 12, m[10], m[11]);
        g(s, 2, 7, 8, 13, m[12], m[13]);
        g(s, 3, 4, 9, 14, m[14], m[15]);
    }

    private static void g(int[] s, int a, int b, int c, int d, int x, int y) {
        s[a] = s[a] + s[b] + x;
        s[d] = Integer.rotateRight(s[d] ^ s[a], 16);
        s[c] = s[c] + s[d];
        s[b] = Integer.rotateRight(s[b] ^ s[c], 12);
        s[a] = s[a] + s[b] + y;
        s[d] = Integer.rotateRight(s[d] ^ s[a], 8);
        s[c] = s[c] + s[d];
        s[b] = Integer.rotateRight(s[b] ^ s[c], 7);
    }

    private static int[] permute(int[] m) {
        int[] out = new int[16];
        for (int i = 0; i < 16; i++) out[i] = m[MSG_PERMUTATION[i]];
        return out;
    }

    private static void toWords(byte[] in, int off, int len, int[] out) {
        java.util.Arrays.fill(out, 0);
        for (int i = 0; i < len; i++) {
            out[i >> 2] |= (in[off + i] & 0xff) << ((i & 3) * 8);
        }
    }

    private static int leInt(byte[] b, int off) {
        return (b[off] & 0xff) | ((b[off + 1] & 0xff) << 8) | ((b[off + 2] & 0xff) << 16) | ((b[off + 3] & 0xff) << 24);
    }

    private static void putLe(byte[] out, int off, int v) {
        out[off] = (byte) v;
        out[off + 1] = (byte) (v >>> 8);
        out[off + 2] = (byte) (v >>> 16);
        out[off + 3] = (byte) (v >>> 24);
    }

    public static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        return sb.toString();
    }

    public static String hexPrefix(byte[] b, int chars) {
        return hex(b).substring(0, chars);
    }
}
