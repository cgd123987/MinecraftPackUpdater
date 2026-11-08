// 构建主流程：扫描 → 哈希/元数据 → 镜像解析 → 决定托管方式 → 生成清单/版权页/站点。
import { copyFile, link, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mapLimit } from '../common/async.mjs';
import { hashFileBoth, sha256 } from '../common/hash.mjs';
import { prettyJson, stableStringify } from '../common/json.mjs';
import { ensureDir, formatBytes, writeFileAtomic } from '../common/fsutil.mjs';
import { scanScopes } from './scanner.mjs';
import { readModJar } from './modmeta.mjs';
import { ModrinthResolver, ResolveCache } from './resolve.mjs';
import { buildCatalog, renderCatalogHtml, renderIndexHtml } from './catalog.mjs';
import { step, info, warn, ok, progress, progressDone } from '../common/log.mjs';

const MAX_DESC = 400;

export async function buildPack(cfg, opts = {}) {
  const t0 = Date.now();
  step('1/6 扫描更新范围');
  const { files, scopes } = await scanScopes(cfg, opts);
  info(`scope: ${scopes.map((s) => `${s.id}(${s.kind})`).join(', ')}`);
  info(`待处理文件 ${files.length} 个`);
  if (!cfg.pages.project && !cfg.pages.baseUrl) {
    warn('未配置 pages.project / pages.baseUrl：清单里的自托管下载地址会是占位符（仅适合本地测试）');
  }

  const byTarget = new Map();  for (const f of files) {
    if (byTarget.has(f.target)) {
      const other = byTarget.get(f.target);
      throw new Error(`目标路径冲突: ${f.target}\n  - ${other.scopeId}\n  - ${f.scopeId}\n请调整 scope.target 或 exclude`);
    }
    byTarget.set(f.target, f);
  }

  step('2/6 计算哈希并读取 mod 元数据');
  let done = 0;
  const entries = await mapLimit(files, cfg.concurrency, async (f) => {
    const st = await stat(f.abs);
    const hashes = await hashFileBoth(f.abs);
    let modInfo = null;
    if (f.kind === 'mods') {
      try { modInfo = readModJar(f.abs); }
      catch (e) { warn(`读取 ${f.rel} 元数据失败: ${e.message}`); modInfo = null; }
    }
    done++;
    progress('哈希', done, files.length, f.rel.slice(-40));
    return { ...f, size: st.size, ...hashes, modInfo };
  });
  progressDone();

  step('3/6 通过镜像解析 Modrinth 发布信息');
  const resolver = new ModrinthResolver({
    baseUrl: cfg.mirror.baseUrl,
    userAgent: cfg.mirror.userAgent || undefined,
    cache: await loadResolveCache(cfg),
  });
  if (cfg.mirror.enabled) {
    const scopeById = new Map(scopes.map((s) => [s.id, s]));
    const jars = entries.filter((e) => e.kind === 'mods' && scopeById.get(e.scopeId)?.mirror?.enabled !== false);
    const skipped = entries.filter((e) => e.kind === 'mods').length - jars.length;
    if (skipped) info(`${skipped} 个 scope 关闭了镜像解析，按自托管处理`);
    let n = 0;
    await mapLimit(jars, Math.min(4, cfg.concurrency), async (e) => {
      try { e.remote = await resolver.resolveBySha1(e.sha1); }
      catch (err) { warn(`解析失败 ${e.rel}: ${err.message}`); e.remote = null; }
      n++;
      progress('解析', n, jars.length, e.rel.slice(-40));
    });
    progressDone();
    info(`Modrinth 命中 ${resolver.stats.hit} / 未发布 ${resolver.stats.miss} / 缓存 ${resolver.stats.cached}`);
  } else {
    info('镜像解析已关闭（mirror.enabled=false），所有文件自托管');
  }
  await saveResolveCache(cfg, resolver);

  step('4/6 决定托管方式并准备对象存储');
  const stateDir = cfg.paths.stateDir;
  const objectDir = join(stateDir, 'objects');
  await ensureDir(objectDir);

  const manifestFiles = [];
  let hosted = 0, mirrored = 0, totalBytes = 0;
  for (const e of entries) {
    const meta = toModManifest(e.modInfo);
    const base = {
      path: e.target,
      scope: e.scopeId,
      role: e.role,
      size: e.size,
      sha1: e.sha1,
      sha256: e.sha256,
      mods: meta,
    };
    if (e.remote) {
      mirrored++;
      base.source = {
        kind: 'mirror',
        url: e.remote.url,
        fallbacks: e.remote.fallbacks,
        provider: 'modrinth',
        projectId: e.remote.projectId,
        projectSlug: e.remote.projectSlug,
        versionNumber: e.remote.versionNumber,
      };
    } else {
      hosted++;
      const obj = join(objectDir, e.sha256);
      if (!existsSync(obj)) {
        await copyFile(e.abs, obj);
      }
      base.source = { kind: 'pages', path: contentPath(e.sha256, e.target), url: '' };
      if (e.size > cfg.pages.maxAssetBytes) {
        base.parts = await computeParts(e.abs, cfg.pages.chunkBytes, e.sha256);
        info(`分片: ${e.target} → ${base.parts.length} 片`);
      }
    }
    totalBytes += e.size;
    manifestFiles.push(base);
  }

  // 目标路径 → 是否必须存在于客户端；requiredModIds 校验
  const providedModIds = new Set();
  for (const f of manifestFiles) for (const m of f.mods || []) if (m.modId) providedModIds.add(m.modId);
  const missingRequired = (cfg.requiredModIds || []).filter((id) => !providedModIds.has(id));
  if (missingRequired.length) {
    throw new Error(
      `requiredModIds 里的模组没有出现在更新范围中: ${missingRequired.join(', ')}\n`
      + `请检查对应 mod 是否在 scope 内（提示：把客户端专属 mod 目录也配成一个 scope）。`,
    );
  }

  step('5/6 生成清单与版权页');
  const prevLatest = await readJsonIfExists(join(stateDir, 'latest.json'));
  const prevManifest = prevLatest
    ? await readJsonIfExists(join(stateDir, 'versions', prevLatest.version, 'manifest.json'))
    : null;

  const contentHash = computeContentHash(cfg, manifestFiles);
  let version, publishedAt;
  if (prevManifest && prevManifest.contentHash === contentHash && !cfg.pack.version) {
    version = prevManifest.version;
    publishedAt = prevManifest.publishedAt;
    info(`内容无变化，沿用版本 ${version}`);
  } else {
    version = cfg.pack.version || `${dateStamp()}-${contentHash.slice(0, 8)}`;
    publishedAt = new Date().toISOString();
  }

  const manifest = {
    schema: 1,
    packId: cfg.pack.id,
    packName: cfg.pack.name,
    version,
    contentHash,
    publishedAt,
    notes: cfg.pack.notes || '',
    baseUrl: cfg.pages.baseUrl || '',
    game: cfg.game,
    policy: cfg.policy,
    requiredModIds: cfg.requiredModIds || [],
    chunkBytes: cfg.pages.chunkBytes,
    scopes: scopes.map((s) => ({ id: s.id, kind: s.kind, dir: s.target, role: s.role })),
    files: manifestFiles,
  };
  for (const f of manifest.files) {
    if (f.source.kind === 'pages') f.source.url = siteUrl(cfg, f.source.path);
  }

  const manifestText = prettyJson(manifest);
  const manifestSha256 = sha256(Buffer.from(manifestText, 'utf8'));
  const latest = {
    schema: 1,
    packId: manifest.packId,
    version: manifest.version,
    contentHash,
    manifest: `packs/${manifest.version}/manifest.json`,
    manifestSha256,
    publishedAt: manifest.publishedAt,
    notes: manifest.notes,
  };

  const catalog = buildCatalog(manifest);

  step('6/6 生成待发布站点目录');
  const siteDir = join(cfg.paths.outDir, 'site');
  const retained = await collectRetained(cfg, prevManifest, manifest);
  const siteStats = await buildSite(cfg, retained, catalog, latest, { siteDir });

  await ensureDir(join(stateDir, 'versions', version));
  await writeFileAtomic(join(stateDir, 'versions', version, 'manifest.json'), manifestText);
  await writeFileAtomic(join(stateDir, 'latest.json'), prettyJson(latest));
  await ensureDir(cfg.paths.outDir);
  await writeFileAtomic(join(cfg.paths.outDir, 'latest.json'), prettyJson(latest));
  await writeFileAtomic(join(cfg.paths.outDir, 'manifest.json'), manifestText);

  await pruneObjects(cfg, retained);

  const stats = {
    version,
    files: manifestFiles.length,
    mirrored,
    hosted,
    totalBytes,
    mods: catalog.mods.length,
    siteFiles: siteStats.fileCount,
    parts: siteStats.partCount,
    contentHash,
    changed: !prevManifest || prevManifest.contentHash !== contentHash,
    elapsedMs: Date.now() - t0,
    retainedVersions: retained.map((m) => m.version),
  };

  ok(`构建完成：${stats.files} 个文件（镜像 ${mirrored} / 自托管 ${hosted}），共 ${formatBytes(totalBytes)}`);
  info(`版本 ${version}，站点文件 ${stats.siteFiles} 个${stats.parts ? `（含分片 ${stats.parts}）` : ''}，耗时 ${Math.round(stats.elapsedMs / 1000)}s`);
  info(`站点目录: ${siteDir}`);
  if (stats.siteFiles > 19000) {
    warn(`站点文件数 ${stats.siteFiles} 接近 Cloudflare Pages 免费版 20,000 上限，请缩小更新范围`);
  }
  return { manifest, manifestText, manifestSha256, latest, catalog, siteDir, stats };
}

