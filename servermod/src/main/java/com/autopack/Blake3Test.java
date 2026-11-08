package com.autopack;

/** BLAKE3 自检：对着官方测试向量验证（构建脚本会跑一次）。 */
public final class Blake3Test {
    public static void main(String[] args) {
        int[] lengths = {0, 1, 2, 3, 63, 64, 65, 1023, 1024, 1025, 2048, 3072, 4096, 8192};
        String[] expected = {
                "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
                "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213",
                "7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63",
                "e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f",
                "e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b",
                "4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98",
                "de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee",
                "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11",
                "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7",
                "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444",
                "e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a",
                "b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2",
                "015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969",
                "aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63",
        };
        for (int i = 0; i < lengths.length; i++) {
            byte[] input = new byte[lengths[i]];
            for (int k = 0; k < input.length; k++) input[k] = (byte) (k % 251);
            String got = Blake3.hex(Blake3.hash(input));
            if (!got.equals(expected[i])) {
                System.err.println("BLAKE3 FAIL len=" + lengths[i] + " got=" + got + " want=" + expected[i]);
                System.exit(1);
            }
        }
        // Pages 键：blake3(base64 + 扩展名) 前 32 个十六进制字符
        String key = Blake3.hexPrefix(Blake3.hash("aGVsbG8=".getBytes(java.nio.charset.StandardCharsets.US_ASCII)), 32);
        System.out.println("BLAKE3_OK key_sample=" + key);
    }
}
