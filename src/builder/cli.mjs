#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { buildPack } from './build.mjs';
import { publish } from './publish.mjs';
import { fetchJson } from '../common/http.mjs';
import { mimeFor, formatBytes } from '../common/fsutil.mjs';
import { error, info, ok, step, warn, color } from '../common/log.mjs';

const HELP = `AutoPack 服务端构建器

用法: node src/builder/cli.mjs <命令> [参数]

命令:
  build                 扫描并生成 dist/site（不联网发布）
  publish               把 dist/site 发布到 Cloudflare Pages（wrangler）
  all                   build + publish
  login                 登录 Cloudflare（wrangler login，打开浏览器）
  doctor                检查配置、目录、镜像、wrangler 与登录状态
  serve                 本地预览 dist/site（默认 http://127.0.0.1:8788）
  clean                 清理 dist 与 .autopack

参数:
  --config <path>       配置文件（默认 config/pack.json）
  --scope a,b           只构建指定 scope（可多次，逗号分隔）
  --force               发布时忽略“内容未变”
  --port <n>            serve 端口
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const opts = parseArgs(argv.slice(1));
  const configPath = opts.config
    ? resolve(opts.config)
    : defaultConfigPath();

  switch (cmd) {
    case 'build': {
      const cfg = await loadConfig(configPath);
      const result = await buildPack(cfg, { scopes: opts.scope });
      printSummary(result);
      return;
    }
    case 'publish': {
      const cfg = await loadConfig(configPath);
      await publish(cfg, { force: opts.force });
      return;
    }
    case 'all': {
      const cfg = await loadConfig(configPath);
      const result = await buildPack(cfg, { scopes: opts.scope });
      printSummary(result);
      await publish(cfg, { force: opts.force });
      return;
    }
    case 'doctor': {
      await doctor(configPath);
      return;
    }
    case 'login': {
      let cfg = null;
      try { cfg = await loadConfig(configPath); } catch { /* login 不强依赖配置 */ }
      const { login } = await import('./wrangler.mjs');
      step('登录 Cloudflare');
      const auth = login(cfg, { cwd: process.cwd() });
      ok(`登录成功：${auth.email || '(已获取凭据)'}`);
      if (auth.accountId) info(`账号 ID：${auth.accountId}`);
      return;
    }
    case 'serve': {
      const cfg = await loadConfig(configPath);
      await serve(cfg.paths.outDir, Number(opts.port) || 8788);
      return;
    }
    case 'clean': {
      const cfg = await loadConfig(configPath);
      const { rm } = await import('node:fs/promises');
      await rm(cfg.paths.outDir, { recursive: true, force: true });
      await rm(cfg.paths.stateDir, { recursive: true, force: true });
      ok('已清理 dist 与 .autopack');
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      error(`未知命令: ${cmd}`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

function defaultConfigPath() {
  const exeDir = dirname(process.execPath);
  const candidates = [
    resolve(process.cwd(), 'config', 'pack.json'),
    resolve(exeDir, 'config', 'pack.json'),
    resolve(exeDir, 'pack.json'),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

function parseArgs(args) {  const out = { scope: null, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') out.config = args[++i];
    else if (a === '--scope') out.scope = [...(out.scope || []), ...String(args[++i]).split(',')].filter(Boolean);
    else if (a === '--force') out.force = true;
    else if (a === '--port') out.port = args[++i];
    else if (a.startsWith('--config=')) out.config = a.slice(9);
  }
  return out;
}

function printSummary(result) {
  const { manifest, catalog, stats, latest } = result;
  step('摘要');
  console.log(`  整合包    ${manifest.packName} (${manifest.packId})`);
  console.log(`  版本      ${manifest.version}   ${stats.changed ? color.green('内容有更新') : color.gray('内容未变')}`);
  console.log(`  文件      ${stats.files} 个，共 ${formatBytes(stats.totalBytes)}`);
  console.log(`  镜像直链  ${stats.mirrored} 个（Modrinth 经 MCIM）`);
  console.log(`  自托管    ${stats.hosted} 个（未发布 mod / 自定义范围）`);
  console.log(`  模组元数据 ${stats.mods} 条`);
  console.log(`  站点文件  ${stats.siteFiles} 个（Pages 上限 20000）`);
  if (stats.retainedVersions?.length > 1) console.log(`  保留版本  ${stats.retainedVersions.join(', ')}`);
  console.log(`  清单      ${join('.', 'dist', 'site', latest.manifest)}`);
};

async function doctor(configPath) {
  step('环境检查');
  console.log(`  Node.js   ${process.version}`);
  const cfg = await loadConfig(configPath);
  ok(`配置有效: ${configPath}`);
  console.log(`  来源目录  ${cfg.paths.serverDir || '(未设置)'}`);
  for (const s of cfg.scopes.filter((x) => x.enabled)) {
    console.log(`  scope     ${s.id}  ${s.kind}  ${s.source} → ${s.target}  role=${s.role}`);
  }
  console.log(`  镜像      ${cfg.mirror.enabled ? cfg.mirror.baseUrl : '已关闭'}`);
  console.log(`  Pages     ${cfg.pages.project || '(未设置)'}  ${cfg.pages.baseUrl || ''}`);

  step('镜像连通性');
  try {
    const v = await fetchJson(`${cfg.mirror.baseUrl}/modrinth/v2/project/sodium`, { allow404: true, retries: 0, timeoutMs: 8000 });
    if (v) ok(`MCIM 可用（Sodium: ${v.title}）`);
    else warn('MCIM 返回 404');
  } catch (e) {
    warn(`MCIM 不可达: ${e.message}（构建仍可继续，但所有 mod 会走自托管）`);
  }

  step('发布工具');
  const { wranglerCommand, checkAuth } = await import('./wrangler.mjs');
  const { spawnSync } = await import('node:child_process');
  const bin = wranglerCommand(cfg);
  const ver = spawnSync(`${bin} --version`, { shell: true, encoding: 'utf8', timeout: 60000 });
  if (ver.status === 0) ok(`wrangler: ${(ver.stdout || '').trim().split('\n').pop()}（${bin}）`);
  else warn(`wrangler 不可用（尝试: ${bin}）；运行 npm i -g wrangler，或设置 pages.wranglerCommand`);

  const auth = checkAuth(cfg);
  if (auth.ok) {
    ok(`Cloudflare 已登录${auth.email ? `：${auth.email}` : auth.hasToken ? '（API Token）' : ''}`);
    if (auth.accountId) info(`账号 ID：${auth.accountId}`);
  } else {
    warn('Cloudflare 未登录：运行 `AutoPackBuilder.exe login`，或设置 CLOUDFLARE_API_TOKEN');
  }
}

async function serve(outDir, port) {
  const siteDir = join(outDir, 'site');
  if (!existsSync(siteDir)) throw new Error('dist/site 不存在，请先 build');
  const server = createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel === '/') rel = '/index.html';
      const file = join(siteDir, ...rel.split('/').filter(Boolean));
      if (!resolve(file).startsWith(resolve(siteDir))) { res.writeHead(403).end('forbidden'); return; }
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': mimeFor(file),
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
      });
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e.message));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    ok(`本地预览: http://127.0.0.1:${port}/  （latest.json: http://127.0.0.1:${port}/latest.json）`);
  });
}

main().catch((e) => {
  error(e.message || String(e));
  if (process.env.AUTOPACK_DEBUG) console.error(e);
  process.exitCode = 1;
});