function contentPath(sha, targetPath) {
  const dot = targetPath.lastIndexOf('.');
  const ext = dot > 0 ? targetPath.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
  return `files/${sha.slice(0, 2)}/${sha}${ext}`;
}

function siteUrl(cfg, path) {
  const base = (cfg.pages.baseUrl || 'https://example.pages.dev').replace(/\/+$/, '');
  return `${base}/${path}`;
}
function toModManifest(info) {
  if (!info?.mods?.length) return [];
  return info.mods.map((m) => ({
    modId: m.modId,
    name: m.name,
    version: m.version,
    authors: m.authors,
    license: m.license,
    description: m.description ? m.description.slice(0, MAX_DESC) : null,
    environment: m.environment || null,
    links: (m.links || []).map((l) => ({ kind: l.kind, url: l.url })),
  }));
}

function computeContentHash(cfg, files) {
  const payload = {
    packId: cfg.pack.id,
    packName: cfg.pack.name,
    baseUrl: cfg.pages.baseUrl || '',
    game: cfg.game,
    policy: cfg.policy,
    requiredModIds: cfg.requiredModIds,
    chunkBytes: cfg.pages.chunkBytes,
    scopes: cfg.scopes.filter((s) => s.enabled).map((s) => ({ id: s.id, kind: s.kind, target: s.target, role: s.role })),
    files: files.map((f) => ({
      path: f.path, sha256: f.sha256, role: f.role,
      source: f.source.kind === 'mirror' ? `mirror:${f.source.url}` : 'pages',
    })),
  };
  return sha256(Buffer.from(stableStringify(payload), 'utf8'));
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function computeParts(srcPath, chunkBytes, fullSha) {
  const st = await stat(srcPath);
  const fh = await open(srcPath, 'r');
  const parts = [];
  try {
    let off = 0, index = 0;
    while (off < st.size) {
      const len = Math.min(chunkBytes, st.size - off);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      if (bytesRead !== len) throw new Error(`读取分片失败: ${srcPath} @${off}`);
      parts.push({
        path: `parts/${fullSha.slice(0, 2)}/${fullSha}.part${String(index).padStart(2, '0')}`,
        size: len,
        sha256: sha256(buf),
        index,
        offset: off,
      });
      off += len;
      index++;
    }
    if (off !== st.size) throw new Error(`分片总大小不符: ${srcPath}`);
  } finally {
    await fh.close();
  }
  return parts;
}

async function collectRetained(cfg, prevManifest, current) {
  const versionsDir = join(cfg.paths.stateDir, 'versions');
  const keep = Math.max(0, Number(cfg.pages.retainVersions) || 0);
  const history = [];
  if (keep > 0 && existsSync(versionsDir)) {
    const dirs = (await readdir(versionsDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    const withTime = [];
    for (const d of dirs) {
      const m = await readJsonIfExists(join(versionsDir, d.name, 'manifest.json'));
      if (m && m.version !== current.version) withTime.push(m);
    }
    withTime.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    history.push(...withTime.slice(0, keep));
  }
  return [current, ...history];
}

async function buildSite(cfg, manifests, catalog, latest, { siteDir }) {
  await rm(siteDir, { recursive: true, force: true });
  await ensureDir(siteDir);
  const objectDir = join(cfg.paths.stateDir, 'objects');
  let fileCount = 0, partCount = 0;
  const missing = [];

  for (const m of manifests) {
    const dir = join(siteDir, 'packs', m.version);
    await ensureDir(dir);

    for (const f of m.files) {
      if (f.source.kind !== 'pages') continue;
      const obj = join(objectDir, f.sha256);
      if (!existsSync(obj)) { missing.push(f.path); continue; }
      if (f.parts?.length) {
        const chunkBytes = m.chunkBytes || cfg.pages.chunkBytes;
        await writeParts(obj, f, chunkBytes, siteDir);
        partCount += f.parts.length;
        fileCount += f.parts.length;
      } else {
        const dest = join(siteDir, f.source.path);
        await ensureDir(join(dest, '..'));
        await linkOrCopy(obj, dest);
        fileCount++;
      }
    }
    await writeFileAtomic(join(dir, 'manifest.json'), prettyJson(m));
    fileCount++;
  }
  if (missing.length) {
    warn(`有 ${missing.length} 个自托管文件在对象库中缺失，相关旧版本将不完整: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}`);
  }

  await writeFileAtomic(join(siteDir, 'latest.json'), prettyJson(latest));
  await writeFileAtomic(join(siteDir, 'catalog.json'), prettyJson(catalog));
  await writeFileAtomic(join(siteDir, 'catalog.html'), renderCatalogHtml(catalog));
  await writeFileAtomic(join(siteDir, 'index.html'), renderIndexHtml(catalog, latest));
  fileCount += 4;

  // Cloudflare Pages 免费版上限
  if (fileCount > 20000) {
    throw new Error(`站点文件数 ${fileCount} 超过 Cloudflare Pages 免费版 20,000 上限，请缩小 scope 或排除缓存目录`);
  }
  return { fileCount, partCount };
}

async function writeParts(objPath, fileEntry, chunkBytes, siteDir) {
  const st = await stat(objPath);
  const fh = await open(objPath, 'r');
  try {
    let off = 0;
    for (const part of fileEntry.parts) {
      const len = Math.min(chunkBytes, st.size - off);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      if (bytesRead !== len) throw new Error(`读取分片失败: ${objPath} @${off}`);
      part.sha256 = sha256(buf);
      part.size = len;
      part.offset = off;
      const dest = join(siteDir, part.path);
      await ensureDir(join(dest, '..'));
      await writeFileAtomic(dest, buf);
      off += len;
    }
    if (off !== st.size) throw new Error(`分片总大小不符: ${objPath}`);
  } finally {
    await fh.close();
  }
}

async function linkOrCopy(src, dest) {
  try { await link(src, dest); }
  catch { await copyFile(src, dest); }
}

async function pruneObjects(cfg, retainedManifests) {
  const objectDir = join(cfg.paths.stateDir, 'objects');
  const keep = new Set();
  for (const m of retainedManifests) for (const f of m.files) if (f.source.kind === 'pages') keep.add(f.sha256);
  let names;
  try { names = await readdir(objectDir); } catch { return; }
  let removed = 0;
  for (const name of names) {
    if (!keep.has(name)) { await rm(join(objectDir, name), { force: true }); removed++; }
  }
  if (removed) info(`清理对象库 ${removed} 个不再引用的文件`);
}

async function loadResolveCache(cfg) {
  const p = join(cfg.paths.stateDir, 'resolve-cache.json');
  const raw = await readJsonIfExists(p);
  return new ResolveCache(p, raw || {});
}

async function saveResolveCache(cfg, resolver) {
  if (!resolver.cache?.cacheDirty) return;
  await ensureDir(cfg.paths.stateDir);
  await writeFileAtomic(resolver.cache.filePath, prettyJson(resolver.cache.toJSON()));
}

async function readJsonIfExists(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export { contentPath, dateStamp };
