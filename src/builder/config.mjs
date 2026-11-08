// 配置加载与校验。config/pack.json 是唯一入口。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const DEFAULT_CONFIG = {
  pack: { id: 'mypack', name: '我的整合包', version: null, notes: '' },
  game: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '' },
  paths: { serverDir: '', outDir: 'dist', stateDir: '.autopack' },
  scopes: [
    { id: 'mods', kind: 'mods', source: 'mods', target: 'mods', role: 'required', enabled: true },
  ],
  exclude: [
    '**/*.bak', '**/*.tmp', '**/*.log', '**/.DS_Store', '**/Thumbs.db',
    '**/__pycache__/**', '**/cache/**', '**/logs/**', '**/crash-reports/**',
  ],
  requiredModIds: [],
  policy: { keepUnknownMods: true, deleteOrphans: false, backupBeforeReplace: true },
  mirror: { enabled: true, baseUrl: 'https://mod.mcimirror.top', userAgent: '' },
  pages: {
    project: '', accountId: '', branch: 'main', baseUrl: '',
    maxAssetBytes: 24 * 1024 * 1024,
    chunkBytes: 20 * 1024 * 1024,
    retainVersions: 1,
  },
  concurrency: 4,
};

export async function loadConfig(configPath) {
  const abs = resolve(configPath);
  let raw;
  try { raw = JSON.parse(await readFile(abs, 'utf8')); }
  catch (e) { throw new Error(`读取配置失败 ${abs}: ${e.message}`); }
  return normalizeConfig(raw, dirname(abs));
}

export function normalizeConfig(raw, baseDir) {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), raw || {});
  cfg.__configDir = baseDir;
  cfg.__configPath = resolve(baseDir, 'pack.json');

  if (!cfg.pack.id) throw new Error('配置缺少 pack.id');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(cfg.pack.id)) {
    throw new Error(`pack.id 只能用小写字母/数字/下划线/连字符: ${cfg.pack.id}`);
  }
  if (!Array.isArray(cfg.scopes) || cfg.scopes.length === 0) {
    throw new Error('配置至少需要一个 scope');
  }
  const ids = new Set();
  for (const s of cfg.scopes) {
    if (!s.id) throw new Error('scope 缺少 id');
    if (ids.has(s.id)) throw new Error(`scope id 重复: ${s.id}`);
    ids.add(s.id);
    if (!s.kind) s.kind = 'files';
    if (!['mods', 'files'].includes(s.kind)) throw new Error(`scope ${s.id} kind 只能是 mods/files`);
    if (!s.target) s.target = s.source;
    if (!s.role) s.role = s.kind === 'mods' ? 'required' : 'content';
    if (s.enabled === undefined) s.enabled = true;
    if (!s.include) s.include = [];
    if (!s.exclude) s.exclude = [];
    if (s.mirror === undefined) s.mirror = null;
  }
  if (cfg.paths.serverDir) {
    cfg.paths.serverDir = isAbsolute(cfg.paths.serverDir)
      ? cfg.paths.serverDir
      : resolve(baseDir, cfg.paths.serverDir);
    if (!existsSync(cfg.paths.serverDir)) {
      throw new Error(`paths.serverDir 不存在: ${cfg.paths.serverDir}`);
    }
  }
  cfg.paths.outDir = isAbsolute(cfg.paths.outDir)
    ? cfg.paths.outDir
    : resolve(findProjectRoot(baseDir), cfg.paths.outDir);
  cfg.paths.stateDir = isAbsolute(cfg.paths.stateDir)
    ? cfg.paths.stateDir
    : resolve(findProjectRoot(baseDir), cfg.paths.stateDir);
  if (cfg.pages.maxAssetBytes > 25 * 1024 * 1024) throw new Error('pages.maxAssetBytes 不能超过 25MiB（Pages 硬限制）');
  if (cfg.pages.chunkBytes > cfg.pages.maxAssetBytes) throw new Error('pages.chunkBytes 不能超过 maxAssetBytes');
  if (!cfg.pages.baseUrl && cfg.pages.project) cfg.pages.baseUrl = `https://${cfg.pages.project}.pages.dev`;
  cfg.pages.baseUrl = String(cfg.pages.baseUrl || '').replace(/\/+$/, '');
  return cfg;
}

/** scope.source 可以是相对 serverDir 的路径，也可以是绝对路径。 */
export function scopeSourceDir(cfg, scope) {
  if (isAbsolute(scope.source)) return scope.source;
  if (!cfg.paths.serverDir) throw new Error(`scope ${scope.id} 使用相对路径，但未配置 paths.serverDir`);
  return resolve(cfg.paths.serverDir, scope.source);
}

/** 从配置目录向上找 package.json，作为项目根；找不到就用配置目录。 */
export function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function deepMerge(base, extra) {  if (Array.isArray(extra)) return extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const k of Object.keys(extra)) out[k] = deepMerge(out[k], extra[k]);
    return out;
  }
  return extra === undefined ? base : extra;
}
