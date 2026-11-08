// 本地更新器进程：起一个只监听 127.0.0.1 的 HTTP 服务，承载 UI API 与任务调度。
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Updater } from './engine.mjs';
import { renderAppHtml } from './ui.mjs';
import { ensureDir, formatBytes, writeFileAtomic } from '../common/fsutil.mjs';
import { prettyJson } from '../common/json.mjs';

export class ClientApp {
  constructor({ gameDir, config, launcherPath }) {
    this.gameDir = gameDir;
    this.config = config;
    this.launcherPath = launcherPath || null;
    this.phase = 'idle';
    this.message = '';
    this.progress = { current: 0, total: 0, bytes: 0, bytesTotal: 0 };
    this.plan = null;
    this.latest = null;
    this.manifest = null;
    this.localVersion = null;
    this.logs = [];
    this.busy = false;
    this.configPath = join(gameDir, '.autopack', 'client.json');
  }

  log(line) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.logs.push(`[${stamp}] ${line}`);
    if (this.logs.length > 300) this.logs.shift();
  }

  async saveConfig() {
    await ensureDir(join(this.gameDir, '.autopack'));
    await writeFileAtomic(this.configPath, prettyJson({
      baseUrl: this.config.baseUrl || '',
      launcher: this.config.launcher || '',
      packId: this.config.packId || null,
      downloadConcurrency: this.config.downloadConcurrency || 64,
    }));
  }

  createUpdater() {
    return new Updater({
      gameDir: this.gameDir,
      baseUrl: this.config.baseUrl,
      downloadConcurrency: this.config.downloadConcurrency || 64,
      onProgress: (e) => {
        if (e.phase) this.phase = e.phase;
        if (e.message) this.message = e.message;
        if (e.current != null) this.progress = { current: e.current, total: e.total || 0, bytes: e.bytes || 0, bytesTotal: e.bytesTotal || 0, speed: e.speed || 0 };
      },
    });
  }

  async runCheck() {
    if (this.busy) throw new Error('已有任务正在进行');
    this.busy = true;
    this.phase = 'checking';
    this.message = '检查更新…';
    this.progress = { current: 0, total: 0 };
    try {
      const u = this.createUpdater();
      await u.loadLocal();
      this.localVersion = u.state.data.installedVersion;
      const { latest, manifest, plan } = await u.check();
      this.latest = latest;
      this.manifest = manifest;
      this.plan = plan;
      this.upToDate = plan.upToDate;
      this.message = plan.upToDate ? '已是最新版本' : `发现更新：需要下载 ${plan.installs.length} 个文件`;
      this.log(this.message);
      this.phase = plan.upToDate ? 'ready' : 'ready';
    } catch (e) {
      this.phase = 'error';
      this.message = e.message;
      this.log(`错误：${e.message}`);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async runUpdate() {
    if (this.busy) throw new Error('已有任务正在进行');
    if (!this.manifest || !this.plan) await this.runCheck();
    if (this.plan.upToDate) return { skipped: true };
    this.busy = true;
    this.phase = 'downloading';
    try {
      const u = this.createUpdater();
      await u.loadLocal();
      this.log(`开始更新到 ${this.manifest.version}，共 ${formatBytes(this.plan.bytes)}`);
      const result = await u.sync(this.manifest, this.plan);
      this.localVersion = result.version;
      this.upToDate = true;
      this.plan = { ...this.plan, installs: [], bytes: 0, toBackup: [], upToDate: true, warnings: [], orphans: this.plan.orphans, missingRequired: result.missingRequired };
      this.phase = 'done';
      this.message = `更新完成（${result.installed} 个文件）`;
      this.log(this.message);
      return result;
    } catch (e) {
      this.phase = 'error';
      this.message = e.message;
      this.log(`更新失败：${e.message}`);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    const plan = this.plan ? {
      version: this.plan.version,
      bytes: this.plan.bytes,
      installs: this.plan.installs.map((f) => ({ path: f.path, size: f.size, action: f.action, role: f.role })),
      toBackup: this.plan.toBackup.map((b) => ({ path: b.path, reason: b.reason })),
      orphans: this.plan.orphans,
      keptMods: this.plan.keptMods || [],
      warnings: this.plan.warnings,
      missingRequired: this.plan.missingRequired,
      upToDate: this.plan.upToDate,
    } : null;
    return {
      phase: this.phase,
      message: this.message,
      progress: this.progress,
      plan,
      packName: this.manifest?.packName || null,
      packId: this.manifest?.packId || null,
      localVersion: this.localVersion,
      remoteVersion: this.latest?.version || null,
      upToDate: this.upToDate ?? null,
      logs: this.logs.slice(-80),
      config: {
        baseUrl: this.config.baseUrl || '',
        launcher: this.config.launcher || '',
        gameDir: this.gameDir,
      },
    };
  }

  async launchGame() {
    const launcher = this.config.launcher || this.launcherPath;
    if (!launcher) throw new Error('未配置启动器路径，请在“设置”里填写，或用启动器手动启动');
    if (!existsSync(launcher)) throw new Error(`启动器不存在: ${launcher}`);
    this.log(`启动：${launcher}`);
    exec(`"${launcher}"`, { cwd: this.gameDir, windowsHide: false });
  }
}

export function startServer(app, { port = 0, openBrowser = false } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const readBody = () => new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    });

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(200, renderAppHtml(), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, app.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/check') {
        app.runCheck().catch(() => {});
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/update') {
        app.runUpdate().catch(() => {});
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody();
        if (typeof body.baseUrl === 'string') app.config.baseUrl = body.baseUrl.replace(/\/+$/, '');
        if (typeof body.launcher === 'string') app.config.launcher = body.launcher;
        await app.saveConfig();
        app.log('设置已保存');
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/launch') {
        await app.launchGame();
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/open-dir') {
        exec(`explorer "${app.gameDir}"`);
        return send(200, { ok: true });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}/`;
      resolve({ server, url });
    });
  });
}

export async function loadClientConfig(gameDir, defaultsPath) {
  let defaults = {};
  if (defaultsPath && existsSync(defaultsPath)) {
    try { defaults = JSON.parse(await readFile(defaultsPath, 'utf8')); } catch { defaults = {}; }
  }
  const p = join(gameDir, '.autopack', 'client.json');
  let local = {};
  if (existsSync(p)) {
    try { local = JSON.parse(await readFile(p, 'utf8')); } catch { local = {}; }
  }
  return {
    baseUrl: local.baseUrl || defaults.baseUrl || '',
    launcher: local.launcher || defaults.launcher || '',
    packId: local.packId || defaults.packId || null,
    downloadConcurrency: Number(local.downloadConcurrency || defaults.downloadConcurrency || 64),
  };
}
