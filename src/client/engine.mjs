// 客户端同步引擎：检查更新 → 计算差异（modId 级）→ 下载/分片合并/校验 → 备份并落位。
// 设计原则：
//  - 只动“清单里的文件”和“state 里记录过的文件”；
//  - 玩家自装、且不影响进服的 mod 永不删除；
//  - 被替换/移除的文件先备份，失败可回滚；
//  - 落位采用 临时文件 + 重命名，避免写坏。
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { fetchJson, downloadFile, DEFAULT_UA } from '../common/http.mjs';
import { mapLimit } from '../common/async.mjs';
import { sha256, hashFile } from '../common/hash.mjs';
import { ensureDir, safeJoin, timestampLocal } from '../common/fsutil.mjs';
import { ClientState } from './state.mjs';
import { ModIndex } from './modindex.mjs';

export class Updater {
  constructor(opts) {
    this.gameDir = opts.gameDir;
    this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    this.userAgent = opts.userAgent || DEFAULT_UA;
    this.onProgress = opts.onProgress || (() => {});
    this.keepUnknownMods = opts.keepUnknownMods !== false;
    this.deleteOrphans = opts.deleteOrphans === true;
    this.downloadConcurrency = Math.max(1, Number(opts.downloadConcurrency) || 64);
    this.state = new ClientState(opts.gameDir);
    this.modIndex = new ModIndex(opts.gameDir);
    this.manifest = null;
    this.latest = null;
  }

  async loadLocal() {
    await this.state.load();
    await this.modIndex.load();
    return this;
  }

