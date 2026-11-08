import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/common/toml.mjs';
import { ZipArchive } from '../src/common/zip.mjs';
import { readModJar } from '../src/builder/modmeta.mjs';
import { toMirrorUrl, toOfficialUrl, extractLinks, projectMirrorUrl } from '../src/common/mirror.mjs';
import { matchesAny, globToRegExp } from '../src/common/fsutil.mjs';
import { makeZip, modsToml, makeTempDir } from './helpers.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('TOML：基础值、表、表数组、多行串', () => {
  const t = parseToml(`
modLoader="javafml" # 注释
loaderVersion="[4,)"
license="MIT"
[[mods]]
modId="foo"
version="1.2.3"
displayName="Foo & Bar" # 引号里有 # 和空格
description='''line1
line2 "quoted" # not comment'''
deps=["a","b"]
[[mods]]
modId="bar"
flag=true
num=42
ratio=0.5
[features.foo]
openGLVersion="[3.2,)"
`);
  assert.equal(t.modLoader, 'javafml');
  assert.equal(t.license, 'MIT');
  assert.equal(t.mods.length, 2);
  assert.equal(t.mods[0].modId, 'foo');
  assert.match(t.mods[0].description, /line2 "quoted" # not comment/);
  assert.deepEqual(t.mods[0].deps, ['a', 'b']);
  assert.equal(t.mods[1].num, 42);
  assert.equal(t.features.foo.openGLVersion, '[3.2,)');
});

test('TOML：转义与字面串', () => {
  const t = parseToml(`a="line\\nnext\\tTAB \\"q\\""
b='C:\\path\\no\\escape'
c="""ml
body"""
`);
  assert.equal(t.a, 'line\nnext\tTAB "q"');
  assert.equal(t.b, 'C:\\path\\no\\escape');
  assert.equal(t.c, 'ml\nbody');
});

test('ZIP：读取条目内容', async () => {
  const tmp = await makeTempDir();
  const p = join(tmp, 'a.jar');
  await writeFile(p, makeZip({ 'META-INF/neoforge.mods.toml': 'modId="x"', 'assets/logo.png': Buffer.from([1, 2, 3]) }));
  const z = ZipArchive.open(p);
  assert.equal(z.readText('META-INF/neoforge.mods.toml'), 'modId="x"');
  assert.deepEqual([...z.read('assets/logo.png')], [1, 2, 3]);
  assert.equal(z.read('nope'), null);
});

test('mod 元数据：NeoForge 与 Fabric', async () => {
  const tmp = await makeTempDir();
  const neo = join(tmp, 'neo.jar');
  await writeFile(neo, makeZip({
    'META-INF/neoforge.mods.toml': modsToml({
      modId: 'foo', name: 'Foo Mod', version: '2.0',
      description: 'see https://modrinth.com/mod/foo and https://www.curseforge.com/minecraft/mc-mods/foo',
      displayURL: 'https://github.com/x/foo',
    }),
  }));
  const info = readModJar(neo);
  assert.equal(info.mods[0].modId, 'foo');
  assert.equal(info.mods[0].version, '2.0');
  const kinds = info.links.map((l) => l.kind);
  assert.ok(kinds.includes('modrinth'));
  assert.ok(kinds.includes('curseforge'));
  assert.ok(kinds.includes('github'));

  const fab = join(tmp, 'fab.jar');
  await writeFile(fab, makeZip({
    'fabric.mod.json': JSON.stringify({
      id: 'bar', name: 'Bar', version: '1.0', license: 'MIT',
      description: 'https://modrinth.com/mod/bar', environment: 'client',
      contact: { homepage: 'https://example.com' },
      authors: [{ name: 'Z' }],
    }),
  }));
  const fi = readModJar(fab);
  assert.equal(fi.mods[0].modId, 'bar');
  assert.equal(fi.mods[0].environment, 'client');
  assert.equal(fi.mods[0].authors, 'Z');
});

test('镜像：CDN/API 双向映射', () => {
  assert.equal(
    toMirrorUrl('https://cdn.modrinth.com/data/abc/versions/v1/f.jar'),
    'https://mod.mcimirror.top/data/abc/versions/v1/f.jar',
  );
  assert.equal(
    toMirrorUrl('https://api.modrinth.com/v2/project/abc?x=1'),
    'https://mod.mcimirror.top/modrinth/v2/project/abc?x=1',
  );
  assert.equal(
    toMirrorUrl('https://edge.forgecdn.net/files/1/2/f.jar'),
    'https://mod.mcimirror.top/files/1/2/f.jar',
  );
  assert.equal(
    toMirrorUrl('https://api.curseforge.com/v1/mods/1'),
    'https://mod.mcimirror.top/curseforge/v1/mods/1',
  );
  // 非镜像域名原样返回
  assert.equal(toMirrorUrl('https://example.com/a.jar'), 'https://example.com/a.jar');
  // 反向还原
  assert.equal(
    toOfficialUrl('https://mod.mcimirror.top/data/abc/versions/v1/f.jar'),
    'https://cdn.modrinth.com/data/abc/versions/v1/f.jar',
  );
  assert.equal(
    toOfficialUrl('https://mod.mcimirror.top/modrinth/v2/project/abc'),
    'https://api.modrinth.com/v2/project/abc',
  );
});

test('镜像：链接抽取与项目页镜像地址', () => {
  const links = extractLinks('主页 https://modrinth.com/mod/sodium 和 https://www.curseforge.com/minecraft/mc-mods/jei，重复 https://modrinth.com/mod/sodium');
  assert.equal(links.length, 2);
  assert.equal(projectMirrorUrl(links[0]), 'https://mod.mcimirror.top/modrinth/v2/project/sodium');
  assert.match(projectMirrorUrl(links[1]), /curseforge\/v1\/mods\/search\?gameId=432&slug=jei/);
});

test('glob：include/exclude 匹配', () => {
  assert.ok(globToRegExp('*.jar').test('a.jar'));
  assert.ok(!globToRegExp('*.jar').test('dir/a.jar'));
  assert.ok(globToRegExp('**/*.jar').test('dir/sub/a.jar'));
  assert.ok(matchesAny('kubejs/server_scripts/main.js', ['kubejs']));
  assert.ok(matchesAny('mods/a.jar', ['mods/*.jar']));
  assert.ok(!matchesAny('mods/a.jar.bak', ['mods/*.jar']));
  assert.ok(matchesAny('logs/latest.log', ['**/logs/**']));
});
