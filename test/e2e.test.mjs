import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeConfig } from '../src/builder/config.mjs';
import { buildPack } from '../src/builder/build.mjs';
import { Updater } from '../src/client/engine.mjs';
import { baseConfig, makeTempDir, modsToml, serveDir, writeJar } from './helpers.mjs';

async function makePackConfig(root, serverDir, siteUrl, extra = {}) {
  const raw = baseConfig({
    paths: {
      serverDir,
      outDir: join(root, 'dist'),
      stateDir: join(root, '.autopack'),
    },
    pages: {
      project: 'test', branch: 'main', baseUrl: siteUrl, retainVersions: 0,
      maxAssetBytes: 25 * 1024 * 1024, chunkBytes: 24 * 1024 * 1024,
    },
    scopes: [
      { id: 'mods', kind: 'mods', source: 'mods', target: 'mods', role: 'required', enabled: true },
      { id: 'kubejs', kind: 'files', source: 'kubejs', target: 'kubejs', role: 'content', enabled: true },
    ],
    ...extra,
  });
  return normalizeConfig(raw, root);
}

async function prepareServer(root) {
  const serverDir = join(root, 'server');
  await writeJar(join(serverDir, 'mods'), 'goodmod-1.0.0.jar', {
    'META-INF/neoforge.mods.toml': modsToml({
      modId: 'goodmod', name: 'Good Mod', version: '1.0.0',
      description: 'download from https://modrinth.com/mod/goodmod',
    }),
  });
  await writeJar(join(serverDir, 'mods'), 'privatemod-1.0.0.jar', {
    'META-INF/neoforge.mods.toml': modsToml({ modId: 'privatemod', name: 'Private Mod' }),
  });
  await mkdir(join(serverDir, 'kubejs'), { recursive: true });
  await writeFile(join(serverDir, 'kubejs', 'main.js'), 'console.log("v1")\n');
  return serverDir;
}

