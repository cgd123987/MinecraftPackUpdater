#!/usr/bin/env node
// 不依赖 Gradle：直接 javac 编译服务端 mod 并打成 jar。
// 用法: node tools/build-server-jar.mjs [服务器目录]
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOD = join(ROOT, 'servermod');
const OUT = join(ROOT, 'build-server');
const DIST = ROOT;                      // jar 直接放项目最外层
const SERVER_DIR = resolve(process.argv[2] || 'D:/dd/云梦缘服务端');

const JDK_CANDIDATES = [
  process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin'),
  'C:/Program Files/Java/jdk-21/bin',
  'C:/Users/Dell/AppData/Roaming/.minecraft/runtime/java-runtime-delta/bin',
  'C:/Program Files/Eclipse Adoptium/jdk-21/bin',
];

function findTool(name) {
  for (const dir of JDK_CANDIDATES) {
    if (!dir) continue;
    const p = join(dir, `${name}.exe`);
    if (existsSync(p)) return p;
  }
  return name;
}

async function findJar(relDir, pattern, depth = 0) {
  const dir = join(SERVER_DIR, 'libraries', relDir);
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { withFileTypes: true });
  const jars = entries.filter((e) => e.isFile() && e.name.endsWith('.jar') && pattern.test(e.name));
  if (jars.length) return join(dir, jars[0].name);
  if (depth >= 2) return null;
  for (const e of entries.filter((x) => x.isDirectory())) {
    const found = await findJar(`${relDir}/${e.name}`, pattern, depth + 1);
    if (found) return found;
  }
  return null;
}

async function main() {
  if (!existsSync(join(SERVER_DIR, 'libraries'))) {
    throw new Error(`服务器目录下没有 libraries: ${SERVER_DIR}\n用法: node tools/build-server-jar.mjs <服务器目录>`);
  }
  const javac = findTool('javac');
  const jarTool = findTool('jar');
  const ver = spawnSync(javac, ['-version'], { encoding: 'utf8' });
  console.log(`javac: ${javac} (${(ver.stdout || ver.stderr || '').trim()})`);

  const classpath = [
    await findJar('net/neoforged/neoforge', /universal\.jar$/),
    await findJar('net/neoforged/fancymodloader/loader', /^loader-.*\.jar$/),
    await findJar('net/neoforged/bus', /^bus-.*\.jar$/),
    await findJar('net/minecraft/server', /-srg\.jar$/),
    await findJar('com/google/code/gson/gson', /^gson-.*\.jar$/),
  ].filter(Boolean);
  console.log(`classpath: ${classpath.length} 个 jar`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'classes'), { recursive: true });
  await mkdir(DIST, { recursive: true });

  const sources = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.java')) sources.push(p);
    }
  }
  await walk(join(MOD, 'src', 'main', 'java'));
  console.log(`编译 ${sources.length} 个源文件…`);

  const res = spawnSync(javac, [
    '-J-Duser.language=en', '-J-Duser.country=US',
    '-encoding', 'UTF-8', '--release', '21',
    '-cp', classpath.join(';'),
    '-d', join(OUT, 'classes'),
    ...sources,
  ], { encoding: 'utf8', stdio: 'pipe' });
  if (res.status !== 0) {
    console.error(res.stdout || '');
    console.error(res.stderr || '');
    throw new Error('javac 编译失败');
  }

  await cp(join(MOD, 'src', 'main', 'resources'), join(OUT, 'classes'), { recursive: true });

  const jarPath = join(DIST, 'AutoPack-1.0.0.jar');
  await rm(jarPath, { force: true });
  const jarRes = spawnSync(jarTool, ['--create', '--file', jarPath, '-C', join(OUT, 'classes'), '.'], { encoding: 'utf8' });
  if (jarRes.status !== 0) throw new Error(`打包失败: ${jarRes.stderr}`);
  const size = (await stat(jarPath)).size;
  console.log(`\n产物: ${jarPath} (${(size / 1024).toFixed(0)} KiB)`);
  console.log(`安装: 把 ${basename(jarPath)} 复制到 ${join(SERVER_DIR, 'mods')}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