  async check() {
    if (!this.baseUrl) throw new Error('未配置更新源地址');
    this.onProgress({ phase: 'check', message: '检查更新…' });
    const latest = await fetchJson(`${this.baseUrl}/latest.json?t=${Date.now()}`, {
      retries: 2, userAgent: this.userAgent, timeoutMs: 15000,
    });
    if (!latest?.manifest) throw new Error('更新源返回的 latest.json 不合法');
    this.latest = latest;

    const manifestUrl = new URL(latest.manifest, `${this.baseUrl}/`).toString();
    const res = await fetch(manifestUrl, { headers: { 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`下载清单失败: HTTP ${res.status}`);
    const text = await res.text();
    if (latest.manifestSha256) {
      const got = sha256(Buffer.from(text, 'utf8'));
      if (got !== latest.manifestSha256) throw new Error('清单校验失败（内容与 latest.json 记录不符），请稍后重试');
    }
    this.manifest = JSON.parse(text);
    const plan = await this.plan(this.manifest);
    return { latest: this.latest, manifest: this.manifest, plan };
  }

  async plan(manifest) {
    await this.modIndex.scan();
    const installs = [];
    const unchanged = [];
    const toBackup = [];
    const warnings = [];

    const manifestPaths = new Set(manifest.files.map((f) => f.path));
    const manifestModIds = new Set();
    for (const f of manifest.files) for (const m of f.mods || []) if (m.modId) manifestModIds.add(m.modId);

    for (const f of manifest.files) {
      if (this.state.data.optOut?.includes(f.path)) { unchanged.push({ ...f, reason: 'opt-out' }); continue; }
      const dst = safeJoin(this.gameDir, f.path);
      const st = await stat(dst).catch(() => null);
      if (!st?.isFile()) { installs.push({ ...f, action: 'install' }); continue; }
      const known = this.state.getFile(f.path);
      let same = false;
      if (known?.sha256 === f.sha256 && known.size === f.size && st.size === f.size) {
        same = true;
      } else if (st.size === f.size) {
        same = (await hashFile(dst)) === f.sha256;
      }
      if (same) { unchanged.push({ ...f, reason: 'up-to-date' }); continue; }
      installs.push({ ...f, action: known ? 'update' : 'replace' });
    }

    // 同一 modId 的本地旧版本：无论本次是否需要下载，都先备份移除，避免一个 mod 两份。
    const backupSet = new Map();
    for (const f of manifest.files) {
      for (const m of f.mods || []) {
        if (!m.modId) continue;
        for (const local of this.modIndex.find(m.modId)) {
          if (local.path === f.path) continue;
          if (this.state.data.optOut?.includes(local.path)) continue;
          const covered = local.modIds.every((id) => manifestModIds.has(id));
          if (!covered) {
            warnings.push(`保留 ${local.path}：它还提供了清单外的 modId（删除可能影响其它模组）`);
            continue;
          }
          if (!backupSet.has(local.path)) backupSet.set(local.path, local);
        }
      }
    }
    for (const local of backupSet.values()) toBackup.push({ path: local.path, reason: 'duplicate-modid' });

    // state 中记录过、但新清单里没有的文件：默认保留（不删玩家东西）。
    const orphans = [];
    for (const p of Object.keys(this.state.data.files)) {
      if (manifestPaths.has(p)) continue;
      if (backupSet.has(p)) continue;
      orphans.push(p);
    }
    if (this.deleteOrphans) for (const p of orphans) toBackup.push({ path: p, reason: 'orphan' });

    // 必须安装的 mod 是否齐全
    const required = manifest.requiredModIds || [];
    const present = new Set(this.modIndex.allModIds());
    for (const o of toBackup) {
      const entry = this.modIndex.byPath.get(o.path);
      for (const id of entry?.modIds || []) {
        const remaining = (this.modIndex.find(id) || []).some((e) => e.path !== o.path)
          || installs.some((f) => (f.mods || []).some((m) => m.modId === id));
        if (!remaining) present.delete(id);
      }
    }
    for (const f of installs) for (const m of f.mods || []) if (m.modId) present.add(m.modId);
    const missingRequired = required.filter((id) => !present.has(id));

    const bytes = installs.reduce((s, f) => s + (f.size || 0), 0);
    // 玩家自装、且清单完全不认识的 mod：明确列出来，让玩家知道“不会被删”。
    const keptMods = this.modIndex.entries()
      .filter((e) => !manifestPaths.has(e.path) && !backupSet.has(e.path)
        && e.modIds.length > 0 && e.modIds.every((id) => !manifestModIds.has(id)))
      .map((e) => ({ path: e.path, modIds: e.modIds }));
    return {
      version: manifest.version,
      installs,
      unchanged,
      toBackup,
      orphans: orphans.filter((p) => !toBackup.some((b) => b.path === p)),
      keptMods,
      warnings,
      missingRequired,
      bytes,
      upToDate: installs.length === 0 && toBackup.length === 0,
    };
  }

  async sync(manifest, plan, opts = {}) {
    const version = manifest.version;
    const stagingDir = join(this.gameDir, '.autopack', 'staging', version);
    await ensureDir(stagingDir);

    if (plan.installs.length) {
      const need = plan.bytes + 64 * 1024 * 1024;
      const fsInfo = await statfs(this.gameDir).catch(() => null);
      if (fsInfo && fsInfo.bavail * fsInfo.bsize < need) {
        throw new Error(`磁盘空间不足：需要约 ${Math.ceil(need / 1048576)}MB，可用 ${Math.floor((fsInfo.bavail * fsInfo.bsize) / 1048576)}MB`);
      }
    }

    const total = plan.installs.length;
    const staged = new Map();

    // 同一份内容（sha256）只下载一次；不同路径共用 staging 文件。
    const unique = new Map();
    for (const f of plan.installs) if (!unique.has(f.sha256)) unique.set(f.sha256, f);

    let doneFiles = 0;
    let doneBytes = 0;
    let speed = 0;
    let sampleBytes = 0;
    let sampleAt = Date.now();
    const sampleSpeed = () => {
      const now = Date.now();
      const dt = (now - sampleAt) / 1000;
      if (dt < 0.25) return speed;
      const inst = Math.max(0, doneBytes - sampleBytes) / dt;
      speed = speed > 0 ? speed * 0.6 + inst * 0.4 : inst;
      sampleBytes = doneBytes;
      sampleAt = now;
      return speed;
    };
    this.onProgress({
      phase: 'download', current: 0, total, bytes: 0, bytesTotal: plan.bytes, speed: 0,
      message: `并行下载 ${unique.size} 个文件（${this.downloadConcurrency} 线程）`,
    });

    await mapLimit([...unique.values()], this.downloadConcurrency, async (f) => {
      const bin = join(stagingDir, `${f.sha256}.bin`);
      let fileLoaded = 0;
      if (!(await matches(bin, f.sha256, f.size))) {
        await this.downloadEntry(f, bin, (loaded) => {
          const delta = Math.max(0, loaded - fileLoaded);
          fileLoaded = loaded;
          doneBytes += delta;
          const sp = sampleSpeed();
          this.onProgress({
            phase: 'download', current: doneFiles, total, bytes: Math.min(doneBytes, plan.bytes), bytesTotal: plan.bytes,
            speed: sp, message: `下载 ${f.path}`,
          });
        });
      }
      if (!(await matches(bin, f.sha256, f.size))) {
        throw new Error(`文件校验失败: ${f.path}`);
      }
      staged.set(f.path, bin);
      doneBytes += Math.max(0, (f.size || 0) - fileLoaded);
      fileLoaded = f.size || 0;
      doneFiles++;
      this.onProgress({
        phase: 'download', current: doneFiles, total, bytes: Math.min(doneBytes, plan.bytes), bytesTotal: plan.bytes,
        speed: sampleSpeed(), message: `已完成 ${doneFiles}/${total}`,
      });
    });

    for (const f of plan.installs) {
      if (!staged.has(f.path)) staged.set(f.path, join(stagingDir, `${f.sha256}.bin`));
    }

    this.onProgress({ phase: 'apply', current: 0, total: plan.installs.length + plan.toBackup.length, message: '备份旧文件…' });
    const backupDir = join(this.gameDir, '.autopack', 'backup', timestampLocal());
    let applied = 0;
    for (const b of plan.toBackup) {
      const src = safeJoin(this.gameDir, b.path);
      const exists = await stat(src).catch(() => null);
      if (exists?.isFile()) {
        const dest = join(backupDir, ...b.path.split('/'));
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
        await rm(src, { force: true });
        this.state.removeFile(b.path);
      }
      applied++;
    }

    for (const f of plan.installs) {
      const dst = safeJoin(this.gameDir, f.path);
      const st = await stat(dst).catch(() => null);
      if (st?.isFile()) {
        const dest = join(backupDir, ...f.path.split('/'));
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(dst, dest).catch(() => {});
      }
      await mkdir(dirname(dst), { recursive: true });
      const tmp = `${dst}.autopack-tmp`;
      await rm(tmp, { force: true });
      await copyFile(staged.get(f.path), tmp);
      try {
        await rename(tmp, dst);
      } catch (e) {
        await rm(tmp, { force: true });
        if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
          throw new Error(`无法写入 ${f.path}：文件被占用。请关闭游戏后再更新。`);
        }
        throw e;
      }
      this.state.setFile(f.path, { sha256: f.sha256, size: f.size, installedAt: new Date().toISOString() });
      applied++;
      await this.state.save();
      this.onProgress({
        phase: 'apply', current: applied, total: plan.installs.length + plan.toBackup.length,
        message: `应用 ${f.path}`,
      });
    }

    // 清理 state 里“已不在清单、但保留在磁盘”的记录，避免下次误判
    for (const p of plan.orphans || []) this.state.removeFile(p);

    this.state.data.packId = manifest.packId;
    this.state.data.installedVersion = version;
    this.state.data.lastSyncAt = new Date().toISOString();
    this.state.data.lastResult = 'success';
    await this.state.save();

    await rm(stagingDir, { recursive: true, force: true });
    this.onProgress({ phase: 'done', current: 1, total: 1, message: '更新完成' });
    return {
      installed: plan.installs.length,
      removed: plan.toBackup.length,
      kept: plan.orphans.length,
      version,
      backupDir: plan.toBackup.length ? backupDir : null,
      missingRequired: plan.missingRequired,
    };
  }

  async downloadEntry(f, destBin, onProgress) {
    if (f.parts?.length) {
      const origin = new URL(f.source.url).origin;
      const partsDir = `${destBin}.parts`;
      await ensureDir(partsDir);
      const partFiles = [];
      let loadedTotal = 0;
      for (const part of f.parts) {
        const partUrl = `${origin}/${part.path.replace(/^\/+/, '')}`;
        const partPath = join(partsDir, `part${String(part.index).padStart(2, '0')}`);
        if (!(await matches(partPath, part.sha256, part.size))) {
          await downloadFile(partUrl, partPath, {
            expectedSize: part.size, userAgent: this.userAgent, timeoutMs: 300000,
            onProgress: (n) => onProgress(loadedTotal + n, f.size),
          });
        }
        if (!(await matches(partPath, part.sha256, part.size))) throw new Error(`分片校验失败: ${part.path}`);
        partFiles.push(partPath);
        loadedTotal += part.size;
      }
      const out = createWriteStream(destBin);
      for (const p of partFiles) {
        for await (const chunk of createReadStream(p)) {
          if (!out.write(chunk)) await once(out, 'drain');
        }
      }
      await new Promise((resolve, reject) => {
        out.end((err) => (err ? reject(err) : resolve()));
        out.once('error', reject);
      });
      await rm(partsDir, { recursive: true, force: true });
      return;
    }

    const urls = [f.source.url, ...(f.source.fallbacks || [])].filter(Boolean);
    let lastErr;
    for (const url of urls) {
      try {
        await downloadFile(url, destBin, {
          expectedSize: f.size, userAgent: this.userAgent,
          onProgress: (n) => onProgress(n, f.size),
          retries: 1, timeoutMs: 120000,
        });
        return;
      } catch (e) {
        lastErr = e;
        this.onProgress({ phase: 'download', message: `源不可用，尝试下一个：${new URL(url).host}` });
      }
    }
    throw new Error(`下载失败 ${f.path}: ${lastErr?.message || '所有源都不可用'}`);
  }
}

async function matches(filePath, expectedSha, expectedSize) {
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) return false;
  if (expectedSize != null && st.size !== expectedSize) return false;
  return (await hashFile(filePath)) === expectedSha;
}