test('端到端：构建 → 同步 → 幂等 → 保留自装 mod → 替换同 modId 旧版 → 增量更新 → 分片', async (t) => {
  const root = await makeTempDir('autopack-e2e-');
  const serverDir = await prepareServer(root);
  const siteDir = join(root, 'dist', 'site');
  const site = await serveDir(siteDir);
  t.after(() => site.close());

  const cfg = await makePackConfig(root, serverDir, site.url);
  const first = await buildPack(cfg, {});
  assert.equal(first.manifest.files.length, 3, '两个 mod + 一个 kubejs 文件');
  assert.equal(first.stats.mirrored, 0, '关闭镜像后全部自托管');
  assert.equal(first.manifest.files.filter((f) => f.source.kind === 'pages').length, 3);

  const gameDir = join(root, 'game');
  await mkdir(join(gameDir, 'mods'), { recursive: true });

  // 1) 首次同步
  const up1 = new Updater({ gameDir, baseUrl: site.url });
  await up1.loadLocal();
  const { manifest, plan } = await up1.check();
  assert.equal(plan.installs.length, 3);
  assert.equal(plan.upToDate, false);
  const r1 = await up1.sync(manifest, plan);
  assert.equal(r1.installed, 3);

  for (const f of manifest.files) {
    const local = await readFile(join(gameDir, ...f.path.split('/')));
    assert.equal(local.length, f.size, `${f.path} 大小`);
  }
  const goodJar = await readFile(join(gameDir, 'mods', 'goodmod-1.0.0.jar'));
  assert.ok(goodJar.length > 0);

  // 2) 幂等
  const up2 = new Updater({ gameDir, baseUrl: site.url });
  await up2.loadLocal();
  const second = await up2.check();
  assert.equal(second.plan.upToDate, true);
  assert.equal(second.plan.installs.length, 0);

  // 3) 清单外的自装 mod 永不删除
  await writeJar(join(gameDir, 'mods'), 'clientonly-1.0.jar', {
    'META-INF/neoforge.mods.toml': modsToml({ modId: 'clientonly', name: 'Client Only' }),
  });
  const up3 = new Updater({ gameDir, baseUrl: site.url });
  await up3.loadLocal();
  const third = await up3.check();
  assert.equal(third.plan.upToDate, true);
  assert.equal(third.plan.toBackup.length, 0);
  assert.ok(await stat(join(gameDir, 'mods', 'clientonly-1.0.jar')), '自装 mod 必须保留');

  // 4) 同 modId 的旧 jar 被替换（备份而非直接删除）
  await copyFile(join(gameDir, 'mods', 'goodmod-1.0.0.jar'), join(gameDir, 'mods', 'goodmod-0.9-old.jar'));
  const up4 = new Updater({ gameDir, baseUrl: site.url });
  await up4.loadLocal();
  const fourth = await up4.check();
  assert.equal(fourth.plan.toBackup.length, 1);
  assert.equal(fourth.plan.toBackup[0].path, 'mods/goodmod-0.9-old.jar');
  await up4.sync(fourth.manifest, fourth.plan);
  await assert.rejects(stat(join(gameDir, 'mods', 'goodmod-0.9-old.jar')), '旧 jar 应被移走');
  const backupRoot = join(gameDir, '.autopack', 'backup');
  const backupDirs = await import('node:fs/promises').then((m) => m.readdir(backupRoot));
  assert.equal(backupDirs.length, 1);
  assert.ok(await stat(join(backupRoot, backupDirs[0], 'mods', 'goodmod-0.9-old.jar')), '旧 jar 应在备份里');

  // 5) 内容变更 → 只更新变更文件，旧内容进备份
  await writeFile(join(serverDir, 'kubejs', 'main.js'), 'console.log("v2 changed")\n');
  const second2 = await buildPack(await makePackConfig(root, serverDir, site.url), {});
  assert.notEqual(second2.manifest.version, first.manifest.version);
  const up5 = new Updater({ gameDir, baseUrl: site.url });
  await up5.loadLocal();
  const fifth = await up5.check();
  assert.equal(fifth.plan.installs.length, 1);
  assert.equal(fifth.plan.installs[0].path, 'kubejs/main.js');
  await up5.sync(fifth.manifest, fifth.plan);
  assert.equal(await readFile(join(gameDir, 'kubejs', 'main.js'), 'utf8'), 'console.log("v2 changed")\n');

  // 6) 分片：>1KiB 的文件按 512B 切片，客户端合并后哈希一致
  const extras = join(serverDir, 'extras');
  await mkdir(extras, { recursive: true });
  const big = Buffer.alloc(2048);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  await writeFile(join(extras, 'big.bin'), big);

  const chunkCfg = await makePackConfig(root, serverDir, site.url, {
    scopes: [
      { id: 'mods', kind: 'mods', source: 'mods', target: 'mods', role: 'required', enabled: true },
      { id: 'extras', kind: 'files', source: 'extras', target: 'extras', role: 'content', enabled: true },
    ],
    pages: {
      project: 'test', branch: 'main', baseUrl: site.url, retainVersions: 0,
      maxAssetBytes: 1024, chunkBytes: 512,
    },
  });
  const third2 = await buildPack(chunkCfg, {});
  const bigEntry = third2.manifest.files.find((f) => f.path === 'extras/big.bin');
  assert.equal(bigEntry.parts.length, 4);
  assert.equal(bigEntry.source.kind, 'pages');

  const up6 = new Updater({ gameDir, baseUrl: site.url });
  await up6.loadLocal();
  const sixth = await up6.check();
  const bigPlan = sixth.plan.installs.find((f) => f.path === 'extras/big.bin');
  assert.ok(bigPlan, '应计划下载分片文件');
  await up6.sync(sixth.manifest, sixth.plan);
  const merged = await readFile(join(gameDir, 'extras', 'big.bin'));
  assert.deepEqual(merged, big);
});

test('requiredModIds 不在范围内时构建失败并给出提示', async () => {
  const root = await makeTempDir('autopack-req-');
  const serverDir = await prepareServer(root);
  const cfg = await makePackConfig(root, serverDir, 'http://127.0.0.1:1', { requiredModIds: ['sodium'] });
  await assert.rejects(() => buildPack(cfg, {}), /requiredModIds.*sodium/);
});

test('重复的目标路径会被拒绝', async () => {
  const root = await makeTempDir('autopack-dup-');
  const serverDir = await prepareServer(root);
  const cfg = await makePackConfig(root, serverDir, 'http://127.0.0.1:1', {
    scopes: [
      { id: 'a', kind: 'mods', source: 'mods', target: 'mods', role: 'required', enabled: true },
      { id: 'b', kind: 'mods', source: 'mods', target: 'mods', role: 'optional', enabled: true },
    ],
  });
  await assert.rejects(() => buildPack(cfg, {}), /目标路径冲突/);
});
