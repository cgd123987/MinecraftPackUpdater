#!/usr/bin/env node
// AutoPack 客户端入口。默认打开本地 Web UI；--console 走命令行（便于脚本与测试）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { Updater } from './engine.mjs';
import { ClientApp, loadClientConfig, startServer } from './server.mjs';
import { formatBytes } from '../common/fsutil.mjs';
import { error, info, ok, progress, progressDone, warn, color } from '../common/log.mjs';

const HELP = `AutoPack 客户端

用法: AutoPackClient.exe [参数]

  --dir <路径>       游戏目录（默认：exe 所在目录）
  --url <地址>       更新源（默认读取 .autopack/client.json 或 exe 旁的 autopack.json）
  --console          命令行模式，不打开网页
  --check            只检查不更新（隐含 --console）
  --update           命令行模式下直接执行更新
  --no-open          启动 UI 但不自动打开浏览器
  --port <n>         本地 UI 端口（默认随机）
  --threads <n>      下载线程数（默认 64）
  --launcher <路径>  启动器路径
`;

function parseArgs(argv) {
  const o = { console: false, check: false, update: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--console') o.console = true;
    else if (a === '--check') { o.check = true; o.console = true; }
    else if (a === '--update') o.update = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--threads') o.threads = Number(argv[++i]);
    else if (a === '--launcher') o.launcher = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function defaultGameDir() {
  // SEA 打包后 process.execPath 指向 AutoPackClient.exe；开发时是 node.exe。
  const exeName = basename(process.execPath).toLowerCase();
  const isSea = exeName !== 'node.exe' && exeName !== 'node';
  return isSea ? dirname(process.execPath) : process.cwd();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const gameDir = resolve(opts.dir || defaultGameDir());
  const exeDefaults = join(dirname(process.execPath), 'autopack.json');
  const config = await loadClientConfig(gameDir, exeDefaults);
  if (opts.url) config.baseUrl = opts.url.replace(/\/+$/, '');
  if (opts.launcher) config.launcher = opts.launcher;
  if (opts.threads) config.downloadConcurrency = Math.max(1, Number(opts.threads) || 64);

  if (opts.console) {
    await runConsole(gameDir, config, opts);
    return;
  }

  if (!existsSync(gameDir)) throw new Error(`游戏目录不存在: ${gameDir}`);
  const app = new ClientApp({ gameDir, config });
  app.log(`游戏目录：${gameDir}`);
  if (!config.baseUrl) {
    app.log('尚未配置更新源，请在页面“设置”里填写');
  } else {
    app.log(`更新源：${config.baseUrl}`);
  }
  const { url } = await startServer(app, { port: opts.port || 0 });
  console.log('');
  console.log(`  ${color.bold('AutoPack 更新器已启动')}`);
  console.log(`  地址：${color.blue(url)}`);
  console.log(`  游戏目录：${gameDir}`);
  console.log('  关闭本窗口即退出更新器。');
  console.log('');
  if (opts.open) openBrowser(url);
  if (config.baseUrl) app.runCheck().catch(() => {});
}

async function runConsole(gameDir, config, opts) {
  if (!config.baseUrl) throw new Error('未配置更新源：用 --url 指定，或先运行 UI 保存设置');
  info(`游戏目录：${gameDir}`);
  info(`更新源：${config.baseUrl}`);
  const updater = new Updater({
    gameDir,
    baseUrl: config.baseUrl,
    downloadConcurrency: config.downloadConcurrency || 64,
    onProgress: (e) => {
      if (e.total > 0) {
        const parts = [];
        if (e.bytesTotal) parts.push(`${formatBytes(e.bytes)}/${formatBytes(e.bytesTotal)}`);
        if (e.speed > 0) parts.push(`${formatBytes(e.speed)}/s`);
        progress(e.message || '处理中', e.current, e.total, parts.join('  '));
      } else if (e.message) info(e.message);
    },
  });
  await updater.loadLocal();
  const { manifest, plan } = await updater.check();
  progressDone();
  console.log('');
  console.log(`  整合包     ${manifest.packName} (${manifest.packId})`);
  console.log(`  版本       ${manifest.version}`);
  console.log(`  需下载     ${plan.installs.length} 个，共 ${formatBytes(plan.bytes)}`);
  console.log(`  替换旧文件 ${plan.toBackup.length} 个`);
  console.log(`  保留本机   ${plan.orphans.length} 个（不在清单内，不删除）`);
  if (plan.keptMods?.length) {
    console.log(`  自装模组   ${plan.keptMods.length} 个，全部保留：${plan.keptMods.slice(0, 5).map((m) => m.modIds.join('/')).join(', ')}${plan.keptMods.length > 5 ? ' …' : ''}`);
  }
  if (plan.warnings?.length) for (const w of plan.warnings) warn(w);
  if (plan.missingRequired?.length) warn(`缺少必须安装的模组：${plan.missingRequired.join(', ')}`);
  if (plan.upToDate) { ok('已是最新版本'); return; }
  if (!opts.update) {
    info('仅检查（加 --update 执行更新）');
    return;
  }
  const result = await updater.sync(manifest, plan);
  progressDone();
  ok(`更新完成：${result.installed} 个文件，替换 ${result.removed} 个`);
  console.log(`  本地版本   ${result.version}`);
  if (result.backupDir) console.log(`  备份目录   ${result.backupDir}`);
}

function openBrowser(url) {
  if (process.platform !== 'win32') {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('cmd', ['/c', 'start', '""', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

main().catch((e) => {
  progressDone();
  error(e.message || String(e));
  if (process.env.AUTOPACK_DEBUG) console.error(e);
  process.exitCode = 1;
});
