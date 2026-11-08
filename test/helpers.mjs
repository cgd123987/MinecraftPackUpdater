// 测试辅助：生成最小合法 jar（ZIP store 模式）、临时目录、本地静态服务器。
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeFor } from '../src/common/fsutil.mjs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: { "META-INF/neoforge.mods.toml": "text" | Buffer } */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export function modsToml({ modId, name, version = '1.0.0', description = 'test mod', displayURL, license = 'MIT' }) {
  return `modLoader="javafml"
loaderVersion="[4,)"
license="${license}"

[[mods]]
modId="${modId}"
version="${version}"
displayName="${name}"
authors="tester"
${displayURL ? `displayURL="${displayURL}"` : ''}
description='''${description}'''
`;
}

export async function makeTempDir(prefix = 'autopack-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeJar(dir, fileName, entries) {
  await mkdir(dir, { recursive: true });
  const p = join(dir, fileName);
  await writeFile(p, makeZip(entries));
  return p;
}

/** 启动一个只读静态服务器（模拟 Cloudflare Pages）。 */
export async function serveDir(root) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(root, ...path.split('/').filter(Boolean));
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export function baseConfig(overrides = {}) {
  return {
    pack: { id: 'testpack', name: '测试包' },
    game: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.265' },
    paths: { outDir: 'dist', stateDir: '.autopack' },
    scopes: [
      { id: 'mods', kind: 'mods', source: 'mods', target: 'mods', role: 'required', enabled: true },
    ],
    requiredModIds: [],
    mirror: { enabled: false },
    pages: { project: 'test', branch: 'main', baseUrl: 'http://127.0.0.1:1', retainVersions: 0 },
    concurrency: 2,
    ...overrides,
  };
}
