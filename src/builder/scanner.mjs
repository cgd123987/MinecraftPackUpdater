// 按 scope 扫描待发布文件。scope 决定：来源目录、游戏内目标路径、角色、include/exclude。
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { scopeSourceDir } from './config.mjs';
import { matchesAny, toPosix, walkFiles } from '../common/fsutil.mjs';

export async function scanScopes(cfg, opts = {}) {
  const only = opts.scopes?.length ? new Set(opts.scopes) : null;
  const scopes = cfg.scopes.filter((s) => s.enabled && (!only || only.has(s.id)));
  if (scopes.length === 0) throw new Error('没有启用的 scope（检查配置 enabled 或 --scope 参数）');

  const out = [];
  const problems = [];
  for (const scope of scopes) {
    const srcDir = scopeSourceDir(cfg, scope);
    let st;
    try { st = await stat(srcDir); } catch { st = null; }
    if (!st?.isDirectory()) {
      problems.push(`scope ${scope.id} 的目录不存在: ${srcDir}`);
      continue;
    }
    const files = await walkFiles(srcDir);
    for (const abs of files) {
      const rel = toPosix(relative(srcDir, abs));
      if (rel.split('/').some((seg) => seg.startsWith('.') && seg !== '.')) continue;
      if (matchesAny(rel, cfg.exclude)) continue;
      if (matchesAny(rel, scope.exclude)) continue;
      if (scope.include.length > 0 && !matchesAny(rel, scope.include)) continue;
      if (scope.kind === 'mods' && !/\.jar$/i.test(abs)) continue;
      out.push({
        scopeId: scope.id,
        kind: scope.kind,
        role: scope.role,
        sourceDir: srcDir,
        rel,
        abs,
        target: `${scope.target.replace(/\/+$/, '')}/${rel}`.replace(/^\/+/, ''),
      });
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
  if (out.length === 0) throw new Error('扫描结果为空：检查 scope 的 source/include/exclude');
  return { files: out, scopes };
}
