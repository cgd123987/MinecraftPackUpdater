import { createReadStream } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export function toPosix(p) { return p.split(sep).join('/'); }

/** 相对路径规范化 + 越界检查（防止 ../ 逃逸）。 */
export function safeJoin(root, relPosix) {
  const norm = relPosix.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.split('/').some((seg) => seg === '..')) throw new Error(`非法路径: ${relPosix}`);
  const full = join(root, ...norm.split('/'));
  const r = relative(root, full);
  if (r.startsWith('..') || r.includes(`..${sep}`)) throw new Error(`路径越界: ${relPosix}`);
  return full;
}

export async function walkFiles(root, opts = {}) {
  const { excludeDirs = new Set(['.git', 'node_modules']), followSymlinks = false } = opts;
  const out = [];
  async function rec(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) continue;
        await rec(full);
      } else if (e.isFile()) {
        out.push(full);
      } else if (e.isSymbolicLink() && followSymlinks) {
        const st = await stat(full).catch(() => null);
        if (st?.isFile()) out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

export async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }

export async function writeFileAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await writeFile(tmp, data);
      await rm(filePath, { force: true });
      await rename(tmp, filePath);
      return;
    } catch (e) {
      lastErr = e;
      await rm(tmp, { force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
  // 杀毒软件/索引器短暂占用时兜底：直接写目标文件。
  try {
    await writeFile(filePath, data);
  } catch {
    throw lastErr;
  }
}

export async function copyFileAtomic(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  await cp(src, tmp);
  await rm(dest, { force: true });
  await rename(tmp, dest);
}

export async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export function formatBytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export function timestampCompact(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function timestampLocal(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 简易 glob：支持 ** / * / ?，用于 include/exclude。 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPosix, patterns) {
  for (const p of patterns) {
    if (p.startsWith('!')) continue;
    if (globToRegExp(p).test(relPosix)) return true;
    // "kubejs" 这种目录名等价于 "kubejs/**"
    if (!p.includes('*') && (relPosix === p || relPosix.startsWith(`${p}/`))) return true;
  }
  return false;
}

export function mimeFor(fileName) {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return ({
    jar: 'application/java-archive',
    zip: 'application/zip',
    json: 'application/json',
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    toml: 'text/plain; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    kubejs: 'text/plain; charset=utf-8',
    snbt: 'text/plain; charset=utf-8',
    nbt: 'application/octet-stream',
    ogg: 'audio/ogg',
    mp3: 'audio/mpeg',
    properties: 'text/plain; charset=utf-8',
  })[ext] || 'application/octet-stream';
}
