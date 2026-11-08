#!/usr/bin/env node
// 把客户端/构建器打包成单文件 exe：esbuild 打包 → Node SEA 生成 blob → postject 注入 node.exe。
// 产物：dist-exe/AutoPackClient.exe、dist-exe/AutoPackBuilder.exe
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = ROOT;                       // exe 直接放项目最外层
const TMP = join(ROOT, '.build-exe');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const TARGETS = {
  client: { entry: 'src/client/index.mjs', exe: 'AutoPackClient.exe', title: '客户端' },
  builder: { entry: 'src/builder/cli.mjs', exe: 'AutoPackBuilder.exe', title: '构建器' },
};

async function main() {
  const arg = process.argv[2] || 'all';
  const names = arg === 'all' ? Object.keys(TARGETS) : [arg];
  for (const n of names) if (!TARGETS[n]) throw new Error(`未知目标: ${n}（可选 client/builder/all）`);

  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await mkdir(OUT, { recursive: true });

  for (const name of names) {
    const t = TARGETS[name];
    console.log(`\n[${t.title}] esbuild 打包 ${t.entry}`);
    const bundlePath = join(TMP, `${name}.cjs`);
    await build({
      entryPoints: [join(ROOT, t.entry)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: bundlePath,
      logLevel: 'warning',
      sourcemap: false,
      minify: false,
      define: { 'process.env.AUTOPACK_BUNDLED': '"1"' },
    });
    const bundleSize = (await stat(bundlePath)).size;
    console.log(`  bundle: ${(bundleSize / 1024).toFixed(0)} KiB`);

    const blobPath = join(TMP, `${name}.blob`);
    const seaConfig = join(TMP, `${name}.sea.json`);
    await writeFile(seaConfig, JSON.stringify({
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    }, null, 2));
    const sea = spawnSync(process.execPath, ['--experimental-sea-config', seaConfig], { encoding: 'utf8' });
    if (sea.status !== 0) throw new Error(`生成 SEA blob 失败:\n${sea.stderr}`);
    console.log(`  blob:   ${((await stat(blobPath)).size / 1024).toFixed(0)} KiB`);

    const exePath = join(OUT, t.exe);
    await copyFile(process.execPath, exePath);
    const postjectBin = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
    if (!existsSync(postjectBin)) throw new Error('缺少 postject，请先运行 npm install');
    const inject = spawnSync(process.execPath, [
      postjectBin, exePath, 'NODE_SEA_BLOB', blobPath,
      '--sentinel-fuse', SENTINEL,
    ], { encoding: 'utf8' });
    if (inject.status !== 0) throw new Error(`注入失败:\n${inject.stderr}`);
    const size = (await stat(exePath)).size;
    console.log(`  产物:   ${exePath}  (${(size / 1024 / 1024).toFixed(1)} MiB)`);
  }
  console.log('\n完成。未签名的 exe 首次运行可能触发 SmartScreen，选择“仍要运行”即可。');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
