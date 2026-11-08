// 扫描本地 mods/*.jar 的 modId，用于：
//  1) 找出“同一 mod 的旧版本”并替换；
//  2) 校验必须安装的 mod（如 sodium）；
//  3) 判断玩家自装 mod 是否要保留。
// 带磁盘缓存（按 路径+大小+mtime），避免每次启动都解压 300 个 jar。
import { readFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readModJar } from '../builder/modmeta.mjs';
import { prettyJson } from '../common/json.mjs';
import { ensureDir, toPosix, writeFileAtomic } from '../common/fsutil.mjs';

export class ModIndex {
  constructor(gameDir) {
    this.gameDir = gameDir;
    this.modsDir = join(gameDir, 'mods');
    this.cachePath = join(gameDir, '.autopack', 'mods-index.json');
    this.cache = {};
    this.byModId = new Map();
    this.byPath = new Map();
  }

  async load() {
    try { this.cache = JSON.parse(await readFile(this.cachePath, 'utf8')); } catch { this.cache = {}; }
    return this;
  }

  async scan() {
    let names = [];
    try { names = await readdir(this.modsDir); } catch { return this; }
    const nextCache = {};
    for (const name of names) {
      if (!/\.jar(\.disabled)?$/i.test(name)) continue;
      const abs = join(this.modsDir, name);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) continue;
      const rel = toPosix(relative(this.gameDir, abs));
      const key = `${rel}|${st.size}|${Math.floor(st.mtimeMs)}`;
      const cached = this.cache[key];
      let entry;
      if (cached) {
        entry = { ...cached, path: rel };
      } else {
        let ids = [];
        let names_ = [];
        try {
          const info = readModJar(abs);
          ids = (info.mods || []).map((m) => m.modId).filter(Boolean);
          names_ = (info.mods || []).map((m) => m.name).filter(Boolean);
        } catch { /* 损坏的 jar 忽略 */ }
        entry = { path: rel, modIds: ids, names: names_, size: st.size, mtime: Math.floor(st.mtimeMs) };
      }
      nextCache[key] = { modIds: entry.modIds, names: entry.names, size: entry.size, mtime: entry.mtime };
      this.byPath.set(rel, entry);
      for (const id of entry.modIds) {
        if (!this.byModId.has(id)) this.byModId.set(id, []);
        this.byModId.get(id).push(entry);
      }
    }
    this.cache = nextCache;
    await ensureDir(join(this.gameDir, '.autopack'));
    await writeFileAtomic(this.cachePath, prettyJson(nextCache));
    return this;
  }

  /** 某 modId 对应的所有本地 jar（一般是旧版本或重复）。 */
  find(modId) { return this.byModId.get(modId) || []; }

  allModIds() { return new Set(this.byModId.keys()); }

  entries() { return [...this.byPath.values()]; }
}
